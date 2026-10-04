import { describe, expect, test } from 'claude-code/testing'
import { ICON_SETS } from '../hooks/icons'
import { C } from '../hooks/theme'
import { footerLayout } from '../hooks/model/footer'
import { buildTurns } from '../hooks/model/turns'
import { displayWidth } from '../hooks/model/width'
import { renderPane } from '../hooks/view'
import { footerGroups, footerPlan } from '../hooks/view/footer'
import { act, acts, base, byKey, el, nodes, text, type Node } from './fixtures/view'

describe('footerPlan', () => {
  const frame = { scrollTop: 0, windowRows: 20, total: 0, starts: {} }
  const plan = (extra: Record<string, unknown>) => {
    const data = { ...base, icons: ICON_SETS.nerd, ...extra } as unknown as Parameters<typeof footerGroups>[0]
    return footerPlan(footerGroups(data, act, frame), footerLayout(100), 100)
  }

  test('the turn list keeps two rows of keys and hides six', () => {
    const turns = plan({ view: 'turns' })
    expect(turns.rows.map(row => row.id)).toEqual(['1', '2'])
    expect(turns.hidden).toHaveLength(6)
  })

  test('the team board keeps one row', () => {
    expect(plan({ view: 'team' }).rows.map(row => row.id)).toEqual(['2'])
  })
})

describe('footer', () => {
  const footerOf = (tree: unknown) => byKey(tree, 'footer')

  test('the navigation and turn N/M sit in the footer, the header holds only metrics', () => {
    const tree = renderPane(el, { ...base, selected: 1, isLatest: true }, act)
    const footer = footerOf(tree)
    expect(footer).toBeDefined()
    expect(text(byKey(footer, 'turn-position'))).toBe('turn 2/2 (live)')
    expect(byKey(footer, 'turn-position')?.props['color']).toBe('inactive')
    // Nothing of the navigation is above the items.
    const body = nodes(tree)[0]!
    const head = (nodes(tree)[1]?.children as Node[]).filter(Boolean)[0]!
    expect(byKey(head, 'nav-prev')).toBeUndefined()
    expect(text(head)).not.toContain('turn 2/2')
    expect(nodes(body).filter(n => n.props['key'] === 'nav-prev')).toHaveLength(1)
  })

  test('the separators between the columns are muted, the old dot groups are gone', () => {
    const tree = renderPane(el, { ...base, selected: 1 }, act)
    const seps = nodes(tree).filter(n => String(n.props['key']).startsWith('footer-sep-'))
    expect(seps.map(text)).toEqual(['│', '│'])
    for (const sep of seps) expect(sep.props['color']).toBe('inactive')
    expect(nodes(tree).some(n => String(n.props['key']).startsWith('nav-group-'))).toBe(false)
    const ascii = renderPane(el, { ...base, icons: ICON_SETS.ascii }, act)
    expect(
      nodes(ascii)
        .filter(n => String(n.props['key']).startsWith('footer-sep-'))
        .map(text),
    ).toEqual(['|', '|'])
  })

  test('a thin rule across the pane separates it, a dash in the ascii set', () => {
    const rule = (icons?: (typeof ICON_SETS)['nerd']) =>
      byKey(renderPane(el, { ...base, columns: 40, ...(icons ? { icons } : {}) }, act), 'footer-rule')
    expect(text(rule())).toBe('─'.repeat(40))
    expect(rule()?.props['color']).toBe('inactive')
    expect(text(rule(ICON_SETS.ascii))).toBe('-'.repeat(40))
    expect(nodes(renderPane(el, base, act)).filter(n => String(n.props['key']).endsWith('rule'))).toHaveLength(1)
  })

  test('a narrow pane stacks the groups instead of overflowing', () => {
    const tree = renderPane(el, { ...base, columns: 40, selected: 1 }, act)
    expect(footerOf(tree)?.props['width']).toBe(40)
    expect(nodes(footerOf(tree)).some(n => n.props['flexWrap'] === 'wrap')).toBe(false)
  })
})

