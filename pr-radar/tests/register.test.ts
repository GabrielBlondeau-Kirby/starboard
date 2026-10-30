import { expect, test } from 'claude-code/testing'

import { parsePrUrl, rowOf, summaryOf, truncate, votesOf } from '../hooks/register'

const GIT: Record<string, string> = {
  'rev-parse --show-toplevel': '/repo/shop',
  'remote get-url origin': 'vs-ssh.visualstudio.com:v3/contoso/Payments/Shop',
}

const pr = (over: object) => ({
  pullRequestId: 1, title: 'Ajoute le remboursement partiel', status: 'active', mergeStatus: 'succeeded',
  createdBy: { id: 'other' }, reviewers: [], repository: { name: 'Shop', project: { name: 'Payments' } }, ...over,
})
const build = (over: object) => ({ status: 'completed', result: 'succeeded', sourceVersion: 'abc', definition: { name: 'CI' }, ...over })

function stub(on: Parameters<Parameters<typeof test>[1]>[1], statuses: (string | undefined)[], urls: string[] = []) {
  on('process.run', (_, e) => ({ value: { exitCode: 0, stdout: GIT[e.argv.slice(1).join(' ')] ?? '', stderr: '' } }))
  on('env.get', () => ({ value: 'secret-pat' }))
  on('clock.every', () => ({ value: { cancel: () => {} } }))
  on('command.register', () => ({ value: undefined }))
  on('command.run', () => ({ text: '' }))
  const store: Record<string, unknown> = {}
  on('store.get', (_, e) => ({ value: store[e.key] }))
  on('store.set', (_, e) => {
    store[e.key] = e.value
    return { value: undefined }
  })
  on('http.fetch', (_, e) => {
    urls.push(e.url)
    const body = e.url.includes('/connectionData') ? { authenticatedUser: { id: 'me' } }
      : e.url.includes('creatorId=me') ? { value: [
        pr({ pullRequestId: 10, createdBy: { id: 'me' }, reviewers: [{ id: 'x', vote: 10 }] }),
        pr({ pullRequestId: 20, createdBy: { id: 'me' }, autoCompleteSetBy: { id: 'me' } }),
      ] }
      : e.url.includes('sourceRefName=refs%2Fheads%2Ffeature%2Fx') ? { value: [pr({ pullRequestId: 30, status: 'completed' }), pr({ pullRequestId: 31 })] }
      : /pullrequests\/31\?/.test(e.url) ? pr({ pullRequestId: 31 })
      : e.url.includes('refs%2Fpull%2F10%2Fmerge') ? { value: [build({ result: 'failed' })] }
      : { value: [build({})] }
    return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify(body) } }
  })
  on('ui.status', (_, e) => {
    statuses.push(e.text)
    return { value: undefined }
  })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
}

test('parses Azure DevOps PR URLs', () => {
  expect(parsePrUrl('https://dev.azure.com/contoso/Contoso%20Pay/_git/Shop/pullrequest/62367?_a=files'))
    .toEqual({ org: 'contoso', project: 'Contoso Pay', id: 62367 })
  expect(parsePrUrl('https://contoso.visualstudio.com/Payments/_git/Shop/pullrequest/12')).toEqual({ org: 'contoso', project: 'Payments', id: 12 })
  expect(parsePrUrl('feature/x')).toBe(undefined)
})

test('truncates titles to 15 characters', () => {
  expect(truncate('Ajoute le remboursement partiel')).toBe('Ajoute le remb…')
  expect(truncate('Court')).toBe('Court')
})

test('counts approvals of people only', () => {
  expect(votesOf([{ vote: 10 }, { vote: 5 }, { vote: 10, isContainer: true }, { vote: 0 }])).toBe('👍2')
  expect(votesOf([{ vote: 10 }, { vote: -10 }])).toBe('👎')
})

test('one row of fixed icon slots per PR', () => {
  const where = { org: 'contoso', project: 'Payments' }
  const row = rowOf({ pr: pr({ pullRequestId: 7, autoCompleteSetBy: { id: 'me' }, reviewers: [{ vote: 10, isRequired: true }] }), where, role: 'mine', ci: 'ok' })
  expect(row).toEqual({
    label: '#7 Shop        ', value: '✍️ 🔵 👍1 ✅ 🚀 Ajoute le remb…', status: 'ok', dim: false,
    href: 'https://dev.azure.com/contoso/Payments/_git/Shop/pullrequest/7',
  })
  expect(rowOf({ pr: pr({ isDraft: true }), where, role: 'follow', ci: 'running' }, 4)).toMatchObject({ label: '#1 Shop', value: '📌 📝 👍0 ⏳    Ajoute le remb…' })
})

test('lists my PRs, without starboard', async ($, on) => {
  const statuses: (string | undefined)[] = []
  const urls: string[] = []
  stub(on, statuses, urls)
  await $.session.start({ cwd: '/repo/shop', surface: 'terminal', isInteractive: true })
  const { text } = await $.command.run({ command: 'prs', args: '' }) as { text: string }

  expect(statuses.at(-1)).toBe('PR ✍️2 ❌1')
  expect(urls.some(url => url.includes('reviewerId'))).toBe(false)
  expect(text).toContain('#10 Shop ✍️ 🔵 👍1 ❌')
  expect(text).toContain('#20 Shop ✍️ 🔵 👍0 ✅ 🚀 Ajoute')
  expect(statuses.some(s => s?.includes('secret-pat'))).toBe(false)
})

test('follows a PR by branch, then drops it', async ($, on) => {
  const statuses: (string | undefined)[] = []
  stub(on, statuses)
  await $.session.start({ cwd: '/repo/shop', surface: 'terminal', isInteractive: true })

  expect(await $.command.run({ command: 'prs', args: 'add feature/x' })).toEqual({ text: 'PR #31 suivie.' })
  const { text } = await $.command.run({ command: 'prs', args: '' }) as { text: string }
  expect(text).toContain('#31 Shop 📌')

  expect(await $.command.run({ command: 'prs', args: 'rm 31' })).toEqual({ text: 'PR #31 retirée du suivi.' })
  expect(summaryOf([])).toBe('—')
})
