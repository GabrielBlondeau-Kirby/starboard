import { expect, test } from 'claude-code/testing'

const GIT: Record<string, string> = {
  'rev-parse --show-toplevel': '/repo/hap-pay-12',
  'branch --show-current': 'feature/PAY-12-refund',
  'rev-parse --path-format=absolute --git-common-dir': '/repo/hap/.git',
  'status --porcelain': '',
}

test('without the sidebar mod, the workspace goes to the footer', async ($, on) => {
  const statuses: (string | undefined)[] = []
  on('process.run', (_, e) => ({ value: { exitCode: 0, stdout: GIT[e.argv.slice(1).join(' ')] ?? '', stderr: '' } }))
  on('clock.every', () => ({ value: { cancel: () => {} } }))
  on('ui.status', (_, e) => {
    statuses.push(e.text)
    return { value: undefined }
  })
  on('session.start', (_, e) => ({ cwd: e.cwd }))

  await $.session.start({ cwd: '/repo/hap-pay-12', surface: 'terminal', isInteractive: true })

  expect(statuses.at(-1)).toBe('feature/PAY-12-refund · hap-pay-12 (lié) · PAY-12')
})
