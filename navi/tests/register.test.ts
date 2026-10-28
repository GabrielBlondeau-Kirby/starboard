import { expect, test } from 'claude-code/testing'

import { completeSession, introduction, isConnectMessage, isCutMessage, liveEdges, parseListing, partnersOf, sectionOf, summarizeEdges } from '../hooks/register'

test('parseListing puts this session first and keeps every named peer', () => {
  const { self, peers } = parseListing({
    listing: 'This session is api-2f [94a7de] — the name other sessions use',
    sections: [
      { kind: 'peer', rows: [{ name: 'api-7b', status: 'busy' }, { status: 'idle' }, { name: 'docs-cd', status: 'idle' }] },
    ],
  })

  expect(self).toBe('api-2f')
  expect(peers.map(p => p.name)).toEqual(['api-2f', 'api-7b', 'docs-cd'])
  expect(peers[0]?.isSelf).toBe(true)
})

test('parseListing without a self line lists the peers alone', () => {
  const { self, peers } = parseListing({ sections: [{ kind: 'peer', rows: [{ name: 'a' }] }] })

  expect(self).toBe('')
  expect(peers.map(p => p.name)).toEqual(['a'])
})

test('isConnectMessage accepts only a connect message with both names', () => {
  expect(isConnectMessage({ kind: 'connect', from: 'a', to: 'b' })).toBe(true)
  expect(isConnectMessage({ kind: 'connect', from: 'a' })).toBe(false)
  expect(isConnectMessage('connect')).toBe(false)
  expect(isConnectMessage(null)).toBe(false)
})

test('introduction names the partner as the SendMessage recipient', () => {
  expect(introduction('docs-cd')).toContain('SendMessage (to: "docs-cd")')
})

test('summarizeEdges groups by pair and hides socket addresses', () => {
  const names = new Set(['a', 'b'])
  const links = summarizeEdges(
    [
      { from: 'a', to: 'b', at: 1, kind: 'message' },
      { from: 'a', to: 'b', at: 2, kind: 'message' },
      { from: 'b', to: 'uds:/run/user/1000/cc-socks/1.sock', at: 3, kind: 'message' },
      { from: 'a', to: 'b', at: 4, kind: 'link' },
    ],
    names,
  )

  expect(links).toEqual([
    { from: 'a', to: 'b', kind: 'message', count: 2 },
    { from: 'a', to: 'b', kind: 'link', count: 1 },
  ])
})

test('partnersOf lists each linked session once, in either direction', () => {
  const names = new Set(['me', 'a', 'b', 'c'])
  const partners = partnersOf(
    [
      { from: 'me', to: 'a', at: 1, kind: 'message' },
      { from: 'a', to: 'me', at: 2, kind: 'link' },
      { from: 'b', to: 'me', at: 3, kind: 'message' },
      { from: 'b', to: 'c', at: 4, kind: 'message' },
      { from: 'me', to: 'uds:/run/user/1000/cc-socks/1.sock', at: 5, kind: 'message' },
    ],
    names,
    'me',
  )

  expect(partners).toEqual(['a', 'b'])
})

test('completeSession offers linked sessions first and skips this session', () => {
  const graph = {
    self: 'api-2f',
    notice: '',
    peers: [
      { name: 'api-2f', isSelf: true },
      { name: 'api-7b', status: 'busy', isSelf: false },
      { name: 'api-cf', status: 'idle', isSelf: false },
      { name: 'docs-cd', status: 'idle', isSelf: false },
    ],
    edges: [{ from: 'api-cf', to: 'api-2f', at: 1, kind: 'link' as const }],
  }

  expect(completeSession('api', graph)).toEqual([
    { text: 'api-cf', description: 'session liée · idle' },
    { text: 'api-7b', description: 'session · busy' },
  ])
  expect(completeSession('API-7', graph).map(c => c.text)).toEqual(['api-7b'])
  expect(completeSession('ap', graph)).toEqual([])
  expect(completeSession('api-cf', graph)).toEqual([])
})

const pair = [
  { from: 'me', to: 'a', at: 1, kind: 'link' as const },
  { from: 'b', to: 'me', at: 2, kind: 'message' as const },
]

