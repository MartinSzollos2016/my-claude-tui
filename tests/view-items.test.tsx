import { describe, expect, test } from 'claude-code/testing'
import { ICON_SETS } from '../hooks/icons'
import { C } from '../hooks/theme'
import { rowText } from '../hooks/model/cursor'
import { resetSectionCache, sectionCacheSize } from '../hooks/model/sections'
import { buildTurns } from '../hooks/model/turns'
import { displayWidth } from '../hooks/model/width'
import { renderPane } from '../hooks/view/pane'
import { act, acts, base, byKey, calls, el, foldedTimings, foldedTurn, nodes, text, type Node } from './fixtures/view'

describe('trace tree guides', () => {
  const traceOf = () =>
    buildTurns(
      [
        {
          role: 'assistant',
          text: '',
          toolUses: [
            { tool_use_id: 'g', tool: 'Grep', input: { pattern: 'x' }, text: 'm' },
            { tool_use_id: 'r', tool: 'Read', input: { file_path: '/a.go' }, text: 'm' },
          ],
        },
      ],
      'ag/',
    )[0]!.items
  const rows = (icons: (typeof ICON_SETS)['nerd']) =>
    renderPane(el, { ...base, icons, expanded: new Set(['a1']), traces: new Map([['ag', { items: traceOf() }]]) }, act)

  test('trace rows lead with ├─ and └─ in muted text, the last row closes the branch', () => {
    const tree = rows(ICON_SETS.nerd)
    const guides = nodes(tree).filter(n => n.type === 'Text' && /^[├└]─ $/.test(text(n)))
    expect(guides.map(text)).toEqual(['├─ ', '└─ '])
    for (const g of guides) expect(g.props['color']).toBe('inactive')
    expect(byKey(tree, 'guide-ag/g')).toBeDefined()
    expect(byKey(tree, 'guide-a1')).toBeUndefined()
  })

  test('the ascii set uses |- and `-, and a label gives up the room the indent and prefix take', () => {
    const guides = nodes(rows(ICON_SETS.ascii)).filter(n => n.props['key']?.toString().startsWith('guide-'))
    expect(guides.map(text)).toEqual(['|- ', '`- '])
    const long = (id: string, prefix: string) =>
      buildTurns(
        [
          {
            role: 'assistant',
            text: '',
            toolUses: [
              { tool_use_id: id, tool: 'Bash', input: { command: 'x', description: 'd'.repeat(300) }, text: 'm' },
            ],
          },
        ],
        prefix,
      )[0]!.items
    const top = renderPane(
      el,
      {
        ...base,
        columns: 50,
        turns: buildTurns([
          {
            role: 'assistant',
            text: '',
            toolUses: [
              { tool_use_id: 'L', tool: 'Bash', input: { command: 'x', description: 'd'.repeat(300) }, text: 'm' },
            ],
          },
        ]),
      },
      act,
    )
    const inTrace = renderPane(
      el,
      { ...base, columns: 50, expanded: new Set(['a1']), traces: new Map([['ag', { items: long('L', 'ag/') }]]) },
      act,
    )
    const topLen = String(byKey(top, 'L')?.props['label']).length
    const traceLen = String(byKey(inTrace, 'ag/L')?.props['label']).length
    expect(topLen - traceLen).toBe(4 + 3)
  })

  test('a subagent inside a trace continues the guide of its parent', () => {
    const inner = buildTurns(
      [
        {
          role: 'assistant',
          text: '',
          toolUses: [
            { tool_use_id: 'n', tool: 'Agent', input: { subagent_type: 'Explore' }, agentId: 'in', text: 'r' },
            { tool_use_id: 'z', tool: 'Read', input: { file_path: '/z' }, text: 'm' },
          ],
        },
      ],
      'ag/',
    )[0]!.items
    const leaf = buildTurns(
      [
        {
          role: 'assistant',
          text: '',
          toolUses: [{ tool_use_id: 'q', tool: 'Grep', input: { pattern: 'x' }, text: 'm' }],
        },
      ],
      'in/',
    )[0]!.items
    const tree = renderPane(
      el,
      {
        ...base,
        expanded: new Set(['a1', 'ag/n']),
        traces: new Map([
          ['ag', { items: inner }],
          ['in', { items: leaf }],
        ]),
      },
      act,
    )
    expect(text(byKey(tree, 'guide-in/q'))).toBe('│  └─ ')

    // Margins do not pile up: the continuation guide of the nested row sits in
    // the column of its parent's branch glyph, the nested branch one level in.
    const offsetOf = (key: string, from: unknown, acc = 0): number | undefined => {
      if (Array.isArray(from)) {
        for (const c of from) {
          const found = offsetOf(key, c, acc)
          if (found !== undefined) return found
        }
        return undefined
      }
      if (from === null || typeof from !== 'object' || !('type' in from)) return undefined
      const n = from as Node
      const here = acc + (typeof n.props['marginLeft'] === 'number' ? n.props['marginLeft'] : 0)
      if (n.props['key'] === key) return here
      return offsetOf(key, n.children, here)
    }
    const parent = offsetOf('item-ag/n', tree)
    const child = offsetOf('item-in/q', tree)
    expect(parent).toBeDefined()
    expect(child).toBe(parent)
    const sibling = offsetOf('item-ag/z', tree)
    expect(sibling).toBe(parent)
  })
})

