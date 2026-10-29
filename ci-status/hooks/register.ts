import type { EngineInterface as Engine, Register } from 'claude-code'

// The starboard contract, kept local: the mod does not depend on `starboard`, it only uses it when present.
type StarboardRow = { label?: string; value: string; status?: 'ok' | 'warn' | 'error' | 'off'; dim?: boolean; href?: string }
type StarboardSection = { id: string; title: string; order?: number; summary?: string; rows: StarboardRow[] }
type WithStarboard = Engine & {
  starboard: { publish: (section: StarboardSection) => Promise<void>; remove: (id: string) => Promise<void> }
}

export type Remote = { org: string; project: string; repo: string }
type Build = {
  id: number
  buildNumber: string
  status: string
  result?: string
  sourceVersion: string
  startTime?: string
  finishTime?: string
  queueTime?: string
  definition: { name: string }
  _links?: { web?: { href?: string } }
}
type Report = { line: string; summary?: string; rows: StarboardRow[] }

const SECTION = 'ci-status'
const POLL_MS = 60000
const ENABLED = 'enabled'
const API = 'api-version=7.1'

// git@ssh.dev.azure.com:v3/org/project/repo, vs-ssh.visualstudio.com:v3/…, https://dev.azure.com/org/project/_git/repo,
// https://org.visualstudio.com/project/_git/repo
const REMOTES = [
  /(?:ssh\.dev\.azure\.com|vs-ssh\.visualstudio\.com):v3\/([^/]+)\/([^/]+)\/([^/]+?)(?:\.git)?$/,
  /dev\.azure\.com\/([^/]+)\/([^/]+)\/_git\/([^/]+?)(?:\.git)?$/,
  /\/\/(?:[^@/]+@)?([^./]+)\.visualstudio\.com\/(?:DefaultCollection\/)?([^/]+)\/_git\/([^/]+?)(?:\.git)?$/,
]

export function parseRemote(url: string): Remote | undefined {
  for (const pattern of REMOTES) {
    const [, org, project, repo] = pattern.exec(url) ?? []
    if (org && project && repo) return { org, project: decodeURIComponent(project), repo: decodeURIComponent(repo) }
  }
  return undefined
}

export const pullRequestUrl = (remote: Remote, id: number): string =>
  `https://dev.azure.com/${remote.org}/${encodeURIComponent(remote.project)}/_git/${encodeURIComponent(remote.repo)}/pullrequest/${id}`