test('a cut by either side hides the edges of that pair up to the cut', () => {
  expect(liveEdges(pair, [{ by: 'me', peer: 'a', at: 5 }]).map(e => e.to)).toEqual(['me'])
  expect(liveEdges(pair, [{ by: 'a', peer: 'me', at: 5 }]).map(e => e.from)).toEqual(['b'])
  expect(liveEdges(pair, [{ by: 'c', peer: 'a', at: 5 }])).toEqual(pair)
})

test('cut-all hides every edge of the session that cut', () => {
  expect(liveEdges(pair, [{ by: 'me', peer: '*', at: 5 }])).toEqual([])
  expect(liveEdges([{ from: 'a', to: 'b', at: 1, kind: 'link' }], [{ by: 'me', peer: '*', at: 5 }])).toHaveLength(1)
})

test('a link made after the cut brings it back', () => {
  const again = [...pair, { from: 'a', to: 'me', at: 9, kind: 'link' as const }]
  const live = liveEdges(again, [{ by: 'me', peer: '*', at: 5 }])
  expect(partnersOf(live, new Set(['me', 'a', 'b']), 'me')).toEqual(['a'])
})

test('isCutMessage accepts only a cut message with a peer', () => {
  expect(isCutMessage({ kind: 'cut', peer: 'a' })).toBe(true)
  expect(isCutMessage({ kind: 'cut' })).toBe(false)
})

test('the starboard section lists the session, then its links with their state', () => {
  const section = sectionOf({
    self: 'me',
    notice: '',
    peers: [{ name: 'me', isSelf: true }, { name: 'a', status: 'busy', isSelf: false }, { name: 'b', status: 'idle', isSelf: false }],
    edges: pair,
  })
  expect(section.summary).toBe('2 liées')
  expect(section.rows).toEqual([
    { label: '🌐', value: 'me', status: 'ok' },
    { label: '🔗', value: 'a', status: 'warn' },
    { label: '🔗', value: 'b', status: 'ok' },
  ])
  expect(sectionOf({ self: 'me', notice: '', peers: [], edges: [] }).rows.at(-1)).toEqual({ value: 'aucune session liée', dim: true })
})

function stub(on: Parameters<Parameters<typeof test>[1]>[1], toasts: string[]) {
  const store: Record<string, unknown> = {
    'edges:me': [{ from: 'me', to: 'a', at: 1, kind: 'link' }, { from: 'me', to: 'b', at: 2, kind: 'message' }],
  }
  let now = 10
  on('tool.call', () => ({
    result: { listing: 'This session is me [abc123]', sections: [{ kind: 'peer', rows: [{ name: 'a', status: 'idle' }, { name: 'b', status: 'busy' }] }] },
  }))
  on('store.keys', () => ({ value: Object.keys(store) }))
  on('store.get', (_, e) => ({ value: store[e.key] }))
  on('store.set', (_, e) => {
    store[e.key] = e.value
    return { value: undefined }
  })
  on('clock.now', () => ({ value: now++ }))
  on('clock.every', () => ({ value: { cancel: () => {} } }))
  on('command.register', () => ({ value: undefined }))
  on('command.run', () => ({ text: '' }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', (_, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  return store
}

test('/navi cut and cut-all record the cut under this session, without starboard', async ($, on) => {
  const toasts: string[] = []
  const store = stub(on, toasts)
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })

  expect((await $.command.run({ command: 'navi', args: 'cut a' })).text).toBe('Connexion coupée : me ↔ a.')
  expect((await $.command.run({ command: 'navi', args: 'cut a' })).text).toBe('Aucune connexion avec « a ».')
  expect((await $.command.run({ command: 'navi', args: 'cut-all' })).text).toBe('Toutes les connexions de me coupées (1).')
  expect((store['cuts:me'] as { peer: string }[]).map(c => c.peer)).toEqual(['a', '*'])
  expect(toasts).toEqual(['Connexion coupée : me ↔ a', 'Toutes les connexions de me coupées (1)'])
  expect((await $.command.run({ command: 'navi', args: 'cut-all' })).text).toBe('Aucune connexion à couper.')
})
