import type { EngineInterface as Engine, PluginOptions, Register } from 'claude-code'

// The starboard contract, kept local: the mod does not depend on `starboard`, it only uses it when present.
type StarboardRow = { label?: string; value: string; status?: 'ok' | 'warn' | 'error' | 'off'; dim?: boolean }
type StarboardSection = { id: string; title: string; order?: number; summary?: string; rows: StarboardRow[] }
type WithStarboard = Engine & { starboard: { publish: (section: StarboardSection) => Promise<void> } }

export type Stack = { name: string; bytes: number; containers: number }
export type Level = 'ok' | 'warn' | 'error'
type Report = { level: Level | 'off'; line: string; summary?: string; rows: StarboardRow[]; biggest?: string; percent?: number }

const SECTION = 'docker-stacks'
const POLL_MS = 30000
const ERROR_PERCENT = 95
const NO_PROJECT = '(hors compose)'

const UNITS: Record<string, number> = {
  b: 1, kb: 1e3, mb: 1e6, gb: 1e9, tb: 1e12, kib: 1024, mib: 1024 ** 2, gib: 1024 ** 3, tib: 1024 ** 4,
}

// "668.6MiB", "12.3kB", "0B": what `docker stats` prints in MemUsage.
export function parseSize(text: string): number {
  const [, amount, unit] = /^\s*([\d.]+)\s*([a-z]*)\s*$/i.exec(text) ?? []
  const factor = UNITS[(unit || 'b').toLowerCase()]
  return amount && factor ? Number(amount) * factor : 0
}

export const prefixesOf = (option: unknown): string[] =>
  String(option ?? '').split(',').map(prefix => prefix.trim()).filter(Boolean)

const decimal = (value: number) => value.toFixed(1).replace('.', ',')

export const formatSize = (bytes: number): string =>
  bytes >= 1024 ** 3 ? `${decimal(bytes / 1024 ** 3)} Go` : `${Math.round(bytes / 1024 ** 2)} Mo`

export function levelOf(percent: number, warnPercent: number): Level {
  if (percent >= ERROR_PERCENT) return 'error'
  return percent >= warnPercent ? 'warn' : 'ok'
}

export type Container = { project: string; name: string }

// One stack per Compose project, biggest first. A project is kept when its name or one of its containers'
// matches a prefix (a main stack's project is often just its folder); outside Compose only when nothing is filtered.
export function groupStacks(containers: Map<string, Container>, usage: Map<string, number>, prefixes: string[]): Stack[] {
  const matches = (text: string) => prefixes.some(prefix => text.startsWith(prefix))
  const byProject = new Map<string, string[]>()
  for (const [id, { project }] of containers) byProject.set(project, [...(byProject.get(project) ?? []), id])
  const stacks: Stack[] = []
  for (const [project, ids] of byProject) {
    const names = ids.map(id => containers.get(id)?.name ?? '')
    const via = project === '' || matches(project) ? undefined : names.find(matches)
    const kept = prefixes.length === 0 || (project !== '' && (matches(project) || via !== undefined))
    if (!kept) continue
    const name = project === '' ? NO_PROJECT : via ? `${project} (${via})` : project
    stacks.push({ name, bytes: ids.reduce((sum, id) => sum + (usage.get(id) ?? 0), 0), containers: ids.length })
  }
  return stacks.sort((a, b) => b.bytes - a.bytes)
}

const lines = (text: string) => text.split('\n').map(line => line.trim()).filter(Boolean)

async function docker($: Engine, args: string[]) {
  const { exitCode, stdout } = await $.process.run(['docker', ...args], { timeoutMs: 15000 })
  return exitCode === 0 ? stdout : undefined
}

export async function describeStacks($: Engine, options: PluginOptions): Promise<Report> {
  const unavailable: Report = { level: 'off', line: 'Docker indisponible', rows: [{ value: 'Docker indisponible', status: 'off', dim: true }] }
  const total = Number((await docker($, ['info', '--format', '{{.MemTotal}}']).catch(() => undefined))?.trim())
  if (!total) return unavailable
  const ps = await docker($, ['ps', '--format', '{{.ID}}\t{{.Label "com.docker.compose.project"}}\t{{.Names}}'])
  const stats = await docker($, ['stats', '--no-stream', '--format', '{{.ID}}\t{{.MemUsage}}'])
  if (ps === undefined || stats === undefined) return unavailable

  const containers = new Map(lines(ps).map(line => {
    const [id = '', project = '', name = ''] = line.split('\t')
    return [id.slice(0, 12), { project: project.trim(), name: name.trim() }] as const
  }))
  const usage = new Map(lines(stats).map(line => {
    const [id = '', mem = ''] = line.split('\t')
    return [id.slice(0, 12), parseSize(mem.split('/')[0] ?? '')] as const
  }))
  const used = [...usage.values()].reduce((sum, bytes) => sum + bytes, 0)
  const percent = Math.round((used / total) * 100)
  const warnPercent = Number(options.warnPercent) || 80
  const level = levelOf(percent, warnPercent)
  const stacks = groupStacks(containers, usage, prefixesOf(options.prefixes))
  const shown = stacks.reduce((sum, stack) => sum + stack.bytes, 0)

  const summary = `${formatSize(used).replace(' Go', '')}/${formatSize(total)} · ${percent} %`
  const rows: StarboardRow[] = [
    ...stacks.map((stack): StarboardRow => ({
      label: stack.name,
      value: `${formatSize(stack.bytes)} · ${stack.containers} conteneur${stack.containers > 1 ? 's' : ''}`,
    })),
    ...(stacks.length === 0 ? [{ value: 'aucune stack active', status: 'off' as const, dim: true }] : []),
    ...(used - shown >= 1024 ** 2 ? [{ label: 'autres', value: formatSize(used - shown), dim: true }] : []),
    { label: 'total', value: `${formatSize(used)} / ${formatSize(total)} · ${percent} %`, status: level },
  ]
  return { level, percent, biggest: stacks[0]?.name, summary, rows, line: `Docker ${level === 'ok' ? '' : '⚠ '}${summary}` }
}

let wasOver = false

async function refresh($: Engine, options: PluginOptions): Promise<Report> {
  const report = await describeStacks($, options)
  const isOver = report.level === 'warn' || report.level === 'error'
  if (isOver && !wasOver) {
    $.ui.toast(`Docker : ${report.percent} % de la mémoire utilisée${report.biggest ? ` — ${report.biggest}` : ''}`)
  }
  wasOver = isOver
  try {
    // Without the starboard mod `$.starboard` is absent and the call throws: fall back to the footer.
    await ($ as WithStarboard).starboard.publish({ id: SECTION, title: 'Docker', order: 40, summary: report.summary, rows: report.rows })
  } catch {
    // The footer only when memory runs short: a healthy Docker is not worth its room.
    $.ui.status(isOver ? report.line : undefined)
  }
  return report
}

export const register: Register = (on, options) => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'docker', description: 'Stacks Docker actives et mémoire utilisée' })
    // Not awaited: `docker stats` takes a couple of seconds.
    refresh($, options).catch(() => {})
    $.clock.every(POLL_MS, () => refresh($, options).catch(() => {}))
    return next(e)
  })

  on('command.run', { command: 'docker' }, async $ => {
    const report = await refresh($, options)
    const stacks = report.rows.filter(row => row.label && row.label !== 'total').map(row => `${row.label} : ${row.value}`)
    return { text: [report.line, ...stacks].join('\n') }
  })
}
