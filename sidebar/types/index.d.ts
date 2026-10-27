export type SidebarStatus = 'ok' | 'warn' | 'error' | 'off'

export type SidebarRow = {
  label?: string
  value: string
  status?: SidebarStatus
  dim?: boolean
}

export type SidebarSection = {
  id: string
  title: string
  order?: number
  rows: SidebarRow[]
  note?: string
}

export type Sidebar = {
  publish: (section: SidebarSection) => Promise<void>
  remove: (id: string) => Promise<void>
}

declare module 'claude-code' {
  interface EngineInterface {
    sidebar: Sidebar
  }
  interface PluginState {
    sidebar: {
      sections: Record<string, SidebarSection>
      collapsed: Record<string, boolean>
    }
  }
}
