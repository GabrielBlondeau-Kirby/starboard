import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { StarboardRow, StarboardSection, StarboardStatus } from '../types'

const PANE = 'starboard'
const sections = atom({ plugin: 'starboard', key: 'sections' } as const, {})
const collapsed = atom({ plugin: 'starboard', key: 'collapsed' } as const, {})

const MARKS: Record<StarboardStatus, { mark: string; color: string }> = {
  ok: { mark: '●', color: 'success' },
  warn: { mark: '●', color: 'warning' },
  error: { mark: '●', color: 'error' },
  off: { mark: '○', color: 'inactive' },
}

export const sortSections = (all: Record<string, StarboardSection>): StarboardSection[] =>
  Object.values(all).sort((a, b) => (a.order ?? 100) - (b.order ?? 100) || a.title.localeCompare(b.title))

export const register: Register = on => {
  // `$.starboard` is a noun: each call raises `starboard.publish` / `starboard.remove`, answered below with our own `$`.
  on('engine.create', async ($, e, next) => {
    const built = await next(e)
    return { ...built, starboard: { publish: async () => {}, remove: async () => {} } }
  })

  on('starboard.publish', async ($, section) => {
    await update($, sections, all => ({ ...all, [section.id]: section }))
    return { value: undefined }
  })

  on('starboard.remove', async ($, id) => {
    await update($, sections, all => {
      const { [id]: _, ...rest } = all
      return rest
    })
    return { value: undefined }
  })

  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'starboard', description: 'Ouvre le panneau latéral des mods' })
    void $.ui.open({ id: PANE, title: 'Starboard' })
    return next(e)
  })

  on('command.run', { command: 'starboard' }, async $ => {
    await $.ui.open({ id: PANE, title: 'Starboard' })
    return { text: 'Panneau latéral ouvert.' }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const list = sortSections(await read($, sections))
    const folded = await read($, collapsed)

    const row = (one: StarboardRow) => {
      const status = one.status && MARKS[one.status]
      return (
        <Box flexDirection="row" gap={1}>
          {status && <Text color={status.color}>{status.mark}</Text>}
          {one.label && <Text dimColor>{one.label}</Text>}
          <Text dimColor={one.dim} wrap="truncate-end">{one.value}</Text>
        </Box>
      )
    }

    return (
      <Box flexDirection="column" gap={1}>
        {list.length === 0 && <Text dimColor>Aucune section publiée pour l'instant.</Text>}
        {list.map(section => {
          const isFolded = folded[section.id] === true
          return (
            <Box flexDirection="column">
              <Button
                key={`toggle-${section.id}`}
                plain
                onPress={() => update($, collapsed, all => ({ ...all, [section.id]: !isFolded }))}
              >
                <Text bold>{isFolded ? '▸' : '▾'} {section.title}</Text>
              </Button>
              {!isFolded && section.rows.map(row)}
              {!isFolded && section.note && <Text dimColor>{section.note}</Text>}
            </Box>
          )
        })}
      </Box>
    )
  })
}
