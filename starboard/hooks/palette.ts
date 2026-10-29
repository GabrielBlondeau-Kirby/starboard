import type { StarboardStatus } from '../types'

export type Card = { background?: string; border: string; title: string }
export type Ink = { text: string; dim: string; link: string }
export type Palette = { ink: Ink; marks: Record<StarboardStatus, string>; card: (id: string) => Card }

// Dark inks on every pastel card: the terminal's own text colors are made for its background, not ours.
export const INK = { text: '#1f2328', dim: '#4b535c', link: '#0a4f96' }
export const MARK_INK: Record<StarboardStatus, string> = { ok: '#1a7f37', warn: '#9a6700', error: '#cf222e', off: '#59616b' }

const MIN_CONTRAST = 4.5

// A stable pick per section: the same card each redraw, a different one from section to section.
export function hueOf(id: string): number {
  let hash = 2166136261
  for (const char of id) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619)
  return (hash >>> 0) % 360
}

export function hex(hue: number, saturation: number, lightness: number): string {
  const s = saturation / 100
  const l = lightness / 100
  const k = (n: number) => (n + hue / 30) % 12
  const a = s * Math.min(l, 1 - l)
  const channel = (n: number) => Math.round(255 * (l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1))))
  return `#${[0, 8, 4].map(n => channel(n).toString(16).padStart(2, '0')).join('')}`
}

const luminance = (color: string): number => {
  const [r = 0, g = 0, b = 0] = [1, 3, 5].map(i => parseInt(color.slice(i, i + 2), 16) / 255)
    .map(c => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4))
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

export const contrast = (a: string, b: string): number => {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return ((light ?? 0) + 0.05) / ((dark ?? 0) + 0.05)
}

// A pastel background, and a title in a far hue darkened until it reads on it (WCAG AA, 4.5:1).
export function cardOf(id: string): Card & { background: string } {
  const hue = hueOf(id)
  const background = hex(hue, 28, 85)
  const titleHue = (hue + 150) % 360
  let lightness = 34
  let title = hex(titleHue, 70, lightness)
  while (contrast(title, background) < MIN_CONTRAST && lightness > 10) title = hex(titleHue, 70, (lightness -= 2))
  return { background, border: hex(hue, 25, 62), title }
}

// A desktop draws each Button natively, in its own theme's text color whatever we ask: on a pastel card
// that text vanishes. There the cards keep the app's background and the inks are the theme's own keys.
const THEMED: Palette = {
  ink: { text: 'text', dim: 'inactive', link: 'suggestion' },
  marks: { ok: 'success', warn: 'warning', error: 'error', off: 'inactive' },
  card: id => ({ border: hex(hueOf(id), 45, 55), title: 'text' }),
}

const PASTEL: Palette = { ink: INK, marks: MARK_INK, card: cardOf }

export const paletteOf = (surface: string): Palette => (surface === 'terminal' ? PASTEL : THEMED)
