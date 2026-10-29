import { expect, test } from 'claude-code/testing'

import { jiraOf, parseRemote, reviewOf, stateOf, ticketRows } from '../hooks/register'

const GIT: Record<string, string> = {
  'rev-parse --show-toplevel': '/repo/hap-pay-12',
  'branch --show-current': 'feature/PAY-12-refund',
  'rev-parse --path-format=absolute --git-common-dir': '/repo/hap/.git',
  'status --porcelain': '',
}

const JIRA = { jiraUrl: 'https://example.atlassian.net/', jiraEmail: 'me@example.com', jiraToken: 'secret-token' }

function stub(on: Parameters<Parameters<typeof test>[1]>[1], answer?: { status: number; body: object }, urls: string[] = []) {
  on('process.run', (_, e) => ({ value: { exitCode: 0, stdout: GIT[e.argv.slice(1).join(' ')] ?? '', stderr: '' } }))
  on('clock.every', () => ({ value: { cancel: () => {} } }))
  on('clock.now', () => ({ value: 0 }))
  on('http.fetch', (_, e) => {
    urls.push(e.url)
    const { status, body } = answer ?? { status: 200, body: {} }
    return { value: { status, ok: status < 300, headers: {}, text: JSON.stringify(body) } }
  })
}

async function footer($: Parameters<Parameters<typeof test>[1]>[0], on: Parameters<Parameters<typeof test>[1]>[1]) {
  const statuses: (string | undefined)[] = []
  on('ui.status', (_, e) => {
    statuses.push(e.text)
    return { value: undefined }
  })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/repo/hap-pay-12', surface: 'terminal', isInteractive: true })
  return statuses.at(-1)
}

test('without the starboard mod, the workspace goes to the footer', async ($, on) => {
  const urls: string[] = []
  stub(on, undefined, urls)

  expect(await footer($, on)).toBe('feature/PAY-12-refund · hap-pay-12 (lié) · PAY-12')
  expect(urls).toEqual([])
})

test('a Jira URL alone links the key without calling Jira', async () => {
  // Without a token the rows are built without touching the engine.
  const rows = await ticketRows(undefined as never, jiraOf({ jiraUrl: JIRA.jiraUrl }), 'PAY-12')

  expect(rows).toEqual([{ label: 'jira', value: 'PAY-12', href: 'https://example.atlassian.net/browse/PAY-12' }])
})

test('with a token, the footer shows the status, never the token', { options: JIRA }, async ($, on) => {
  const urls: string[] = []
  stub(on, { status: 200, body: { fields: { summary: 'Rembourser une commande', status: { name: 'En cours', statusCategory: { key: 'indeterminate' } } } } }, urls)

  const text = await footer($, on)

  expect(text).toBe('feature/PAY-12-refund · hap-pay-12 (lié) · PAY-12 · En cours')
  expect(urls).toEqual(['https://example.atlassian.net/rest/api/3/issue/PAY-12?fields=summary,status'])
  expect(text?.includes('secret-token')).toBe(false)
})

test('a refused token keeps the key in the footer', { options: { ...JIRA, jiraUrl: 'https://refused.atlassian.net' } }, async ($, on) => {
  stub(on, { status: 401, body: {} })

  expect(await footer($, on)).toBe('feature/PAY-12-refund · hap-pay-12 (lié) · PAY-12')
})

test('parses Azure DevOps remotes', () => {
  expect(parseRemote('vs-ssh.visualstudio.com:v3/contoso/Contoso.Payments/Shop')).toEqual({ org: 'contoso', project: 'Contoso.Payments', repo: 'Shop' })
  expect(parseRemote('git@github.com:someone/repo.git')).toBe(undefined)
})

test('a PR state has its icon', () => {
  expect(stateOf({ pullRequestId: 1, status: 'completed' }).icon).toBe('✅')
  expect(stateOf({ pullRequestId: 1, status: 'active', isDraft: true }).icon).toBe('📝')
  expect(stateOf({ pullRequestId: 1, status: 'active' }).icon).toBe('⏳')
})

test('a review counts people, and waits for every required reviewer', () => {
  const team = { vote: 10, isRequired: true, isContainer: true }
  expect(reviewOf([{ vote: 10 }, team, { vote: 0 }])).toEqual({ label: 'revue', value: '✔ approuvée · 1/2', status: 'ok' })
  expect(reviewOf([{ vote: 10 }, { vote: 0, isRequired: true }]).status).toBe('off')
  expect(reviewOf([{ vote: 10 }, { vote: -10 }]).value).toBe('✖ rejetée · 1/2')
  expect(reviewOf([]).value).toBe('○ pas encore approuvée')
})

test('the branch PR is a link with its state and review, never the PAT', async ($, on) => {
  const urls: string[] = []
  stub(on, { status: 200, body: { value: [
    { pullRequestId: 7, status: 'abandoned' },
    { pullRequestId: 9, status: 'active', isDraft: false, reviewers: [{ vote: 10 }, { vote: 0 }] },
  ] } }, urls)
  GIT['remote get-url origin'] = 'vs-ssh.visualstudio.com:v3/contoso/Contoso.Payments/Shop'
  on('env.get', () => ({ value: 'secret-pat' }))
  try {
    const text = await footer($, on)

    expect(text).toBe('feature/PAY-12-refund · hap-pay-12 (lié) · PAY-12 · ⏳ #9 · Active · ✔ approuvée · 1/2')
    expect(urls[0]).toContain('/Contoso.Payments/_apis/git/repositories/Shop/pullRequests?searchCriteria.sourceRefName=refs%2Fheads%2Ffeature%2FPAY-12-refund&searchCriteria.status=all')
    expect(text?.includes('secret-pat')).toBe(false)
  } finally {
    delete GIT['remote get-url origin']
  }
})
