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
    const { Box, Text, Button, Link } = $.ui.resolve(e)
    const list = sortSections(await read($, sections))
    const folded = await read($, collapsed)

    // Mirrors the desktop app's own sidebar: one rounded card per section, the title with its caret,
    // a summary on the right of the header, each row's value flush right.
    const row = (one: StarboardRow) => {
      const status = one.status && MARKS[one.status]
      return (
        <Box flexDirection="row" justifyContent="space-between" gap={1}>
          <Box flexDirection="row" gap={1} flexShrink={0}>
            {status && <Text color={status.color}>{status.mark}</Text>}
            {one.label && <Text dimColor>{one.label}</Text>}
          </Box>
          <Text dimColor={one.dim} wrap="truncate-end">
            {one.href ? <Link href={one.href}>{one.value}</Link> : one.value}
          </Text>
        </Box>
      )
    }

    return (
      <Box flexDirection="column" gap="sm">
        {list.length === 0 && <Text dimColor>Aucune section publiée pour l'instant.</Text>}
        {list.map(section => {
          const isFolded = folded[section.id] === true
          return (
            <Box flexDirection="column" borderStyle="round" borderColor="subtle" paddingX={1} gap="xs">
              <Box flexDirection="row" justifyContent="space-between" gap={1}>
                <Button
                  key={`toggle-${section.id}`}
                  plain
                  label={section.title}
                  onPress={() => update($, collapsed, all => ({ ...all, [section.id]: !isFolded }))}
                >
                  <Text weight="semibold">{section.title}</Text>
                  <Text dimColor> {isFolded ? '▸' : '▾'}</Text>
                </Button>
                {section.summary && <Text dimColor wrap="truncate-end">{section.summary}</Text>}
              </Box>
              {!isFolded && section.rows.map(row)}
              {!isFolded && section.note && <Text dimColor>{section.note}</Text>}
            </Box>
          )
        })}
      </Box>
    )
  })
}
