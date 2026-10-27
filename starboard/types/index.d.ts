export type StarboardStatus = 'ok' | 'warn' | 'error' | 'off'

export type StarboardRow = {
  label?: string
  value: string
  status?: StarboardStatus
  dim?: boolean
}

export type StarboardSection = {
  id: string
  title: string
  order?: number
  rows: StarboardRow[]
  /** Short text on the right of the header, shown folded or not ("11 %", "2 actifs"). */
  summary?: string
  note?: string
}

export type Starboard = {
  publish: (section: StarboardSection) => Promise<void>
  remove: (id: string) => Promise<void>
}

declare module 'claude-code' {
  interface EngineInterface {
    starboard: Starboard
  }
  interface PluginState {
    starboard: {
      sections: Record<string, StarboardSection>
      collapsed: Record<string, boolean>
    }
  }
}
