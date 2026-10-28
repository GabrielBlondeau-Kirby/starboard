import { expect, test } from 'claude-code/testing'

import { parseTasks, splitTitle, tickLine } from '../hooks/register'

const TODO = [
  '# À faire',
  '',
  '- [x] **Add overlays.** Done on 2026-10-11.',
  '- [ ] **Chapters: a zoomed preview.** Around the playhead,',
  '  to place a cut to the second.',
  '- [ ] Short durations: 15, 30, 60, 120 s',
  '',
  '## Ideas',
  '- not a task: no box, not under a to-do heading',
].join('\n')

test('the format: boxes, bold titles, wrapped lines', async () => {
  const tasks = parseTasks(TODO, 'docs/A-FAIRE.md')
  expect(tasks.map(t => [t.n, t.done, t.title])).toEqual([
    [1, true, 'Add overlays'],
    [2, false, 'Chapters: a zoomed preview'],
    [3, false, 'Short durations'],
  ])
  expect(tasks[1]?.body).toBe('Around the playhead, to place a cut to the second.')
})

test('plain bullets count only under a to-do heading', async () => {
  const tasks = parseTasks('## TODO\n- write the README\n## Notes\n- nope', 'TODO.md')
  expect(tasks.map(t => [t.title, t.hasBox])).toEqual([['write the README', false]])
})

test('titles without bold stop at the first sentence', async () => {
  expect(splitTitle('Fix the footer. It stays stale.')).toEqual({ title: 'Fix the footer', body: 'It stays stale.' })
})

test('ticking keeps the line and adds a missing box', async () => {
  expect(tickLine('- [ ] **A.** b', true)).toBe('- [x] **A.** b')
  expect(tickLine('  * [x] a', false)).toBe('  * [ ] a')
  expect(tickLine('- write it', true)).toBe('- [x] write it')
})

// The engine hands hooks absolute paths, under the test's working directory (the mod folder).
const rel = (path: string) => path.replace(/\\/g, '/').replace(/^.*\/tasks(\/|$)/, '').replace(/\/$/, '')

type Body = Extract<Parameters<typeof test>[1], (...args: never[]) => unknown>
type On = Parameters<Body>[1]

function memoryFs(on: On, files: Record<string, string>) {
  const missing = () => Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
  on('fs.list', (_, e) => {
    const dir = rel(e.path)
    const names = Object.keys(files).filter(p => (dir ? p.startsWith(`${dir}/`) : true) && !p.slice(dir ? dir.length + 1 : 0).includes('/'))
    return { value: names.map(p => ({ name: p.split('/').pop()!, kind: 'file' as const, size: files[p]?.length ?? 0, mtimeMs: 0, isLink: false })) }
  })
  on('fs.stat', (_, e) => {
    const path = rel(e.path)
    if (Object.keys(files).some(p => p.startsWith(`${path}/`))) return { value: { kind: 'dir' as const, size: 0, mtimeMs: 0, isLink: false } }
    const file = files[path]
    if (file === undefined) throw missing()
    return { value: { kind: 'file' as const, size: file.length, mtimeMs: 0, isLink: false } }
  })
  on('fs.read', (_, e) => {
    const file = files[rel(e.path)]
    if (file === undefined) throw missing()
    return { value: file }
  })
  on('fs.write', (_, e) => {
    files[rel(e.path)] = e.text
    return { value: undefined }
  })
}

test('/todo finds docs/A-FAIRE.md, ticks and adds in it', async ($, on) => {
  const files: Record<string, string> = { 'README.md': '# readme', 'docs/A-FAIRE.md': TODO }
  memoryFs(on, files)
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('clock.every', () => ({ value: undefined }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))

  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  // The testing kit types $.command.run with the engine's full input; the mod only reads rgs.
  const todo = (args: string) => $.command.run({ command: 'todo', args } as never)

  const listed = await todo('')
  expect(listed.text).toContain('docs/A-FAIRE.md — 2 open')
  expect(listed.text).toContain('#2 [ ] Chapters: a zoomed preview')

  await todo('done 2')
  expect(files['docs/A-FAIRE.md']?.split('\n')[3]).toBe('- [x] **Chapters: a zoomed preview.** Around the playhead,')

  await todo('add Remove the CLI line')
  expect(files['docs/A-FAIRE.md']?.trimEnd().split('\n').at(-1)).toBe('- [ ] Remove the CLI line')
})

test('/todo source takes a folder for its Markdown files', async ($, on) => {
  const files: Record<string, string> = { 'notes/a.md': '- [ ] **One.**', 'notes/b.md': '- [ ] **Two.**', 'notes/c.txt': '- [ ] no' }
  memoryFs(on, files)
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('clock.every', () => ({ value: undefined }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))

  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  const todo = (args: string) => $.command.run({ command: 'todo', args } as never)

  await todo('source notes')
  expect(files['.claude/todo.json']).toContain('"notes"')
  const listed = await todo('')
  expect(listed.text).toContain('#1 [ ] One')
  expect(listed.text).toContain('#2 [ ] Two')
  expect(listed.text).not.toContain('c.txt')
})