describe('display-width alignment', () => {
  const rowLabel = (description: string, name = 'Bash') => {
    const wide = buildTurns([
      { role: 'user', text: 'go', toolUses: [] },
      {
        role: 'assistant',
        text: '',
        toolUses: [{ tool_use_id: 'w1', tool: name, input: { command: 'x', description }, text: 'ok' }],
      },
    ])
    return String(byKey(renderPane(el, { ...base, turns: wide }, act), 'w1')?.props['label'])
  }

  test('a row label with wide characters is cut to the room in cells', () => {
    const cjk = rowLabel('日本語'.repeat(70))
    // An untimed row: 100 columns less chevron, status and icon (7 cells).
    expect(displayWidth(cjk)).toBeLessThanOrEqual(93)
    expect(displayWidth(cjk)).toBeGreaterThanOrEqual(92)
    expect(cjk.trimEnd().endsWith('…')).toBe(true)
  })

  test('a wide tool name sets the name column in cells, an ASCII one pads to it', () => {
    const mixed = buildTurns([
      { role: 'user', text: 'go', toolUses: [] },
      {
        role: 'assistant',
        text: '',
        toolUses: [
          { tool_use_id: 'w1', tool: 'mcp__srv__日本語', input: { q: 'a' }, text: 'ok' },
          { tool_use_id: 'r1', tool: 'Read', input: { file_path: '/a.ts' }, text: 'ok' },
        ],
      },
    ])
    const tree = renderPane(el, { ...base, turns: mixed, stats: [undefined] }, act)
    expect(String(byKey(tree, 'r1')?.props['label'])).toMatch(/^Read {4}\S/)
    expect(String(byKey(tree, 'w1')?.props['label'])).toMatch(/^日本語 {2}\S/)
  })

  test('the turn list pads its prompt column by cells', () => {
    const wide = buildTurns([
      { role: 'user', text: '日本語の長い質問'.repeat(20), toolUses: [] },
      { role: 'assistant', text: 'ok', toolUses: [] },
    ])
    const tree = renderPane(el, { ...base, turns: wide, view: 'turns', stats: [undefined] }, act)
    const row = text(byKey(tree, 'turn-0') ?? nodes(tree).find(n => n.props['key'] === 'turn-0'))
    expect(displayWidth(row)).toBeLessThanOrEqual(98)
  })
})

describe('duration bars', () => {
  const bar = (tree: unknown, id: string) => byKey(tree, `bar-${id}`)

  test('each tool row ends in an 8-cell bar relative to the longest call, the longest in the accent', () => {
    const tree = renderPane(el, base, act)
    expect(text(bar(tree, 'a1'))).toBe('████████')
    expect(bar(tree, 'a1')?.props['color']).toBe(C.accent)
    expect(text(bar(tree, 'b1'))).toBe('█████   ')
    expect(bar(tree, 'b1')?.props['color']).toBe(C.muted)
    expect(text(bar(tree, 'p1'))).toBe('██      ')
    for (const id of ['b1', 'a1', 'p1']) expect(displayWidth(text(bar(tree, id)))).toBe(8)
  })

  test('a row without a duration draws no bar', () => {
    expect(bar(renderPane(el, base, act), 'e1')).toBeUndefined()
  })

  test('the bar is left out under 70 columns and the label takes its room back', () => {
    const wide = renderPane(el, { ...base, columns: 70 }, act)
    const narrow = renderPane(el, { ...base, columns: 69 }, act)
    expect(bar(wide, 'b1')).toBeDefined()
    expect(bar(narrow, 'b1')).toBeUndefined()
  })

  test('the ascii set draws = and -', () => {
    const tree = renderPane(el, { ...base, icons: ICON_SETS.ascii }, act)
    expect(text(bar(tree, 'a1'))).toBe('========')
    expect(text(bar(tree, 'b1'))).toBe('=====   ')
  })

  test('the label and the bar fit the width', () => {
    const long = buildTurns([
      { role: 'user', text: 'go', toolUses: [] },
      {
        role: 'assistant',
        text: '',
        toolUses: [
          { tool_use_id: 'l1', tool: 'Bash', input: { command: 'x', description: 'd'.repeat(300) }, text: 'ok' },
        ],
      },
    ])
    const label = (columns: number) =>
      displayWidth(
        String(
          byKey(renderPane(el, { ...base, turns: long, columns, timings: { l1: { start: 0, end: 5000 } } }, act), 'l1')
            ?.props['label'],
        ),
      )
    // Chevron, status and icon take 7 cells, the time 8, and the bar 9 more while it shows.
    expect(label(70)).toBe(70 - 15 - 9)
    expect(label(69)).toBe(69 - 15)
  })
})

