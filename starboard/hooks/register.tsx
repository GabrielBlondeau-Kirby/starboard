import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { StarboardRow, StarboardSection, StarboardStatus } from '../types'
import { cardOf, INK, MARK_INK } from './palette'

const PANE = 'starboard'
const sections = atom({ plugin: 'starboard', key: 'sections' } as const, {})
const collapsed = atom({ plugin: 'starboard', key: 'collapsed' } as const, {})
// The order the person chose with ▲ ▼, kept across sessions; sections it does not name follow their own `order`.
const layout = atom({ plugin: 'starboard', key: 'layout' } as const, [])
const LAYOUT = 'layout'
// Folded to one line per section (its title and summary), kept across sessions.
const compact = atom({ plugin: 'starboard', key: 'compact' } as const, false)
const COMPACT = 'compact'

const MARKS: Record<StarboardStatus, string> = { ok: '●', warn: '●', error: '●', off: '○' }

export function sortSections(all: Record<string, StarboardSection>, chosen: string[] = []): StarboardSection[] {
  const byDefault = Object.values(all).sort((a, b) => (a.order ?? 100) - (b.order ?? 100) || a.title.localeCompare(b.title))
  const rank = (section: StarboardSection) => {
    const index = chosen.indexOf(section.id)
    return index >= 0 ? index : chosen.length + byDefault.indexOf(section)
  }
  return byDefault.sort((a, b) => rank(a) - rank(b))
}

// Swaps a section with its neighbour; the whole shown order is kept, so the next session finds it as is.
export function moveSection(ids: string[], id: string, step: -1 | 1): string[] {
  const from = ids.indexOf(id)
  const to = from + step
  if (from < 0 || to < 0 || to >= ids.length) return ids
  const moved = [...ids]
  moved[from] = ids[to] ?? id
  moved[to] = id
  return moved
}

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
    await $.command.register({ name: 'starboard', description: 'Ouvre le panneau latéral des mods ; /starboard reset rend aux sections leur ordre par défaut' })
    const saved = await $.store.get(LAYOUT)
    if (Array.isArray(saved)) await update($, layout, () => saved.filter((id): id is string => typeof id === 'string'))
    if ((await $.store.get(COMPACT)) === true) await update($, compact, () => true)
    void $.ui.open({ id: PANE, title: 'Starboard' })
    return next(e)
  })

  on('command.run', { command: 'starboard' }, async ($, e) => {
    if (e.args.trim().toLowerCase() === 'reset') {
      await update($, layout, () => [])
      await $.store.set(LAYOUT, [])
      return { text: 'Sections remises dans leur ordre par défaut.' }
    }
    await $.ui.open({ id: PANE, title: 'Starboard' })
    return { text: 'Panneau latéral ouvert.' }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button, Link } = $.ui.resolve(e)
    const list = sortSections(await read($, sections), await read($, layout))
    const move = async (id: string, step: -1 | 1) => {
      const next = moveSection(list.map(section => section.id), id, step)
      await update($, layout, () => next)
      await $.store.set(LAYOUT, next)
    }
    const folded = await read($, collapsed)
    const isCompact = await read($, compact)
    const toggleCompact = async () => {
      await update($, compact, value => !value)
      await $.store.set(COMPACT, !isCompact)
    }
    const compactButton = (
      <Box flexDirection="row" justifyContent="flex-end">
        <Button key="compact" plain label={isCompact ? 'Déplier le panneau' : 'Panneau compact'} onPress={toggleCompact}>
          <Text dimColor>{isCompact ? '⇥' : '⇤'}</Text>
        </Button>
      </Box>
    )

    if (isCompact) {
      return (
        <Box flexDirection="column">
          {compactButton}
          {list.map(section => {
            const card = cardOf(section.id)
            return (
              <Box flexDirection="row" gap={1} backgroundColor={card.background} paddingX={1}>
                <Text bold color={card.title} wrap="truncate-end">{section.title}</Text>
                {section.summary && <Text color={INK.dim} wrap="truncate-end">{section.summary}</Text>}
              </Box>
            )
          })}
        </Box>
      )
    }

    // Mirrors the desktop app's own sidebar: one rounded card per section, the title with its caret,
    // a summary on the right of the header, each row's value flush right.
    const row = (one: StarboardRow) => {
      return (
        <Box flexDirection="row" justifyContent="space-between" gap={1}>
          <Box flexDirection="row" gap={1} flexShrink={0}>
            {one.status && <Text color={MARK_INK[one.status]}>{MARKS[one.status]}</Text>}
            {one.label && <Text color={INK.dim}>{one.label}</Text>}
          </Box>
          {one.href
            ? <Text color={INK.link} underline wrap="truncate-end"><Link href={one.href}>{one.value}</Link></Text>
            : <Text color={one.dim ? INK.dim : INK.text} wrap="truncate-end">{one.value}</Text>}
        </Box>
      )
    }

    return (
      <Box flexDirection="column" gap="sm">
        {compactButton}
        {list.length === 0 && <Text dimColor>Aucune section publiée pour l'instant.</Text>}
        {list.map((section, index) => {
          const isFolded = folded[section.id] === true
          const card = cardOf(section.id)
          return (
            <Box flexDirection="column" borderStyle="round" borderColor={card.border} backgroundColor={card.background} paddingX={1} gap="xs">
              <Box flexDirection="row" justifyContent="space-between" gap={1}>
                <Button
                  key={`toggle-${section.id}`}
                  plain
                  label={section.title}
                  onPress={() => update($, collapsed, all => ({ ...all, [section.id]: !isFolded }))}
                >
                  <Text weight="semibold" bold color={card.title}>{section.title}</Text>
                  <Text color={INK.dim}> {isFolded ? '▸' : '▾'}</Text>
                </Button>
                <Box flexDirection="row" gap={1} flexShrink={1}>
                  {section.summary && <Text color={INK.dim} wrap="truncate-end">{section.summary}</Text>}
                  {(section.actions ?? []).map(action => (
                    <Button
                      key={`action-${section.id}-${action.command}-${action.args ?? ''}`}
                      plain
                      label={action.hint}
                      onPress={() => void $.command.run({ command: action.command, args: action.args ?? '' }).catch(() => {})}
                    >
                      <Text color={INK.link}>{action.label}</Text>
                    </Button>
                  ))}
                  {index > 0 && (
                    <Button key={`up-${section.id}`} plain label={`Monter ${section.title}`} onPress={() => move(section.id, -1)}>
                      <Text color={INK.dim}>▲</Text>
                    </Button>
                  )}
                  {index < list.length - 1 && (
                    <Button key={`down-${section.id}`} plain label={`Descendre ${section.title}`} onPress={() => move(section.id, 1)}>
                      <Text color={INK.dim}>▼</Text>
                    </Button>
                  )}
                </Box>
              </Box>
              {!isFolded && section.rows.map(row)}
              {!isFolded && section.note && <Text color={INK.dim}>{section.note}</Text>}
            </Box>
          )
        })}
      </Box>
    )
  })
}
