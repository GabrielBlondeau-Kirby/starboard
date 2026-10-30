import type { EngineInterface as Engine, Register } from 'claude-code'

// The starboard contract, kept local: the mod does not depend on `starboard`, it only uses it when present.
type StarboardRow = { label?: string; value: string; status?: 'ok' | 'warn' | 'error' | 'off'; dim?: boolean; href?: string }
type StarboardAction = { label: string; hint: string; command: string; args?: string }
type StarboardSection = { id: string; title: string; order?: number; summary?: string; rows: StarboardRow[]; actions?: StarboardAction[] }
type WithStarboard = Engine & {
  starboard: { publish: (section: StarboardSection) => Promise<void>; remove: (id: string) => Promise<void> }
}

export type Where = { org: string; project: string }
export type Followed = Where & { id: number }
export type Reviewer = { id?: string; vote: number; isRequired?: boolean; isContainer?: boolean }
export type PullRequest = {
  pullRequestId: number
  title: string
  status: string
  isDraft?: boolean
  mergeStatus?: string
  autoCompleteSetBy?: { id: string }
  createdBy?: { id: string }
  reviewers?: Reviewer[]
  repository: { name: string; project: { name: string } }
}
type Build = { status: string; result?: string; sourceVersion: string; definition: { name: string } }
export type Ci = 'running' | 'failed' | 'ok' | 'none'
export type Role = 'mine' | 'follow'
export type Entry = { pr: PullRequest; where: Where; role: Role; ci: Ci }

const SECTION = 'pr-radar'
const POLL_MS = 60000
const FOLLOWED = 'followed'
const WHERE = 'where'
const TITLE_MAX = 15
const REPO_MAX = 12
const API = 'api-version=7.1'

const REMOTES = [
  /(?:ssh\.dev\.azure\.com|vs-ssh\.visualstudio\.com):v3\/([^/]+)\/([^/]+)\/([^/]+?)(?:\.git)?$/,
  /dev\.azure\.com\/([^/]+)\/([^/]+)\/_git\/([^/]+?)(?:\.git)?$/,
  /\/\/(?:[^@/]+@)?([^./]+)\.visualstudio\.com\/(?:DefaultCollection\/)?([^/]+)\/_git\/([^/]+?)(?:\.git)?$/,
]
// https://dev.azure.com/org/project/_git/repo/pullrequest/123, https://org.visualstudio.com/project/_git/repo/pullrequest/123
const PR_URLS = [
  /dev\.azure\.com\/([^/]+)\/([^/]+)\/_git\/[^/]+\/pullrequest\/(\d+)/,
  /\/\/(?:[^@/]+@)?([^./]+)\.visualstudio\.com\/(?:DefaultCollection\/)?([^/]+)\/_git\/[^/]+\/pullrequest\/(\d+)/,
]

export function parseRemote(url: string): Where | undefined {
  for (const pattern of REMOTES) {
    const [, org, project] = pattern.exec(url) ?? []
    if (org && project) return { org, project: decodeURIComponent(project) }
  }
  return undefined
}

export function parsePrUrl(url: string): Followed | undefined {
  for (const pattern of PR_URLS) {
    const [, org, project, id] = pattern.exec(url) ?? []
    if (org && project && id) return { org, project: decodeURIComponent(project), id: Number(id) }
  }
  return undefined
}

