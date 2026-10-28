import type { ClientSurface, ClientPointerEvent, ClientKeyEvent } from 'claude-code'

import type { Graph } from '../types'

type DragState = { cursor: number; source?: number; hover?: number }

const partnersOf = (graph: Graph, name: string) => {
  const partners = new Set<string>()
  const names = new Set(graph.peers.map(peer => peer.name))
  for (const edge of graph.edges) {
    if (!names.has(edge.from) || !names.has(edge.to)) continue
    if (edge.from === name) partners.add(edge.to)
    if (edge.to === name) partners.add(edge.from)
  }
  return [...partners]
}

export default function SessionGraph(graph: Graph, surface: ClientSurface<DragState>) {
  const { Box, Text } = surface.elements
  const state: DragState = surface.state ?? { cursor: 0 }
  const count = graph.peers.length
  const rowAt = (y: number) => (y >= 0 && y < count ? y : undefined)

  const connect = (source: number | undefined, target: number | undefined) => {
    const from = source === undefined ? undefined : graph.peers[source]
    const to = target === undefined ? undefined : graph.peers[target]
    if (!from || !to || from === to) return
    surface.post({ kind: 'connect', from: from.name, to: to.name })
  }

  // Set on every call (a later call replaces the listener) so it always reads the current peers.
  {
    surface.onPointer((event: ClientPointerEvent) => {
      const current = surface.state ?? { cursor: 0 }
      const row = rowAt(event.y)
      if (event.type === 'down' && event.button === 'left' && row !== undefined) {
        surface.setState({ ...current, cursor: row, source: row, hover: row })
      } else if (event.type === 'move' && current.source !== undefined) {
        surface.setState({ ...current, hover: row })
      } else if (event.type === 'up' && current.source !== undefined) {
        connect(current.source, row)
        surface.setState({ cursor: row ?? current.cursor })
      }
    })
    surface.onKey((event: ClientKeyEvent) => {
      const current = surface.state ?? { cursor: 0 }
      if (event.key === 'up') surface.setState({ ...current, cursor: Math.max(0, current.cursor - 1) })
      else if (event.key === 'down') surface.setState({ ...current, cursor: Math.min(count - 1, current.cursor + 1) })
      else if (event.key === ' ') surface.setState({ ...current, source: current.cursor })
      else if (event.key === 'x') {
        const peer = graph.peers[current.cursor]
        if (peer && !peer.isSelf) surface.post({ kind: 'cut', peer: peer.name })
      } else if (event.key === 'return') {
        connect(current.source, current.cursor)
        surface.setState({ cursor: current.cursor })
      }
    })
  }

  return (
    <Box flexDirection="column">
      {graph.peers.map((peer, index) => {
        const isSource = state.source === index
        const isTarget = state.source !== undefined && state.hover === index && !isSource
        const partners = partnersOf(graph, peer.name)
        const mark = isSource ? '◉' : isTarget ? '➜' : state.cursor === index ? '›' : ' '
        return (
          <Text inverse={isTarget} color={isSource ? 'cyan' : peer.isSelf ? 'green' : undefined}>
            {mark} {peer.isSelf ? '★' : '●'} {peer.name}
            <Text dimColor> {peer.status ?? ''}</Text>
            {partners.length > 0 && <Text color="yellow"> ↔ {partners.join(', ')}</Text>}
          </Text>
        )
      })}
    </Box>
  )
}