describe('grouped runs', () => {
  const run = (n: number, extra: { tool_use_id: string; tool: string; input: Record<string, unknown> }[] = []) =>
    buildTurns([
      { role: 'user', text: 'go', toolUses: [] },
      {
        role: 'assistant',
        text: '',
        toolUses: [
          ...Array.from({ length: n }, (_, i) => ({
            tool_use_id: `g${i}`,
            tool: 'Read',
            input: { file_path: `/src/f${i % 3}.ts` },
            text: 'x',
          })),
          ...extra.map(e => ({ ...e, text: 'ok' })),
        ],
      },
    ])
  const timings = { g0: { start: 0, end: 1000 }, g1: { start: 1000, end: 4000 }, g2: { start: 4000, end: 4500 } }
  const grouped = { ...base, turns: run(3), timings }

  test('a run of three reads is one row with its calls and files, not three rows', () => {
    const tree = renderPane(el, grouped, act)
    expect(String(byKey(tree, 'group:g0')?.props['label']).trimEnd()).toBe('Read ×3 · 3 files')
    expect(byKey(tree, 'g0')).toBeUndefined()
    expect(byKey(tree, 'g1')).toBeUndefined()
    expect(text(byKey(tree, 'status-group:g0'))).toBe('✓ ')
  })

  test('the group row shows the total time as one bar, the longest row of the turn', () => {
    const tree = renderPane(el, grouped, act)
    expect(text(nodes(tree).find(n => n.props['key'] === 'bar-group:g0'))).toBe('████████')
    expect(nodes(tree).find(n => n.props['key'] === 'bar-group:g0')?.props['color']).toBe(C.accent)
    expect(text(tree)).toContain('4.5s')
  })

  test('a click toggles the group id', () => {
    calls.length = 0
    ;(byKey(renderPane(el, grouped, act), 'group:g0')?.props['onPress'] as () => void)()
    expect(calls).toEqual(['toggle:group:g0'])
  })

  test('open, it lists the original rows under tree guides, the last closing the branch', () => {
    const tree = renderPane(el, { ...grouped, expanded: new Set(['group:g0']) }, act)
    expect(byKey(tree, 'g0')).toBeDefined()
    expect(byKey(tree, 'g2')).toBeDefined()
    const guides = nodes(tree).filter(n => n.props['key']?.toString().startsWith('guide-'))
    expect(guides.map(text)).toEqual(['├─ ', '├─ ', '└─ '])
    for (const g of guides) expect(g.props['color']).toBe(C.muted)
  })

  test('the group state survives a longer run, and two calls do not group', () => {
    const longer = renderPane(el, { ...grouped, turns: run(5), expanded: new Set(['group:g0']) }, act)
    expect(byKey(longer, 'g4')).toBeDefined()
    const two = renderPane(el, { ...grouped, turns: run(2) }, act)
    expect(byKey(two, 'group:g0')).toBeUndefined()
    expect(byKey(two, 'g0')).toBeDefined()
  })

  test('an error call or another tool breaks the run', () => {
    const broken = buildTurns([
      { role: 'user', text: 'go', toolUses: [] },
      {
        role: 'assistant',
        text: '',
        toolUses: [
          { tool_use_id: 'a', tool: 'Read', input: { file_path: '/a' }, text: 'x' },
          { tool_use_id: 'b', tool: 'Read', input: { file_path: '/b' }, text: 'x' },
          { tool_use_id: 'c', tool: 'Read', input: { file_path: '/c' }, text: 'boom', isError: true },
          { tool_use_id: 'd', tool: 'Read', input: { file_path: '/d' }, text: 'x' },
        ],
      },
    ])
    const tree = renderPane(el, { ...base, turns: broken }, act)
    expect(nodes(tree).some(n => String(n.props['key']).startsWith('group:'))).toBe(false)
  })

  test('a run in a subagent trace groups under the trace guides', () => {
    const trace = buildTurns(
      [
        {
          role: 'assistant',
          text: '',
          toolUses: [1, 2, 3].map(n => ({
            tool_use_id: `t${n}`,
            tool: 'Grep',
            input: { pattern: `p${n}` },
            text: 'm',
          })),
        },
      ],
      'ag/',
    )[0]!.items
    const tree = renderPane(
      el,
      {
        ...base,
        expanded: new Set(['a1', 'group:ag/t1']),
        traces: new Map([['ag', { items: trace }]]),
      },
      act,
    )
    expect(String(byKey(tree, 'group:ag/t1')?.props['label']).trimEnd()).toBe('Grep ×3 · 3 patterns')
    expect(byKey(tree, 'ag/t2')).toBeDefined()
    expect(text(tree)).toMatch(/└─ /)
  })

  test('the ascii set groups with x and draws only ASCII', () => {
    const tree = renderPane(el, { ...grouped, icons: ICON_SETS.ascii, expanded: new Set(['group:g0']) }, act)
    expect(String(byKey(tree, 'group:g0')?.props['label']).trimEnd()).toBe('Read x3 . 3 files')
    expect(text(tree)).toMatch(/^[\x20-\x7e\n]*$/)
  })

  test('every group text and button keeps the colors and hover scope', () => {
    const tree = renderPane(el, { ...grouped, expanded: new Set(['group:g0']) }, act)
    for (const n of nodes(tree)) if (n.type === 'Text') expect(n.props['color']).toBeDefined()
    const row = byKey(tree, 'group:g0')
    expect(row?.props['plain']).toBe(true)
    expect(row?.props['dimColor']).toBe(true)
    expect(row?.props['hover']).toMatchObject({ scope: 'row:group:g0' })
  })
})

