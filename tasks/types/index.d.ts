export type Task = {
  /** 1-based, in file order across all sources: what `/tasks do <n>` takes. */
  n: number
  /** The file it was read from, as the sources name it. */
  source: string
  /** 0-based line of the task's bullet in its file. */
  line: number
  done: boolean
  title: string
  /** The rest of the item: its first line after the title, and its continuation lines. */
  body: string
  /** False for a plain bullet under a to-do heading: ticking it adds the box. */
  hasBox: boolean
}

declare module 'claude-code' {
  interface PluginState {
    tasks: {
      list: Task[]
      sources: string[]
    }
  }
}
