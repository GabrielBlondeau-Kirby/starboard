import type { EngineInterface as Engine, Register } from 'claude-code'

// The sidebar's contract, kept local: the mod does not depend on `sidebar`, it only uses it when present.
type SidebarRow = { label?: string; value: string; status?: 'ok' | 'warn' | 'error' | 'off'; dim?: boolean }
type SidebarSection = { id: string; title: string; order?: number; rows: SidebarRow[] }
type WithSidebar = Engine & { sidebar: { publish: (section: SidebarSection) => Promise<void> } }

const SECTION = 'workspace-info'
const POLL_MS = 15000
const TICKET = /\b([A-Z][A-Z0-9]+-\d+)\b/

export const ticketOf = (branch: string): string | undefined => TICKET.exec(branch.toUpperCase())?.[1]

async function git($: Engine, args: string[]) {
  const { exitCode, stdout } = await $.process.run(['git', ...args], { timeoutMs: 5000 })
  return exitCode === 0 ? stdout.trim() : undefined
}

export async function describeWorkspace($: Engine): Promise<SidebarRow[]> {
  const top = await git($, ['rev-parse', '--show-toplevel'])
  if (!top) return [{ value: 'pas un dépôt git', status: 'off', dim: true }]

  const branch = (await git($, ['branch', '--show-current'])) || '(HEAD détachée)'
  const common = await git($, ['rev-parse', '--path-format=absolute', '--git-common-dir'])
  const isLinked = common !== undefined && !common.startsWith(`${top}/`)
  const dirty = await git($, ['status', '--porcelain'])
  const ticket = ticketOf(branch)

  return [
    { label: 'branche', value: branch, status: dirty ? 'warn' : 'ok' },
    { label: 'worktree', value: `${top.split('/').pop()}${isLinked ? ' (lié)' : ''}` },
    { label: 'jira', value: ticket ?? '—', dim: ticket === undefined },
  ]
}

export const footerOf = (rows: SidebarRow[]): string =>
  rows.filter(row => !row.dim).map(row => row.value).join(' · ') || rows[0]?.value || ''

async function refresh($: Engine) {
  const rows = await describeWorkspace($)
  try {
    // Without the sidebar mod `$.sidebar` is absent and the call throws: fall back to the footer.
    await ($ as WithSidebar).sidebar.publish({ id: SECTION, title: 'Contexte', order: 10, rows })
  } catch {
    $.ui.status(footerOf(rows))
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await refresh($)
    $.clock.every(POLL_MS, () => refresh($))
    return next(e)
  })
}
