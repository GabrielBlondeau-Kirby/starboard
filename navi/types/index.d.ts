export type Peer = { name: string; status?: string; isSelf: boolean }
export type Edge = { from: string; to: string; at: number; kind: 'message' | 'link' }
// `by` cut its links with `peer` ('*': with every session) at `at`; edges up to then are ignored.
export type Cut = { by: string; peer: string; at: number }
export type Graph ={ self: string; peers: Peer[]; edges: Edge[]; notice: string }

declare module 'claude-code' {
  interface PluginState {
    navi: { graph: Graph }
  }
}
