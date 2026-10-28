import { atom, read, update } from 'claude-code'
import type { EngineInterface as Engine, Register } from 'claude-code'

import type { Edge, Graph, Peer } from '../types'

const PANE = 'navi'
const POLL_MS = 5000
const EDGE_TTL_MS = 24 * 60 * 60 * 1000
const MAX_EDGES_PER_SESSION = 100
const MAX_FOOTER_PARTNERS = 3
const MIN_COMPLETION_CHARS = 3

const graph = atom({ plugin: 'navi', key: 'graph' } as const, { self: '', peers: [], edges: [], notice: '' })

type ListAgentsResult = {
  listing?: string
  sections?: { kind: string; rows: { name?: string; status?: string }[] }[]
}

type ConnectMessage = { kind: 'connect'; from: string; to: string }

// The store is shared by every session running this mod: each session writes only its own key,
// so two sessions never race on the same value.
const edgesKey = (self: string) => `edges:${self}`

const stripRef = (name: string) => name.replace(/\s*\[[^\]]*\]\s*$/, '').trim()

export const parseListing = (result: ListAgentsResult): { self: string; peers: Peer[] } => {
  const self = /This session is (\S+)/.exec(result.listing ?? '')?.[1] ?? ''
  const peers: Peer[] = []
  for (const section of result.sections ?? []) {
    for (const row of section.rows) {
      if (row.name) peers.push({ name: row.name, status: row.status, isSelf: false })
    }
  }
  if (self) peers.unshift({ name: self, status: 'cette session', isSelf: true })
  return { self, peers }
}

export type Link = { from: string; to: string; kind: Edge['kind']; count: number }

// A reply goes to the sender's socket (`uds:…`), not its name: only edges between listed sessions are shown.
export const summarizeEdges = (edges: Edge[], names: Set<string>): Link[] => {
  const links = new Map<string, Link>()
  for (const edge of edges) {
    if (!names.has(edge.from) || !names.has(edge.to)) continue
    const key = `${edge.kind}|${edge.from}|${edge.to}`
    const link = links.get(key) ?? { from: edge.from, to: edge.to, kind: edge.kind, count: 0 }
    links.set(key, { ...link, count: link.count + 1 })
  }
  return [...links.values()]
}

export const partnersOf = (edges: Edge[], names: Set<string>, self: string): string[] => {
  const partners = new Set<string>()
  for (const link of summarizeEdges(edges, names)) {
    if (link.from === self) partners.add(link.to)
    if (link.to === self) partners.add(link.from)
  }
  return [...partners]
}

export type SessionCompletion = { text: string; description: string }

// Linked sessions first, then the other listed ones; never this session itself.
export const completeSession = (token: string, g: Graph): SessionCompletion[] => {
  const typed = token.toLowerCase()
  if (typed.length < MIN_COMPLETION_CHARS) return []
  const partners = new Set(partnersOf(g.edges, new Set(g.peers.map(peer => peer.name)), g.self))
  return g.peers
    .filter(peer => !peer.isSelf && peer.name.toLowerCase().startsWith(typed) && peer.name.toLowerCase() !== typed)
    .sort((a, b) => Number(partners.has(b.name)) - Number(partners.has(a.name)))
    .map(peer => ({
      text: peer.name,
      description: [partners.has(peer.name) ? 'session liée' : 'session', peer.status].filter(Boolean).join(' · '),
    }))
}

export const isConnectMessage = (data: unknown): data is ConnectMessage =>
  typeof data === 'object' &&
  data !== null &&
  (data as ConnectMessage).kind === 'connect' &&
  typeof (data as ConnectMessage).from === 'string' &&
  typeof (data as ConnectMessage).to === 'string'

export const introduction = (partner: string) =>
  `[navi] La personne te met en relation avec la session « ${partner} », qui travaille sur un sujet lié au tien. ` +
  `Utilise SendMessage (to: "${partner}") pour te présenter : sur quoi tu travailles, ce que tu vas modifier et ce que tu attends d'elle. ` +
  `Coordonnez-vous avant toute modification qui touche son travail.`

async function readEdges($: Engine, now: number) {
  const edges: Edge[] = []
  for (const key of await $.store.keys()) {
    if (!key.startsWith('edges:')) continue
    const stored = (await $.store.get(key)) as Edge[] | undefined
    for (const edge of stored ?? []) if (now - edge.at < EDGE_TTL_MS) edges.push(edge)
  }
  return edges
}

async function recordEdge($: Engine, edge: Edge) {
  const { self } = await read($, graph)
  if (!self) return
  const key = edgesKey(self)
  const stored = ((await $.store.get(key)) as Edge[] | undefined) ?? []
  await $.store.set(key, [...stored, edge].slice(-MAX_EDGES_PER_SESSION))
  await update($, graph, g => ({ ...g, edges: [...g.edges, edge] }))
}