export const tokenFromEnvFile = (text: string): string | undefined =>
  /^\s*(?:export\s+)?AZURE_ACCESS_TOKEN\s*=\s*["']?([^"'\s#]+)/m.exec(text)?.[1]

async function git($: Engine, args: string[]) {
  const { exitCode, stdout } = await $.process.run(['git', ...args], { timeoutMs: 5000 })
  return exitCode === 0 ? stdout.trim() : undefined
}

// The PAT never leaves this function except inside the Authorization header.
async function findToken($: Engine, top: string | undefined): Promise<string | undefined> {
  const fromEnv = await $.env.get('AZURE_ACCESS_TOKEN')
  if (fromEnv || !top) return fromEnv
  const common = await git($, ['rev-parse', '--path-format=absolute', '--git-common-dir'])
  for (const root of [top, common?.replace(/\/\.git\/?$/, '')]) {
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

async function api<T>($: Engine, auth: string, url: string): Promise<T> {
  const init = { headers: { Authorization: auth, Accept: 'application/json' } }
  // Azure DevOps sometimes drops the TLS connection: one retry.
  const { ok, status, text } = await $.http.fetch(url, init).catch(() => $.http.fetch(url, init))
  // A wrong PAT answers 203 with the sign-in page instead of a 401.
  if (!ok || status === 203) throw new HttpError(status)
  return JSON.parse(text) as T
}

const projectApi = (where: Where, path: string) =>
  `https://dev.azure.com/${where.org}/${encodeURIComponent(where.project)}/_apis/${path}${path.includes('?') ? '&' : '?'}${API}`

export const prUrl = (where: Where, pr: PullRequest) =>
  `https://dev.azure.com/${where.org}/${encodeURIComponent(where.project)}/_git/${encodeURIComponent(pr.repository.name)}/pullrequest/${pr.pullRequestId}`

const users = new Map<string, string>()

async function me($: Engine, auth: string, org: string): Promise<string> {
  const known = users.get(org)
  if (known) return known
  const { authenticatedUser } = await api<{ authenticatedUser: { id: string } }>($, auth, `https://dev.azure.com/${org}/_apis/connectionData`)
  users.set(org, authenticatedUser.id)
  return authenticatedUser.id
}

export function verdict(builds: Build[]): Ci {
  if (builds.length === 0) return 'none'
  if (builds.some(b => b.status !== 'completed')) return 'running'
  if (builds.some(b => b.result === 'failed' || b.result === 'canceled')) return 'failed'
  return 'ok'
}

// The builds of the PR's merge ref for its latest commit, one per pipeline.
async function ciOf($: Engine, auth: string, where: Where, pr: PullRequest): Promise<Ci> {
  if (pr.status !== 'active') return 'none'
  const ref = encodeURIComponent(`refs/pull/${pr.pullRequestId}/merge`)
  const { value } = await api<{ value: Build[] }>($, auth, projectApi(where, `build/builds?branchName=${ref}&$top=10&queryOrder=queueTimeDescending`))
  const head = value[0]?.sourceVersion
  const builds = value.filter(b => b.sourceVersion === head)
    .filter((b, i, all) => all.findIndex(o => o.definition.name === b.definition.name) === i)
  return verdict(builds)
}

export const truncate = (title: string, max = TITLE_MAX): string => {
  const chars = [...title.trim()]
  return chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : chars.join('')
}

const ROLE: Record<Role, string> = { mine: '✍️', follow: '📌' }
const CI: Record<Ci, string> = { ok: '✅', failed: '❌', running: '⏳', none: '⚪' }

export function stateOf(pr: PullRequest): string {
  if (pr.status === 'completed') return '🟣'
  if (pr.status === 'abandoned') return '⚫'
  if (pr.isDraft) return '📝'
  return pr.mergeStatus === 'conflicts' ? '⚔️' : '🔵'
}

// Azure DevOps votes: 10 approved, 5 approved with suggestions, -5 waiting for author, -10 rejected.
// A team reviewer (isContainer) carries its members' vote, so only people are counted.
export function votesOf(reviewers: Reviewer[] = []): string {
  if (reviewers.some(r => r.vote === -10)) return '👎'
  if (reviewers.some(r => r.vote === -5)) return '↩️'
  return `👍${reviewers.filter(r => !r.isContainer && r.vote >= 5).length}`
}

// The repository column is as wide as the longest name in the list, within REPO_MAX.
export const repoWidth = (entries: Entry[]): number =>
  Math.min(REPO_MAX, Math.max(0, ...entries.map(e => [...e.pr.repository.name].length)))

export function rowOf({ pr, where, role, ci }: Entry, width = REPO_MAX): StarboardRow {
  const active = pr.status === 'active'
  const blocked = ci === 'failed' || pr.mergeStatus === 'conflicts' || (pr.reviewers ?? []).some(r => r.vote <= -5)
  const approved = (pr.reviewers ?? []).some(r => r.vote >= 5) && (pr.reviewers ?? []).filter(r => r.isRequired).every(r => r.vote >= 5)
  const status: StarboardRow['status'] = !active || pr.isDraft ? 'off' : blocked ? 'error' : approved && ci === 'ok' ? 'ok' : 'warn'
  // Fixed slots, so the columns line up from one PR to the next; no auto-complete leaves two spaces.
  const icons = [ROLE[role], stateOf(pr), votesOf(pr.reviewers), active ? CI[ci] : '  ', pr.autoCompleteSetBy ? '🚀' : '  ']
  // Starboard draws the value flush right: the title is padded so the icon slots stay in one column.
  const repo = truncate(pr.repository.name, width).padEnd(width)
  return { label: `#${pr.pullRequestId} ${repo}`, value: `${icons.join(' ')} ${truncate(pr.title).padEnd(TITLE_MAX)}`, status, dim: !active, href: prUrl(where, pr) }
}

export function summaryOf(entries: Entry[]): string {
  const mine = entries.filter(e => e.role === 'mine').length
  const failed = entries.filter(e => e.ci === 'failed').length
  return [mine && `✍️${mine}`, failed && `❌${failed}`]
    .filter(Boolean).join(' ') || '—'
}

const sameWhere = (a: Where, b: Where) => a.org === b.org && a.project === b.project

async function followed($: Engine): Promise<Followed[]> {
  return ((await $.store.get(FOLLOWED)) as Followed[] | undefined) ?? []
}

type Context = { where?: Where; auth?: string }

async function contextOf($: Engine): Promise<Context> {
  const top = await git($, ['rev-parse', '--show-toplevel'])
  const remote = top ? parseRemote((await git($, ['remote', 'get-url', 'origin'])) ?? '') : undefined
  // Outside an Azure DevOps repository, the last one seen still answers.
  if (remote) await $.store.set(WHERE, remote)
  const where = remote ?? ((await $.store.get(WHERE)) as Where | undefined)
  const token = await findToken($, top)
  return { where, auth: token ? `Basic ${btoa(`:${token}`)}` : undefined }
}

export async function collect($: Engine, { where, auth }: Context): Promise<Entry[]> {
  if (!auth) return []
  const byKey = new Map<string, { pr: PullRequest; where: Where; role: Role }>()
  const add = (pr: PullRequest, at: Where, role: Role) => {
    const key = `${at.org}/${pr.pullRequestId}`
    if (!byKey.has(key)) byKey.set(key, { pr, where: at, role })
  }
  if (where) {
    const id = await me($, auth, where.org)
    const mine = await api<{ value: PullRequest[] }>($, auth, projectApi(where, `git/pullrequests?searchCriteria.creatorId=${id}&searchCriteria.status=active`))
    mine.value.forEach(pr => add(pr, where, 'mine'))
  }
  const follows = await followed($)
  const extra = await Promise.all(follows.map(f => api<PullRequest>($, auth, projectApi(f, `git/pullrequests/${f.id}`)).then(pr => ({ pr, f })).catch(() => undefined)))
  for (const one of extra) if (one) add(one.pr, one.f, 'follow')

  const order: Role[] = ['mine', 'follow']
  const entries = [...byKey.values()].sort((a, b) => order.indexOf(a.role) - order.indexOf(b.role) || b.pr.pullRequestId - a.pr.pullRequestId)
  return Promise.all(entries.map(async e => ({ ...e, ci: await ciOf($, auth, e.where, e.pr).catch((): Ci => 'none') })))
}

type Report = { line: string; summary: string; rows: StarboardRow[]; actions: StarboardAction[] }

export async function describe($: Engine): Promise<Report | undefined> {
  const context = await contextOf($)
  if (!context.where && (await followed($)).length === 0) return undefined
  if (!context.auth) {
    return { line: 'PR ○ pas de PAT', summary: '○', actions: [], rows: [{ value: 'AZURE_ACCESS_TOKEN introuvable (env ou docker/.env)', status: 'off', dim: true }] }
  }
  try {
    const entries = await collect($, context)
    const summary = summaryOf(entries)
    const finished = entries.some(e => e.role === 'follow' && e.pr.status !== 'active')
    return {
      line: `PR ${summary}`,
      summary,
      rows: entries.length ? entries.map(entry => rowOf(entry, repoWidth(entries))) : [{ value: 'aucune PR', dim: true }],
      actions: finished ? [{ label: '🧹', hint: 'Ne plus suivre les PR terminées ou abandonnées', command: 'prs', args: 'clean' }] : [],
    }
  } catch (error) {
    const status = error instanceof HttpError ? error.status : undefined
    const why = status === 401 || status === 203 ? 'PAT refusé' : status ? `HTTP ${status}` : 'Azure DevOps injoignable'
    return { line: `PR ⚠ ${why}`, summary: '⚠', actions: [], rows: [{ value: why, status: 'warn' }] }
  }
}

async function refresh($: Engine): Promise<Report | undefined> {
  const report = await describe($)
  try {
    if (!report) return void (await ($ as WithStarboard).starboard.remove(SECTION))
    // Without the starboard mod `$.starboard` is absent and the call throws: fall back to the footer.
    const { summary, rows, actions } = report
    await ($ as WithStarboard).starboard.publish({ id: SECTION, title: 'PR', order: 25, summary, rows, actions })
  } catch {
    $.ui.status(report?.line)
  }
  return report
}

// `#123` or `123`: a PR of the current project; a PR URL; anything else is a source branch.
async function resolve($: Engine, arg: string): Promise<Followed | string> {
  const fromUrl = parsePrUrl(arg)
  if (fromUrl) return fromUrl
  const { where, auth } = await contextOf($)
  if (!where) return 'Pas de projet Azure DevOps connu : donner l\'URL de la PR.'
  const id = /^#?(\d+)$/.exec(arg)?.[1]
  if (id) return { ...where, id: Number(id) }
  if (!auth) return 'AZURE_ACCESS_TOKEN introuvable (env ou docker/.env).'
  const ref = encodeURIComponent(`refs/heads/${arg.replace(/^refs\/heads\//, '')}`)
  const { value } = await api<{ value: PullRequest[] }>($, auth, projectApi(where, `git/pullrequests?searchCriteria.sourceRefName=${ref}&searchCriteria.status=all`))
  const pr = value.find(p => p.status === 'active') ?? value.sort((a, b) => b.pullRequestId - a.pullRequestId)[0]
  return pr ? { ...where, id: pr.pullRequestId } : `Aucune PR pour la branche ${arg} dans ${where.project}.`
}

const USAGE = '/prs : rafraîchir · /prs add <url|branche|#id> : suivre une PR · /prs rm <id> : ne plus la suivre · /prs clean : retirer les PR terminées'

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'prs', description: 'Mes PR Azure DevOps et celles que je suis : /prs add <url|branche>, /prs rm <id>, /prs clean' })
    // Not awaited: the first API calls must not hold up the session start.
    refresh($).catch(() => {})
    $.clock.every(POLL_MS, () => refresh($).catch(() => {}))
    return next(e)
  })

  on('command.run', { command: 'prs' }, async ($, e) => {
    const [verb = '', ...rest] = e.args.trim().split(/\s+/)
    const arg = rest.join(' ')
    const list = await followed($)
    if (verb === 'add') {
      if (!arg) return { text: USAGE }
      const target = await resolve($, arg).catch(() => 'Azure DevOps injoignable.')
      if (typeof target === 'string') return { text: target }
      if (!list.some(f => f.id === target.id && sameWhere(f, target))) await $.store.set(FOLLOWED, [...list, target])
      await refresh($)
      return { text: `PR #${target.id} suivie.` }
    }
    if (verb === 'rm') {
      const id = Number(arg.replace(/^#/, ''))
      const kept = list.filter(f => f.id !== id)
      if (kept.length === list.length) return { text: `La PR #${arg} n'est pas suivie.` }
      await $.store.set(FOLLOWED, kept)
      await refresh($)
      return { text: `PR #${id} retirée du suivi.` }
    }
    if (verb === 'clean') {
      const { auth } = await contextOf($)
      if (!auth) return { text: 'AZURE_ACCESS_TOKEN introuvable (env ou docker/.env).' }
      const states = await Promise.all(list.map(f => api<PullRequest>($, auth, projectApi(f, `git/pullrequests/${f.id}`)).then(pr => pr.status).catch(() => 'active')))
      const kept = list.filter((_, i) => states[i] === 'active')
      await $.store.set(FOLLOWED, kept)
      await refresh($)
      return { text: `${list.length - kept.length} PR retirée(s) du suivi.` }
    }
    if (verb) return { text: USAGE }
    const report = await refresh($)
    return { text: report ? [report.line, ...report.rows.map(r => `${r.label ?? ''} ${r.value}`.trim())].join('\n') : 'Pas de projet Azure DevOps ni de PR suivie.' }
  })
}
