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
// Looked for, case-insensitively, at the project root and in docs/ when no source is configured.
const CANDIDATES = ['todo.md', 'tasks.md', 'a-faire.md', 'a_faire.md', 'backlog.md']
const DIRS = ['', 'docs']

const list = atom({ plugin: 'tasks', key: 'list' } as const, [])
const sources = atom({ plugin: 'tasks', key: 'sources' } as const, [])

// ---- The format ---------------------------------------------------------------------------

const BULLET = /^(\s*)(?:[-*+]|\d+[.)])\s+(?:\[([ xX])\]\s+)?(.*)$/
const HEADING = /^#{1,6}\s+(.*)$/
// A plain bullet (no box) is a task only under a heading like these; `\b` misses the accented « à ».
const TODO_HEADING = /(^|[^\p{L}])(todo|to-do|tasks?|backlog|[àa] faire)([^\p{L}]|$)/iu

export function splitTitle(text: string): { title: string; body: string } {
  const bold = /^\*\*(.+?)\*\*\s*(.*)$/.exec(text)
  if (bold) return { title: bold[1].replace(/[.:]$/, ''), body: bold[2] }
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
      isTodoSection = TODO_HEADING.test(heading[1])
      return
    }
    const bullet = BULLET.exec(line)
    const indent = bullet ? bullet[1].length : 0
    const hasBox = bullet?.[2] !== undefined
    if (bullet && (hasBox || (isTodoSection && indent === 0))) {
      close()
      const { title, body } = splitTitle(bullet[3].trim())
      const task: Task = { n: first + tasks.length, source, line: index, done: /x/i.test(bullet[2] ?? ''), title, body, hasBox }
      tasks.push(task)
      open = { task, indent, rest: [] }
      return
    }
    // An item's wrapped lines sit indented under its bullet; a blank line or a dedent ends it.
    const lead = /^\s*/.exec(line)![0].length
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

async function configured($: Engine): Promise<string[] | undefined> {
  try {
    const { sources: named } = JSON.parse(await $.fs.read(CONFIG)) as { sources?: string[] }
    return named?.length ? named : undefined
  } catch {
    return undefined
  }
}

async function discover($: Engine): Promise<string[]> {
  const found: string[] = []
  for (const dir of DIRS) {
    const entries = await $.fs.list(dir || '.').catch(() => [])
    for (const entry of entries) {
      if (entry.kind === 'file' && CANDIDATES.includes(entry.name.toLowerCase())) found.push(dir ? `${dir}/${entry.name}` : entry.name)
    }
  }
  return found
}

/** Configured sources, a directory standing for its Markdown files; else what discovery finds. */
async function resolveSources($: Engine): Promise<string[]> {
  const named = await configured($)
  if (!named) return discover($)
  const files: string[] = []
  for (const path of named) {
    const stat = await $.fs.stat(path).catch(() => undefined)
    if (stat?.kind === 'directory') {
      const entries = await $.fs.list(path)
      files.push(...entries.filter(e => e.kind === 'file' && /\.md$/i.test(e.name)).map(e => `${path.replace(/[\\/]$/, '')}/${e.name}`))
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
    return `${task.source} changed since it was read; numbers are refreshed, run /todo and try again.`
  }
  lines[task.line] = tickLine(line, done)
  await $.fs.write(task.source, lines.join('\n'))
  await load($, true)
  return `${done ? 'Ticked' : 'Unticked'} #${n} ${task.title} in ${task.source}.`
}

async function add($: Engine, text: string): Promise<string> {
  const files = await read($, sources)
  const target = files[0] ?? 'TODO.md'
  const before = await $.fs.read(target).catch(() => '# TODO\n')
  await $.fs.write(target, `${before.replace(/\s*$/, '\n')}- [ ] ${text}\n`)
  await load($, true)
  return `Added to ${target}: ${text}`
}

async function start($: Engine, n: number): Promise<string> {
  const task = current.find(t => t.n === n)
  if (!task) return `No task #${n}. Run /todo to see the numbers.`
  void $.prompt.submit({
    text: `Work on task #${n} from ${task.source}:\n\n**${task.title}** ${task.body}\n\nWhen it is done, tick it in ${task.source} (\`- [x]\`).`,
  })
  return `Starting #${n} ${task.title}.`
}

async function setSources($: Engine, paths: string[]): Promise<string> {
  await $.fs.write(CONFIG, `${JSON.stringify({ sources: paths }, null, 2)}\n`)
  await load($, true)
  const files = await read($, sources)
  return paths.length
    ? `Sources saved in ${CONFIG}: ${files.join(', ') || 'none readable'}.`
    : `Sources reset: discovery finds ${files.join(', ') || 'nothing'}.`
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
      const shown = verb === 'all' ? current : openOf(current)
      return `${files.join(', ')} — ${openOf(current).length} open\n\n${shown.map(describe).join('\n') || 'Nothing left to do.'}`
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
    if (!open.length) return next(e)
    const { Box, Text, Button } = $.ui.resolve(e)
    const first = open[0]
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