describe('group status', () => {
  const three = (extra: Record<string, unknown> = {}) =>
    buildTurns([
      { role: 'user', text: 'go', toolUses: [] },
      {
        role: 'assistant',
        text: '',
        toolUses: [
          { tool_use_id: 's1', tool: 'Read', input: { file_path: '/a' }, text: 'x' },
          { tool_use_id: 's2', tool: 'Read', input: { file_path: '/b' }, text: 'x', ...extra },
          { tool_use_id: 's3', tool: 'Read', input: { file_path: '/c' } },
        ],
      },
    ])
  const glyph = (props: Record<string, unknown>) =>
    text(byKey(renderPane(el, { ...base, turns: three(), ...props }, act), 'status-group:s1'))

  test('a stale pending member makes the group idle, not a spinner', () => {
    expect(glyph({ isLatest: false })).toBe('· ')
    expect(glyph({ isLatest: true, isWorking: false })).toBe('· ')
  })

  test('a pending member of the live turn keeps the spinner', () => {
    expect(glyph({ isLatest: true, isWorking: true })).toBe('⠋ ')
  })

  test('an interrupted member shows interrupted', () => {
    const turns = buildTurns([
      { role: 'user', text: 'go', toolUses: [] },
      {
        role: 'assistant',
        text: '',
        toolUses: [1, 2, 3].map(n => ({
          tool_use_id: `i${n}`,
          tool: 'Read',
          input: { file_path: `/${n}` },
          text: 'x',
          ...(n === 2 ? { interrupted: true } : {}),
        })),
      },
    ])
    const items = turns[0]!.items.map(it =>
      it.kind === 'tool' && it.id === 'i2' ? { ...it, isInterrupted: true } : it,
    )
    const tree = renderPane(el, { ...base, turns: [{ ...turns[0]!, items }] }, act)
    expect(text(byKey(tree, 'status-group:i1'))).toBe('⏸ ')
  })

  test('the bar scale ignores traces of other turns', () => {
    const other = buildTurns(
      [{ role: 'assistant', text: '', toolUses: [{ tool_use_id: 'z', tool: 'Bash', input: {}, text: 'x' }] }],
      'zz/',
    )[0]!.items
    const tree = renderPane(
      el,
      {
        ...base,
        traces: new Map([['zz', { items: other }]]),
        timings: { ...base.timings, z: { start: 0, end: 900_000 } },
      },
      act,
    )
    expect(text(nodes(tree).find(n => n.props['key'] === 'bar-a1'))).toBe('████████')
  })
})

