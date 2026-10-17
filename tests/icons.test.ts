import { describe, expect, test } from 'claude-code/testing'
import { ICON_SETS, iconsFor } from '../hooks/icons'
import { displayWidth } from '../hooks/model/width'

describe('icon sets', () => {
  test('the desktop app draws unicode for nerd and keeps ascii; unicode has no private-use glyph', () => {
    expect(iconsFor('nerd', true)).toBe(ICON_SETS.unicode)
    expect(iconsFor('ascii', true)).toBe(ICON_SETS.ascii)
    expect(iconsFor('unicode', true)).toBe(ICON_SETS.unicode)
    expect(iconsFor('nerd', false)).toBe(ICON_SETS.nerd)
    const glyphs = JSON.stringify(Object.values(ICON_SETS.unicode))
    expect(glyphs.match(/[\u{E000}-\u{F8FF}\u{F0000}-\u{10FFFF}]/u)?.[0]).toBeUndefined()
  })

  test('every set has the same keys', () => {
    const keys = Object.keys(ICON_SETS.nerd).sort()
    expect(Object.keys(ICON_SETS.unicode).sort()).toEqual(keys)
    expect(Object.keys(ICON_SETS.ascii).sort()).toEqual(keys)
  })

  test('the ascii set is only ASCII, the unicode set has no Nerd Font private-use glyph', () => {
    const all = (set: (typeof ICON_SETS)['nerd']) => Object.values(set).flat().join('')
    expect(all(ICON_SETS.ascii)).toMatch(/^[\x20-\x7e]+$/)
    expect(all(ICON_SETS.unicode)).not.toMatch(/[\ue000-\uf8ff\u{f0000}-\u{ffffd}]/u)
    expect(all(ICON_SETS.nerd)).toMatch(/[\ue000-\uf8ff\u{f0000}-\u{ffffd}]/u)
  })

  test('no set draws a character above U+FFFF, which terminals such as JediTerm draw two cells wide', () => {
    for (const [name, set] of Object.entries(ICON_SETS))
      for (const [key, value] of Object.entries(set))
        for (const glyph of [value].flat())
          for (const ch of glyph) expect(ch.codePointAt(0)!, `${name}.${key}`).toBeLessThanOrEqual(0xffff)
  })

  test('no set draws the paused mark as a spinner frame, and the unicode set avoids the wide U+23F8', () => {
    for (const set of Object.values(ICON_SETS)) expect(set.spinner).not.toContain(set.idle)
    expect(ICON_SETS.unicode.interrupted).not.toBe('\u23f8')
    expect(ICON_SETS.nerd.interrupted).toBe('\u23f8')
  })

  test('each glyph is one code point that displayWidth counts one cell wide, in every set; the spinner has frames', () => {
    for (const set of Object.values(ICON_SETS))
      for (const [key, value] of Object.entries(set).filter(([k]) => !MULTI.includes(k)))
        for (const glyph of [value].flat()) {
          expect([...glyph].length, key).toBe(1)
          expect(displayWidth(glyph), key).toBe(1)
        }
    for (const set of Object.values(ICON_SETS))
      for (const key of ['treeBranch', 'treeLast', 'treeGuide'] as const) expect([...set[key]].length, key).toBe(3)
    expect(ICON_SETS.ascii.spinner).toEqual(['|', '/', '-', '\\'])
    expect(ICON_SETS.ascii.done).toBe('+')
    expect(ICON_SETS.ascii.error).toBe('x')
    expect(ICON_SETS.ascii.ellipsis).toBe('...')
    expect(ICON_SETS.ascii.border).toBe('classic')
    expect(ICON_SETS.nerd.border).toBe('round')
    expect(ICON_SETS.unicode.ellipsis).toBe('…')
  })

  test('the page keys and the more above / below rows have triangles, ^ and v in ascii', () => {
    for (const set of [ICON_SETS.nerd, ICON_SETS.unicode]) {
      expect([set.pageUp, set.pageDown, set.moreAbove, set.moreBelow]).toEqual(['▲', '▼', '▲', '▼'])
      for (const glyph of [set.pageUp, set.pageDown, set.moreAbove, set.moreBelow]) expect(displayWidth(glyph)).toBe(1)
    }
    expect([ICON_SETS.ascii.pageUp, ICON_SETS.ascii.pageDown]).toEqual(['^', 'v'])
    expect([ICON_SETS.ascii.moreAbove, ICON_SETS.ascii.moreBelow]).toEqual(['^', 'v'])
  })

  test('the thinking glyph never doubles as the ellipsis; unicode thinks in ∴', () => {
    for (const set of Object.values(ICON_SETS)) expect(set.thinking).not.toBe(set.ellipsis)
    expect(ICON_SETS.unicode.thinking).toBe('∴')
  })
})

const MULTI = [
  'ellipsis',
  'border',
  'taskDone',
  'taskActive',
  'taskTodo',
  'treeBranch',
  'treeLast',
  'treeGuide',
  'keyLatest',
]
