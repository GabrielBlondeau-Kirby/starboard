import { atom, read, update } from 'claude-code'
import type { EngineInterface as Engine, Register } from 'claude-code'

import type { Cut, Edge, Graph, Peer } from '../types'

// The starboard contract, kept local: the mod does not depend on `starboard`, it only uses it when present.
type StarboardRow = { label?: string; value: string; status?: 'ok' | 'warn' | 'error' | 'off'; dim?: boolean }
type StarboardSection = { id: string; title: string; order?: number; summary?: string; rows: StarboardRow[] }
type WithStarboard = Engine & { starboard: { publish: (section: StarboardSection) => Promise<void> } }

const PANE = 'navi'
const SECTION = 'navi'
const ALL = '*'
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
type CutMessage = { kind: 'cut'; peer: string }

// The store is shared by every session running this mod: each session writes only its own keys,
// so two sessions never race on the same value.
const edgesKey = (self: string) => `edges:${self}`
const cutsKey = (self: string) => `cuts:${self}`

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

const cuts = (cut: Cut, by: string, other: string) => cut.by === by && (cut.peer === ALL || cut.peer === other)

// Either side may have cut the pair; a message or a connection made after the cut brings the link back.
export const isCut = (edge: Edge, all: Cut[]): boolean =>
  all.some(cut => cut.at >= edge.at && (cuts(cut, edge.from, edge.to) || cuts(cut, edge.to, edge.from)))

export const liveEdges = (edges: Edge[], all: Cut[]): Edge[] => edges.filter(edge => !isCut(edge, all))

export const sectionOf = (g: Graph): StarboardSection => {
  const partners = partnersOf(g.edges, new Set(g.peers.map(peer => peer.name)), g.self)
  const status = (name: string) => g.peers.find(peer => peer.name === name)?.status
  const rows: StarboardRow[] = [
    { label: '🌐', value: g.self, status: 'ok' },
    ...partners.map((name): StarboardRow => ({ label: '🔗', value: name, status: status(name) === 'busy' ? 'warn' : 'ok' })),
  ]
  if (partners.length === 0) rows.push({ value: 'aucune session liée', dim: true })
  const summary = `${partners.length} liée${partners.length > 1 ? 's' : ''}`
  return { id: SECTION, title: 'Sessions', order: 30, summary, rows }
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

export const isCutMessage = (data: unknown): data is CutMessage =>
  typeof data === 'object' && data !== null && (data as CutMessage).kind === 'cut' && typeof (data as CutMessage).peer === 'string'

export const introduction = (partner: string) =>
  `[navi] La personne te met en relation avec la session « ${partner} », qui travaille sur un sujet lié au tien. ` +
  `Utilise SendMessage (to: "${partner}") pour te présenter : sur quoi tu travailles, ce que tu vas modifier et ce que tu attends d'elle. ` +
  `Coordonnez-vous avant toute modification qui touche son travail.`

async function readEdges($: Engine, now: number) {
  const edges: Edge[] = []
  const all: Cut[] = []
  for (const key of await $.store.keys()) {
    if (key.startsWith('edges:')) {
      const stored = (await $.store.get(key)) as Edge[] | undefined
      for (const edge of stored ?? []) if (now - edge.at < EDGE_TTL_MS) edges.push(edge)
    } else if (key.startsWith('cuts:')) {
      const stored = (await $.store.get(key)) as Omit<Cut, 'by'>[] | undefined
      for (const cut of stored ?? []) if (now - cut.at < EDGE_TTL_MS) all.push({ ...cut, by: key.slice('cuts:'.length) })
    }
  }
  return liveEdges(edges, all)
}

// Each refresh would redraw the starboard pane: publish only what changed.
let published = ''

async function publish($: Engine) {
  const g: Graph = await read($, graph)
  if (!g.self) return
  const section = sectionOf(g)
  const text = JSON.stringify(section)
  if (text === published) return
  published = text
  try {
    await ($ as WithStarboard).starboard.publish(section)
  } catch {
    // No starboard: the prompt footer already shows the session and its links.
  }
}

async function recordEdge($: Engine, edge: Edge) {
  const { self } = await read($, graph)
  if (!self) return
  const key = edgesKey(self)
  const stored = ((await $.store.get(key)) as Edge[] | undefined) ?? []
  await $.store.set(key, [...stored, edge].slice(-MAX_EDGES_PER_SESSION))
  await update($, graph, g => ({ ...g, edges: [...g.edges, edge] }))
  await publish($)
}

async function refresh($: Engine) {
  try {
    const call = await $.tool.call({ tool: 'ListAgents' })
    if ('deny' in call && call.deny) return
    const { self, peers } = parseListing((call.result ?? {}) as ListAgentsResult)
    const edges = await readEdges($, await $.clock.now())
    await update($, graph, g => ({ ...g, self, peers, edges }))
    await publish($)
  } catch (error) {
    await update($, graph, g => ({ ...g, notice: `ListAgents indisponible : ${String(error)}` }))
  }
}

// Records the cut under this session's own key; `peer` is a session name or ALL.
async function cut($: Engine, peer: string): Promise<string> {
  const g: Graph = await read($, graph)
  if (!g.self) return 'Nom de cette session inconnu : connexion impossible à couper.'
  const partners = partnersOf(g.edges, new Set(g.peers.map(p => p.name)), g.self)
  if (peer !== ALL && !partners.includes(peer)) return `Aucune connexion avec « ${peer} ».`
  if (partners.length === 0) return 'Aucune connexion à couper.'

  const now = await $.clock.now()
  const key = cutsKey(g.self)
  const stored = ((await $.store.get(key)) as Omit<Cut, 'by'>[] | undefined) ?? []
  await $.store.set(key, [...stored.filter(c => now - c.at < EDGE_TTL_MS), { peer, at: now }].slice(-MAX_EDGES_PER_SESSION))
  await refresh($)

  const text = peer === ALL ? `Toutes les connexions de ${g.self} coupées (${partners.length})` : `Connexion coupée : ${g.self} ↔ ${peer}`
  $.ui.toast(text)
  return `${text}.`
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'navi',
      description: 'Panneau des sessions locales ; /navi cut <session> coupe une connexion, /navi cut-all toutes',
    })
    // Earlier versions pinned the name as a status notice; the host keeps it until cleared.
    $.ui.status(undefined)
    void refresh($)
    $.clock.every(POLL_MS, () => refresh($))

    return next(e)
  })

  on('command.run', { command: 'navi' }, async ($, e) => {
    const [action = '', ...rest] = e.args.trim().split(/\s+/)
    await refresh($)
    if (action === 'cut-all') return { text: await cut($, ALL) }
    if (action === 'cut') {
      const peer = stripRef(rest.join(' '))
      return { text: peer ? await cut($, peer) : 'Usage : /navi cut <session>' }
    }
    if (action !== '') return { text: 'Usage : /navi, /navi cut <session>, /navi cut-all' }
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
    if (isCutMessage(e.data)) {
      const text = await cut($, e.data.peer)
      await update($, graph, g => ({ ...g, notice: text.startsWith('Connexion coupée') ? '' : text }))
      return next(e)
    }
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
        <Text dimColor>Glisse une session sur une autre pour les mettre en relation (ou ↑↓, espace puis entrée) ; x coupe la connexion avec la session sous le curseur.</Text>
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
