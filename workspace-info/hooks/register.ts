import type { EngineInterface as Engine, PluginOptions, Register } from 'claude-code'

// The starboard contract, kept local: the mod does not depend on `starboard`, it only uses it when present.
type StarboardRow = { label?: string; value: string; status?: 'ok' | 'warn' | 'error' | 'off'; dim?: boolean; href?: string }
type StarboardAction = { label: string; hint: string; command: string; args?: string }
type StarboardSection = { id: string; title: string; order?: number; summary?: string; rows: StarboardRow[]; actions?: StarboardAction[] }
type WithStarboard = Engine & { starboard: { publish: (section: StarboardSection) => Promise<void> } }

export type Jira = { url?: string; email?: string; token?: string }
type Issue = { summary: string; status: string; category?: string }
type Lookup = { at: number; issue?: Issue; error?: string }
export type Remote = { org: string; project: string; repo: string }
export type Reviewer = { vote: number; isRequired?: boolean; isContainer?: boolean }
export type PullRequest = { pullRequestId: number; status: string; isDraft?: boolean; reviewers?: Reviewer[] }
type PrLookup = { at: number; pr?: PullRequest; error?: string }

const SECTION = 'workspace-info'
const POLL_MS = 15000
const CACHE_MS = 5 * 60 * 1000
const FOCUS_MS = 30 * 60 * 1000
const TICKET = /\b([A-Z][A-Z0-9]+-\d+)\b/
const CATEGORY: Record<string, StarboardRow['status']> = { done: 'ok', indeterminate: 'warn', new: 'off' }
const PR_CACHE_MS = 60 * 1000
const API = 'api-version=7.1'

// git@ssh.dev.azure.com:v3/org/project/repo, vs-ssh.visualstudio.com:v3/…, https://dev.azure.com/org/project/_git/repo,
// https://org.visualstudio.com/project/_git/repo
const REMOTES = [
  /(?:ssh\.dev\.azure\.com|vs-ssh\.visualstudio\.com):v3\/([^/]+)\/([^/]+)\/([^/]+?)(?:\.git)?$/,
  /dev\.azure\.com\/([^/]+)\/([^/]+)\/_git\/([^/]+?)(?:\.git)?$/,
  /\/\/(?:[^@/]+@)?([^./]+)\.visualstudio\.com\/(?:DefaultCollection\/)?([^/]+)\/_git\/([^/]+?)(?:\.git)?$/,
]

export const ticketOf = (branch: string): string | undefined => TICKET.exec(branch.toUpperCase())?.[1]

const text = (value: PluginOptions[string] | undefined) => (typeof value === 'string' && value.trim() ? value.trim() : undefined)

export const jiraOf = (options: PluginOptions | undefined): Jira => ({
  url: text(options?.jiraUrl)?.replace(/\/+$/, ''),
  email: text(options?.jiraEmail),
  token: text(options?.jiraToken),
})

async function git($: Engine, args: string[]) {
  const { exitCode, stdout } = await $.process.run(['git', ...args], { timeoutMs: 5000 })
  return exitCode === 0 ? stdout.trim() : undefined
}

const lookups = new Map<string, Lookup>()

// The token never leaves this function except inside the Authorization header.
async function fetchIssue($: Engine, jira: Required<Jira>, key: string): Promise<Lookup> {
  const now = await $.clock.now()
  const cacheKey = `${jira.url}/${key}`
  const known = lookups.get(cacheKey)
  if (known && now - known.at < CACHE_MS) return known
  let lookup: Lookup
  try {
    const { ok, status, text: body } = await $.http.fetch(`${jira.url}/rest/api/3/issue/${key}?fields=summary,status`, {
      headers: { Authorization: `Basic ${btoa(`${jira.email}:${jira.token}`)}`, Accept: 'application/json' },
    })
    if (!ok) {
      lookup = { at: now, error: status === 401 || status === 403 ? 'token Jira refusé' : status === 404 ? 'ticket introuvable' : `Jira HTTP ${status}` }
    } else {
      const { fields } = JSON.parse(body) as { fields: { summary: string; status: { name: string; statusCategory?: { key?: string } } } }
      lookup = { at: now, issue: { summary: fields.summary, status: fields.status.name, category: fields.status.statusCategory?.key } }
    }
  } catch {
    lookup = { at: now, error: 'Jira injoignable' }
  }
  lookups.set(cacheKey, lookup)
  return lookup
}

