import { atom, read, update } from 'claude-code'
import type { EngineInterface as Engine, Register } from 'claude-code'

import type { Task } from '../types'

// The starboard contract, kept local: the mod does not depend on `starboard`, it only uses it when present.
type StarboardRow = { label?: string; value: string; status?: 'ok' | 'warn' | 'error' | 'off'; dim?: boolean }
type StarboardSection = { id: string; title: string; order?: number; summary?: string; rows: StarboardRow[]; note?: string }
type WithStarboard = Engine & { starboard: { publish: (section: StarboardSection) => Promise<void> } }

const SECTION = 'tasks'
const CONFIG = '.claude/todo.json'
const POLL_MS = 10000
const MAX_ROWS = 8
const MAX_CONTEXT = 25
// Looked for, case-insensitively, in a folder and its docs/ when no source is configured.
const CANDIDATES = ['todo.md', 'tasks.md', 'a-faire.md', 'a_faire.md', 'backlog.md']
const DIRS = ['', 'docs']
const SKIPPED = new Set(['node_modules', 'dist', 'build', 'out'])

const list = atom({ plugin: 'tasks', key: 'list' } as const, [])
const sources = atom({ plugin: 'tasks', key: 'sources' } as const, [])

// ---- The format ---------------------------------------------------------------------------

const BULLET = /^(\s*)(?:[-*+]|\d+[.)])\s+(?:\[([ xX])\]\s+)?(.*)$/
const HEADING = /^#{1,6}\s+(.*)$/
// A plain bullet (no box) is a task only under a heading like these; `\b` misses the accented « à ».
const TODO_HEADING = /(^|[^\p{L}])(todo|to-do|tasks?|backlog|[àa] faire)([^\p{L}]|$)/iu

export function splitTitle(text: string): { title: string; body: string } {
  const bold = /^\*\*(.+?)\*\*\s*(.*)$/.exec(text)
  if (bold) return { title: (bold[1] ?? '').replace(/[.:]$/, ''), body: bold[2] ?? '' }
  const stop = text.search(/[.:]\s/)
  return stop > 0 ? { title: text.slice(0, stop), body: text.slice(stop + 2) } : { title: text, body: '' }
}

export function parseTasks(text: string, source: string, first = 1): Task[] {
  const tasks: Task[] = []
  let isTodoSection = false
  let open: { task: Task; indent: number; rest: string[] } | undefined
  const close = () => {
    if (open) open.task.body = [open.task.body, ...open.rest].filter(Boolean).join(' ')
    open = undefined
  }

  text.split(/\r?\n/).forEach((line, index) => {
    const heading = HEADING.exec(line)
    if (heading) {
      close()
      isTodoSection = TODO_HEADING.test(heading[1] ?? '')
      return
    }
    const bullet = BULLET.exec(line)
    const indent = (bullet?.[1] ?? '').length
    const hasBox = bullet?.[2] !== undefined
    if (bullet && (hasBox || (isTodoSection && indent === 0))) {
      close()
      const { title, body } = splitTitle((bullet[3] ?? '').trim())
      const task: Task = { n: first + tasks.length, source, line: index, done: /x/i.test(bullet[2] ?? ''), title, body, hasBox }
      tasks.push(task)
      open = { task, indent, rest: [] }
      return
    }
    // An item's wrapped lines sit indented under its bullet; a blank line or a dedent ends it.
    const lead = line.length - line.trimStart().length
    if (open && line.trim() && lead > open.indent) open.rest.push(line.trim())
    else close()
  })
  close()
  return tasks
}

/** The task's bullet line, ticked or unticked; a plain bullet gains its box. */
export function tickLine(line: string, done: boolean): string {
  const box = done ? '[x]' : '[ ]'
  return /\[[ xX]\]/.test(line) ? line.replace(/\[[ xX]\]/, box) : line.replace(/^(\s*(?:[-*+]|\d+[.)])\s+)/, `$1${box} `)
}

// ---- Sources ------------------------------------------------------------------------------

// Paths are absolute, under the folder the session works in now: Claude moves between projects during
// a session, and a session opened on a folder of projects has its to-do files one level down.
const norm = (path: string) => path.replace(/\\/g, '/')
const join = (dir: string, name: string) => (name ? `${norm(dir).replace(/\/+$/, '')}/${name}` : norm(dir))
const isAbsolute = (path: string) => /^([A-Za-z]:)?\//.test(norm(path))

/** The folder above, or undefined at a root; `E:` alone would be drive-relative, so `E:/` it is. */
export function parentOf(dir: string): string | undefined {
  const d = norm(dir).replace(/\/+$/, '')
  const cut = d.lastIndexOf('/')
  if (cut < 0) return undefined
  const up = d.slice(0, cut)
  return up === '' ? '/' : /^[A-Za-z]:$/.test(up) ? `${up}/` : up
}

let base = ''

