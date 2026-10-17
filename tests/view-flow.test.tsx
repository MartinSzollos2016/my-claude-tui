// The desktop app's pane (isFlow): it flows at its natural height, the footer
// framed on top, rows sized by boxes, cards on their rows, no cell sizes.
import { describe, expect, test } from 'claude-code/testing'
import { ICON_SETS } from '../hooks/icons'
import { C } from '../hooks/theme'
import { buildTurns } from '../hooks/model/turns'
import { PANE_TEXT_BUDGET } from '../hooks/view/context'
import { renderPane } from '../hooks/view/pane'
import {
  act,
  base,
  byKey,
  el,
  foldedOpen,
  foldedTimings,
  foldedTurn,
  measured,
  nodes,
  text,
  type Node,
} from './fixtures/view'

const flow = (extra: Record<string, unknown> = {}) =>
  renderPane(el, { ...base, isFlow: true, icons: ICON_SETS.unicode, ...extra }, act)
const team = {
  view: 'team',
  members: [{ name: 'alice', type: 'teammate', status: 'running' }],
  tasks: [{ id: '1', subject: 'Write tests', status: 'in_progress', owner: 'alice' }],
}
const views = () => [
  flow(),
  flow({ turns: foldedTurn, timings: foldedTimings, expanded: foldedOpen, stats: [undefined] }),
  flow({ view: 'turns', stats: [undefined, undefined] }),
  flow(team),
  flow({ isFooterOpen: false }),
]
const strings = (tree: unknown): string[] =>
  nodes(tree).flatMap(n => [
    ...(typeof n.props['label'] === 'string' ? [n.props['label']] : []),
    ...[n.props['children']].flat(Infinity).filter((c): c is string => typeof c === 'string'),
  ])
const isInside = (outer: Node | undefined, inner: Node | undefined) =>
  outer !== undefined && inner !== undefined && nodes(outer).includes(inner)

