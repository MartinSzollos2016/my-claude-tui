import { describe, expect, test } from 'claude-code/testing'
import { ICON_SETS, type Icons } from '../hooks/icons'
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
  // The unicode set draws a different glyph for each category, so a swap shows.
  test('each tool category draws its own icon', () => {
    for (const [tool, key] of CATEGORY_ICON) {
      const item: ToolItem = { kind: 'tool', id: 't', tool, input: {}, summary: '', isError: false, isPending: false }
      expect(itemIcon(item, ICON_SETS.unicode).glyph, tool).toBe(ICON_SETS.unicode[key])
    }
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
