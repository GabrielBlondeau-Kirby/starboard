export type Peer = { name: string; status?: string; isSelf: boolean }
export type Edge = { from: string; to: string; at: number; kind: 'message' | 'link' }
export type Graph = { self: string; peers: Peer[]; edges: Edge[]; notice: string }

declare module 'claude-code' {
  interface PluginState {
    navi: { graph: Graph }
  }
}
