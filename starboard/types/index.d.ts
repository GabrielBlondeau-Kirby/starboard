export type StarboardStatus = 'ok' | 'warn' | 'error' | 'off'

export type StarboardRow = {
  label?: string
  value: string
  status?: StarboardStatus
  dim?: boolean
  /** Draws the value as a link to this URL. */
  href?: string
}

/** A button in the section header: runs `/command args` as if the person typed it. */
export type StarboardAction = {
  /** One or two characters, an icon ("🧹", "◎"). */
  label: string
  /** Names the button for screen readers and the hover hint. */
  hint: string
  command: string
  args?: string
}

export type StarboardSection = {
  id: string
  title: string
  order?: number
  rows: StarboardRow[]
  /** Short text on the right of the header, shown folded or not ("11 %", "2 actifs"). */
  summary?: string
  note?: string
  actions?: StarboardAction[]
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
      layout: string[]
    }
  }
}