/** A path as the person reads it: relative to the session's folder when under it. */
export const shown = (path: string, from = base) => {
  const root = `${norm(from).replace(/\/+$/, '')}/`
  return norm(path).startsWith(root) ? norm(path).slice(root.length) : norm(path)
}

async function configured($: Engine): Promise<string[] | undefined> {
  try {
    const { sources: named } = JSON.parse(await $.fs.read(join(base, CONFIG))) as { sources?: string[] }
    return named?.length ? named.map(path => (isAbsolute(path) ? norm(path) : join(base, path))) : undefined
  } catch {
    return undefined
  }
}

async function candidatesIn($: Engine, dir: string): Promise<string[]> {
  const found: string[] = []
  for (const sub of DIRS) {
    const at = join(dir, sub)
    for (const entry of await $.fs.list(at).catch(() => [])) {
      if (entry.kind === 'file' && CANDIDATES.includes(entry.name.toLowerCase())) found.push(join(at, entry.name))
    }
  }
  return found
}

/** The session's folder and its parents first, as CLAUDE.md is found (a session opened inside a
 *  project); failing that, the projects one level down (a session opened on a folder of projects). */
async function discover($: Engine): Promise<string[]> {
  for (let dir: string | undefined = base; dir; dir = parentOf(dir)) {
    const found = await candidatesIn($, dir)
    if (found.length) return found
  }
  const found: string[] = []
  for (const entry of await $.fs.list(base).catch(() => [])) {
    if (entry.kind === 'dir' && !entry.name.startsWith('.') && !SKIPPED.has(entry.name)) {
      found.push(...(await candidatesIn($, join(base, entry.name))))
    }
  }
  return found
}

/** Configured sources, a directory standing for its Markdown files; else what discovery finds. */
async function resolveSources($: Engine): Promise<string[]> {
  base = norm(await $.session.cwd())
  const named = await configured($)
  if (!named) return discover($)
  const files: string[] = []
  for (const path of named) {
    const stat = await $.fs.stat(path).catch(() => undefined)
    if (stat?.kind === 'dir') {
      const entries = await $.fs.list(path)
      files.push(...entries.filter(e => e.kind === 'file' && /\.md$/i.test(e.name)).map(e => join(path, e.name)))
    } else if (stat) files.push(path)
  }
  return files
}

async function signatureOf($: Engine, files: string[]): Promise<string> {
  const stats = await Promise.all(files.map(f => $.fs.stat(f).then(s => `${f}:${s.mtimeMs}:${s.size}`, () => `${f}:-`)))
  return stats.join('|')
}

// ---- Refresh and display ------------------------------------------------------------------

let signature = ''
let current: Task[] = []

async function load($: Engine, force = false) {
  const files = await resolveSources($)
  const next = await signatureOf($, files)
  if (!force && next === signature) return
  signature = next
  const all: Task[] = []
  for (const file of files) {
    const text = await $.fs.read(file).catch(() => '')
    all.push(...parseTasks(text, file, all.length + 1))
  }
  current = all
  await update($, list, () => all)
  await update($, sources, () => files)
  await publish($, files)
}

const openOf = (tasks: Task[]) => tasks.filter(t => !t.done)

async function publish($: Engine, files: string[]) {
  const open = openOf(current)
  const rows: StarboardRow[] = open.length
    ? open.slice(0, MAX_ROWS).map(t => ({ label: `#${t.n}`, value: t.title }))
    : [{ value: files.length ? 'nothing left to do' : 'no to-do file found', status: files.length ? 'ok' : 'off', dim: true }]
  const more = open.length - MAX_ROWS
  try {
    // Without the starboard mod `$.starboard` is absent and the call throws: the band alone shows the tasks.
    await ($ as WithStarboard).starboard.publish({
      id: SECTION,
      title: 'Tasks',
      order: 45,
      summary: `${open.length} open`,
      rows,
      note: `${more > 0 ? `+${more} more · ` : ''}/todo do|done|add`,
    })
  } catch {}
}

const describe = (t: Task) => `#${t.n} ${t.done ? '[x]' : '[ ]'} ${t.title}${t.body ? ` — ${t.body}` : ''}`

async function setDone($: Engine, n: number, done: boolean): Promise<string> {
  const task = current.find(t => t.n === n)
  if (!task) return `No task #${n}. Run /todo to see the numbers.`
  const lines = (await $.fs.read(task.source)).split('\n')
  const line = lines[task.line]
  // The numbers come from the last read: if the file moved since, refuse rather than tick the wrong line.
  if (!line || !line.includes(task.title)) {
    await load($, true)
    return `${shown(task.source)} changed since it was read; numbers are refreshed, run /todo and try again.`
  }
  lines[task.line] = tickLine(line, done)
  await $.fs.write(task.source, lines.join('\n'))
  await load($, true)
  return `${done ? 'Ticked' : 'Unticked'} #${n} ${task.title} in ${shown(task.source)}.`
}

