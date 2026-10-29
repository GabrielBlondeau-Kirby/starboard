import { expect, test } from 'claude-code/testing'

import { formatSize, groupStacks, isLinked, levelOf, orphansOf, parseSize, prefixesOf, slugOf } from '../hooks/register'

const GIB = 1024 ** 3
const MIB = 1024 ** 2

type Docker = { info?: string; ps?: string; stats?: string }

const machine = (usedMiB: number): Docker => ({
  info: String(8 * GIB),
  ps: 'aaaaaaaaaaaa\tshop-main\tshop-main-web-1\nbbbbbbbbbbbb\tshop-main\tshop-main-db-1\ncccccccccccc\tshop-feature-x\tshop-feature-x-web-1\ndddddddddddd\tother\tother-1\neeeeeeeeeeee\t\tlonely',
  stats: [
    `aaaaaaaaaaaa\t${usedMiB / 2}MiB / 8GiB`,
    `bbbbbbbbbbbb\t${usedMiB / 4}MiB / 8GiB`,
    `cccccccccccc\t${usedMiB / 8}MiB / 8GiB`,
    `dddddddddddd\t${usedMiB / 16}MiB / 8GiB`,
    `eeeeeeeeeeee\t${usedMiB / 16}MiB / 8GiB`,
  ].join('\n'),
})

function stub(on: Parameters<Parameters<typeof test>[1]>[1], docker: () => Docker, statuses: (string | undefined)[], toasts: string[]) {
  on('process.run', (_, e) => {
    const out = docker()[e.argv[1] as keyof Docker]
    return { value: { exitCode: out === undefined ? 1 : 0, stdout: out ?? '', stderr: '' } }
  })
  on('clock.every', () => ({ value: { cancel: () => {} } }))
  on('command.register', () => ({ value: undefined }))
  on('command.run', () => ({ text: '' }))
  const store: Record<string, unknown> = {}
  on('store.get', (_, e) => ({ value: store[e.key] }))
  on('store.set', (_, e) => {
    store[e.key] = e.value
    return { value: undefined }
  })
  on('ui.status', (_, e) => {
    statuses.push(e.text)
    return { value: undefined }
  })
  on('ui.toast', (_, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
}

test('parses the sizes docker stats prints', () => {
  expect(parseSize('668.6MiB')).toBe(668.6 * MIB)
  expect(parseSize('1.5GiB')).toBe(1.5 * GIB)
  expect(parseSize('12.3kB')).toBe(12300)
  expect(parseSize('0B')).toBe(0)
  expect(parseSize('n/a')).toBe(0)
  expect(formatSize(1.25 * GIB)).toBe('1,3 Go')
  expect(formatSize(530 * MIB)).toBe('530 Mo')
})

test('groups containers by Compose project, filtered by prefix, biggest first', () => {
  const containers = new Map([
    ['a', { project: 'shop-main', name: 'shop-main-web-1' }],
    ['b', { project: 'shop-main', name: 'shop-main-db-1' }],
    ['c', { project: 'shop-x', name: 'shop-x-web-1' }],
    ['d', { project: 'other', name: 'other-1' }],
    ['e', { project: '', name: 'lonely' }],
    ['f', { project: 'docker', name: 'shop-core' }],
    ['g', { project: 'docker', name: 'docker-db-1' }],
  ])
  const usage = new Map([['a', 100], ['b', 50], ['c', 200], ['d', 999], ['e', 10], ['f', 300], ['g', 20]])

  expect(groupStacks(containers, usage, prefixesOf(' shop- , '))).toEqual([
    { name: 'docker (shop-core)', bytes: 320, containers: 2 },
    { name: 'shop-x', bytes: 200, containers: 1 },
    { name: 'shop-main', bytes: 150, containers: 2 },
  ])
  expect(groupStacks(containers, usage, []).map(stack => stack.name)).toEqual(['other', 'docker', 'shop-x', 'shop-main', '(hors compose)'])
})

test('the level follows the warning threshold, error from 95 %', () => {
  expect(levelOf(79, 80)).toBe('ok')
  expect(levelOf(80, 80)).toBe('warn')
  expect(levelOf(95, 80)).toBe('error')
})

test('without starboard, the footer shows only a memory shortage, toasted once', { options: { prefixes: 'shop-', warnPercent: 80 } }, async ($, on) => {
  const statuses: (string | undefined)[] = []
  const toasts: string[] = []
  let current = machine(4096)
  stub(on, () => current, statuses, toasts)
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })

  const healthy = await $.command.run({ command: 'docker', args: '' })
  expect(statuses.at(-1)).toBe(undefined)
  expect(healthy.text).toContain('shop-main : 3,0 Go · 2 conteneurs')
  expect(healthy.text).not.toContain('other')

  current = machine(7168)
  await $.command.run({ command: 'docker', args: '' })
  await $.command.run({ command: 'docker', args: '' })
  expect(statuses.at(-1)).toBe('Docker ⚠ 7,0/8,0 Go · 88 %')
  expect(toasts).toEqual(['Docker : 88 % de la mémoire utilisée — shop-main'])
})

test('a stopped Docker says so instead of failing', async ($, on) => {
  const statuses: (string | undefined)[] = []
  stub(on, () => ({}), statuses, [])
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })

  expect((await $.command.run({ command: 'docker', args: '' })).text).toBe('Docker indisponible')
  expect(statuses.at(-1)).toBe(undefined)
})

test('a stack belongs to the session by its worktree or by the branch in its name', () => {
  const session = { top: '/src/shop-PAY-12', branch: 'feature/PAY-12-refund' }
  expect(slugOf('feature/PAY-12-refund')).toBe('feature-pay-12-refund')
  expect(isLinked({ project: 'docker', name: 'shop-core', dir: '/src/shop-PAY-12/docker' }, session)).toBe(true)
  expect(isLinked({ project: 'shop-feature-pay-12-refund-fakepsp', name: 'x', dir: '/src/FakePSP/docker' }, session)).toBe(true)
  expect(isLinked({ project: 'docker', name: 'shop-core', dir: '/src/shop/docker' }, session)).toBe(false)
  expect(isLinked({ project: 'shop-feature-pay-123-other', name: 'x', dir: '/src/shop-PAY-123/docker' }, session)).toBe(false)
})

test('an orphan is a stack whose folder is gone, with the stacks named after it', () => {
  const containers = [
    { project: 'shop-feature-x', name: 'a', dir: '/src/shop-x/docker' },
    { project: 'shop-feature-x-fakepsp', name: 'b', dir: '/src/FakePSP/docker' },
    { project: 'shop-feature-y', name: 'c', dir: '/src/shop-y/docker' },
    { project: 'other', name: 'd', dir: '/gone/other' },
    { project: '', name: 'lonely' },
  ]
  const missing = new Set(['/src/shop-x/docker', '/gone/other'])

  expect(orphansOf(containers, missing, ['shop-'])).toEqual(['shop-feature-x', 'shop-feature-x-fakepsp'])
  expect(orphansOf(containers, missing, [])).toEqual(['other', 'shop-feature-x', 'shop-feature-x-fakepsp'])
  // A shared stack gone ("shop", from a removed fake's folder) does not take the branch stacks with it.
  expect(orphansOf([...containers, { project: 'shop', name: 'e', dir: '/gone/fake' }], new Set(['/gone/fake']), ['shop'])).toEqual(['shop'])
})
