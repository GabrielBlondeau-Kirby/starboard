import type { EngineInterface as Engine, PluginOptions, Register } from 'claude-code'

// The starboard contract, kept local: the mod does not depend on `starboard`, it only uses it when present.
type StarboardRow = { label?: string; value: string; status?: 'ok' | 'warn' | 'error' | 'off'; dim?: boolean; href?: string }
type StarboardSection = { id: string; title: string; order?: number; summary?: string; rows: StarboardRow[] }
type WithStarboard = Engine & { starboard: { publish: (section: StarboardSection) => Promise<void> } }

export type Jira = { url?: string; email?: string; token?: string }
type Issue = { summary: string; status: string; category?: string }
type Lookup = { at: number; issue?: Issue; error?: string }

const SECTION = 'workspace-info'
const POLL_MS = 15000
const CACHE_MS = 5 * 60 * 1000
const TICKET = /\b([A-Z][A-Z0-9]+-\d+)\b/
const CATEGORY: Record<string, StarboardRow['status']> = { done: 'ok', indeterminate: 'warn', new: 'off' }

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

export async function describeWorkspace($: Engine, jira: Jira = {}): Promise<StarboardRow[]> {
  const top = await git($, ['rev-parse', '--show-toplevel'])
  if (!top) return [{ value: 'pas un dépôt git', status: 'off', dim: true }]

  const branch = (await git($, ['branch', '--show-current'])) || '(HEAD détachée)'
  const common = await git($, ['rev-parse', '--path-format=absolute', '--git-common-dir'])
  const isLinked = common !== undefined && !common.startsWith(`${top}/`)
  const dirty = await git($, ['status', '--porcelain'])

  return [
    { label: 'branche', value: branch, status: dirty ? 'warn' : 'ok' },
    { label: 'worktree', value: `${top.split('/').pop()}${isLinked ? ' (lié)' : ''}` },
    ...(await ticketRows($, jira, ticketOf(branch))),
  ]
}

export const footerOf = (rows: StarboardRow[]): string =>
  rows.filter(row => !row.dim).map(row => row.value).join(' · ') || rows[0]?.value || ''

async function refresh($: Engine, jira: Jira) {
  const rows = await describeWorkspace($, jira)
  const ticket = rows.find(row => row.label === 'jira' && !row.dim)
  try {
    // Without the starboard mod `$.starboard` is absent and the call throws: fall back to the footer.
    await ($ as WithStarboard).starboard.publish({ id: SECTION, title: 'Contexte', order: 10, summary: ticket?.value.split(' · ')[0], rows })
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
}