describe('keyboard cursor', () => {
  const marks = (tree: unknown) => nodes(tree).filter(n => String(n.props['key']).startsWith('cursor-'))
  const buttons = (tree: unknown, key: string) => byKey(tree, key)

  test('no cursor draws no marker column, the marked row gets the accent block', () => {
    expect(marks(renderPane(el, base, act))).toHaveLength(0)
    expect(marks(renderPane(el, { ...base, cursor: null }, act))).toHaveLength(0)
    const tree = renderPane(el, { ...base, cursor: 'e1' }, act)
    const drawn = marks(tree)
    expect(drawn.map(n => n.props['key'])).toEqual(['cursor-t0:o0', 'cursor-b1', 'cursor-e1', 'cursor-a1', 'cursor-p1'])
    for (const mark of drawn) {
      const isHere = mark.props['key'] === 'cursor-e1'
      expect(text(mark)).toBe(isHere ? '\u258c' : ' ')
      expect(mark.props['color']).toBe(isHere ? 'suggestion' : 'inactive')
    }
  })

  test('the marker is a plain > in the ascii set, and the folded run is a row of its own', () => {
    const ascii = renderPane(el, { ...base, cursor: 'b1', icons: ICON_SETS.ascii }, act)
    expect(text(byKey(ascii, 'cursor-b1'))).toBe('>')
    const run = renderPane(el, { ...base, turns: foldedTurn, cursor: 'group:fr1', timings: foldedTimings }, act)
    expect(text(byKey(run, 'cursor-group:fr1'))).toBe('\u258c')
    expect(text(byKey(run, 'cursor-fe'))).toBe(' ')
  })

  test('a cursor keeps the label inside the row: the marker takes one cell of the label room', () => {
    const plain = String(byKey(renderPane(el, { ...base, turns: foldedTurn }, act), 'fe')?.props['label'])
    const moved = String(byKey(renderPane(el, { ...base, turns: foldedTurn, cursor: 'fe' }, act), 'fe')?.props['label'])
    expect(displayWidth(moved)).toBeLessThanOrEqual(displayWidth(plain))
  })

  test('j, k and y sit in the cursor group, plain and dim with their own hover scope', () => {
    const tree = renderPane(el, { ...base, cursor: 'b1' }, act)
    const keys = nodes(byKey(tree, 'footer-row-1'))
      .filter(n => n.type === 'Button' && ['j', 'k', 'o', 'y'].includes(String(n.props['hotkey'])))
      .map(n => [n.props['key'], n.props['hotkey'], String(n.props['label']).trimEnd()])
    expect(keys).toEqual([
      ['nav-down', 'j', '↓'],
      ['nav-up', 'k', '↑'],
      ['nav-open', 'o', 'open'],
      ['nav-copy', 'y', 'copy'],
    ])
    for (const [key] of keys) {
      const b = buttons(tree, String(key))!
      expect(b.props['plain']).toBe(true)
      expect(b.props['dimColor']).toBe(true)
      expect((b.props['hover'] as { scope: string }).scope).toBe(`btn:${String(key)}`)
    }
  })

  test('y and o act only with a cursor, j nothing for a turn without rows', () => {
    const idle = renderPane(el, base, act)
    expect(acts(idle, 'nav-down')).toBe(true)
    expect(acts(idle, 'nav-copy')).toBe(false)
    expect(acts(idle, 'nav-open')).toBe(false)
    const empty = renderPane(el, { ...base, turns: buildTurns([{ role: 'user', text: 'hi', toolUses: [] }]) }, act)
    expect(acts(empty, 'nav-down')).toBe(false)
  })

  test('the buttons call the actions, y passes the surface of the press', () => {
    calls.length = 0
    const tree = renderPane(el, { ...base, cursor: 'b1' }, act)
    ;(buttons(tree, 'nav-down')!.props['onPress'] as () => void)()
    ;(buttons(tree, 'nav-up')!.props['onPress'] as () => void)()
    ;(buttons(tree, 'nav-open')!.props['onPress'] as () => void)()
    ;(buttons(tree, 'nav-copy')!.props['onPress'] as (e: { surface: string }) => void)({ surface: 'terminal' })
    expect(calls).toEqual(['down:0/24/6/2/3', 'up', 'open', 'copyCursor:terminal'])
  })
})