describe('the desktop flow pane', () => {
  test('flows at its natural height: no root size, no window, no more above or below', () => {
    measured.length = 0
    for (const tree of views()) {
      const root = tree as Node
      expect([root.props['height'], root.props['width']]).toEqual([undefined, undefined])
      for (const key of ['pane-window', 'more-above', 'more-below', 'footer-rule'])
        expect(byKey(tree, key), key).toBeUndefined()
      for (const node of nodes(tree)) {
        expect(Number(node.props['marginTop'] ?? 0)).toBeGreaterThanOrEqual(0)
        // A bar is a one-row drawing (flow-bar-*), not a height in cells.
        const isBar = String(node.props['key'] ?? '').startsWith('flow-bar')
        if (node.type === 'Box' && node.props['position'] !== 'absolute' && !isBar) {
          expect(node.props['width'] === base.columns, 'a box as wide as the pane').toBe(false)
          expect(typeof node.props['height'], 'a box of fixed height').not.toBe('number')
        }
      }
      for (const s of strings(tree)) expect(/^(.)\1{9,}$/.test(s), s).toBe(false)
    }
    expect(measured).toEqual([])
  })

  test('the footer is framed on top, between the header and the content', () => {
    const tree = flow() as Node
    const children = [tree.props['children']].flat(Infinity) as Node[]
    const footerAt = children.findIndex(n => n?.props?.['key'] === 'footer')
    const contentAt = children.findIndex(n => n?.props?.['key'] === 'pane-content')
    expect(footerAt).toBeGreaterThan(0)
    expect(contentAt).toBeGreaterThan(footerAt)
    const footer = byKey(tree, 'footer')
    expect(footer?.props['borderStyle']).toBe(ICON_SETS.unicode.border)
    expect(footer?.props['width']).toBeUndefined()
  })

  test("the footer holds the grid's keys, the page keys hidden with their hotkeys", () => {
    for (const isFooterOpen of [true, false]) {
      const grid = renderPane(el, { ...base, icons: ICON_SETS.unicode, isFooterOpen }, act)
      const tree = flow({ isFooterOpen })
      const keysOf = (t: unknown) =>
        nodes(byKey(t, 'footer'))
          .filter(n => n.type === 'Button')
          .map(n => String(n.props['key']))
          .sort()
      expect(keysOf(tree)).toEqual(keysOf(grid))
      const hidden = nodes(byKey(tree, 'footer-hidden')).map(n => n.props['key'])
      expect(hidden).toContain('nav-pageup')
      expect(hidden).toContain('nav-pagedown')
    }
  })

  test('a row sizes by boxes: the label grows and clips, the time keeps its box', () => {
    const tree = flow()
    const item = byKey(tree, 'item-b1')
    const row = nodes(item).find(n => n.type === 'Box' && n.props['flexDirection'] === 'row')
    expect(row?.props['width']).toBeUndefined()
    const label = byKey(tree, 'b1')
    const cell = nodes(row).find(n => n.type === 'Box' && n.props['flexGrow'] === 1 && isInside(n, label))
    expect([cell?.props['flexShrink'], cell?.props['overflow']]).toEqual([1, 'hidden'])
    expect(String(label?.props['label'])).not.toMatch(/ {2}$/)
  })

  test("a row's leading cells sit in boxes of their own width, never padded with spaces", () => {
    const tree = flow({ cursor: 'b1' })
    for (const id of ['b1', 'p1', 't0:o0']) {
      const item = byKey(tree, `item-${id}`)
      for (const key of [`cursor-${id}`, `status-${id}`, `icon-${id}`]) {
        const cell = byKey(item, key)
        const box = nodes(item).find(
          n => n.type === 'Box' && (n.props['children'] === cell || [n.props['children']].flat().includes(cell)),
        )
        expect(typeof box?.props['width'], `${key} box`).toBe('number')
        for (const s of strings(cell)) expect(s.endsWith(' '), `${key}: ${JSON.stringify(s)}`).toBe(false)
      }
    }
  })

  test("a row's card sits above its row, revealed by the row's hover", () => {
    const tree = flow()
    const card = byKey(tree, 'card-p1')
    expect(card).toBeDefined()
    expect(isInside(byKey(tree, 'item-p1'), card)).toBe(true)
    // Above its row, as the terminal places it where it fits: a pointer moving
    // down the rows never lands on the card the row above revealed.
    expect([card?.props['position'], card?.props['bottom'], card?.props['top'], card?.props['display']]).toEqual([
      'absolute',
      1,
      undefined,
      'none',
    ])
    expect((card?.props['hover'] as Record<string, unknown>)['scope']).toBe('row:p1')
  })

  test('no text is padded with spaces to a cell width', () => {
    for (const tree of views()) for (const s of strings(tree)) expect(/\S {2,}$/.test(s), JSON.stringify(s)).toBe(false)
  })

  test('a row reads its name and summary without a padded name column', () => {
    const tree = flow({ thinking: { count: 1, text: 'pondering' } })
    for (const key of ['b1', 't0:thinking']) {
      const label = String(byKey(tree, key)?.props['label'] ?? text(byKey(tree, key)))
      expect(label, key).not.toMatch(/\S {3,}\S/)
    }
  })

  test('holding the keys changes nothing that takes room: the rows never shift under a click', () => {
    for (const extra of [{}, { view: 'turns', stats: [undefined, undefined] }, { isFooterOpen: false }]) {
      const at = (isFocused: boolean) =>
        JSON.stringify(flow({ ...extra, isFocused }), (k, v) =>
          k === 'color' || typeof v === 'function' ? undefined : v,
        )
      expect(at(true)).toBe(at(false))
    }
  })

  test('the header, the keys and the content are cards: rounded frames apart from each other', () => {
    for (const tree of [flow(), flow({ view: 'turns', stats: [undefined, undefined] }), flow(team)]) {
      const root = tree as Node
      const cards = ([root.props['children']].flat(Infinity) as Node[]).filter(n => n?.type === 'Box')
      expect(cards.length).toBeGreaterThanOrEqual(3)
      for (const card of cards) {
        expect(card.props['borderStyle']).toBe(ICON_SETS.unicode.border)
        expect(card.props['marginBottom']).toBe(1)
      }
    }
  })

  test('a detail of many timed rows, each with its bar, stays under the text budget', () => {
    const rows = 400
    const turns = buildTurns([
      { role: 'user', text: 'go', toolUses: [] },
      {
        role: 'assistant',
        text: '',
        toolUses: Array.from({ length: rows }, (_, i) => ({
          tool_use_id: `e${i}`,
          tool: 'Edit',
          input: { file_path: `/f${i}.ts`, old_string: 'a', new_string: 'b' },
          text: 'ok',
        })),
      },
    ])
    const timings = Object.fromEntries(Array.from({ length: rows }, (_, i) => [`e${i}`, { start: 0, end: 1_000 + i }]))
    const tree = flow({ turns, timings, stats: [undefined], columns: 100 })
    expect(strings(tree).join('').length).toBeLessThan(PANE_TEXT_BUDGET + 5_000)
  })

  test("the cursor's row is highlighted across its width, the app's way of showing a selection", () => {
    const detail = flow({ cursor: 'b1' })
    const row = nodes(byKey(detail, 'item-b1')).find(n => n.type === 'Box' && n.props['flexDirection'] === 'row')
    expect(row?.props['backgroundColor']).toBe(C.rowHover)
    const other = nodes(byKey(detail, 'item-p1')).find(n => n.type === 'Box' && n.props['flexDirection'] === 'row')
    expect(other?.props['backgroundColor']).toBeUndefined()
    const turns = flow({ view: 'turns', stats: [undefined, undefined], turnCursor: 1 })
    expect(byKey(turns, 'turn-card-1')?.props['backgroundColor']).toBe(C.rowHover)
    expect(byKey(turns, 'turn-card-0')?.props['backgroundColor']).toBeUndefined()
  })

  test('one row of the turn list is bright: the cursor, else the open turn', () => {
    const stats = [undefined, undefined]
    const dim = (tree: unknown, i: number) => byKey(tree, `turn-${i}`)?.props['dimColor']
    const withCursor = flow({ view: 'turns', stats, selected: 0, turnCursor: 1 })
    expect([dim(withCursor, 0), dim(withCursor, 1)]).toEqual([true, false])
    const without = flow({ view: 'turns', stats, selected: 0 })
    expect([dim(without, 0), dim(without, 1)]).toEqual([false, true])
  })

  test("the turn's card on top: its prompt, its time on the right, model, tokens and context under it", () => {
    const card = byKey(flow({ isLatest: true }), 'flow-turn-card')
    expect(text(card)).toContain('Fix the bug')
    expect(text(card)).toContain('1m 5s')
    expect(text(card)).toMatch(/opus.*1\.5k tokens.*62% context/)
  })

  test('the rows are cards under Running and Finished, a trace keeps its rows inside its card', () => {
    const tree = flow({
      isWorking: true,
      isLatest: true,
      expanded: new Set(['a1']),
      traces: new Map([
        [
          'ag',
          {
            items: buildTurns(
              [
                {
                  role: 'assistant',
                  text: '',
                  toolUses: [{ tool_use_id: 'g', tool: 'Grep', input: { pattern: 'x' }, text: 'm' }],
                },
              ],
              'ag/',
            )[0]!.items,
          },
        ],
      ]),
    })
    expect(text(byKey(tree, 'flow-section-running'))).toBe('Running 2')
    expect(text(byKey(tree, 'flow-section-finished'))).toBe('Finished 3')
    for (const id of ['b1', 'e1', 'a1', 'p1'])
      expect(typeof byKey(tree, `item-${id}`)?.props['borderStyle'], id).toBe('string')
    expect(byKey(tree, 'item-ag/g')?.props['borderStyle']).toBeUndefined()
    expect(nodes(tree).some(n => /^flow-bar/.test(String(n.props['key'])))).toBe(false)
  })

  test('the top row holds the views and the turn moves, as buttons; the cursor keys keep their hotkeys hidden', () => {
    for (const isFooterOpen of [true, false])
      for (const view of ['detail', 'turns'] as const) {
        const tree = flow({ view, isFooterOpen, stats: [undefined, undefined], cursor: 'b1' })
        const shown = nodes(byKey(tree, 'footer-keys'))
          .filter(n => n.type === 'Button')
          .map(n => String(n.props['key']))
        const nav = ['prev', 'next', 'latest', 'detail', 'turns', 'team', 'search', 'expand', 'collapse'].map(
          k => `nav-${k}`,
        )
        expect(shown.length).toBeGreaterThan(0)
        for (const key of shown) expect(nav, key).toContain(key)
        const hidden = nodes(byKey(tree, 'footer-hidden')).map(n => n.props['key'])
        for (const key of ['nav-down', 'nav-up', 'nav-keys']) expect(hidden, key).toContain(key)
      }
  })

  test('a very long turn stays under the text budget and says what it left out', () => {
    // Edits do not fold into one row: each is a row of its own.
    const long = buildTurns([
      { role: 'user', text: 'go', toolUses: [] },
      {
        role: 'assistant',
        text: '',
        toolUses: [
          { tool_use_id: 'big', tool: 'Bash', input: { command: 'cat' }, text: 'x'.repeat(50_000) },
          ...Array.from({ length: 900 }, (_, i) => ({
            tool_use_id: `r${i}`,
            tool: 'Edit',
            input: { file_path: `/${'deep/'.repeat(30)}f${i}.ts`, old_string: 'a', new_string: 'b' },
            text: 'ok',
          })),
        ],
      },
    ])
    const tree = flow({ turns: long, expanded: new Set(['big']), stats: [undefined] })
    expect(strings(tree).join('').length).toBeLessThan(PANE_TEXT_BUDGET + 5_000)
    expect(/more rows? .* pane text budget reached/.test(text(tree))).toBe(true)
  })

  test('a list of very many turns stays under the text budget, as the grid does', () => {
    const many = buildTurns(
      Array.from({ length: 1200 }, (_, i) => [
        { role: 'user' as const, text: `question ${i} `.repeat(30), toolUses: [] },
        { role: 'assistant' as const, text: 'ok', toolUses: [] },
      ]).flat(),
    )
    const stats = many.map((_, i) => ({
      key: 'k',
      turnIndex: i,
      durationMs: 4_000 + i,
      endedAt: i,
      inputTokens: 900,
      outputTokens: 100,
    }))
    for (const columns of [60, 100, 160]) {
      const tree = flow({ view: 'turns', turns: many, stats, columns })
      expect(strings(tree).join('').length, `${columns}`).toBeLessThan(PANE_TEXT_BUDGET + 5_000)
    }
  })

  test('two ticks while working draw the same tree but the spinner', () => {
    const spin = new RegExp(`[${ICON_SETS.unicode.spinner.join('')}]`, 'g')
    const at = (frame: number) =>
      JSON.stringify(flow({ isWorking: true, isLatest: true, frame }), (_k, v) =>
        typeof v === 'string' ? v.replace(spin, '*') : typeof v === 'function' ? undefined : v,
      )
    expect(at(1)).toBe(at(0))
  })
})