async function refresh($: Engine) {
  try {
    const call = await $.tool.call({ tool: 'ListAgents' })
    if ('deny' in call && call.deny) return
    const { self, peers } = parseListing((call.result ?? {}) as ListAgentsResult)
    const edges = await readEdges($, await $.clock.now())
    await update($, graph, g => ({ ...g, self, peers, edges }))
  } catch (error) {
    await update($, graph, g => ({ ...g, notice: `ListAgents indisponible : ${String(error)}` }))
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'navi',
      description: 'Ouvre le panneau des sessions locales et de leurs connexions',
    })
    // Earlier versions pinned the name as a status notice; the host keeps it until cleared.
    $.ui.status(undefined)
    void refresh($)
    $.clock.every(POLL_MS, () => refresh($))

    return next(e)
  })

  on('command.run', { command: 'navi' }, async $ => {
    await refresh($)
    await $.ui.open({ id: PANE, title: 'Sessions' })

    return { text: 'Panneau des sessions ouvert.' }
  })

  on('session.send', async ($, e, next) => {
    const sent = await next(e)
    if (sent.isDelivered && !e.agentId) {
      // The message is already delivered: failing to record it must never fail the send.
      try {
        const { self } = await read($, graph)
        await recordEdge($, { from: self, to: stripRef(e.to), at: await $.clock.now(), kind: 'message' })
      } catch {
        // best effort
      }
    }

    return sent
  })

  on('ui.message', async ($, e, next) => {
    if (!isConnectMessage(e.data)) return next(e)
    const { from, to } = e.data
    if (from === to) return next(e)

    const { self } = await read($, graph)
    const failures: string[] = []
    for (const [target, partner] of [
      [from, to],
      [to, from],
    ] as const) {
      if (target === self) {
        await $.session.append({ message: { type: 'user', content: [{ type: 'text', text: introduction(partner) }] } })
        continue
      }
      const sent = await $.session.send({ to: target, text: introduction(partner) })
      if (!sent.isDelivered) failures.push(`${target} : ${sent.reason}`)
    }

    if (failures.length === 0) {
      await recordEdge($, { from, to, at: await $.clock.now(), kind: 'link' })
      $.ui.toast(`Connexion créée : ${from} ↔ ${to}`)
      await update($, graph, g => ({ ...g, notice: '' }))
    } else {
      await update($, graph, g => ({ ...g, notice: `Échec : ${failures.join(' · ')}` }))
    }

    return next(e)
  })

  on('prompt.autocomplete', async ($, e, next) => {
    const completions = completeSession(e.token, await read($, graph))
    const { suggestions } = await next(e)
    if (completions.length === 0) return { suggestions }

    return { suggestions: [...suggestions, ...completions] }
  })

  // The session's SendMessage name at the right of the prompt footer, its linked sessions below it.
  on('ui.render', { component: 'SessionMode' }, async ($, e, next) => {
    const g: Graph = await read($, graph)
    if (!g.self) return next(e)

    const partners = partnersOf(g.edges, new Set(g.peers.map(peer => peer.name)), g.self)
    if (partners.length === 0) return next({ ...e, props: { ...e.props, modes: [...e.props.modes, `🌐 ${g.self}`] } })

    const { Box, Text } = $.ui.resolve(e)
    const shown = partners.slice(0, MAX_FOOTER_PARTNERS)
    const hidden = partners.length - shown.length

    return (
      <Box flexDirection="column" alignItems="flex-end">
        {e.props.modes.length > 0 && <Text dimColor>{e.props.modes.join(' & ')}</Text>}
        <Text dimColor>🌐 {g.self}</Text>
        {shown.map(partner => (
          <Text dimColor>🔗 {partner}</Text>
        ))}
        {hidden > 0 && <Text dimColor>+{hidden}</Text>}
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const elements = $.ui.resolve(e)
    const { Box, Text } = elements
    const g: Graph = await read($, graph)
    const rows = Math.max(3, g.peers.length + 2)
    const links = summarizeEdges(g.edges, new Set(g.peers.map(peer => peer.name)))

    return (
      <Box flexDirection="column">
        <Text dimColor>Glisse une session sur une autre pour les mettre en relation (ou ↑↓, espace puis entrée).</Text>
        {g.notice !== '' && <Text color="red">{g.notice}</Text>}
        {g.peers.length === 0 ? (
          <Text dimColor>Aucune session trouvée.</Text>
        ) : 'Client' in elements ? (
          <elements.Client key="graph" module="./graph.tsx" props={g} height={rows} />
        ) : (
          g.peers.map(peer => <Text>{peer.isSelf ? '★' : '●'} {peer.name}</Text>)
        )}
        <Text bold>Connexions (24 h)</Text>
        {links.length === 0 && <Text dimColor>Aucune connexion enregistrée.</Text>}
        {links.map(link => (
          <Text>
            {link.from} {link.kind === 'link' ? '↔' : '→'} {link.to}
            <Text dimColor> {link.kind === 'link' ? 'connexion' : `${link.count} message${link.count > 1 ? 's' : ''}`}</Text>
          </Text>
        ))}
      </Box>
    )
  })
}