export const tokenFromEnvFile = (text: string): string | undefined =>
  /^\s*(?:export\s+)?AZURE_ACCESS_TOKEN\s*=\s*["']?([^"'\s#]+)/m.exec(text)?.[1]

export const minutes = (from?: string, to?: string, now = Date.now()): string => {
  if (!from) return ''
  const ms = (to ? Date.parse(to) : now) - Date.parse(from)
  return `${Math.max(0, Math.round(ms / 60000))} min`
}

async function git($: Engine, args: string[]) {
  const { exitCode, stdout } = await $.process.run(['git', ...args], { timeoutMs: 5000 })
  return exitCode === 0 ? stdout.trim() : undefined
}

// The PAT never leaves this function except inside the Authorization header.
async function findToken($: Engine, top: string): Promise<string | undefined> {
  const fromEnv = await $.env.get('AZURE_ACCESS_TOKEN')
  if (fromEnv) return fromEnv
  const common = await git($, ['rev-parse', '--path-format=absolute', '--git-common-dir'])
  const main = common?.replace(/\/\.git\/?$/, '')
  for (const root of [top, main]) {
    if (!root) continue
    try {
      const token = tokenFromEnvFile(await $.fs.read(`${root}/docker/.env`))
      if (token) return token
    } catch {
      // No docker/.env there: try the next place.
    }
  }
  return undefined
}

class HttpError extends Error {
  constructor(readonly status: number) {
    super(`HTTP ${status}`)
  }
}

async function api<T>($: Engine, auth: string, remote: Remote, path: string): Promise<T> {
  const base = `https://dev.azure.com/${remote.org}/${encodeURIComponent(remote.project)}/_apis`
  const sep = path.includes('?') ? '&' : '?'
  const url = `${base}/${path}${sep}${API}`
  const init = { headers: { Authorization: auth, Accept: 'application/json' } }
  // Azure DevOps sometimes drops the TLS connection ("EOF occurred in violation of protocol"): one retry.
  const { ok, status, text } = await $.http.fetch(url, init).catch(() => $.http.fetch(url, init))
  // A wrong PAT answers 203 with the sign-in page instead of a 401.
  if (!ok || status === 203) throw new HttpError(status)
  return JSON.parse(text) as T
}

const failedSteps = new Map<number, string[]>()

async function stepsOf($: Engine, auth: string, remote: Remote, build: Build): Promise<string[]> {
  const known = failedSteps.get(build.id)
  if (known) return known
  const { records } = await api<{ records: { name: string; type: string; result?: string }[] }>(
    $, auth, remote, `build/builds/${build.id}/timeline`,
  )
  const failed = records.filter(r => r.result === 'failed' || r.result === 'canceled')
  const tasks = failed.filter(r => r.type === 'Task')
  const names = [...new Set((tasks.length ? tasks : failed).map(r => r.name))]
  failedSteps.set(build.id, names)
  return names
}

export function verdict(builds: Build[]): 'running' | 'failed' | 'ok' {
  if (builds.some(b => b.status !== 'completed')) return 'running'
  if (builds.some(b => b.result === 'failed' || b.result === 'canceled')) return 'failed'
  return 'ok'
}

export async function describeCi($: Engine): Promise<Report | undefined> {
  const top = await git($, ['rev-parse', '--show-toplevel'])
  const remote = top ? parseRemote((await git($, ['remote', 'get-url', 'origin'])) ?? '') : undefined
  const branch = top ? await git($, ['branch', '--show-current']) : undefined
  // Not an Azure DevOps repository or a detached HEAD: nothing to say.
  if (!top || !remote || !branch) return undefined

  const token = await findToken($, top)
  if (!token) {
    return { line: 'CI ○ pas de PAT', rows: [{ value: 'AZURE_ACCESS_TOKEN introuvable (env ou docker/.env)', status: 'off', dim: true }] }
  }
  const auth = `Basic ${btoa(`:${token}`)}`

  try {
    const ref = encodeURIComponent(`refs/heads/${branch}`)
    const prs = await api<{ value: { pullRequestId: number }[] }>(
      $, auth, remote,
      `git/repositories/${encodeURIComponent(remote.repo)}/pullRequests?searchCriteria.sourceRefName=${ref}&searchCriteria.status=active`,
    )
    const pr = prs.value[0]?.pullRequestId
    const buildRef = pr ? encodeURIComponent(`refs/pull/${pr}/merge`) : ref
    const { value: recent } = await api<{ value: Build[] }>(
      $, auth, remote, `build/builds?branchName=${buildRef}&$top=10&queryOrder=queueTimeDescending`,
    )
    const where = pr ? `PR ${pr}` : branch
    const prRow: StarboardRow = { label: 'pr', value: pr ? `#${pr}` : 'aucune', dim: !pr, href: pr ? pullRequestUrl(remote, pr) : undefined }
    const [latest] = recent
    if (!latest) {
      return { line: `CI ○ ${where} · aucun build`, rows: [prRow, { label: 'build', value: 'aucun', status: 'off', dim: true }] }
    }

    // The latest commit's builds, one per pipeline.
    const head = latest.sourceVersion
    const builds = recent.filter(b => b.sourceVersion === head)
      .filter((b, i, all) => all.findIndex(o => o.definition.name === b.definition.name) === i)
    const state = verdict(builds)
    const main = builds.find(b => b.status !== 'completed') ?? builds.find(b => b.result === 'failed') ?? latest
    const elapsed = minutes(main.startTime ?? main.queueTime, main.finishTime)
    const failed = state === 'failed'
      ? (await Promise.all(builds.filter(b => b.result === 'failed' || b.result === 'canceled').map(b => stepsOf($, auth, remote, b)))).flat()
      : []

    const rows: StarboardRow[] = [
      prRow,
      ...builds.map((b): StarboardRow => ({
        label: b.definition.name,
        value: `${b.status === 'completed' ? (b.result ?? 'terminé') : b.status === 'notStarted' ? 'en attente' : 'en cours'} · ${minutes(b.startTime ?? b.queueTime, b.finishTime)}`,
        status: b.status !== 'completed' ? 'warn' : b.result === 'succeeded' ? 'ok' : b.result === 'partiallySucceeded' ? 'warn' : 'error',
        href: b._links?.web?.href,
      })),
      ...failed.map((name): StarboardRow => ({ label: 'échec', value: name, status: 'error' })),
      { label: 'commit', value: head.slice(0, 8), dim: true },
    ]

    const line = state === 'running' ? `CI ⏳ ${where} · ${elapsed}`
      : state === 'failed' ? `CI ❌ ${failed.slice(0, 2).join(', ') || where}`
      : `CI ✅ ${where}`
    return { line, summary: state === 'running' ? `⏳ ${elapsed}` : state === 'failed' ? '❌' : '✅', rows }
  } catch (error) {
    const status = error instanceof HttpError ? error.status : undefined
    const why = status === 401 || status === 203 ? 'PAT refusé' : status ? `HTTP ${status}` : 'Azure DevOps injoignable'
    return { line: `CI ⚠ ${why}`, rows: [{ value: why, status: 'warn' }] }
  }
}

async function isEnabled($: Engine) {
  return (await $.store.get(ENABLED)) !== false
}

async function clear($: Engine) {
  $.ui.status(undefined)
  try {
    await ($ as WithStarboard).starboard.remove(SECTION)
  } catch {
    // No starboard: the footer is already cleared.
  }
}

async function refresh($: Engine): Promise<Report | undefined> {
  if (!(await isEnabled($))) return void (await clear($))
  const report = await describeCi($)
  if (!report) return void (await clear($))
  try {
    // Without the starboard mod `$.starboard` is absent and the call throws: fall back to the footer.
    await ($ as WithStarboard).starboard.publish({ id: SECTION, title: 'CI', order: 20, summary: report.summary, rows: report.rows })
  } catch {
    $.ui.status(report.line)
  }
  return report
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'ci', description: 'CI Azure DevOps de la branche : /ci on, /ci off, /ci pour rafraîchir' })
    // Not awaited: the first API calls must not hold up the session start.
    refresh($).catch(() => {})
    $.clock.every(POLL_MS, () => refresh($).catch(() => {}))
    return next(e)
  })

  on('command.run', { command: 'ci' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    if (arg === 'off') {
      await $.store.set(ENABLED, false)
      await clear($)
      return { text: 'Suivi de la CI désactivé (/ci on pour le réactiver).' }
    }
    if (arg === 'on') await $.store.set(ENABLED, true)
    if (!(await isEnabled($))) return { text: 'Suivi de la CI désactivé : /ci on pour le réactiver.' }
    const report = await refresh($)
    return { text: report ? report.line : 'Pas de CI Azure DevOps pour ce dossier.' }
  })
}
