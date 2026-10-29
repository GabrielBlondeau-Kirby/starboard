import { expect, test } from 'claude-code/testing'

import { parseRemote, pullRequestUrl, tokenFromEnvFile } from '../hooks/register'

const GIT: Record<string, string> = {
  'rev-parse --show-toplevel': '/repo/shop-PAY-42',
  'remote get-url origin': 'vs-ssh.visualstudio.com:v3/contoso/Contoso.Payments/Shop',
  'branch --show-current': 'feature/PAY-42',
}

const build = (over: object) => ({
  id: 7, buildNumber: '20261028.1', status: 'completed', result: 'succeeded', sourceVersion: 'abcdef1234',
  startTime: '2026-10-28T10:00:00Z', finishTime: '2026-10-28T10:12:00Z', definition: { name: 'Shop-CI' }, ...over,
})

function stub(on: Parameters<Parameters<typeof test>[1]>[1], builds: object[], statuses: (string | undefined)[], urls: string[] = []) {
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
    const body = e.url.includes('/pullRequests') ? { value: [{ pullRequestId: 1234 }] }
      : e.url.includes('/timeline') ? { records: [{ name: 'DeployStaging', type: 'Task', result: 'failed' }, { name: 'Job', type: 'Job', result: 'failed' }] }
      : { value: builds }
    return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify(body) } }
  })
  on('ui.status', (_, e) => {
    statuses.push(e.text)
    return { value: undefined }
  })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
}

test('parses Azure DevOps remotes', () => {
  expect(parseRemote('vs-ssh.visualstudio.com:v3/contoso/Contoso.Payments/Shop'))
    .toEqual({ org: 'contoso', project: 'Contoso.Payments', repo: 'Shop' })
  expect(parseRemote('https://contoso@dev.azure.com/contoso/Contoso.Payments/_git/Shop'))
    .toEqual({ org: 'contoso', project: 'Contoso.Payments', repo: 'Shop' })
  expect(parseRemote('git@github.com:someone/repo.git')).toBe(undefined)
})

test('reads the PAT from a docker .env', () => {
  expect(tokenFromEnvFile('FOO=1\nAZURE_ACCESS_TOKEN="abc123"\n')).toBe('abc123')
  expect(tokenFromEnvFile('FOO=1\n')).toBe(undefined)
})

test('a green PR build goes to the footer without starboard', async ($, on) => {
  const statuses: (string | undefined)[] = []
  const urls: string[] = []
  stub(on, [build({})], statuses, urls)
  await $.session.start({ cwd: '/repo/shop-PAY-42', surface: 'terminal', isInteractive: true })
  await $.command.run({ command: 'ci', args: '' })

  expect(statuses.at(-1)).toBe('CI ✅ PR 1234')
  expect(urls.some(url => url.includes('branchName=refs%2Fpull%2F1234%2Fmerge'))).toBe(true)
  expect(statuses.some(text => text?.includes('secret-pat'))).toBe(false)
})

test('a failed build names its failed step', async ($, on) => {
  const statuses: (string | undefined)[] = []
  stub(on, [build({ result: 'failed' })], statuses)
  await $.session.start({ cwd: '/repo/shop-PAY-42', surface: 'terminal', isInteractive: true })
  await $.command.run({ command: 'ci', args: '' })

  expect(statuses.at(-1)).toBe('CI ❌ DeployStaging')
})

test('/ci off clears the footer', async ($, on) => {
  const statuses: (string | undefined)[] = []
  stub(on, [build({ status: 'inProgress', result: undefined, finishTime: undefined })], statuses)
  await $.session.start({ cwd: '/repo/shop-PAY-42', surface: 'terminal', isInteractive: true })
  await $.command.run({ command: 'ci', args: 'off' })

  expect(statuses.at(-1)).toBe(undefined)
})

test('links a PR to Azure DevOps', () => {
  expect(pullRequestUrl({ org: 'contoso', project: 'Contoso Payments', repo: 'Shop' }, 1234))
    .toBe('https://dev.azure.com/contoso/Contoso%20Payments/_git/Shop/pullrequest/1234')
})
