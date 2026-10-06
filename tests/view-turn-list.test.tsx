import { describe, expect, test } from 'claude-code/testing'
import { ICON_SETS } from '../hooks/icons'
import { C } from '../hooks/theme'
import { buildTurns } from '../hooks/model/turns'
import { displayWidth } from '../hooks/model/width'
import { renderPane } from '../hooks/view/pane'
import { searchFieldKey } from '../hooks/view/turn-list'
import { act, base, byKey, el, measured, nodes, text } from './fixtures/view'

describe('turn table', () => {
  const wide = buildTurns([
    { role: 'user', text: 'Fix the bug', toolUses: [{ tool_use_id: 'a', tool: 'Bash', input: {}, text: 'x' }] },
    { role: 'assistant', text: 'ok', toolUses: [] },
    { role: 'user', text: '日本語の質問'.repeat(12), toolUses: [] },
    { role: 'assistant', text: 'ok', toolUses: [] },
  ])
  const stats = [
    { prompt: 'Fix the bug', durationMs: 65_000, endedAt: 0, inputTokens: 1000, outputTokens: 500 },
    { prompt: '', durationMs: 65_000, endedAt: 0, inputTokens: 10, outputTokens: 5 },
  ]
  const table = (columns: number, extra: Record<string, unknown> = {}) =>
    renderPane(el, { ...base, turns: wide, stats, view: 'turns', columns, ...extra }, act)
  const timeColumn = (tree: unknown, key: string) => {
    const label = text(byKey(tree, key))
    return displayWidth(label.slice(0, label.indexOf('1m 5s')))
  }

  test('rows are a table with a muted header, the time column in one display column', () => {
    const tree = table(100)
    const header = byKey(tree, 'turn-header')
    expect(header?.type).toBe('Text')
    expect(header?.props['color']).toBe(C.muted)
    expect(text(header)).toMatch(/#\s+prompt\s+tools\s+time\s+tokens/)
    expect(timeColumn(tree, 'turn-0')).toBe(timeColumn(tree, 'turn-1'))
    expect(displayWidth(text(byKey(tree, 'turn-0')))).toBe(displayWidth(text(byKey(tree, 'turn-1'))))
    expect(text(byKey(tree, 'turn-0'))).toContain('1.5k')
    expect(text(byKey(tree, 'turn-0'))).toContain('████████')
  })

  test('every row is a button, the selected one in full contrast', () => {
    const tree = table(100, { selected: 1 })
    expect(byKey(tree, 'turn-1')?.type).toBe('Button')
    expect(byKey(tree, 'turn-1')?.props['dimColor']).toBe(false)
    expect(byKey(tree, 'turn-0')?.type).toBe('Button')
    expect(byKey(tree, 'turn-0')?.props['dimColor']).toBe(true)
    expect(text(byKey(tree, 'turn-1'))).toContain(ICON_SETS.nerd.marker)
  })

  test('three widths: all columns, no tokens or bar, then no tools', () => {
    const w100 = text(byKey(table(100), 'turn-header'))
    const w69 = text(byKey(table(69), 'turn-header'))
    const w54 = text(byKey(table(54), 'turn-header'))
    expect(w100).toMatch(/tools.*time.*tokens/)
    expect(w69).toContain('tools')
    expect(w69).not.toContain('tokens')
    expect(text(byKey(table(69), 'turn-0'))).not.toContain('█')
    expect(w54).not.toContain('tools')
    expect(w54).toContain('time')
    for (const columns of [100, 69, 54]) {
      const tree = table(columns)
      expect(displayWidth(text(byKey(tree, 'turn-0')))).toBeLessThanOrEqual(columns - 2)
    }
  })

  test('the match snippet stays under its row, highlighted', () => {
    const tree = table(100, { query: 'bug', matches: [{ index: 0, snippet: 'Fix the bug now' }] })
    expect(text(tree)).toContain('Fix the bug now')
    expect(nodes(tree).some(n => n.props['underline'] === true && text(n) === 'bug')).toBe(true)
  })

  test('the search field draws its seed, not the query, under its key generation', () => {
    const typing = byKey(table(100, { query: 'bu', searchField: { gen: 0, seed: '' } }), 'turn-search')
    expect(typing?.type).toBe('Input')
    expect(typing?.props['value']).toBe('')
    const reset = table(100, { query: '', searchField: { gen: 2, seed: '' } })
    expect(byKey(reset, 'turn-search')).toBeUndefined()
    expect(byKey(reset, 'turn-search-2')?.props['value']).toBe('')
    expect(searchFieldKey(0)).toBe('turn-search')
    expect(searchFieldKey(2)).toBe('turn-search-2')
  })

  test('the ascii set draws the table in ASCII', () => {
    const tree = renderPane(
      el,
      { ...base, turns: wide.slice(0, 1), stats, view: 'turns', icons: ICON_SETS.ascii, selected: 0 },
      act,
    )
    expect(text(tree)).toMatch(/^[\x20-\x7e\n]*$/)
    expect(text(byKey(tree, 'turn-0'))).toContain('========')
  })
})

describe('turn list cursor', () => {
  test('every turn row starts where the window can find it', () => {
    measured.length = 0
    renderPane(el, { ...base, view: 'turns' }, act)
    const starts = (measured.at(-1) as unknown as { starts: Record<string, number> }).starts
    const ids = Object.keys(starts).filter(id => id.startsWith('turn:'))
    expect(ids).toEqual(base.turns.map(t => `turn:${t.index}`).reverse())
  })

  test('the row under the cursor has the accent cursor mark in its first cell', () => {
    const tree = renderPane(el, { ...base, view: 'turns', turnCursor: 0 }, act)
    const mark = byKey(tree, 'turn-cursor-0')!
    expect(text(mark)).toBe(ICON_SETS.nerd.cursor)
    expect(mark.props['color']).toBe(C.accent)
    expect(nodes(tree).filter(n => String(n.props['key']).startsWith('turn-cursor-'))).toHaveLength(1)
    expect(byKey(renderPane(el, { ...base, view: 'turns' }, act), 'turn-cursor-0')).toBeUndefined()
  })
})