describe('pane focus', () => {
  const mark = (tree: unknown) => byKey(tree, 'brand-mark')
  const last = (tree: unknown) => byKey(tree, 'focus-note')

  test('a focused pane has a bold brand mark and says keys are on', () => {
    const tree = renderPane(el, { ...base, isFocused: true }, act)
    expect(mark(tree)?.props['color']).toBe('claude')
    expect(mark(tree)?.props['bold']).toBe(true)
    expect(text(mark(tree))).toContain(ICON_SETS.nerd.robot)
    expect(text(last(tree))).toBe('keys on')
    expect(last(tree)?.props['color']).toBe('suggestion')
  })

  test('an unfocused pane mutes the mark and hints how to get the keys', () => {
    const tree = renderPane(el, { ...base, isFocused: false }, act)
    expect(mark(tree)?.props['color']).toBe('inactive')
    expect(mark(tree)?.props['bold']).not.toBe(true)
    expect(text(last(tree))).toBe('click or ctrl+x tab')
    expect(last(tree)?.props['color']).toBe('inactive')
  })

  test('with the info bar shown the hint asks for the chord twice: the bar takes the first', () => {
    const tree = renderPane(el, { ...base, isFocused: false, isBarShown: true }, act)
    expect(text(last(tree))).toBe('click or ctrl+x tab ×2')
    const ascii = renderPane(el, { ...base, isFocused: false, isBarShown: true, icons: ICON_SETS.ascii }, act)
    expect(text(last(ascii))).toBe('click or ctrl+x tab x2')
    expect(text(last(renderPane(el, { ...base, isFocused: true, isBarShown: true }, act)))).toBe('keys on')
  })

  test('an unknown focus acts as unfocused, without the hint', () => {
    const tree = renderPane(el, base, act)
    expect(mark(tree)?.props['color']).toBe('inactive')
    expect(last(tree)).toBeUndefined()
    expect(text(tree)).not.toContain('keys on')
    expect(text(tree)).not.toContain('ctrl+x')
  })

  test('the note ends the status row, right after the position of the turn', () => {
    const status = byKey(renderPane(el, { ...base, isFocused: true }, act), 'footer-status')
    expect(status?.props['justifyContent']).toBe('flex-end')
    expect(text(status)).toBe('turn 1/2 · keys on')
    const parts = (status?.children as Node[]).filter(Boolean)
    expect(parts.at(-1)?.props['key']).toBe('focus-note')
  })
})

