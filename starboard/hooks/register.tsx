import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { StarboardRow, StarboardSection, StarboardStatus } from '../types'
import { paletteOf } from './palette'

const PANE = 'starboard'
const sections = atom({ plugin: 'starboard', key: 'sections' } as const, {})
const collapsed = atom({ plugin: 'starboard', key: 'collapsed' } as const, {})
// The order the person chose with ▲ ▼, kept across sessions; sections it does not name follow their own `order`.
const layout = atom({ plugin: 'starboard', key: 'layout' } as const, [])
const LAYOUT = 'layout'
// Folded: the side pane closed, its summary in the footer instead; kept across sessions.
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

// The footer, not the band above the prompt: that band draws one plugin's tree only, and other mods take it.
export const footerOf = (list: StarboardSection[]): string =>
  ['⇥ /starboard', ...list.map(section => (section.summary ? `${section.title} ${section.summary}` : section.title))].join(' · ')

async function showFooter($: EngineInterface) {
  if (!(await read($, compact))) return
  $.ui.status(footerOf(sortSections(await read($, sections), await read($, layout))))
}

async function fold($: EngineInterface) {
  await update($, compact, () => true)
  await $.store.set(COMPACT, true)
  await $.ui.close({ id: PANE })
  await showFooter($)
}

async function unfold($: EngineInterface) {
  await update($, compact, () => false)
  await $.store.set(COMPACT, false)
  $.ui.status(undefined)
  await $.ui.open({ id: PANE, title: 'Starboard' })
}

export const register: Register = on => {
  // `$.starboard` is a noun: each call raises `starboard.publish` / `starboard.remove`, answered below with our own `$`.
  on('engine.create', async ($, e, next) => {
    const built = await next(e)
    return { ...built, starboard: { publish: async () => {}, remove: async () => {} } }
  })

  on('starboard.publish', async ($, section) => {
    await update($, sections, all => ({ ...all, [section.id]: section }))
    await showFooter($)
    return { value: undefined }
  })

  on('starboard.remove', async ($, id) => {
    await update($, sections, all => {
      const { [id]: _, ...rest } = all
      return rest
    })
    await showFooter($)
    return { value: undefined }
  })

  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'starboard', description: 'Ouvre le panneau latéral des mods ; /starboard reset rend aux sections leur ordre par défaut' })
    const saved = await $.store.get(LAYOUT)
    if (Array.isArray(saved)) await update($, layout, () => saved.filter((id): id is string => typeof id === 'string'))
    const isFoldedAway = (await $.store.get(COMPACT)) === true
    if (isFoldedAway) await update($, compact, () => true)
    if (!isFoldedAway) void $.ui.open({ id: PANE, title: 'Starboard' })
    return next(e)
  })

  on('command.run', { command: 'starboard' }, async ($, e) => {
    if (e.args.trim().toLowerCase() === 'reset') {
      await update($, layout, () => [])
      await $.store.set(LAYOUT, [])
      return { text: 'Sections remises dans leur ordre par défaut.' }
    }
    await unfold($)
    return { text: 'Panneau latéral ouvert.' }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button, Link } = $.ui.resolve(e)
    const { ink, marks, card: cardOf } = paletteOf(e.surface)
    const list = sortSections(await read($, sections), await read($, layout))
    const move = async (id: string, step: -1 | 1) => {
      const next = moveSection(list.map(section => section.id), id, step)
      await update($, layout, () => next)
      await $.store.set(LAYOUT, next)
    }
    const folded = await read($, collapsed)
    // Mirrors the desktop app's own sidebar: one rounded card per section, the title with its caret,
    // a summary on the right of the header, each row's value flush right.
    const row = (one: StarboardRow) => {
      return (
        <Box flexDirection="row" justifyContent="space-between" gap={1}>
          <Box flexDirection="row" gap={1} flexShrink={0}>
            {one.status && <Text color={marks[one.status]}>{MARKS[one.status]}</Text>}
            {one.label && <Text color={ink.dim}>{one.label}</Text>}
          </Box>
          {one.href
            ? <Text color={ink.link} underline wrap="truncate-end"><Link href={one.href}>{one.value}</Link></Text>
            : <Text color={one.dim ? ink.dim : ink.text} wrap="truncate-end">{one.value}</Text>}
        </Box>
      )
    }

    const compactButton = (
      <Box flexDirection="row" justifyContent="flex-end">
        <Button key="fold" plain onPress={() => fold($)}>
          <Text dimColor>⇤</Text>
        </Button>
      </Box>
    )

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
                  onPress={() => update($, collapsed, all => ({ ...all, [section.id]: !isFolded }))}
                >
                  <Text weight="semibold" bold color={card.title}>{section.title}</Text>
                  <Text color={ink.dim}> {isFolded ? '▸' : '▾'}</Text>
                </Button>
                <Box flexDirection="row" gap={1} flexShrink={1}>
                  {section.summary && <Text color={ink.dim} wrap="truncate-end">{section.summary}</Text>}
                  {(section.actions ?? []).map(action => (
                    <Button
                      key={`action-${section.id}-${action.command}-${action.args ?? ''}`}
                      plain
                     
                      onPress={() => void $.command.run({ command: action.command, args: action.args ?? '' }).catch(() => {})}
                    >
                      <Text color={ink.link}>{action.label}</Text>
                    </Button>
                  ))}
                  {index > 0 && (
                    <Button key={`up-${section.id}`} plain onPress={() => move(section.id, -1)}>
                      <Text color={ink.dim}>▲</Text>
                    </Button>
                  )}
                  {index < list.length - 1 && (
                    <Button key={`down-${section.id}`} plain onPress={() => move(section.id, 1)}>
                      <Text color={ink.dim}>▼</Text>
                    </Button>
                  )}
                </Box>
              </Box>
              {!isFolded && section.rows.map(row)}
              {!isFolded && section.note && <Text color={ink.dim}>{section.note}</Text>}
            </Box>
          )
        })}
      </Box>
    )
  })
}