export async function ticketRows($: Engine, jira: Jira, ticket: string | undefined): Promise<StarboardRow[]> {
  if (!ticket) return [{ label: 'jira', value: '—', dim: true }]
  const href = jira.url ? `${jira.url}/browse/${ticket}` : undefined
  if (!jira.url || !jira.email || !jira.token) return [{ label: 'jira', value: ticket, href }]
  const { issue, error } = await fetchIssue($, { url: jira.url, email: jira.email, token: jira.token }, ticket)
  if (!issue) return [{ label: 'jira', value: ticket, href }, { value: error ?? 'Jira injoignable', status: 'warn', dim: true }]
  return [
    { label: 'jira', value: `${ticket} · ${issue.status}`, href, status: CATEGORY[issue.category ?? ''] },
    { label: 'titre', value: issue.summary, dim: true },
  ]
}

export function parseRemote(url: string): Remote | undefined {
  for (const pattern of REMOTES) {
    const [, org, project, repo] = pattern.exec(url) ?? []
    if (org && project && repo) return { org, project: decodeURIComponent(project), repo: decodeURIComponent(repo) }
  }
  return undefined
}

export const tokenFromEnvFile = (text: string): string | undefined =>
  /^\s*(?:export\s+)?AZURE_ACCESS_TOKEN\s*=\s*["']?([^"'\s#]+)/m.exec(text)?.[1]

// The PAT never leaves this function except inside the Authorization header.
async function findToken($: Engine, top: string): Promise<string | undefined> {
  const fromEnv = await $.env.get('AZURE_ACCESS_TOKEN')
  if (fromEnv) return fromEnv
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

const pullRequests = new Map<string, PrLookup>()

// The open PR of the branch, else its latest one (completed or abandoned).
async function fetchPullRequest($: Engine, remote: Remote, branch: string, token: string): Promise<PrLookup> {
  const now = await $.clock.now()
  const cacheKey = `${remote.org}/${remote.project}/${remote.repo}/${branch}`
  const known = pullRequests.get(cacheKey)
  if (known && now - known.at < PR_CACHE_MS) return known
  let lookup: PrLookup
  try {
    const ref = encodeURIComponent(`refs/heads/${branch}`)
    const url = `https://dev.azure.com/${remote.org}/${encodeURIComponent(remote.project)}/_apis/git/repositories/${encodeURIComponent(remote.repo)}`
      + `/pullRequests?searchCriteria.sourceRefName=${ref}&searchCriteria.status=all&${API}`
    const { ok, status, text: body } = await $.http.fetch(url, { headers: { Authorization: `Basic ${btoa(`:${token}`)}`, Accept: 'application/json' } })
    // A wrong PAT answers 203 with the sign-in page instead of a 401.
    if (!ok || status === 203) {
      lookup = { at: now, error: status === 401 || status === 203 ? 'PAT Azure DevOps refusé' : `Azure DevOps HTTP ${status}` }
    } else {
      const all = (JSON.parse(body) as { value: PullRequest[] }).value.sort((a, b) => b.pullRequestId - a.pullRequestId)
      lookup = { at: now, pr: all.find(pr => pr.status === 'active') ?? all[0] }
    }
  } catch {
    lookup = { at: now, error: 'Azure DevOps injoignable' }
  }
  pullRequests.set(cacheKey, lookup)
  return lookup
}

export function stateOf(pr: PullRequest): { icon: string; label: string; status: StarboardRow['status'] } {
  if (pr.status === 'completed') return { icon: '✅', label: 'Completed', status: 'ok' }
  if (pr.status === 'abandoned') return { icon: '✖', label: 'Abandoned', status: 'off' }
  if (pr.isDraft) return { icon: '📝', label: 'Draft', status: 'off' }
  return { icon: '⏳', label: 'Active', status: 'warn' }
}

// Azure DevOps votes: 10 approved, 5 approved with suggestions, 0 none, -5 waiting for author, -10 rejected.
// A team reviewer (isContainer) carries its members' vote, so only people are counted.
export function reviewOf(reviewers: Reviewer[] = []): StarboardRow {
  const people = reviewers.filter(r => !r.isContainer)
  const approvals = people.filter(r => r.vote >= 5).length
  const count = people.length ? ` · ${approvals}/${people.length}` : ''
  if (reviewers.some(r => r.vote === -10)) return { label: 'revue', value: `✖ rejetée${count}`, status: 'error' }
  if (reviewers.some(r => r.vote === -5)) return { label: 'revue', value: `↺ attend l'auteur${count}`, status: 'warn' }
  const approved = reviewers.some(r => r.vote >= 5) && reviewers.filter(r => r.isRequired).every(r => r.vote >= 5)
  return approved ? { label: 'revue', value: `✔ approuvée${count}`, status: 'ok' } : { label: 'revue', value: `○ pas encore approuvée${count}`, status: 'off' }
}

export async function pullRequestRows($: Engine, top: string, branch: string): Promise<StarboardRow[]> {
  const remote = parseRemote((await git($, ['remote', 'get-url', 'origin'])) ?? '')
  // Not an Azure DevOps repository: no PR row.
  if (!remote) return []
  const token = await findToken($, top)
  if (!token) return [{ label: 'pr', value: 'AZURE_ACCESS_TOKEN introuvable (env ou docker/.env)', status: 'off', dim: true }]
  const { pr, error } = await fetchPullRequest($, remote, branch, token)
  if (error) return [{ label: 'pr', value: error, status: 'warn', dim: true }]
  if (!pr) return [{ label: 'pr', value: 'aucune', dim: true }]
  const { icon, label, status } = stateOf(pr)
  const href = `https://dev.azure.com/${remote.org}/${encodeURIComponent(remote.project)}/_git/${encodeURIComponent(remote.repo)}/pullrequest/${pr.pullRequestId}`
  const row: StarboardRow = { label: 'pr', value: `${icon} #${pr.pullRequestId} · ${label}`, status, href }
  return pr.status === 'active' ? [row, reviewOf(pr.reviewers)] : [row]
}

export type Focus = { top: string; branch?: string; at: number }

// Where a tool call works: the files it writes, the folders a command enters or points git at.
// Reads are left out: looking at another repository for reference is not working there.
export function pathsOf(call: { tool: string; [key: string]: unknown }, home = ''): string[] {
  const field = (key: string) => (typeof call[key] === 'string' ? [call[key] as string] : [])
  const raw = call.tool === 'Edit' || call.tool === 'Write' ? field('file_path')
    : call.tool === 'NotebookEdit' ? field('notebook_path')
    : call.tool === 'Bash' && typeof call.command === 'string'
      ? [...call.command.matchAll(/(?:^|&&|;|\|\|)\s*cd\s+(["']?)([^\s"';&|]+)\1|\bgit\s+-C\s+(["']?)([^\s"';&|]+)\3/g)].map(m => m[2] ?? m[4] ?? '')
      : []
  return raw.filter(Boolean).map(path => (path.startsWith('~/') && home ? `${home}${path.slice(1)}` : path))
    .filter(path => path.startsWith('/') && !/^\/(private\/)?tmp\//.test(path) && !(home && path.startsWith(`${home}/.claude/`)))
}

const tops = new Map<string, string | undefined>()

async function topOf($: Engine, path: string): Promise<string | undefined> {
  // A file being written may not exist yet: its nearest existing folder answers for it.
  let dir = path
  while (dir.length > 1 && !(await $.fs.exists(dir).catch(() => false))) dir = dir.slice(0, dir.lastIndexOf('/')) || '/'
  if (!tops.has(dir)) {
    const top = await git($, ['-C', dir, 'rev-parse', '--show-toplevel'])
      ?? await git($, ['-C', dir.slice(0, dir.lastIndexOf('/')) || '/', 'rev-parse', '--show-toplevel'])
    tops.set(dir, top)
  }
  return tops.get(dir)
}

let focus: Focus | undefined

// The last worktree the session wrote in; cleared once the session works in its own folder again.
async function noteWork($: Engine, call: { tool: string; [key: string]: unknown }) {
  const paths = pathsOf(call, (await $.env.get('HOME')) ?? '')
  if (paths.length === 0) return false
  const sessionTop = await git($, ['rev-parse', '--show-toplevel'])
  const top = await topOf($, paths[paths.length - 1] ?? '')
  if (!top) return false
  const before = focus?.top
  focus = top === sessionTop ? undefined : { top, branch: await git($, ['-C', top, 'branch', '--show-current']), at: await $.clock.now() }
  return focus?.top !== before
}

export function focusRows(current: Focus | undefined, sessionTop: string | undefined, now: number): StarboardRow[] {
  if (!current || current.top === sessionTop || now - current.at > FOCUS_MS) return []
  const name = current.top.split('/').pop()
  return [
    { label: 'travail', value: `⚠ ${name}${current.branch ? ` · ${current.branch}` : ''}`, status: 'warn' },
    { value: `la session regarde ${sessionTop?.split('/').pop() ?? 'un autre dossier'} : /cd ${current.top}`, dim: true },
  ]
}

// The first block of the id is enough to tell sessions apart and to find the transcript (`<id>.jsonl`).
export const shortId = (id: string): string => id.split('-')[0] ?? id

async function sessionRows($: Engine): Promise<StarboardRow[]> {
  const id = await $.session.id().catch(() => undefined)
  return id ? [{ label: 'session', value: shortId(id), dim: true }] : []
}

export async function describeWorkspace($: Engine, jira: Jira = {}): Promise<StarboardRow[]> {
  const top = await git($, ['rev-parse', '--show-toplevel'])
  if (!top) return [{ value: 'pas un dépôt git', status: 'off', dim: true }]

  const current = await git($, ['branch', '--show-current'])
  const branch = current || '(HEAD détachée)'
  const common = await git($, ['rev-parse', '--path-format=absolute', '--git-common-dir'])
  const isLinked = common !== undefined && !common.startsWith(`${top}/`)
  const dirty = await git($, ['status', '--porcelain'])

  return [
    ...focusRows(focus, top, await $.clock.now()),
    { label: 'branche', value: branch, status: dirty ? 'warn' : 'ok' },
    { label: 'worktree', value: `${top.split('/').pop()}${isLinked ? ' (lié)' : ''}` },
    ...(await sessionRows($)),
    ...(await ticketRows($, jira, ticketOf(branch))),
    ...(current ? await pullRequestRows($, top, current) : []),
  ]
}

export const footerOf = (rows: StarboardRow[]): string =>
  rows.filter(row => !row.dim).map(row => row.value).join(' · ') || rows[0]?.value || ''

async function refresh($: Engine, jira: Jira) {
  const rows = await describeWorkspace($, jira)
  const ticket = rows.find(row => row.label === 'jira' && !row.dim)
  const away = rows.some(row => row.label === 'travail') && focus
  // `/cd` is the engine's own command where this build has it: the button moves the session, and every mod with it.
  const canCd = away ? (await $.command.list().catch(() => [])).some(command => command.name === 'cd') : false
  const actions: StarboardAction[] = away && canCd ? [{ label: '↪', hint: `Passer la session dans ${focus?.top}`, command: 'cd', args: focus?.top }] : []
  try {
    // Without the starboard mod `$.starboard` is absent and the call throws: fall back to the footer.
    await ($ as WithStarboard).starboard.publish({ id: SECTION, title: 'Contexte', order: 10, summary: away ? '⚠ ailleurs' : ticket?.value.split(' · ')[0], rows, actions })
  } catch {
    $.ui.status(footerOf(rows))
  }
}

export const register: Register = (on, options) => {
  const jira = jiraOf(options)
  on('session.start', async ($, e, next) => {
    await refresh($, jira)
    $.clock.every(POLL_MS, () => refresh($, jira))
    return next(e)
  })

  // Watches only: the call always goes through, and a failure here never touches it.
  on('tool.call', async ($, e, next) => {
    noteWork($, e as unknown as { tool: string; [key: string]: unknown })
      .then(changed => (changed ? refresh($, jira) : undefined))
      .catch(() => {})
    return next(e)
  })
}
