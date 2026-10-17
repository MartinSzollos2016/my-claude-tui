// The desktop app's pane (isFlow): it flows at its natural height, the footer
// framed on top, rows sized by boxes, cards on their rows, no cell sizes.
import { describe, expect, test } from 'claude-code/testing'
import { ICON_SETS } from '../hooks/icons'
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
        if (node.type === 'Box' && node.props['position'] !== 'absolute') {
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

  test("a row's card sits on its row, revealed by the row's hover", () => {
    const tree = flow()
    const card = byKey(tree, 'card-p1')
    expect(card).toBeDefined()
    expect(isInside(byKey(tree, 'item-p1'), card)).toBe(true)
    expect([card?.props['position'], card?.props['top'], card?.props['display']]).toEqual(['absolute', 1, 'none'])
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
    expect(strings(tree).join('').length).toBeLessThan(PANE_TEXT_BUDGET + 15_000)
    expect(/more rows? .* pane text budget reached/.test(text(tree))).toBe(true)
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