describe('pinned footer', () => {
  const footerOf = (extra: Record<string, unknown> = {}) =>
    byKey(renderPane(el, { ...base, selected: 1, isLatest: true, cursor: 'b1', ...extra }, act), 'footer')!
  const kids = (n: Node | undefined) => (n?.children as Node[]).filter(Boolean)
  // The row as drawn: a button has its hotkey before its label, a box
  // spaces its children by `gap` and pads to its `width`.
  const line = (t: unknown): string => {
    if (typeof t === 'string') return t
    if (Array.isArray(t)) return t.map(line).join('')
    if (t === null || typeof t !== 'object' || !('type' in t)) return ''
    const { type, props, children } = t as Node
    if (type === 'Button') return `${props['hotkey']}: ${props['label']}`
    const parts = (Array.isArray(children) ? children : [children]).filter(Boolean).map(line)
    const joined = parts.join(' '.repeat(Number(props['gap'] ?? 0)))
    return typeof props['width'] === 'number' ? joined.padEnd(props['width']) : joined
  }
  const rowsOf = (footer: Node) => kids(footer).filter(n => String(n.props['key']).startsWith('footer-row'))

  test('is in flow under the window, as wide as the pane, over a pane background', () => {
    const footer = footerOf({ rows: 30 })
    expect(footer.props['position']).toBeUndefined()
    expect(footer.props['top']).toBeUndefined()
    expect(footer.props['width']).toBe(100)
    expect(footer.props['backgroundColor']).toBe(C.paneBackground)
  })

  test('ends the pane body in the detail, turns and team views and with no turns', () => {
    const views = [
      {},
      { view: 'turns' as const },
      { view: 'team' as const },
      { turns: [] },
      { turns: [], view: 'team' as const },
    ]
    for (const extra of views) {
      const tree = renderPane(el, { ...base, ...extra }, act) as Node
      expect(kids(tree).at(-1)?.props['key']).toBe('footer')
      expect(tree.props['paddingBottom']).toBeUndefined()
    }
    expect(byKey(renderPane(el, { ...base, view: 'turns' }, act), 'nav-detail')?.props['hotkey']).toBe('d')
    expect(byKey(renderPane(el, { ...base, view: 'turns' }, act), 'nav-turns')).toBeUndefined()
  })

  test('has one rule, two group rows and the status row at 100 columns', () => {
    const footer = footerOf()
    expect(kids(footer).map(n => n.props['key'])).toEqual([
      'footer-rule',
      'footer-row-1',
      'footer-row-2',
      'footer-status',
    ])
    expect(text(kids(footer)[0])).toBe('─'.repeat(100))
    expect(kids(footer)[0]?.props['color']).toBe(C.muted)
    expect(line(rowsOf(footer)[0])).toBe('p: ‹ prev  n: next ›  l: latest  │  j: ↓  k: ↑  o: open  y: copy')
    expect(line(rowsOf(footer)[1])).toBe(
      't: turns  s: search  m: team     │  e: expand  c: collapse  b: ▲ page  f: ▼ page',
    )
    expect(
      footerOf({ view: 'turns' }) &&
        line(rowsOf(footerOf({ view: 'turns', members: [{ name: 'a', type: 't', status: 'running' }] }))[1]),
    ).toContain('d: detail')
  })

  test('puts the column separator in one display column on both rows', () => {
    const members = [{ name: 'alice', type: 'teammate', status: 'running' as const }]
    for (const extra of [{}, { members }, { icons: ICON_SETS.ascii }, { selected: 0, isLatest: false, cursor: null }]) {
      const rows = rowsOf(footerOf(extra)).map(line)
      const sep = extra.icons ? '|' : '│'
      const at = rows.map(r => displayWidth(r.slice(0, r.indexOf(sep))))
      expect(at[0]).toBe(at[1])
      expect(at[0]).toBeGreaterThan(20)
    }
  })

  test('a key out of reach is the same plain dim Button with its hotkey, and pressing it does nothing', () => {
    const first = renderPane(el, { ...base, selected: 0, isLatest: false, cursor: null }, act)
    for (const [key, hotkey, label] of [
      ['nav-prev', 'p', '‹ prev'],
      ['nav-open', 'o', 'open'],
      ['nav-copy', 'y', 'copy'],
      ['nav-team', 'm', 'team'],
      ['nav-pageup', 'b', '▲ page'],
      ['nav-pagedown', 'f', '▼ page'],
    ] as const) {
      expect(byKey(first, key)?.props).toMatchObject({ hotkey, plain: true, dimColor: true })
      expect(String(byKey(first, key)?.props['label']).trimEnd()).toBe(label)
      expect(byKey(first, `${key}-off`)).toBeUndefined()
      expect(acts(first, key)).toBe(false)
    }
    expect(nodes(first).some(n => String(n.props['key']).endsWith('-off'))).toBe(false)
    const members = [{ name: 'alice', type: 'teammate', status: 'running' as const }]
    expect(acts(renderPane(el, { ...base, members }, act), 'nav-team')).toBe(true)
    const bare = renderPane(el, { ...base, turns: buildTurns([{ role: 'user', text: 'hi', toolUses: [] }]) }, act)
    for (const key of ['nav-expand', 'nav-collapse', 'nav-down', 'nav-up']) expect(acts(bare, key)).toBe(false)
  })

  test('a button keeps the label and hotkey and is plain and dim', () => {
    const button = byKey(footerOf(), 'nav-prev')!
    expect(button.props).toMatchObject({ plain: true, dimColor: true, hotkey: 'p' })
    expect(String(button.props['label']).trimEnd()).toBe('‹ prev')
    expect(String(byKey(footerOf({ selected: 0, isLatest: false }), 'nav-next')?.props['label']).trimEnd()).toBe(
      'next ›',
    )
    expect((button.props['hover'] as { color?: string }).color).toBe('text')
  })

  // The boxes in the footer that lay out buttons side by side.
  const buttonRows = (footer: Node) =>
    nodes(footer).filter(
      n => n.type === 'Box' && n.props['display'] !== 'none' && kids(n).some(c => c.type === 'Button'),
    )

  test('a click between two keys lands on a key: the gap is in the label, not the row', () => {
    const members = [{ name: 'alice', type: 'teammate', status: 'running' as const }]
    for (const columns of [100, 60, 36])
      for (const extra of [{}, { members }, { icons: ICON_SETS.ascii }, { view: 'turns' as const }]) {
        const footer = footerOf({ columns, rows: 10, ...extra })
        const rows = buttonRows(footer)
        expect(rows.length, `${columns}`).toBeGreaterThan(0)
        for (const row of rows) {
          expect(row.props['gap'] ?? 0, `${columns} ${String(row.props['key'])}`).toBe(0)
          const keys = kids(row).filter(c => c.type === 'Button')
          for (const k of keys.slice(0, -1))
            expect(String(k.props['label']), `${columns} ${String(k.props['key'])}`).toMatch(/\S {2}$/)
        }
      }
  })

  test('the last key of the left column reaches the separator', () => {
    const members = [{ name: 'alice', type: 'teammate', status: 'running' as const }]
    for (const extra of [{}, { members }, { icons: ICON_SETS.ascii }, { view: 'turns' as const }]) {
      const footer = footerOf(extra)
      // In the turn list the first row has no left column (no move keys).
      for (const n of extra.view === 'turns' ? [2] : [1, 2]) {
        const row = byKey(footer, `footer-row-${n}`)!
        const left = byKey(row, `footer-left-${n}`)!
        const sep = byKey(row, `footer-sep-${n}`)!
        expect(row.props['gap'] ?? 0).toBe(0)
        // The left keys, padded, end where the separator starts.
        expect(displayWidth(line(left))).toBe(left.props['width'])
        expect(kids(row)[1]?.props['key']).toBe(`footer-divider-${n}`)
        expect(text(sep)).not.toMatch(/^\s/)
      }
    }
  })

  const hiddenKeys = (footer: Node) => {
    const hidden = byKey(footer, 'footer-hidden')
    return hidden === undefined ? [] : nodes(hidden).filter(n => n.type === 'Button')
  }

  test('the detail view draws every key and hides none', () => {
    const footer = footerOf()
    expect(hiddenKeys(footer)).toEqual([])
  })

  test('the turn list draws only its keys: the cursor, the views and the page keys', () => {
    const footer = footerOf({ view: 'turns' })
    const rows = rowsOf(footer)
    expect(rows.map(r => r.props['key'])).toEqual(['footer-row-1', 'footer-row-2'])
    expect(line(rows[0])).toBe('j: ↓  k: ↑  o: open')
    expect(line(rows[1])).toBe('d: detail  s: search  m: team  │  b: ▲ page  f: ▼ page')
    const hidden = byKey(footer, 'footer-hidden')!
    expect(hidden.props['display']).toBe('none')
    expect(hiddenKeys(footer).map(k => [k.props['key'], k.props['hotkey']])).toEqual([
      ['nav-prev', 'p'],
      ['nav-next', 'n'],
      ['nav-latest', 'l'],
      ['nav-copy', 'y'],
      ['nav-expand', 'e'],
      ['nav-collapse', 'c'],
    ])
    for (const k of hiddenKeys(footer)) expect(String(k.props['label'])).not.toMatch(/ $/)
  })

  test('the team board draws only the views it can switch to and the page keys', () => {
    const members = [{ name: 'alice', type: 'teammate', status: 'running' as const }]
    const footer = footerOf({ view: 'team', members })
    const rows = rowsOf(footer)
    expect(rows.map(r => r.props['key'])).toEqual(['footer-row-2'])
    expect(line(rows[0])).toBe('d: detail  s: search  │  b: ▲ page  f: ▼ page')
    expect(hiddenKeys(footer).map(k => k.props['hotkey'])).toEqual(['p', 'n', 'l', 'j', 'k', 'o', 'y', 'm', 'e', 'c'])
  })

  test('stacked, the turn list and the team board keep only their rows', () => {
    const members = [{ name: 'alice', type: 'teammate', status: 'running' as const }]
    expect(rowsOf(footerOf({ columns: 60, view: 'turns' })).map(r => r.props['key'])).toEqual([
      'footer-row-cursor',
      'footer-row-views',
      'footer-row-expand',
    ])
    expect(line(byKey(footerOf({ columns: 60, view: 'turns' }), 'footer-row-expand'))).toBe('b: ▲ page  f: ▼ page')
    expect(rowsOf(footerOf({ columns: 60, view: 'team', members })).map(r => r.props['key'])).toEqual([
      'footer-row-views',
      'footer-row-expand',
    ])
  })

  test('in the turn list j and k act while it has rows, o only with a cursor on a turn', () => {
    const list = footerOf({ view: 'turns' })
    expect(acts(list, 'nav-down')).toBe(true)
    expect(acts(list, 'nav-up')).toBe(true)
    expect(acts(list, 'nav-open')).toBe(false)
    expect(acts(footerOf({ view: 'turns', turnCursor: 0 }), 'nav-open')).toBe(true)
    expect(acts(footerOf({ view: 'turns', turns: [] }), 'nav-down')).toBe(false)
  })

  test('stacks every group on its own row under 64 columns and drops the separator', () => {
    const footer = footerOf({ columns: 60 })
    expect(footer.props['width']).toBe(60)
    expect(kids(footer).map(n => n.props['key'])).toEqual([
      'footer-rule',
      'footer-row-move',
      'footer-row-cursor',
      'footer-row-views',
      'footer-row-expand',
      'footer-status',
    ])
    expect(line(rowsOf(footer)[0])).toBe('p: ‹ prev  n: next ›  l: latest')
    expect(text(footer)).not.toContain('│')
  })

  test('shows only keys and glyphs under 40 columns', () => {
    const footer = footerOf({ columns: 36, isLatest: false })
    expect(line(rowsOf(footer)[0])).toBe('p: ‹  n: ›  l: »')
    expect(line(rowsOf(footer)[1])).toBe('j: ↓  k: ↑  o: +  y: ⧉')
    expect(line(rowsOf(footer)[2])).toBe('t: ≡  s: ⌕  m: ☺')
    expect(line(rowsOf(footer)[3])).toBe('e: ⊞  c: ⊟  b: ▲  f: ▼')
    expect(String(byKey(footer, 'nav-prev')?.props['label']).trimEnd()).toBe('‹')
  })

  test('under 40 columns no key has an empty label, enabled or not, in every view and set', () => {
    const members = [{ name: 'alice', type: 'teammate', status: 'running' as const }]
    for (const extra of [{}, { view: 'turns' as const }, { view: 'team' as const }, { members }, { cursor: null }])
      for (const icons of [ICON_SETS.nerd, ICON_SETS.unicode, ICON_SETS.ascii]) {
        const footer = footerOf({ columns: 36, isLatest: false, icons, ...extra })
        const keys = nodes(footer).filter(n => n.type === 'Button')
        expect(keys.length).toBe(14)
        for (const k of keys) {
          const shown = String(k.props['label'])
          expect(shown, String(k.props['key'])).not.toBe('')
          if (icons === ICON_SETS.ascii) expect(shown).toMatch(/^[\x20-\x7e]+$/)
        }
      }
  })

  test('outside the detail view the keys of the detail turn keep their hotkeys and do nothing', () => {
    const members = [{ name: 'alice', type: 'teammate', status: 'running' as const }]
    for (const view of ['turns', 'team'] as const) {
      const footer = footerOf({ view, members, selected: 0, isLatest: false, cursor: 'b1' })
      // In the turn list j and k move its own cursor (o opens the turn under it).
      const idle = [
        'prev',
        'next',
        'latest',
        'open',
        'copy',
        'expand',
        'collapse',
        ...(view === 'team' ? ['down', 'up'] : []),
      ]
      for (const name of idle) expect(acts(footer, `nav-${name}`), name).toBe(false)
      expect(byKey(footer, 'nav-detail')?.props['hotkey']).toBe('d')
      expect(acts(footer, 'nav-search')).toBe(true)
      expect(byKey(footer, 'nav-turns')).toBeUndefined()
    }
    expect(acts(footerOf({ view: 'turns', members }), 'nav-team')).toBe(true)
    expect(acts(footerOf({ view: 'team', members }), 'nav-team')).toBe(false)
  })

  test('the team board has no header button of its own, the footer holds d', () => {
    const tree = renderPane(el, { ...base, view: 'team' }, act)
    expect(nodes(tree).filter(n => n.props['key'] === 'nav-detail')).toHaveLength(1)
    expect(byKey(footerOf({ view: 'team' }), 'nav-detail')).toBeDefined()
  })

  test('the status row stays inside the frame on stacked panes too', () => {
    // Where the page keys start the status row, it has their width and a gap less.
    for (const [columns, page] of [
      [40, 22],
      [63, 0],
    ]) {
      const status = byKey(footerOf({ columns, isFocused: false }), 'footer-status')!
      expect(status.props['width']).toBe(columns! - 2 - page!)
      expect(displayWidth(text(status))).toBeLessThanOrEqual(columns! - 2 - page!)
    }
  })

  test('uses the ASCII glyphs of the ascii set and stays ASCII only', () => {
    const footer = footerOf({ icons: ICON_SETS.ascii })
    expect(line(rowsOf(footer)[0])).toBe('p: < prev  n: next >  l: latest  |  j: v  k: ^  o: open  y: copy')
    expect(line(footer)).toMatch(/^[\x20-\x7e]*$/)
  })

  test('a disabled key reads exactly as the engine draws the button: key, colon, label', () => {
    const on = footerOf({ selected: 0, isLatest: false, cursor: 'b1' })
    const off = footerOf({ selected: 0, isLatest: false, cursor: null })
    expect(line(rowsOf(on)[0])).toBe('p: ‹ prev  n: next ›  l: latest  │  j: ↓  k: ↑  o: open  y: copy')
    expect(line(rowsOf(off)[0])).toBe(line(rowsOf(on)[0]))
  })

  test('the status row is right-aligned inside the frame and cut with an ellipsis on a narrow pane', () => {
    const fits = byKey(footerOf({ columns: 100, isFocused: true }), 'footer-status')!
    expect(fits.props['width']).toBe(98)
    expect(fits.props['justifyContent']).toBe('flex-end')
    const beside = byKey(footerOf({ columns: 76, isFocused: true }), 'footer-status')!
    expect(beside.props['width']).toBe(74 - 22)
    expect(text(beside)).toBe('turn 2/2 (live) · keys on')
    expect(text(fits)).toBe('turn 2/2 (live) · keys on')
    const cut = byKey(footerOf({ columns: 20, isFocused: false }), 'footer-status')!
    expect(displayWidth(text(cut))).toBeLessThanOrEqual(18)
    expect(text(cut)).toContain('…')
    const ascii = byKey(footerOf({ columns: 20, isFocused: false, icons: ICON_SETS.ascii }), 'footer-status')!
    expect(text(ascii)).toContain('...')
  })

  test('charges its text to the pane budget', () => {
    const big = buildTurns([
      { role: 'user', text: 'x', toolUses: [] },
      { role: 'assistant', text: 'y'.repeat(200_000), toolUses: [] },
    ])
    const tree = renderPane(el, { ...base, turns: big, stats: [undefined], isLatest: true, selected: 0 }, act)
    const total = nodes(tree).reduce((n, node) => n + text(node.children).length, 0)
    expect(total).toBeLessThanOrEqual(100_000)
  })
})