describe('hover preview card', () => {
  const cardOf = (tree: unknown, id: string) => byKey(tree, `card-${id}`)
  const bashTurn = (command: string, extra: Record<string, unknown> = {}) =>
    buildTurns([
      { role: 'user', text: 'go', toolUses: [] },
      {
        role: 'assistant',
        text: '',
        toolUses: [{ tool_use_id: 'c1', tool: 'Bash', input: { command }, text: 'OUTPUT', ...extra }],
      },
    ])

  test('a collapsed tool row has a hidden absolute card revealed by the hover of its row scope', () => {
    const card = cardOf(renderPane(el, base, act), 'b1')!
    expect(card.props['position']).toBe('absolute')
    expect(card.props['display']).toBe('none')
    expect(card.props['hover']).toEqual({ scope: 'row:b1', display: 'flex' })
    expect(card.props['bottom']).toBe(1)
    expect(card.props['backgroundColor']).toBe(C.paneBackground)
    expect(card.props['left']).toBe(4)
    expect(card.props['borderStyle']).toBe('round')
    expect(card.props['borderColor']).toBe('inactive')
    expect(text(card)).toContain('go test ./...')
    expect(text(card)).not.toContain('ok')
    for (const t of nodes(card).filter(n => n.type === 'Text')) expect(t.props['color']).toBe('inactive')
  })

  test('the card sits in the row box, whose Texts share the scope', () => {
    const tree = renderPane(el, base, act)
    const row = byKey(tree, 'item-b1')!
    expect(nodes(row)).toContain(cardOf(tree, 'b1'))
    const scoped = nodes(row).filter(n => n.type === 'Text' && (n.props['hover'] as { scope?: string })?.scope)
    expect(scoped.length).toBeGreaterThan(0)
    for (const t of scoped) expect((t.props['hover'] as { scope: string }).scope).toBe('row:b1')
  })

  test('an expanded row, a message, a folded run and a call with nothing to open have no card', () => {
    const tree = renderPane(el, { ...base, expanded: new Set(['b1']) }, act)
    expect(cardOf(tree, 'b1')).toBeUndefined()
    expect(cardOf(tree, 't0:o0')).toBeUndefined()
    const folded = renderPane(el, { ...base, turns: foldedTurn }, act)
    expect(cardOf(folded, 'group:fr1')).toBeUndefined()
    expect(cardOf(folded, 'fe')).toBeDefined()
    const bare = buildTurns([
      { role: 'user', text: 'go', toolUses: [] },
      { role: 'assistant', text: '', toolUses: [{ tool_use_id: 'n1', tool: 'Bash', input: {} }] },
    ])
    expect(cardOf(renderPane(el, { ...base, turns: bare }, act), 'n1')).toBeUndefined()
  })

  test('the card shows six lines cut to the pane width and at most 600 characters', () => {
    const six = Array.from({ length: 10 }, (_, n) => `line${n} ${'w'.repeat(200)}`).join('\n')
    const card = cardOf(renderPane(el, { ...base, turns: bashTurn(six), columns: 60 }, act), 'c1')!
    const lines = nodes(card).filter(n => n.type === 'Text')
    expect(lines).toHaveLength(6)
    for (const l of lines) expect(displayWidth(text(l))).toBeLessThanOrEqual(52)
    const narrow = bashTurn(Array.from({ length: 6 }, () => 'z'.repeat(300)).join('\n'))
    const wide = cardOf(renderPane(el, { ...base, turns: narrow, columns: 400 }, act), 'c1')!
    expect(text(wide).length).toBeLessThanOrEqual(600)
  })

  test('the ascii set draws the card with a classic border and ASCII text', () => {
    const card = cardOf(renderPane(el, { ...base, icons: ICON_SETS.ascii }, act), 'b1')!
    expect(card.props['borderStyle']).toBe('classic')
    expect(text(card)).toMatch(/^[\x20-\x7e]+$/)
  })

  test('cards draw from the pane text budget and stop at their own share of it', () => {
    const many = buildTurns([
      { role: 'user', text: 'go', toolUses: [] },
      {
        role: 'assistant',
        text: '',
        toolUses: Array.from({ length: 300 }, (_, n) => ({
          tool_use_id: `k${n}`,
          tool: 'Bash',
          input: { command: 'q'.repeat(590) },
          text: 'x',
        })),
      },
    ])
    const tree = renderPane(el, { ...base, turns: many, columns: 700 }, act)
    expect(cardOf(tree, 'k0')).toBeDefined()
    expect(cardOf(tree, 'k299')).toBeUndefined()
    expect(text(tree).length).toBeLessThan(100_000)
    const open = renderPane(el, { ...base, turns: bashTurn('ls'), expanded: new Set(['c1']), columns: 700 }, act)
    expect(text(open)).toContain('OUTPUT')
  })

  const calls = (tool: string, input: (n: number) => Record<string, unknown>, text: string) =>
    buildTurns([
      { role: 'user', text: 'go', toolUses: [] },
      {
        role: 'assistant',
        text: '',
        toolUses: Array.from({ length: 400 }, (_, n) => ({ tool_use_id: `${tool}${n}`, tool, input: input(n), text })),
      },
    ])
  const body = (tag: string) => Array.from({ length: 400 }, (_, n) => `${tag} ${n}`).join('\n')

  test('400 Edits draw their cards without building a diff, on every drawing', () => {
    const edits = calls(
      'Edit',
      n => ({ file_path: `/f${n}.go`, old_string: body('old'), new_string: body('new') }),
      'ok',
    )
    resetSectionCache()
    const first = renderPane(el, { ...base, turns: edits }, act)
    renderPane(el, { ...base, turns: edits }, act)
    expect(cardOf(first, 'Edit0')).toBeDefined()
    expect(sectionCacheSize()).toBe(0)
  })

  test('the text of a folded run of 400 Reads is built once, then read from the cache', () => {
    const numbered = Array.from({ length: 400 }, (_, n) => `${String(n + 1).padStart(6)}\tline ${n}`).join('\n')
    const reads = calls('Read', n => ({ file_path: `/f${n}.go` }), numbered)
    const items = reads[0]!.items
    resetSectionCache()
    renderPane(el, { ...base, turns: reads, cursor: 'group:Read0' }, act)
    const whole = rowText(items, 'group:Read0', () => undefined, ICON_SETS.nerd)
    expect(sectionCacheSize()).toBe(400)
    expect(rowText(items, 'group:Read0', () => undefined, ICON_SETS.nerd)).toBe(whole)
    expect(sectionCacheSize()).toBe(400)
  })

  test('a card in a subagent trace is placed against its own row', () => {
    const trace = buildTurns(
      [{ role: 'assistant', text: '', toolUses: [{ tool_use_id: 'g', tool: 'Grep', input: { pattern: 'x' } }] }],
      'ag/',
    )
    const tree = renderPane(
      el,
      { ...base, expanded: new Set(['a1']), traces: new Map([['ag', { items: trace[0]!.items }]]) },
      act,
    )
    expect(cardOf(tree, 'ag/g')?.props['hover']).toEqual({ scope: 'row:ag/g', display: 'flex' })
  })
})

