import { describe, expect, test } from 'claude-code/testing'
import { ICON_SETS, type Icons } from '../hooks/icons'
import { C } from '../hooks/theme'
import { truncateDisplay } from '../hooks/model/width'
import type { ToolItem } from '../hooks/model/types'
import { cutter, endWrap, isUnicodeCut, itemIcon, middleWrap, scopeOf } from '../hooks/view/kit'

describe('scopeOf', () => {
  test('a short scope is the prefix and the id', () => {
    expect(scopeOf('btn:', 'x')).toBe('btn:x')
  })

  test('a long one is cut to 64 characters with a stable hash of the whole', () => {
    const long = scopeOf('row:', 'a'.repeat(200))
    expect(long).toHaveLength(64)
    expect(long).toContain('~')
    expect(scopeOf('row:', 'a'.repeat(200))).toBe(long)
    expect(scopeOf('row:', `${'a'.repeat(199)}b`)).not.toBe(long)
  })
})

describe('cutting by icon set', () => {
  test('the Nerd and Unicode sets let the engine cut, the ascii set cuts itself', () => {
    expect(isUnicodeCut(ICON_SETS.nerd)).toBe(true)
    expect(isUnicodeCut(ICON_SETS.ascii)).toBe(false)
    expect(endWrap(ICON_SETS.nerd)).toBe('truncate-end')
    expect(endWrap(ICON_SETS.ascii)).toBe('wrap')
    expect(middleWrap(ICON_SETS.nerd)).toBe('truncate-middle')
  })

  test('a cut ends in the set ellipsis', () => {
    expect(cutter(ICON_SETS.ascii)('abcdefgh', 5)).toBe(truncateDisplay('abcdefgh', 5, ICON_SETS.ascii.ellipsis))
  })
})

describe('itemIcon', () => {
  const call = (tool: string, extra: Partial<ToolItem> = {}): ToolItem => ({
    kind: 'tool',
    id: 't',
    tool,
    input: {},
    summary: '',
    isError: false,
    isPending: false,
    ...extra,
  })

  // The unicode set draws a different glyph for each category, so a swap shows.
  test('each tool category draws its own icon, in the default colour', () => {
    const glyphs = CATEGORY_ICON.map(([, key]) => ICON_SETS.unicode[key])
    expect(new Set(glyphs).size, 'one unicode glyph per category').toBe(new Set(CATEGORY_ICON.map(([, k]) => k)).size)
    for (const [tool, key] of CATEGORY_ICON)
      expect(itemIcon(call(tool), ICON_SETS.unicode), tool).toEqual({ glyph: ICON_SETS.unicode[key] })
  })

  test('a subagent and an output are accented, a failed call is a red wrench whatever its tool', () => {
    const { robot, wrench, output } = ICON_SETS.unicode
    expect(itemIcon(call('Agent', { agentId: 'a1' }), ICON_SETS.unicode)).toEqual({ glyph: robot, color: C.accent })
    expect(itemIcon(call('Task', { agentId: 'a1' }), ICON_SETS.unicode)).toEqual({ glyph: robot, color: C.accent })
    expect(itemIcon(call('Bash', { isError: true }), ICON_SETS.unicode)).toEqual({ glyph: wrench, color: C.error })
    expect(itemIcon(call('Read', { isError: true }), ICON_SETS.unicode)).toEqual({ glyph: wrench, color: C.error })
    expect(itemIcon({ kind: 'output', id: 'o', text: 'done' }, ICON_SETS.unicode)).toEqual({
      glyph: output,
      color: C.accent,
    })
  })
})

const CATEGORY_ICON: readonly (readonly [string, keyof Icons])[] = [
  ['Read', 'book'],
  ['Edit', 'penNib'],
  ['MultiEdit', 'penNib'],
  ['Write', 'penNib'],
  ['NotebookEdit', 'penNib'],
  ['Grep', 'folderSearch'],
  ['Glob', 'folderSearch'],
  ['Task', 'robot'],
  ['Agent', 'robot'],
  ['Skill', 'robot'],
  ['Workflow', 'robot'],
  ['WebFetch', 'web'],
  ['WebSearch', 'web'],
  ['Bash', 'wrench'],
  ['SomethingNew', 'wrench'],
]
