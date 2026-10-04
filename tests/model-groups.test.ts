import { describe, expect, test } from 'claude-code/testing'
import { ICON_SETS } from '../hooks/icons'
import { groupLabel } from '../hooks/model/card'
import { groupRuns } from '../hooks/model/groups'
import type { Item, ToolItem } from '../hooks/model/types'

describe('groupRuns', () => {
  const tool = (id: string, name: string, input: Record<string, unknown> = {}, isError = false): ToolItem => ({
    kind: 'tool',
    id,
    tool: name,
    input,
    summary: name,
    isError,
    isPending: false,
  })
  const reads = (n: number, from = 0) =>
    Array.from({ length: n }, (_, i) => tool(`r${from + i}`, 'Read', { file_path: `/a/f${(from + i) % 4}.ts` }))

  test('fewer than three calls stay single rows', () => {
    const items = reads(2)
    expect(groupRuns(items)).toEqual(items)
    expect(groupRuns([])).toEqual([])
  })

  test('three or more consecutive calls of one tool become a group with a stable id', () => {
    const items = reads(7)
    const out = groupRuns(items)
    expect(out).toHaveLength(1)
    expect(out[0]).toEqual({ kind: 'group', id: 'group:r0', tool: 'Read', items })
    expect(groupRuns([...items, tool('r7', 'Read')])[0]).toMatchObject({ id: 'group:r0' })
    expect(groupRuns(items.slice(0, 3))[0]).toMatchObject({ id: 'group:r0' })
  })

  test('an error, another tool or a message breaks the run', () => {
    const items = [...reads(2), tool('e', 'Read', {}, true), ...reads(3, 10)]
    const out = groupRuns(items)
    expect(out.map(r => r.kind)).toEqual(['tool', 'tool', 'tool', 'group'])
    expect(groupRuns([...reads(2), tool('g', 'Grep'), ...reads(2, 10)]).every(r => r.kind === 'tool')).toBe(true)
    const output: Item = { kind: 'output', id: 'o', text: 'x' }
    expect(groupRuns([...reads(2), output, ...reads(2, 10)]).every(r => r.kind !== 'group')).toBe(true)
  })

  test('only read, search and web tools group', () => {
    for (const name of ['Grep', 'Glob', 'WebFetch', 'WebSearch'])
      expect(groupRuns([1, 2, 3].map(n => tool(`${name}${n}`, name)))[0]?.kind).toBe('group')
    for (const name of ['Edit', 'Bash', 'Agent', 'Write', 'Task'])
      expect(groupRuns([1, 2, 3].map(n => tool(`${name}${n}`, name))).every(r => r.kind === 'tool')).toBe(true)
  })

  test('two runs of different tools group apart', () => {
    const out = groupRuns([...reads(3), ...[3, 4, 5].map(n => tool(`g${n}`, 'Grep', { pattern: `p${n}` }))])
    expect(out.map(r => (r.kind === 'group' ? r.tool : '-'))).toEqual(['Read', 'Grep'])
  })

  test('the label counts calls and distinct files, patterns or pages', () => {
    const group = groupRuns(reads(7))[0] as Extract<ReturnType<typeof groupRuns>[number], { kind: 'group' }>
    expect(groupLabel(group, ICON_SETS.nerd)).toBe('Read ×7 · 4 files')
    expect(groupLabel(group, ICON_SETS.ascii)).toBe('Read x7 . 4 files')
    const one = groupRuns([1, 2, 3].map(n => tool(`x${n}`, 'Read', { file_path: '/a.ts' })))[0] as typeof group
    expect(groupLabel(one, ICON_SETS.nerd)).toBe('Read ×3 · 1 file')
    const search = groupRuns([1, 2, 3].map(n => tool(`s${n}`, 'Grep', { pattern: `p${n}` })))[0] as typeof group
    expect(groupLabel(search, ICON_SETS.nerd)).toBe('Grep ×3 · 3 patterns')
    const web = groupRuns([1, 2, 3].map(n => tool(`w${n}`, 'WebSearch', { query: 'q' })))[0] as typeof group
    expect(groupLabel(web, ICON_SETS.nerd)).toBe('WebSearch ×3 · 1 query')
    const fetch = groupRuns([1, 2, 3].map(n => tool(`f${n}`, 'WebFetch', { url: `u${n}` })))[0] as typeof group
    expect(groupLabel(fetch, ICON_SETS.nerd)).toBe('WebFetch ×3 · 3 pages')
    const bare = groupRuns([1, 2, 3].map(n => tool(`b${n}`, 'Glob')))[0] as typeof group
    expect(groupLabel(bare, ICON_SETS.nerd)).toBe('Glob ×3')
  })
})