describe('row hit areas', () => {
  const press = (n: Node | undefined) => (n?.props['onPress'] as () => void)()

  test('the chevron of a row that opens is a button that toggles it', () => {
    calls.length = 0
    const tree = renderPane(el, base, act)
    const chevron = byKey(tree, 'chevron-b1')!
    expect(chevron.type).toBe('Button')
    // Every button is the theme grey: open or closed reads from the glyph.
    expect(chevron.props).toMatchObject({ plain: true, dimColor: true })
    press(chevron)
    const byChevron = calls.at(-1)
    press(byKey(tree, 'b1'))
    expect(byChevron).toBeDefined()
    expect(calls.at(-1)).toBe(byChevron)
    const opened = byKey(renderPane(el, { ...base, expanded: new Set(['b1']) }, act), 'chevron-b1')
    expect(opened?.props['label']).toBe(`${ICON_SETS.nerd.expanded} `)
    expect(chevron.props['label']).toBe(`${ICON_SETS.nerd.collapsed} `)
  })

  test('the label of a row fills the room up to the model and duration columns', () => {
    const tree = renderPane(el, base, act)
    const labels = ['b1', 'e1'].map(id => String(byKey(tree, id)?.props['label']))
    // e1 has no time: it takes back the 17 cells of time and bar b1 keeps.
    expect(displayWidth(labels[1]!) - displayWidth(labels[0]!)).toBe(17)
    expect(labels.some(label => / {2}$/.test(label))).toBe(true)
  })

  test('a row with nothing to open keeps its chevron as text', () => {
    const bare = buildTurns([
      { role: 'user', text: 'go', toolUses: [] },
      { role: 'assistant', text: '', toolUses: [{ tool_use_id: 'n1', tool: 'Bash', input: {} }] },
    ])
    const tree = renderPane(el, { ...base, turns: bare }, act)
    expect(byKey(tree, 'n1')?.type).not.toBe('Button')
    expect(byKey(tree, 'chevron-n1')).toBeUndefined()
    // A blank chevron where the row cannot open.
    expect(text(byKey(tree, 'item-n1')).startsWith('  ')).toBe(true)
    expect(text(byKey(tree, 'item-n1'))).not.toContain(ICON_SETS.nerd.selected)
  })

  test('the thinking row has a chevron button and a label as wide as the row allows', () => {
    calls.length = 0
    const tree = renderPane(el, { ...base, thinking: { count: 1, text: 'short' } }, act)
    press(byKey(tree, 'chevron-t0:thinking'))
    expect(calls).toEqual(['toggle:t0:thinking'])
    expect(displayWidth(String(byKey(tree, 't0:thinking')?.props['label']))).toBe(base.columns - 6)
  })
})

describe('row columns', () => {
  type Uses = Parameters<typeof buildTurns>[0][number]['toolUses']
  const turnOf = (toolUses: Uses) =>
    buildTurns([
      { role: 'user', text: 'go', toolUses: [] },
      { role: 'assistant', text: '', toolUses },
    ])
  const three = turnOf([
    { tool_use_id: 'r1', tool: 'Read', input: { file_path: '/a.ts' }, text: 'x' },
    { tool_use_id: 'g1', tool: 'Grep', input: { pattern: 'foo' }, text: 'x' },
    { tool_use_id: 'w1', tool: 'WebFetch', input: { url: 'https://e.x' }, text: 'x' },
  ])
  const draw = (extra: Record<string, unknown> = {}) =>
    renderPane(el, { ...base, turns: three, stats: [undefined], timings: {}, ...extra }, act)
  const label = (tree: unknown, id: string) => String(byKey(tree, id)?.props['label'])

  test('names pad to the widest name of the list, the summary two cells after, no dash', () => {
    const tree = draw()
    expect(label(tree, 'r1')).toMatch(/^Read {6}\S/)
    expect(label(tree, 'w1')).toMatch(/^WebFetch {2}\S/)
    for (const id of ['r1', 'g1', 'w1']) expect(label(tree, id)).not.toContain(' - ')
  })

  test('names pad to at most 12 cells', () => {
    const long = turnOf([
      { tool_use_id: 'r1', tool: 'Read', input: { file_path: '/a.ts' }, text: 'x' },
      { tool_use_id: 'm1', tool: 'mcp__server__a_very_long_tool_name', input: { q: 'a' }, text: 'x' },
    ])
    expect(label(renderPane(el, { ...base, turns: long, stats: [undefined], timings: {} }, act), 'r1')).toMatch(
      /^Read {10}\S/,
    )
  })

  test('a row without a duration runs its label to the edge and draws no bar', () => {
    const tree = draw()
    // 100 columns less chevron, status and icon (7 cells).
    expect(displayWidth(label(tree, 'r1'))).toBe(93)
    expect(byKey(tree, 'bar-r1')).toBeUndefined()
  })

  test('a timed row ends in its time and bar, the label gives up exactly their room', () => {
    const tree = draw({ timings: { r1: { start: 0, end: 4_000 } } })
    // A space, the time in 7 cells, a space and the 8-cell bar.
    expect(displayWidth(label(tree, 'r1'))).toBe(93 - 17)
    expect(displayWidth(text(byKey(tree, 'bar-r1')))).toBe(8)
    expect(text(byKey(tree, 'item-r1'))).toContain('   4.0s ')
    expect(text(byKey(tree, 'item-r1'))).not.toContain(ICON_SETS.nerd.dot)
  })

  test('the thinking row follows the name width of its turn', () => {
    const tree = draw({ thinking: { count: 1, text: 'pondering' } })
    expect(label(tree, 't0:thinking')).toMatch(/^Thinking {2}pondering/)
  })
})

