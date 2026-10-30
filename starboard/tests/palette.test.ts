import { expect, test } from 'claude-code/testing'

import { cardOf, contrast, hex, hueOf, INK, MARK_INK, paletteOf } from '../hooks/palette'

const IDS = ['workspace-info', 'ci-status', 'navi', 'docker-stacks', 'tasks', 'a', 'zz-another-section']

test('converts HSL to hex', () => {
  expect(hex(0, 100, 50)).toBe('#ff0000')
  expect(hex(120, 100, 25)).toBe('#008000')
  expect(hex(0, 0, 100)).toBe('#ffffff')
})

test('a section keeps its card from one redraw to the next', () => {
  expect(cardOf('ci-status')).toEqual(cardOf('ci-status'))
  expect(new Set(IDS.map(hueOf)).size).toBe(IDS.length)
})

test('every card is pastel and every ink reads on it', () => {
  for (const id of IDS) {
    const { background, title } = cardOf(id)
    expect(contrast(background, '#000000')).toBeGreaterThan(12)
    expect(contrast(title, background)).toBeGreaterThanOrEqual(4.5)
    expect(contrast(INK.text, background)).toBeGreaterThanOrEqual(4.5)
    expect(contrast(INK.link, background)).toBeGreaterThanOrEqual(4.5)
    expect(contrast(INK.dim, background)).toBeGreaterThanOrEqual(4.5)
    for (const ink of Object.values(MARK_INK)) expect(contrast(ink, background)).toBeGreaterThanOrEqual(3)
  }
})

test('a desktop keeps its own background and theme inks, the terminal its pastel cards', () => {
  expect(paletteOf('terminal').card('ci-status').background).toBe(cardOf('ci-status').background)
  expect(paletteOf('desktop').card('ci-status').background).toBeUndefined()
  expect(paletteOf('desktop').ink.text).toBe('text')
})
