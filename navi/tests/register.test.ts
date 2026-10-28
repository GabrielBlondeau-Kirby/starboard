import { expect, test } from 'claude-code/testing'

import { completeSession, introduction, isConnectMessage, parseListing, partnersOf, summarizeEdges } from '../hooks/register'

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