describe('failed children', () => {
  const turns = buildTurns([
    { role: 'user', text: 'go', toolUses: [] },
    {
      role: 'assistant',
      text: '',
      toolUses: [{ tool_use_id: 'ag1', tool: 'Agent', input: { description: 'Job' }, agentId: 'A', text: 'ok' }],
    },
  ])
  const call = (id: string, isError: boolean) => ({
    tool_use_id: id,
    tool: 'Bash',
    input: { command: 'ls' },
    text: isError ? 'Error: no' : 'ok',
    ...(isError ? { isError: true as const } : {}),
  })
  const items = buildTurns(
    [{ role: 'assistant', text: '', toolUses: [call('c1', true), call('c2', false), call('c3', true)] }],
    'A/',
  )[0]!.items
  const traces = new Map([['A', { items }]])
  const draw = (status: 'completed' | 'running', extra: Record<string, unknown> = {}) =>
    renderPane(el, { ...base, turns, stats: [undefined], traces, agents: new Map([['A', status]]), ...extra }, act)

  test('a collapsed finished subagent counts the failed calls of its trace, in the error colour', () => {
    const badge = byKey(draw('completed'), 'badge-ag1')
    expect(text(badge)).toBe(` ${ICON_SETS.nerd.error}2`)
    expect(badge?.props['color']).toBe(C.error)
  })

  test('a running, an open or a clean subagent has no mark', () => {
    expect(byKey(draw('running'), 'badge-ag1')).toBeUndefined()
    expect(byKey(draw('completed', { expanded: new Set(['ag1']) }), 'badge-ag1')).toBeUndefined()
    const clean = new Map([['A', { items: items.filter(item => item.kind === 'tool' && !item.isError) }]])
    expect(byKey(draw('completed', { traces: clean }), 'badge-ag1')).toBeUndefined()
  })

  test('a trace that names its own agent is counted once, not without end', () => {
    const loop = buildTurns(
      [
        {
          role: 'assistant',
          text: '',
          toolUses: [
            call('c1', true),
            { tool_use_id: 'self', tool: 'Agent', input: { description: 'Me' }, agentId: 'A', text: 'ok' },
          ],
        },
      ],
      'A/',
    )[0]!.items
    expect(text(byKey(draw('completed', { traces: new Map([['A', { items: loop }]]) }), 'badge-ag1'))).toBe(
      ` ${ICON_SETS.nerd.error}1`,
    )
  })

  test('the bars of the turn ignore the calls of a collapsed subagent', () => {
    const timed = { c2: { start: 0, end: 600_000 } }
    const tree = draw('completed', {
      turns: buildTurns([
        { role: 'user', text: 'go', toolUses: [] },
        {
          role: 'assistant',
          text: '',
          toolUses: [
            { tool_use_id: 'ag1', tool: 'Agent', input: { description: 'Job' }, agentId: 'A', text: 'ok' },
            { tool_use_id: 'b9', tool: 'Bash', input: { command: 'ls' }, text: 'ok' },
          ],
        },
      ]),
      timings: { ...timed, b9: { start: 0, end: 2_000 } },
    })
    expect(text(byKey(tree, 'bar-b9'))).toBe('████████')
  })

  test('the mark takes its room from the label, the row keeps its width', () => {
    const tree = draw('completed')
    const plain = draw('completed', { traces: new Map() })
    const width = (t: unknown) => displayWidth(String(byKey(t, 'ag1')?.props['label']))
    expect(width(plain) - width(tree)).toBe(1 + displayWidth(`${ICON_SETS.nerd.error}2`))
  })
})