async function add($: Engine, text: string): Promise<string> {
  const files = await read($, sources)
  const target = files[0] ?? join(base, 'TODO.md')
  const before = await $.fs.read(target).catch(() => '# TODO\n')
  await $.fs.write(target, `${before.replace(/\s*$/, '\n')}- [ ] ${text}\n`)
  await load($, true)
  return `Added to ${shown(target)}: ${text}`
}

// A press and its hotkey, or the mod loaded twice (a dev copy beside the installed one), each start
// the task: the prompts queue while a turn runs and arrive as one doubled message.
const RESTART_MS = 5000
let lastStart = { n: 0, at: 0 }

async function start($: Engine, n: number): Promise<string> {
  const task = current.find(t => t.n === n)
  if (!task) return `No task #${n}. Run /todo to see the numbers.`
  const now = await $.clock.now()
  if (lastStart.n === n && now - lastStart.at < RESTART_MS) return `#${n} is already started.`
  lastStart = { n, at: now }
  void $.prompt.submit({
    text: `Work on task #${n} from ${task.source}:\n\n**${task.title}** ${task.body}\n\nWhen it is done, tick it in ${task.source} (\`- [x]\`).`,
  })
  return `Starting #${n} ${task.title}.`
}

async function setSources($: Engine, paths: string[]): Promise<string> {
  base = norm(await $.session.cwd())
  await $.fs.write(join(base, CONFIG), `${JSON.stringify({ sources: paths }, null, 2)}\n`)
  await load($, true)
  const files = await read($, sources)
  return paths.length
    ? `Sources saved in ${CONFIG}: ${files.map(f => shown(f)).join(', ') || 'none readable'}.`
    : `Sources reset: discovery finds ${files.map(f => shown(f)).join(', ') || 'nothing'}.`
}

const USAGE = [
  '/todo              open tasks',
  '/todo all          every task, done included',
  '/todo do <n>       hand task n to Claude',
  '/todo done <n>     tick it in its file (undo <n> unticks)',
  '/todo add <text>   append "- [ ] <text>" to the first source',
  '/todo source <path…>   read these files or folders (saved in .claude/todo.json); "auto" to discover again',
].join('\n')

async function run($: Engine, args: string): Promise<string> {
  const [verb = '', ...rest] = args.trim().split(/\s+/).filter(Boolean)
  const n = Number(rest[0])
  switch (verb) {
    case '':
    case 'all': {
      const files = await read($, sources)
      if (!files.length) return `No to-do file found. Name one with /todo source <path>.\n\n${USAGE}`
      const picked = verb === 'all' ? current : openOf(current)
      return `${files.map(f => shown(f)).join(', ')} — ${openOf(current).length} open\n\n${picked.map(describe).join('\n') || 'Nothing left to do.'}`
    }
    case 'do':
      return start($, n)
    case 'done':
    case 'undo':
      return Number.isInteger(n) ? setDone($, n, verb === 'done') : `Which one? /todo ${verb} <n>`
    case 'add':
      return rest.length ? add($, rest.join(' ')) : 'What? /todo add <text>'
    case 'source':
      return setSources($, rest[0] === 'auto' ? [] : rest)
    default:
      return USAGE
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'todo', description: "The project's to-do list: list, do, done, add", argumentHint: '[all|do|done|undo|add|source]' })
    await load($, true)
    $.clock.every(POLL_MS, () => void load($))
    return next(e)
  })

  on('command.run', { command: 'todo' }, async ($, e) => ({ text: await run($, e.args) }))

  // The open tasks ride in the system prompt, so Claude knows them without reading the file.
  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    const open = openOf(current)
    if (!open.length) return composed
    const lines = open.slice(0, MAX_CONTEXT).map(t => `- #${t.n} ${t.title} (${t.source})`)
    const more = open.length > MAX_CONTEXT ? `\n…and ${open.length - MAX_CONTEXT} more.` : ''
    const text = `# Open tasks of this project\nRead from its to-do files; the person may refer to them by number. When you finish one, tick its box in its file.\n${lines.join('\n')}${more}`
    return { sections: [...composed.sections, { id: 'tasks:open', text, scope: 'session' as const }] }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const open = openOf(await read($, list))
    const [first] = open
    if (!first) return next(e)
    const { Box, Text, Button } = $.ui.resolve(e)
    return (
      <Box flexDirection="row" gap={1}>
        <Text dimColor>Tasks · {open.length} open · next</Text>
        <Text weight="semibold" wrap="truncate-end">#{first.n} {first.title}</Text>
        <Button key="tasks-do" hotkey="d" variant="primary" onPress={() => void start($, first.n)}>Do</Button>
        <Button key="tasks-done" hotkey="x" onPress={async () => $.ui.toast(await setDone($, first.n, true))}>Done</Button>
      </Box>
    )
  })
}
