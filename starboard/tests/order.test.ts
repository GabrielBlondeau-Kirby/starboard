import { expect, test } from 'claude-code/testing'

import { footerOf, moveSection, sortSections } from '../hooks/register'

const section = (id: string, order?: number) => ({ id, title: id, order, rows: [] })
const ALL = { ctx: section('ctx', 10), ci: section('ci', 20), docker: section('docker', 40), tasks: section('tasks') }

test('sections follow their own order until the person chooses one', () => {
  expect(sortSections(ALL).map(s => s.id)).toEqual(['ctx', 'ci', 'docker', 'tasks'])
  expect(sortSections(ALL, ['docker', 'ctx']).map(s => s.id)).toEqual(['docker', 'ctx', 'ci', 'tasks'])
})

test('a section moves one step up or down, never past the ends', () => {
  const ids = ['ctx', 'ci', 'docker']
  expect(moveSection(ids, 'ci', -1)).toEqual(['ci', 'ctx', 'docker'])
  expect(moveSection(ids, 'ci', 1)).toEqual(['ctx', 'docker', 'ci'])
  expect(moveSection(ids, 'ctx', -1)).toEqual(ids)
  expect(moveSection(ids, 'docker', 1)).toEqual(ids)
  expect(moveSection(ids, 'gone', 1)).toEqual(ids)
})

test('folded, the footer names each section with its summary', () => {
  const list = sortSections({ ...ALL, ci: { ...section('ci', 20), summary: 'PR 12 · ✅' } })
  expect(footerOf(list)).toBe('⇥ /starboard · ctx · ci PR 12 · ✅ · docker · tasks')
})
