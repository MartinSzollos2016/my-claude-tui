// The render functions called directly with stand-in elements, so the views
// are unit tested (and measured by coverage) without mounting them in the
// engine. Each element just records its type, props and children.
import type { SessionMessage } from 'claude-code'
import { describe, expect, test } from 'claude-code/testing'

import { buildTurns, displayWidth, resetSectionCache, rowText, sectionCacheSize } from '../hooks/model'
import { renderBar, renderPane, type El } from '../hooks/view'
import { ICON_SETS } from '../hooks/icons'
import { C, modelColor } from '../hooks/theme'

type Node = { type: string; props: Record<string, unknown>; children: unknown }

const make =
  (type: string) =>
  (props: Record<string, unknown>): Node => ({ type, props, children: props['children'] })

const el = {
  Box: make('Box'),
  Text: make('Text'),
  Button: make('Button'),
  Markdown: make('Markdown'),
  Code: make('Code'),
  Input: make('Input'),
} as unknown as El

function nodes(tree: unknown, found: Node[] = []): Node[] {
  if (Array.isArray(tree)) for (const child of tree) nodes(child, found)
  else if (tree !== null && typeof tree === 'object' && 'type' in tree) {
    found.push(tree as Node)
    nodes((tree as Node).children, found)
  }
  return found
}

function text(tree: unknown): string {
  const parts: string[] = []
  const walk = (t: unknown) => {
    if (typeof t === 'string' || typeof t === 'number') parts.push(String(t))
    else if (Array.isArray(t)) t.forEach(walk)
    else if (t !== null && typeof t === 'object' && 'type' in t) {
      const { props, children } = t as Node
      for (const key of ['label', 'text', 'source'])
        if (typeof props[key] === 'string') parts.push(props[key] as string)
      walk(children)
    }
  }
  walk(tree)
  return parts.join('')
}

const byKey = (tree: unknown, key: string) => nodes(tree).find(n => n.props['key'] === key)

// Presses the footer key `key` (always a Button with its hotkey) and says
// whether it reached an action; a key out of reach swallows the press.
function acts(tree: unknown, key: string): boolean {
  const button = byKey(tree, key)
  if (button?.type !== 'Button' || typeof button.props['hotkey'] !== 'string') throw new Error(`no key ${key}`)
  const before = calls.length
  ;(button.props['onPress'] as (e: unknown) => void)({ surface: 'terminal' })
  return calls.length > before
}

const messages: SessionMessage[] = [
  { role: 'user', text: 'Fix the bug', toolUses: [] },
  {
    role: 'assistant',
    text: 'Looking.',
    toolUses: [
      { tool_use_id: 'b1', tool: 'Bash', input: { command: 'go test ./...', description: 'Run tests' }, text: 'ok' },
      {
        tool_use_id: 'e1',
        tool: 'Edit',
        input: { file_path: '/a.go', old_string: 'x', new_string: 'y' },
        text: 'done',
        isError: true,
      },
      {
        tool_use_id: 'a1',
        tool: 'Agent',
        input: { subagent_type: 'Explore', description: 'Find callers' },
        agentId: 'ag',
        text: 'r',
      },
      { tool_use_id: 'p1', tool: 'Read', input: { file_path: '/b.go' } },
    ],
  },
  { role: 'user', text: 'Thanks', toolUses: [] },
  { role: 'assistant', text: 'Welcome.', toolUses: [] },
]

const turns = buildTurns(messages)

const base = {
  turns,
  selected: 0,
  expanded: new Set<string>(),
  timings: { b1: { start: 1_000, end: 3_500 }, p1: { start: 9_000 } },
  turnStat: {
    prompt: 'Fix the bug',
    durationMs: 65_000,
    endedAt: 0,
    model: 'claude-opus-5-5',
    inputTokens: 1_000,
    outputTokens: 500,
  },
  sessionModel: 'claude-sonnet-5',
  contextPercent: 62,
  isLatest: false,
  isWorking: false,
  now: 10_000,
  frame: 0,
  agents: new Map([['ag', 'running' as const]]),
  agentStats: { ag: { model: 'claude-haiku-4-5', durationMs: 4_000 } },
  traces: new Map(),
  columns: 100,
  rows: 30,
  full: new Set<string>(),
  view: 'detail' as const,
  stats: [undefined, undefined],
}

// Four reads and three searches in a row (two groups), then an edit; the
// regressions below draw it folded, open, narrow and in every icon set.
const foldedTurn = buildTurns([
  { role: 'user', text: '日本語 fold', toolUses: [] },
  {
    role: 'assistant',
    text: '',
    toolUses: [
      ...[1, 2, 3, 4].map(n => ({
        tool_use_id: `fr${n}`,
        tool: 'Read',
        input: { file_path: `/s/f${n}.ts` },
        text: 'x',
      })),
      ...[1, 2, 3].map(n => ({ tool_use_id: `fg${n}`, tool: 'Grep', input: { pattern: `p${n}` }, text: 'm' })),
      { tool_use_id: 'fe', tool: 'Edit', input: { file_path: '/s/a', old_string: 'a', new_string: 'b' }, text: 'ok' },
    ],
  },
])
const foldedTimings = { fr1: { start: 0, end: 800 }, fr2: { start: 800, end: 1500 }, fg1: { start: 0, end: 90 } }
const foldedOpen = new Set(['group:fr1', 'group:fg1', 'fe'])
const foldedStats = [{ prompt: '日本語 fold', durationMs: 9_000, endedAt: 0, inputTokens: 3, outputTokens: 4 }]

const calls: string[] = []
// The windows each drawing reports, apart from the calls of the keys.
const measured: { scrollTop: number; windowRows: number; total: number }[] = []
const act = {
  copy: (text: string, surface?: string) => calls.push(`copy:${surface}:${text}`),
  toggle: (id: string) => calls.push(`toggle:${id}`),
  prev: () => calls.push('prev'),
  next: () => calls.push('next'),
  latest: () => calls.push('latest'),
  expandAll: () => calls.push('expandAll'),
  collapseAll: () => calls.push('collapseAll'),
  toggleFull: (id: string) => calls.push(`full:${id}`),
  showTurns: () => calls.push('showTurns'),
  showDetail: () => calls.push('showDetail'),
  showTeam: () => calls.push('showTeam'),
  pickTurn: (i: number) => calls.push(`pick:${i}`),
  search: (query: string) => calls.push(`search:${query}`),
  submitSearch: (query: string) => calls.push(`submit:${query}`),
  focusSearch: () => calls.push('focusSearch'),
  cursorDown: (at: { scrollTop: number; windowRows: number; total: number; starts: Record<string, number> }) =>
    calls.push(`down:${at.scrollTop}/${at.windowRows}/${at.total}/${at.starts['b1']}/${at.starts['e1']}`),
  cursorUp: () => calls.push('up'),
  scroll: (top: number) => calls.push(`scroll:${top}`),
  measure: (at: { scrollTop: number; windowRows: number; total: number }) => measured.push(at),
  cursorOpen: () => calls.push('open'),
  copyCursor: (surface?: string) => calls.push(`copyCursor:${surface}`),
}

describe('renderPane', () => {
  test('Workflow row says running, done or no result', () => {
    const wf = (text?: string) =>
      buildTurns([
        { role: 'user', text: 'go', toolUses: [] },
        {
          role: 'assistant',
          text: '',
          toolUses: [{ tool_use_id: 'w1', tool: 'Workflow', input: { name: 'review' }, ...(text ? { text } : {}) }],
        },
      ])
    const label = (turns: ReturnType<typeof wf>, isWorking: boolean) =>
      String(byKey(renderPane(el, { ...base, turns, isLatest: true, isWorking }, act), 'w1')?.props['label'])
    expect(label(wf(), true)).toContain('review · running')
    expect(label(wf(), false)).toContain('review · no result')
    expect(label(wf('ok'), false)).toContain('review · done')
  })

  test('the header counts thinking blocks and the Thinking row opens its text', () => {
    const quiet = renderPane(el, { ...base, thinking: { count: 3, text: '' } }, act)
    expect(text(quiet)).toContain('\u{F09D1} 3')
    expect(byKey(quiet, 't0:thinking')).toBeUndefined()

    const thinking = { count: 1, text: 'Plan the fix' }
    const tree = renderPane(el, { ...base, thinking }, act)
    expect(String(byKey(tree, 't0:thinking')?.props['label'])).toContain('Thinking')
    ;(byKey(tree, 't0:thinking')?.props['onPress'] as () => void)()
    expect(calls).toContain('toggle:t0:thinking')

    const open = renderPane(el, { ...base, thinking, expanded: new Set(['t0:thinking']) }, act)
    // Markdown is drawn in the terminal's own foreground, unreadable on the
    // pane's theme background; prose goes through Code's markdown highlighting.
    expect(
      nodes(open).some(
        n => n.type === 'Code' && n.props['language'] === 'markdown' && n.props['source'] === 'Plan the fix',
      ),
    ).toBe(true)
    expect(nodes(open).some(n => n.type === 'Markdown')).toBe(false)
    expect(byKey(open, 'copy:t0:thinking')).toBeDefined()
  })

  test('header, prompt, navigation and one row per item', () => {
    const tree = renderPane(el, base, act)
    const all = text(tree)
    expect(all).not.toContain('ctx')
    expect(text(renderPane(el, { ...base, selected: 1, isLatest: true }, act))).toContain('62%')
    expect(all).toContain('opus5.5')
    expect(all).toContain('1.5k')
    expect(all).toContain('1m 5s')
    expect(all).toContain('❯ Fix the bug')
    expect(all).toContain('turn 1/2')
    expect(byKey(tree, 'b1')?.props['label']).toContain('Run tests')
    expect(all).toContain('2.5s')
    expect(all).toContain('haiku4.5')
    expect(acts(tree, 'nav-prev')).toBe(false)
    expect(acts(tree, 'nav-latest')).toBe(true)
    const mid = renderPane(el, { ...base, selected: 1 }, act)
    expect(acts(mid, 'nav-prev')).toBe(true)
    expect(acts(mid, 'nav-next')).toBe(false)
    const last = renderPane(el, { ...base, selected: 1, isLatest: true }, act)
    expect(acts(last, 'nav-prev')).toBe(true)
    expect(acts(last, 'nav-next')).toBe(false)
    expect(acts(last, 'nav-latest')).toBe(false)
  })

  test('every tool row starts with a status glyph, outputs and thinking keep the column blank', () => {
    const glyph = (tree: unknown, id: string) => text(byKey(tree, `status-${id}`))
    const color = (tree: unknown, id: string) => byKey(tree, `status-${id}`)?.props['color']
    const quiet = renderPane(el, base, act)
    expect(glyph(quiet, 'b1')).toBe('✓ ')
    expect(color(quiet, 'b1')).toBe('success')
    expect(glyph(quiet, 'e1')).toBe('✗ ')
    expect(color(quiet, 'e1')).toBe('error')
    expect(glyph(quiet, 'p1')).toBe('· ')
    expect(color(quiet, 'p1')).toBe('inactive')
    expect(glyph(quiet, 'a1')).toBe('⠋ ')

    const live = renderPane(el, { ...base, isLatest: true, isWorking: true, frame: 1 }, act)
    expect(glyph(live, 'p1')).toBe('⠙ ')
    expect(color(live, 'p1')).toBe('success')

    const stopped = buildTurns([
      { role: 'user', text: 'go', toolUses: [] },
      {
        role: 'assistant',
        text: 'o',
        toolUses: [
          {
            tool_use_id: 's1',
            tool: 'Bash',
            input: {},
            text: '[Request interrupted by user for tool use]',
            isError: true,
          },
        ],
      },
    ])
    const paused = renderPane(el, { ...base, turns: stopped, agents: new Map() }, act)
    expect(glyph(paused, 's1')).toBe('⏸ ')
    expect(color(paused, 's1')).toBe('warning')

    // Output rows draw a blank of the same width, so the columns line up.
    expect(glyph(quiet, 't0:o0')).toBe('  ')
  })

  test('the icon set in the data replaces every glyph, the default is Nerd Font', () => {
    const nerd = text(renderPane(el, base, act))
    expect(nerd).toContain(ICON_SETS.nerd.robot)
    const ascii = text(renderPane(el, { ...base, icons: ICON_SETS.ascii, frame: 2 }, act))
    expect(ascii).not.toContain(ICON_SETS.nerd.robot)
    expect(ascii).not.toContain(ICON_SETS.nerd.wrench)
    expect(ascii).toContain(ICON_SETS.ascii.robot)
    expect(text(byKey(renderPane(el, { ...base, icons: ICON_SETS.ascii }, act), 'status-b1'))).toBe('+ ')
    expect(text(byKey(renderPane(el, { ...base, icons: ICON_SETS.ascii, frame: 2 }, act), 'status-a1'))).toBe('- ')
    expect(text(byKey(renderPane(el, { ...base, icons: ICON_SETS.unicode }, act), 'status-b1'))).toBe('✓ ')
    expect(text(byKey(renderPane(el, { ...base, icons: ICON_SETS.ascii }, act), 'status-e1'))).toBe('x ')
  })

  test('the info bar draws its glyphs from the chosen set', () => {
    const bar = (icons?: (typeof ICON_SETS)['nerd']) =>
      text(
        renderBar(el, {
          project: 'tail',
          git: { branch: 'main' },
          mode: null,
          runningAgents: 0,
          columns: 80,
          ...(icons ? { icons } : {}),
        }),
      )
    expect(bar()).toContain(ICON_SETS.nerd.branch)
    expect(bar(ICON_SETS.ascii)).toBe('tail . ^ main')
  })

  test('a path in a row is cut in the middle, file name last; path-only headers truncate in the middle', () => {
    const path = '/home/dev/project/src/server/auth/session.ts'
    const long = buildTurns([
      { role: 'user', text: 'go', toolUses: [] },
      {
        role: 'assistant',
        text: '',
        toolUses: [
          { tool_use_id: 'r9', tool: 'Read', input: { file_path: path }, text: 'x' },
          { tool_use_id: 'w9', tool: 'Write', input: { file_path: path, content: 'x' }, text: 'ok' },
        ],
      },
    ])
    const tree = renderPane(el, { ...base, turns: long, columns: 50, expanded: new Set(['w9']) }, act)
    const label = String(byKey(tree, 'r9')?.props['label'])
    expect(label).toContain('…')
    expect(label.endsWith('session.ts')).toBe(true)
    const wide = renderPane(el, { ...base, turns: long, columns: 120 }, act)
    expect(String(byKey(wide, 'r9')?.props['label'])).toContain('dev/project/src/server/auth/session.ts')
    const meta = nodes(tree).find(n => n.type === 'Text' && text(n).trim() === path)
    expect(meta?.props['wrap']).toBe('truncate-middle')
  })

  test('an error frame is titled with a red bold cross and shows the first error line above the preview', () => {
    const failed = buildTurns([
      { role: 'user', text: 'go', toolUses: [] },
      {
        role: 'assistant',
        text: '',
        toolUses: [
          {
            tool_use_id: 'f1',
            tool: 'Bash',
            input: { command: 'tsc' },
            text: 'compiling\nsrc/a.ts:3: error TS2304: nope\nmore output',
            isError: true,
          },
        ],
      },
    ])
    const tree = renderPane(el, { ...base, turns: failed, expanded: new Set(['f1']) }, act)
    const frame = nodes(tree).find(n => n.type === 'Box' && n.props['borderColor'] === 'error')
    const title = nodes(frame).find(n => n.type === 'Text' && n.props['bold'] === true)
    expect(text(title)).toBe('✗ error')
    expect(title?.props['color']).toBe(C.error)
    const lines = nodes(frame).filter(n => n.type === 'Text' && n.props['color'] === C.error)
    expect(lines.map(n => text(n))).toEqual([
      '✗ error',
      'src/a.ts:3: error TS2304: nope',
      expect.stringContaining('compiling'),
    ])
    expect(lines[1]?.props['wrap']).toBe('truncate-end')
    const ascii = renderPane(el, { ...base, turns: failed, expanded: new Set(['f1']), icons: ICON_SETS.ascii }, act)
    expect(text(ascii)).toContain('x error')
    // A succeeded call gets neither.
    const ok = renderPane(el, { ...base, expanded: new Set(['b1']) }, act)
    expect(text(ok)).not.toContain('✗ error')
  })

  test('the ascii set draws only ASCII: every string, every border, every truncation', () => {
    const path = '/home/dev/project/src/server/auth/session.ts'
    const many = buildTurns([
      { role: 'user', text: `go ${'long prompt '.repeat(40)}`, toolUses: [] },
      {
        role: 'assistant',
        text: 'Done.',
        toolUses: [
          { tool_use_id: 'x1', tool: 'Read', input: { file_path: path }, text: 'x' },
          { tool_use_id: 'x2', tool: 'Write', input: { file_path: path, content: 'x' }, text: 'ok' },
          {
            tool_use_id: 'x3',
            tool: 'Edit',
            input: { file_path: path, old_string: 'a', new_string: 'b' },
            text: 'bad: error',
            isError: true,
          },
          {
            tool_use_id: 'x4',
            tool: 'Bash',
            input: { command: 'seq 300', description: 'd'.repeat(200) },
            text: Array.from({ length: 300 }, (_, n) => `line ${n}`).join('\n'),
          },
          {
            tool_use_id: 'x5',
            tool: 'TodoWrite',
            input: {
              todos: [
                { content: 'a', status: 'completed' },
                { content: 'b', status: 'in_progress' },
                { content: 'c', status: 'pending' },
              ],
            },
            text: 'ok',
          },
          { tool_use_id: 'x6', tool: 'Workflow', input: { name: 'review' } },
          {
            tool_use_id: 'x7',
            tool: 'Agent',
            input: { subagent_type: 'Explore', description: 'Find' },
            agentId: 'ag',
            text: 'r',
          },
        ],
      },
    ])
    const trace = buildTurns(
      [
        {
          role: 'assistant',
          text: 'ok',
          toolUses: [{ tool_use_id: 'g', tool: 'Grep', input: { pattern: 'x', path }, text: 'm' }],
        },
      ],
      'ag/',
    )
    const members = [{ name: 'alice', type: 'teammate', status: 'running' as const }]
    const tasks = [
      { id: '1', subject: 'Write tests', status: 'in_progress', owner: 'alice' },
      { id: '2', subject: 'Ship', status: 'completed' },
      { id: '3', subject: 'Later', status: 'pending' },
    ]
    const open = new Set(['x1', 'x2', 'x3', 'x4', 'x5', 'x7', 't0:o0', 't0:thinking'])
    const numbered = Array.from({ length: 90 }, (_, n) => `${n + 1}→const v${n} = ${n}`).join('\n')
    const rich = buildTurns([
      { role: 'user', text: 'go', toolUses: [] },
      {
        role: 'assistant',
        text: '',
        toolUses: [
          {
            tool_use_id: 'r1',
            tool: 'Read',
            input: { file_path: '/src/a.ts' },
            text: numbered,
          },
          {
            tool_use_id: 'r2',
            tool: 'Edit',
            input: {
              file_path: '/src/a.ts',
              old_string: 'a\nb',
              new_string: Array.from({ length: 150 }, (_, n) => `n${n}`).join('\n'),
            },
            text: 'ok',
          },
          {
            tool_use_id: 'r3',
            tool: 'MultiEdit',
            input: {
              file_path: '/src/a.ts',
              edits: [
                { old_string: 'x', new_string: 'y' },
                { old_string: 'p', new_string: 'q' },
              ],
            },
            text: 'ok',
          },
        ],
      },
    ])
    const richOpen = new Set(['r1', 'r2', 'r3'])

    const ascii = { ...base, turns: many, icons: ICON_SETS.ascii, columns: 70, agents: new Map() }
    const trees = [
      renderPane(
        el,
        {
          ...ascii,
          expanded: open,
          thinking: { count: 1, text: 'Plan' },
          traces: new Map([['ag', { items: trace[0]!.items }]]),
          isLatest: true,
          isWorking: true,
          members,
          tasks,
        },
        act,
      ),
      renderPane(el, { ...ascii, expanded: open, traces: new Map([['ag', { denied: 'gone' }]]) }, act),
      renderPane(el, { ...ascii, expanded: new Set(['x7']) }, act),
      renderPane(
        el,
        { ...ascii, turns: buildTurns([{ role: 'user', text: 'hi', toolUses: [] }]), isLatest: true, isWorking: true },
        act,
      ),
      renderPane(el, { ...ascii, expanded: open, full: new Set(['x4:output']) }, act),
      renderPane(
        el,
        {
          ...ascii,
          view: 'turns',
          stats: [base.turnStat],
          query: 'long',
          matches: [{ index: 0, snippet: '...a long prompt ...' }],
        },
        act,
      ),
      renderPane(el, { ...ascii, view: 'turns', query: 'zzz', matches: [] }, act),
      renderPane(el, { ...ascii, view: 'team', members, tasks }, act),
      renderPane(el, { ...ascii, turns: [] }, act),
      renderPane(el, { ...ascii, view: 'team' }, act),
      renderPane(el, { ...ascii, selected: 1, isLatest: true }, act),
      renderPane(el, { ...ascii, isFocused: true }, act),
      renderPane(el, { ...ascii, isFocused: false }, act),
      renderBar(el, {
        project: 'tail',
        git: null,
        mode: null,
        runningAgents: 0,
        contextTokens: 5000,
        contextPercent: 70,
        columns: 120,
        icons: ICON_SETS.ascii,
      }),
      renderBar(el, {
        project: 'tail',
        git: { branch: 'main' },
        mode: 'plan',
        runningAgents: 1,
        contextTokens: 5000,
        contextPercent: 5,
        costUsd: 1,
        columns: 80,
        icons: ICON_SETS.ascii,
        workflow: { isRunning: true, agents: 2 },
      }),
    ]
    trees.push(
      renderPane(el, { ...ascii, turns: rich, expanded: richOpen }, act),
      renderPane(el, { ...ascii, turns: rich, expanded: richOpen, full: new Set(['r2:diff', 'r1:output']) }, act),
    )
    const folded = { ...ascii, turns: foldedTurn.map(t => ({ ...t, prompt: 'fold' })), timings: foldedTimings }
    trees.push(
      renderPane(el, folded, act),
      renderPane(el, { ...folded, expanded: foldedOpen }, act),
      renderPane(el, { ...folded, expanded: foldedOpen, columns: 60 }, act),
      renderPane(
        el,
        {
          ...folded,
          view: 'turns',
          stats: [{ ...foldedStats[0]!, prompt: 'fold' }],
          query: 'fold',
          matches: [{ index: 0, snippet: 'a fold' }],
        },
        act,
      ),
      renderPane(el, { ...folded, view: 'turns', stats: [{ ...foldedStats[0]!, prompt: 'fold' }], columns: 54 }, act),
      renderPane(el, { ...folded, expanded: foldedOpen, cursor: 'fe' }, act),
      renderPane(el, { ...ascii, cursor: 'b1', expanded: open }, act),
    )
    for (const tree of trees) {
      expect(text(tree)).toMatch(/^[\x20-\x7e\n]*$/)
      for (const n of nodes(tree))
        if (n.props['borderStyle'] !== undefined) expect(n.props['borderStyle']).toBe('classic')
    }
    expect(text(trees[0])).toContain('...')
    expect(text(trees[0])).toMatch(/[|`]- /)
    expect(text(trees[3])).toContain('Working...')
    for (const n of nodes(renderPane(el, base, act)))
      if (n.props['borderStyle'] !== undefined) expect(n.props['borderStyle']).toBe('round')
  })

  test('the first error line is not drawn twice when the output starts with it', () => {
    const failed = buildTurns([
      { role: 'user', text: 'go', toolUses: [] },
      {
        role: 'assistant',
        text: '',
        toolUses: [{ tool_use_id: 'f2', tool: 'Bash', input: {}, text: 'Error: boom\nmore', isError: true }],
      },
    ])
    const tree = renderPane(el, { ...base, turns: failed, expanded: new Set(['f2']) }, act)
    expect(text(tree).split('Error: boom')).toHaveLength(2)
  })

  test('the trace of a subagent carries status glyphs too', () => {
    const trace = buildTurns(
      [
        {
          role: 'assistant',
          text: '',
          toolUses: [{ tool_use_id: 'g', tool: 'Grep', input: { pattern: 'x' }, text: 'm' }],
        },
      ],
      'ag/',
    )
    const tree = renderPane(
      el,
      { ...base, expanded: new Set(['a1']), traces: new Map([['ag', { items: trace[0]!.items }]]) },
      act,
    )
    expect(text(byKey(tree, 'status-ag/g'))).toBe('✓ ')
  })

  test('hover scopes stay within 64 characters and are not shared between buttons', () => {
    const id = 'toolu_vrtx_0123456789abcdefghijklmnopqr'
    const agentId = 'a0123456789abcdef'
    const items = buildTurns(
      [
        { role: 'user', text: 'go', toolUses: [] },
        {
          role: 'assistant',
          text: '',
          toolUses: [{ tool_use_id: id, tool: 'Agent', input: { description: 'd' }, agentId, text: 'r' }],
        },
      ],
      '',
    )
    const inner = buildTurns(
      [
        {
          role: 'assistant',
          text: '',
          toolUses: [{ tool_use_id: id, tool: 'Bash', input: { command: 'ls' }, text: 'o' }],
        },
      ],
      `${agentId}/`,
    )
    const child = inner[0]!.items[0]!.id
    const tree = renderPane(
      el,
      {
        ...base,
        turns: items,
        expanded: new Set([items[0]!.items[0]!.id, child]),
        agents: new Map(),
        agentStats: {},
        traces: new Map([[agentId, { items: inner[0]!.items }]]),
      },
      act,
    )
    const scopes: { key: string; scope: string }[] = []
    for (const n of nodes(tree)) {
      const scope = (n.props['hover'] as { scope?: string } | undefined)?.scope
      if (scope !== undefined && n.type === 'Button') scopes.push({ key: String(n.props['key']), scope })
    }
    expect(scopes.some(s => s.key.startsWith('copy:'))).toBe(true)
    for (const { scope } of scopes) {
      expect(scope.length).toBeGreaterThanOrEqual(1)
      expect(scope.length).toBeLessThanOrEqual(64)
    }
    expect(new Set(scopes.map(s => s.scope)).size).toBe(scopes.length)
  })

  test('the selected turn is bold full-contrast text, not a button', () => {
    const list = renderPane(el, { ...base, view: 'turns', selected: 1 }, act)
    const row = byKey(list, 'turn-1')
    expect(row?.type).toBe('Text')
    expect(row?.props['color']).toBe('text')
    expect(row?.props['bold']).toBe(true)
    expect(text(row)).toContain('Thanks')
    expect(byKey(list, 'turn-0')?.type).toBe('Button')
  })

  test('every Text carries a theme color and every Button the theme grey with a full-contrast hover', () => {
    const thinking = { count: 1, text: 'Plan the fix' }
    const trace = buildTurns(
      [{ role: 'assistant', text: 'ok', toolUses: [{ tool_use_id: 'g', tool: 'Grep', input: { pattern: 'x' } }] }],
      'ag/',
    )
    const members = [{ name: 'alice', type: 'teammate', status: 'running' as const }]
    const tasks = [
      { id: '1', subject: 'Write tests', status: 'in_progress', owner: 'alice' },
      { id: '2', subject: 'Ship', status: 'completed' },
    ]
    const long = buildTurns([
      { role: 'user', text: 'go', toolUses: [] },
      {
        role: 'assistant',
        text: '',
        toolUses: [
          {
            tool_use_id: 'x1',
            tool: 'Bash',
            input: { command: 'cat' },
            text: Array.from({ length: 300 }, (_, n) => `line ${n}`).join('\n'),
          },
        ],
      },
    ])
    const open = new Set(['b1', 'e1', 'a1', 't0:o0', 't0:thinking'])
    const numbered = Array.from({ length: 90 }, (_, n) => `${n + 1}→const v${n} = ${n}`).join('\n')
    const rich = buildTurns([
      { role: 'user', text: 'go', toolUses: [] },
      {
        role: 'assistant',
        text: '',
        toolUses: [
          {
            tool_use_id: 'r1',
            tool: 'Read',
            input: { file_path: '/src/a.ts' },
            text: numbered,
          },
          {
            tool_use_id: 'r2',
            tool: 'Edit',
            input: {
              file_path: '/src/a.ts',
              old_string: 'a\nb',
              new_string: Array.from({ length: 150 }, (_, n) => `n${n}`).join('\n'),
            },
            text: 'ok',
          },
          {
            tool_use_id: 'r3',
            tool: 'MultiEdit',
            input: {
              file_path: '/src/a.ts',
              edits: [
                { old_string: 'x', new_string: 'y' },
                { old_string: 'p', new_string: 'q' },
              ],
            },
            text: 'ok',
          },
        ],
      },
    ])
    const richOpen = new Set(['r1', 'r2', 'r3'])
    const trees = [
      renderPane(el, { ...base, turns: rich, expanded: richOpen }, act),
      renderPane(el, { ...base, turns: rich, expanded: richOpen, full: new Set(['r2:diff']) }, act),
      renderPane(
        el,
        { ...base, thinking, expanded: open, traces: new Map([['ag', { items: trace[0]!.items }]]), members, tasks },
        act,
      ),
      renderPane(el, { ...base, selected: 1, isLatest: true, members, tasks }, act),
      renderPane(el, { ...base, expanded: open }, act),
      renderPane(el, { ...base, expanded: open, traces: new Map([['ag', { denied: 'gone' }]]) }, act),
      renderPane(el, { ...base, turns: long, expanded: new Set(['x1']) }, act),
      renderPane(el, { ...base, turns: long, expanded: new Set(['x1']), full: new Set(['x1:output']) }, act),
      renderPane(el, { ...base, turns: [] }, act),
      renderPane(el, { ...base, turns: buildTurns([{ role: 'user', text: 'hi', toolUses: [] }]) }, act),
      renderPane(el, { ...base, view: 'turns', stats: [base.turnStat, undefined] }, act),
      renderPane(el, { ...base, view: 'turns', query: 'callers', matches: [{ index: 0, snippet: 'a' }] }, act),
      renderPane(el, { ...base, view: 'turns', query: 'zzz', matches: [] }, act),
      renderPane(
        el,
        { ...base, view: 'turns', query: 'callers', matches: [{ index: 0, snippet: 'Find callers' }] },
        act,
      ),
      renderPane(el, { ...base, view: 'team', members, tasks }, act),
      renderPane(el, { ...base, view: 'team', turns: [] }, act),
      renderPane(el, { ...base, icons: ICON_SETS.ascii, expanded: open, thinking }, act),
      renderPane(el, { ...base, icons: ICON_SETS.unicode, view: 'turns', stats: [base.turnStat, undefined] }, act),
      renderPane(el, { ...base, icons: ICON_SETS.ascii, view: 'team', members, tasks }, act),
      renderPane(el, { ...base, selected: 1, isLatest: true, icons: ICON_SETS.ascii }, act),
      renderPane(el, { ...base, isFocused: true }, act),
      renderPane(el, { ...base, isFocused: false }, act),
      renderPane(el, { ...base, view: 'team' }, act),
      renderPane(el, { ...base, turns: [], icons: ICON_SETS.unicode }, act),
      renderPane(el, { ...base, turns: foldedTurn, timings: foldedTimings }, act),
      renderPane(el, { ...base, turns: foldedTurn, timings: foldedTimings, expanded: foldedOpen }, act),
      renderPane(el, { ...base, turns: foldedTurn, timings: foldedTimings, expanded: foldedOpen, columns: 60 }, act),
      renderPane(el, { ...base, turns: foldedTurn, view: 'turns', stats: foldedStats, selected: 0 }, act),
      renderPane(el, { ...base, turns: foldedTurn, view: 'turns', stats: foldedStats, selected: 1, columns: 54 }, act),
      renderPane(el, { ...base, turns: foldedTurn, view: 'turns', stats: foldedStats, columns: 69 }, act),
      renderPane(el, { ...base, cursor: 'e1', expanded: open }, act),
      renderPane(el, { ...base, turns: foldedTurn, cursor: 'group:fr1', expanded: foldedOpen }, act),
    ]
    const allowed: unknown[] = [...Object.values(C), ...['fable', 'opus', 'sonnet', 'haiku'].map(m => modelColor(m))]
    let texts = 0
    let buttons = 0
    for (const tree of trees)
      for (const n of nodes(tree)) {
        if (n.type === 'Text') {
          texts++
          expect(allowed, text(n)).toContain(n.props['color'])
        }
        if (n.type === 'Button') {
          buttons++
          expect(n.props['dimColor'], String(n.props['key'])).toBe(true)
          expect((n.props['hover'] as { color?: string } | undefined)?.color, String(n.props['key'])).toBe('text')
        }
      }
    expect(texts).toBeGreaterThan(50)
    expect(buttons).toBeGreaterThan(20)
  })

  test('expanded rows draw input and output frames, errors in red', () => {
    const tree = renderPane(el, { ...base, expanded: new Set(['b1', 'e1', 't0:o0']) }, act)
    const frames = nodes(tree).filter(
      n => n.type === 'Box' && n.props['borderStyle'] === 'round' && !String(n.props['key']).startsWith('card-'),
    )
    expect(frames.map(f => f.props['borderColor'])).toEqual([
      'suggestion',
      'permission',
      'success',
      'autoAccept',
      'error',
    ])
    expect(text(frames[1])).toContain('$ command')
    expect(text(frames[4])).toContain('done')
  })

  test('a subagent row shows its trace, loading state or why it is unavailable', () => {
    const open = { ...base, expanded: new Set(['a1']) }
    expect(text(renderPane(el, open, act))).toContain('Loading trace')
    expect(text(renderPane(el, { ...open, traces: new Map([['ag', { denied: 'gone' }]]) }, act))).toContain(
      'Trace unavailable: gone',
    )
    const trace = buildTurns(
      [{ role: 'assistant', text: '', toolUses: [{ tool_use_id: 'g', tool: 'Grep', input: { pattern: 'x' } }] }],
      'ag/',
    )
    const tree = renderPane(el, { ...open, traces: new Map([['ag', { items: trace[0]!.items }]]) }, act)
    expect(text(tree)).toContain('Execution Trace')
    expect(text(tree)).toContain('1 tool calls, 0 messages')
    expect(text(tree)).toContain('haiku4.5')
  })

  test('long blocks preview with show all, and the budget stops runaway text', () => {
    const long = buildTurns([
      { role: 'user', text: 'go', toolUses: [] },
      {
        role: 'assistant',
        text: '',
        toolUses: Array.from({ length: 12 }, (_, i) => ({
          tool_use_id: `l${i}`,
          tool: 'Bash',
          input: { command: 'cat' },
          text: Array.from({ length: 300 }, (_, n) => `line ${n} ${'x'.repeat(30)}`).join('\n'),
        })),
      },
    ])
    const ids = long[0]!.items.map(i => i.id)
    const preview = renderPane(
      el,
      { ...base, turns: long, expanded: new Set(ids), full: new Set([`${ids[0]}:output`]) },
      act,
    )
    expect(byKey(preview, `full:${ids[0]}:output`)?.props['label']).toBe('show less')
    expect(byKey(preview, `full:${ids[1]}:output`)?.props['label']).toContain('show all')

    const everything = renderPane(
      el,
      { ...base, turns: long, expanded: new Set(ids), full: new Set(ids.map(id => `${id}:output`)) },
      act,
    )
    expect(text(everything)).toContain('pane text budget reached')
    expect(text(everything).length).toBeLessThan(100_000)
  })

  test('every frame has a copy button that copies the whole block', () => {
    const lines = Array.from({ length: 300 }, (_, n) => `line ${n}`).join('\n')
    const long = buildTurns([
      { role: 'user', text: 'go', toolUses: [] },
      {
        role: 'assistant',
        text: 'Done.',
        toolUses: [{ tool_use_id: 'x1', tool: 'Bash', input: { command: 'seq 300' }, text: lines }],
      },
    ])
    const tree = renderPane(el, { ...base, turns: long, expanded: new Set(['x1', 't0:o0']) }, act)
    for (const key of ['copy:x1:command', 'copy:x1:output', 'copy:t0:o0']) expect(byKey(tree, key)?.type).toBe('Button')
    ;(byKey(tree, 'copy:x1:output')?.props['onPress'] as (e: { surface: string }) => void)({ surface: 'terminal' })
    ;(byKey(tree, 'copy:x1:command')?.props['onPress'] as (e: { surface: string }) => void)({ surface: 'desktop' })
    expect(calls).toContain(`copy:terminal:${lines}`)
    expect(calls).toContain('copy:desktop:seq 300')
  })

  test('turn list and empty state', () => {
    const list = renderPane(el, { ...base, view: 'turns', stats: [base.turnStat, undefined] }, act)
    expect(text(list)).toContain('Turns (2)')
    expect(text(byKey(list, 'turn-0'))).toContain('1m 5s')
    expect(text(byKey(list, 'turn-1'))).toContain('Thanks')
    ;(byKey(list, 'turn-1')?.props['onPress'] as () => void)()
    expect(calls).toContain('pick:1')
    expect(text(renderPane(el, { ...base, turns: [] }, act))).toContain('No turns yet')
    expect(
      text(
        renderPane(
          el,
          { ...base, turns: buildTurns([{ role: 'user', text: 'hi', toolUses: [] }]), isLatest: true, isWorking: true },
          act,
        ),
      ),
    ).toContain('Working…')
  })

  test('the turn search filters the list and shows each match', () => {
    const tree = renderPane(
      el,
      { ...base, view: 'turns', query: 'callers', matches: [{ index: 0, snippet: 'Explore - Find callers' }] },
      act,
    )
    expect(text(tree)).toContain('Turns (1 of 2)')
    expect(byKey(tree, 'turn-0')).toBeDefined()
    expect(byKey(tree, 'turn-1')).toBeUndefined()
    expect(text(tree)).toContain('Explore - Find callers')
    const input = byKey(tree, 'turn-search')
    expect(input?.type).toBe('Input')
    expect(input?.props['placeholder']).toBe('Search turns')
    expect(input?.props['value']).toBe('callers')
    ;(input?.props['onInput'] as (value: string) => void)('x')
    ;(input?.props['onSubmit'] as (value: string) => void)('y')
    ;(byKey(tree, 'search-clear')?.props['onPress'] as () => void)()
    expect(calls).toEqual(expect.arrayContaining(['search:x', 'submit:y', 'search:']))

    expect(text(renderPane(el, { ...base, view: 'turns', query: 'zzz', matches: [] }, act))).toContain(
      'No turn matches "zzz".',
    )
    const all = renderPane(el, { ...base, view: 'turns', query: '' }, act)
    expect(byKey(all, 'turn-0')).toBeDefined()
    expect(byKey(all, 'turn-1')).toBeDefined()
    expect(byKey(all, 'search-clear')).toBeUndefined()
  })

  test('the matched part of a snippet is underlined bold in the accent, the rest muted', () => {
    const tree = renderPane(
      el,
      { ...base, view: 'turns', query: 'CALLERS', matches: [{ index: 0, snippet: 'Explore - Find callers now' }] },
      act,
    )
    const hit = nodes(tree).find(n => n.type === 'Text' && n.props['underline'] === true)
    expect(text(hit)).toBe('callers')
    expect(hit?.props['bold']).toBe(true)
    expect(hit?.props['color']).toBe(C.accent)
    const row = nodes(tree).find(n => n.type === 'Text' && text(n).includes('Explore - Find '))
    expect(row?.props['color']).toBe(C.muted)
    expect(text(row)).toBe('      Explore - Find callers now')
    // A snippet with no match stays one muted line.
    const plain = renderPane(
      el,
      { ...base, view: 'turns', query: 'zzz', matches: [{ index: 0, snippet: 'no hit here' }] },
      act,
    )
    expect(nodes(plain).some(n => n.props['underline'] === true)).toBe(false)
  })

  test('a filtered row keeps the real tail, and the echoed query is sanitized and cut', () => {
    const query = `a\u001b[31m${'q'.repeat(100)}`
    const empty = text(renderPane(el, { ...base, view: 'turns', query, matches: [] }, act))
    expect(empty).not.toContain('\u001b')
    expect(empty).toContain('No turn matches "aqqq')
    expect(empty).toContain('…"')
    const tree = renderPane(
      el,
      { ...base, view: 'turns', stats: [base.turnStat, undefined], query: 'c', matches: [{ index: 0, snippet: 's' }] },
      act,
    )
    expect(text(byKey(tree, 'turn-0'))).toContain('1m 5s')
  })

  test('a long turn list stays within the pane text budget', () => {
    const many = buildTurns(
      Array.from({ length: 1500 }, (_, i) => ({
        role: 'user' as const,
        text: `prompt ${i} ${'x'.repeat(60)}`,
        toolUses: [],
      })),
    )
    const matches = many.map(t => ({ index: t.index, snippet: `…${'s'.repeat(70)}…` }))
    const all = renderPane(el, { ...base, turns: many, stats: [], view: 'turns' }, act)
    const filtered = renderPane(el, { ...base, turns: many, stats: [], view: 'turns', query: 'x', matches }, act)
    for (const tree of [all, filtered]) {
      expect(text(tree).length).toBeLessThan(100_000)
      expect(text(tree)).toMatch(/\d+ more turns/)
    }
    expect(text(filtered)).toContain('refine the search')
    expect(text(all)).not.toContain('refine the search')
  })

  test('the team board stays within the pane text budget', () => {
    const tasks = Array.from({ length: 2000 }, (_, i) => ({
      id: String(i + 1),
      subject: 'y'.repeat(150),
      status: 'pending',
    }))
    const huge = [{ id: '0', subject: 'z'.repeat(20_000), status: 'pending', owner: 'o'.repeat(20_000) }]
    const members = Array.from({ length: 3 }, () => ({ name: 'alice', type: 'teammate', status: 'idle' as const }))
    const tree = renderPane(el, { ...base, view: 'team', members, tasks }, act)
    expect(text(tree).length).toBeLessThan(100_000)
    expect(text(tree)).toMatch(/\d+ more tasks/)
    const one = renderPane(el, { ...base, view: 'team', tasks: huge }, act)
    expect(nodes(one).every(n => typeof n.children !== 'string' || n.children.length < 10_000)).toBe(true)
    expect(text(one).length).toBeLessThan(1000)
    const keys = nodes(tree).map(n => n.props['key'])
    expect(new Set(keys.filter(k => String(k).startsWith('member-'))).size).toBe(3)
  })

  test('row buttons call their actions', () => {
    const tree = renderPane(el, base, act)
    ;(byKey(renderPane(el, { ...base, selected: 1 }, act), 'nav-prev')?.props['onPress'] as () => void)()
    for (const key of ['b1', 'nav-next', 'nav-latest', 'nav-turns', 'nav-search', 'nav-expand', 'nav-collapse']) {
      ;(byKey(tree, key)?.props['onPress'] as () => void)()
    }
    expect(calls).toEqual(
      expect.arrayContaining([
        'toggle:b1',
        'prev',
        'next',
        'latest',
        'showTurns',
        'focusSearch',
        'expandAll',
        'collapseAll',
      ]),
    )
  })

  test('the team view lists teammates and tasks; its nav key acts only with a team', () => {
    expect(acts(renderPane(el, base, act), 'nav-team')).toBe(false)
    const members = [{ name: 'alice', type: 'teammate', status: 'running' as const }]
    const tasks = [
      { id: '1', subject: 'Write tests', status: 'in_progress', owner: 'alice' },
      { id: '2', subject: 'Ship', status: 'completed' },
    ]
    const detail = renderPane(el, { ...base, members, tasks }, act)
    ;(byKey(detail, 'nav-team')?.props['onPress'] as () => void)()
    expect(calls).toContain('showTeam')

    const team = renderPane(el, { ...base, view: 'team', members, tasks }, act)
    const all = text(team)
    expect(all).toContain('Team (1)')
    expect(all).toContain('alice')
    expect(all).toContain('◐ #1 Write tests  → alice')
    expect(all).toContain('☑ #2 Ship')
    expect(nodes(team).some(n => n.props['color'] === 'success' && text(n) === 'running')).toBe(true)
    expect(text(renderPane(el, { ...base, view: 'team', turns: [] }, act))).toContain('No teammates in this session.')
  })
})

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
    expect(text(last(tree))).toBe('ctrl+x tab for keys')
    expect(last(tree)?.props['color']).toBe('inactive')
  })

  test('with the info bar shown the hint asks for the chord twice: the bar takes the first', () => {
    const tree = renderPane(el, { ...base, isFocused: false, isBarShown: true }, act)
    expect(text(last(tree))).toBe('ctrl+x tab twice for keys')
    expect(text(last(renderPane(el, { ...base, isFocused: true, isBarShown: true }, act)))).toBe('keys on')
  })

  test('an unknown focus acts as unfocused, without the hint', () => {
    const tree = renderPane(el, base, act)
    expect(mark(tree)?.props['color']).toBe('inactive')
    expect(last(tree)).toBeUndefined()
    expect(text(tree)).not.toContain('keys on')
    expect(text(tree)).not.toContain('for keys')
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
    nodes(footer).filter(n => n.type === 'Box' && kids(n).some(c => c.type === 'Button'))

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
      for (const n of [1, 2]) {
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
      for (const name of ['prev', 'next', 'latest', 'down', 'up', 'open', 'copy', 'expand', 'collapse'])
        expect(acts(footer, `nav-${name}`), name).toBe(false)
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

describe('own scroll', () => {
  const kids = (n: Node | undefined) => (n?.children as Node[]).filter(Boolean)
  const pane = (extra: Record<string, unknown> = {}) => renderPane(el, { ...base, ...extra }, act) as Node
  const press = (n: Node | undefined) => (n?.props['onPress'] as (e: unknown) => void)({})
  const members = [{ name: 'alice', type: 'teammate', status: 'running' as const }]

  test('the body is exactly as tall as the window: the header, the window and the footer in flow', () => {
    const tree = pane()
    expect(tree.props['height']).toBe(30)
    expect(tree.props['minHeight']).toBeUndefined()
    expect(tree.props['paddingBottom']).toBeUndefined()
    expect(kids(tree).map(n => n.props['key'])).toEqual(['pane-header', 'pane-window', 'footer'])
    expect(kids(pane({ turns: [] })).map(n => n.props['key'])).toEqual(['pane-window', 'footer'])
  })

  test('the header holds the metrics and the prompt and does not scroll', () => {
    const tree = pane({ rows: 10, scrollTop: 2 })
    const header = byKey(tree, 'pane-header')!
    expect(header.props['height']).toBe(2)
    expect(header.props['overflow']).toBe('hidden')
    expect(byKey(header, 'brand-mark')).toBeDefined()
    expect(text(header)).toContain('Fix the bug')
    expect(byKey(byKey(tree, 'pane-window'), 'brand-mark')).toBeUndefined()
  })

  test('the header is laid out row by row with explicit heights, at 64 and 40 columns', () => {
    const busy = new Map([...Array.from({ length: 12 }, (_, i) => [`x${i}`, 'running' as const] as const)])
    for (const columns of [64, 40])
      for (const extra of [{}, { view: 'turns' as const }, { view: 'team' as const, members }]) {
        const tree = pane({ columns, agents: busy, ...extra })
        const header = byKey(tree, 'pane-header')!
        const parts = kids(header)
        for (const part of parts) {
          expect(typeof part.props['height'], JSON.stringify(extra)).toBe('number')
          expect(part.props['overflow']).toBe('hidden')
          expect(part.props['flexShrink']).toBe(0)
        }
        const rows = parts.reduce((sum, part) => sum + Number(part.props['height']), 0)
        expect(header.props['height']).toBe(rows)
        const footerRows = columns >= 64 ? 4 : 6
        expect(byKey(tree, 'pane-window')?.props['height']).toBe(30 - rows - footerRows)
      }
    // A long prompt is cut to the one row it is given.
    const long = buildTurns([{ role: 'user', text: `go ${'very long prompt '.repeat(20)}`, toolUses: [] }])
    for (const icons of [ICON_SETS.nerd, ICON_SETS.ascii]) {
      const prompt = byKey(pane({ turns: long, stats: [undefined], columns: 40, icons }), 'prompt')!
      expect(displayWidth(text(prompt))).toBeLessThanOrEqual(38)
    }
  })

  test('the window clips the rows between the header and the footer in every view', () => {
    const cases: [Record<string, unknown>, number, number][] = [
      [{}, 2, 4],
      [{ columns: 50 }, 2, 6],
      [{ view: 'turns' }, 2, 4],
      [{ view: 'team', members }, 1, 4],
      [{ turns: [] }, 0, 4],
    ]
    for (const [extra, headerRows, footerRows] of cases) {
      const tree = pane(extra)
      const win = byKey(tree, 'pane-window')!
      expect(win.props['overflow'], JSON.stringify(extra)).toBe('hidden')
      expect(win.props['height'], JSON.stringify(extra)).toBe(30 - headerRows - footerRows)
      expect(byKey(tree, 'pane-header')?.props['height'] ?? 0).toBe(headerRows)
    }
  })

  // The engine clamps an absolute box at the top of the tree (measured: the
  // content moved 3 rows for a top of -33), so the content stays in flow in
  // the clipped window and a negative top margin moves it up.
  test('the content is in flow in the window and moved up by a negative top margin, clamped to the content', () => {
    const content = byKey(pane({ rows: 10, scrollTop: 2 }), 'pane-content')!
    expect(content.props).toMatchObject({ marginTop: -2, flexShrink: 0, width: 100 })
    expect(content.props['position']).toBeUndefined()
    expect(content.props['top']).toBeUndefined()
    expect(byKey(pane({ rows: 10 }), 'pane-window')?.props['flexDirection']).toBe('column')
    expect(byKey(pane(), 'pane-content')?.props['marginTop']).toBe(0)
    expect(byKey(pane({ scrollTop: 5 }), 'pane-content')?.props['marginTop']).toBe(0)
    expect(byKey(pane({ rows: 10, scrollTop: 99 }), 'pane-content')?.props['marginTop']).toBe(-4)
  })

  test('more above and more below show only while the content overflows, muted, inside the window', () => {
    const fits = pane()
    expect(byKey(fits, 'more-above')).toBeUndefined()
    expect(byKey(fits, 'more-below')).toBeUndefined()
    const top = pane({ rows: 10 })
    expect(byKey(top, 'more-above')).toBeUndefined()
    const below = byKey(top, 'more-below')!
    expect(text(below)).toBe('▼ 3 more below')
    expect(below.props).toMatchObject({ position: 'absolute', top: 3, left: 0, backgroundColor: C.paneBackground })
    expect(nodes(below).find(n => n.type === 'Text')?.props['color']).toBe(C.muted)
    const mid = pane({ rows: 10, scrollTop: 2 })
    const win = byKey(mid, 'pane-window')
    expect(text(byKey(win, 'more-above'))).toBe('▲ 3 more above')
    expect(byKey(win, 'more-above')?.props['top']).toBe(0)
    expect(text(byKey(win, 'more-below'))).toBe('▼ 1 more below')
    const ascii = pane({ rows: 10, scrollTop: 2, icons: ICON_SETS.ascii })
    expect(text(byKey(ascii, 'more-above'))).toBe('^ 3 more above')
    expect(text(byKey(ascii, 'more-below'))).toBe('v 1 more below')
  })

  test('f and b page the window, and do nothing at the end and at the top', () => {
    const top = pane({ rows: 10 })
    expect(byKey(top, 'nav-pageup')?.props['hotkey']).toBe('b')
    expect(acts(top, 'nav-pageup')).toBe(false)
    const f = byKey(top, 'nav-pagedown')!
    expect(f.props).toMatchObject({ hotkey: 'f', plain: true, dimColor: true })
    expect(String(f.props['label']).trimEnd()).toBe('▼ page')
    expect((f.props['hover'] as { scope?: string }).scope).toBe('btn:nav-pagedown')
    calls.length = 0
    press(f)
    expect(calls).toEqual(['scroll:2'])
    const end = pane({ rows: 10, scrollTop: 4 })
    expect(byKey(end, 'nav-pagedown')?.props['hotkey']).toBe('f')
    expect(acts(end, 'nav-pagedown')).toBe(false)
    expect(byKey(end, 'nav-pageup')?.props['hotkey']).toBe('b')
    press(byKey(end, 'nav-pageup'))
    expect(calls.at(-1)).toBe('scroll:2')
    for (const view of [{}, { view: 'turns' as const }, { view: 'team' as const, members }]) {
      const fits = pane(view)
      expect(acts(fits, 'nav-pageup')).toBe(false)
      expect(acts(fits, 'nav-pagedown')).toBe(false)
    }
    expect(String(byKey(pane({ rows: 10, icons: ICON_SETS.ascii }), 'nav-pagedown')?.props['label']).trimEnd()).toBe(
      'v page',
    )
  })

  test('long prose and one-line JSON count the rows they wrap to, at 80 and 40 columns', () => {
    const prose = Array.from({ length: 20 }, () => 'x'.repeat(300)).join('\n\n')
    const json = JSON.stringify({ data: 'y'.repeat(7989) })
    const wrapped = buildTurns([
      { role: 'user', text: 'go', toolUses: [] },
      {
        role: 'assistant',
        text: prose,
        toolUses: [{ tool_use_id: 'j1', tool: 'Bash', input: { command: 'cat x.json' }, text: json }],
      },
    ])
    const totalAt = (columns: number) => {
      measured.length = 0
      pane({ turns: wrapped, stats: [undefined], columns, expanded: new Set(['t0:o0', 'j1']) })
      return measured[0]!.total
    }
    // Measured in the engine: a frame's body is the pane less 4 (indent) and 4
    // (border and padding), and Markdown draws no empty line. Blank, message
    // row, its frame and blank, the call row, the command frame, the output
    // frame and blank.
    const least = (inner: number) =>
      1 + 1 + 3 + 20 * Math.ceil(300 / inner) + 1 + 1 + 4 + 3 + Math.ceil(8000 / inner) + 1
    expect(totalAt(80)).toBe(least(72))
    expect(totalAt(40)).toBe(least(32))
  })

  test('numbered code gets a gutter of its widest line number and 2 cells, a diff its own', () => {
    const read = buildTurns([
      { role: 'user', text: 'go', toolUses: [] },
      {
        role: 'assistant',
        text: '',
        toolUses: [
          {
            tool_use_id: 'r1',
            tool: 'Read',
            input: { file_path: '/a/w.txt' },
            text: Array.from({ length: 30 }, (_, i) => `${String(i + 1).padStart(6)}→line${i} ${'y'.repeat(240)}`).join(
              '\n',
            ),
          },
        ],
      },
    ])
    measured.length = 0
    pane({ turns: read, stats: [undefined], columns: 108, expanded: new Set(['r1']) })
    // 30 lines of 247 cells beside a 4-cell gutter in a 100-cell body: 3 rows each.
    const frames = measured[0]!.total - (1 + 1 + 1)
    expect(frames).toBe(4 + 3 + 30 * 3)
  })

  // Measured at a 49-column pane: the title of a Bash frame with a long
  // description wrapped under it, a row the estimate missed.
  test('a frame title never shrinks; the ascii set counts the rows its uncut meta wraps to', () => {
    const bash = buildTurns([
      { role: 'user', text: 'go', toolUses: [] },
      {
        role: 'assistant',
        text: '',
        toolUses: [
          {
            tool_use_id: 'c1',
            tool: 'Bash',
            input: { command: 'find .', description: `Search ${'for the probe file '.repeat(6)}` },
            text: 'ok',
          },
        ],
      },
    ])
    const tree = pane({ turns: bash, stats: [undefined], columns: 49, expanded: new Set(['c1']) })
    const titles = nodes(tree).filter(
      n => n.type === 'Box' && n.props['flexShrink'] === 0 && nodes(n.children).some(t => t.props['bold'] === true),
    )
    expect(titles.length).toBeGreaterThanOrEqual(2)
    measured.length = 0
    pane({ turns: bash, stats: [undefined], columns: 49, expanded: new Set(['c1']) })
    const unicode = measured[0]!.total
    measured.length = 0
    pane({ turns: bash, stats: [undefined], columns: 49, expanded: new Set(['c1']), icons: ICON_SETS.ascii })
    expect(measured[0]!.total).toBeGreaterThan(unicode)
  })

  test('a narrow pane counts the wrapped notes, the empty-pane hint and the trace line', () => {
    measured.length = 0
    pane({ turns: [], columns: 30 })
    // The keys hint (about 70 characters) wraps to three rows of 28.
    expect(measured[0]!.total).toBeGreaterThanOrEqual(1 + 2 + 3)
  })

  test('a very short pane drops the header before the window, and a window of two rows its indicators', () => {
    const short = pane({ rows: 5 })
    expect(byKey(short, 'pane-header')).toBeUndefined()
    expect(byKey(short, 'pane-window')?.props['height']).toBe(1)
    expect(byKey(short, 'more-below')).toBeUndefined()
    const two = pane({ rows: 8 })
    expect(byKey(two, 'pane-window')?.props['height']).toBe(2)
    expect(byKey(two, 'more-below')).toBeUndefined()
    expect(byKey(pane({ rows: 9 }), 'more-below')).toBeDefined()
  })

  test('each drawing reports where its window stands, for the scroll of the engine', () => {
    measured.length = 0
    pane({ rows: 10, scrollTop: 99 })
    expect(measured).toEqual([expect.objectContaining({ scrollTop: 4, windowRows: 4, total: 6 })])
  })

  test('the status row says top or end while the content overflows', () => {
    const status = (extra: Record<string, unknown>) => text(byKey(pane({ isFocused: true, ...extra }), 'footer-status'))
    expect(status({ rows: 10 })).toBe('turn 1/2 · top · keys on')
    expect(status({ rows: 10, scrollTop: 2 })).toBe('turn 1/2 · keys on')
    expect(status({ rows: 10, scrollTop: 4 })).toBe('turn 1/2 · end · keys on')
    expect(status({})).toBe('turn 1/2 · keys on')
    expect(text(byKey(pane({ rows: 10, isFocused: true, icons: ICON_SETS.ascii }), 'footer-status'))).toBe(
      'turn 1/2 . top . keys on',
    )
    const place = byKey(pane({ rows: 10 }), 'scroll-place')
    expect(place?.props['color']).toBe(C.muted)
  })

  test('the page keys move to the status row where the views row has no room for them', () => {
    const tree = pane({ columns: 70, rows: 10, isFocused: true })
    const footer = byKey(tree, 'footer')!
    expect(text(byKey(footer, 'footer-row-2'))).not.toContain('page')
    const last = byKey(footer, 'footer-last')!
    expect(byKey(last, 'nav-pagedown')).toBeDefined()
    const status = byKey(last, 'footer-status')!
    expect(status.props['width']).toBe(70 - 2 - 20 - 2)
    expect(text(status)).toBe('turn 1/2 · top · keys on')
    expect(byKey(pane({ columns: 44 }), 'footer-last')).toBeDefined()
    expect(byKey(pane({ columns: 100 }), 'footer-last')).toBeUndefined()
  })

  test('j hands over where the rows are, an open row pushes the rows under it down by its frames', () => {
    calls.length = 0
    press(byKey(pane({ rows: 10, scrollTop: 1, cursor: 'b1' }), 'nav-down'))
    expect(calls).toEqual(['down:1/4/6/2/3'])
    calls.length = 0
    press(byKey(pane({ expanded: new Set(['b1']), cursor: 'b1' }), 'nav-down'))
    expect(calls).toEqual(['down:0/24/15/2/12'])
  })
})

describe('empty states', () => {
  const lines = (tree: unknown) =>
    nodes(tree)
      .filter(n => n.type === 'Text' && String(n.props['key']).startsWith('empty-'))
      .map(n => ({ text: text(n), color: n.props['color'] }))

  test('no turns: a three line block with the keys', () => {
    expect(lines(renderPane(el, { ...base, turns: [] }, act))).toEqual([
      { text: 'No turns yet.', color: 'text' },
      { text: 'Send a prompt; tool calls and subagents appear here.', color: 'inactive' },
      { text: 'Keys: t turns · s search · e expand · ctrl+x tab focuses this pane', color: 'inactive' },
    ])
    expect(lines(renderPane(el, { ...base, turns: [], view: 'turns' }, act))).toHaveLength(3)
    expect(lines(renderPane(el, { ...base, turns: [], isBarShown: true }, act)).at(-1)?.text).toBe(
      'Keys: t turns · s search · e expand · ctrl+x tab twice focuses this pane',
    )
    expect(text(renderPane(el, { ...base, turns: [], icons: ICON_SETS.ascii }, act))).toContain(
      'Keys: t turns . s search . e expand . ctrl+x tab focuses this pane',
    )
  })

  test('no turn matches the search: one line on what to do', () => {
    const tree = renderPane(el, { ...base, view: 'turns', query: 'zzz', matches: [] }, act)
    expect(lines(tree)).toEqual([{ text: 'Clear the search or try fewer words.', color: 'inactive' }])
    expect(text(tree)).toContain('No turn matches "zzz".')
  })

  test('no teammates and no tasks: one hint line each', () => {
    const tree = renderPane(el, { ...base, view: 'team' }, act)
    expect(lines(tree).map(l => l.text)).toEqual([
      'Teammates show up once Claude starts a team.',
      'Tasks show up when Claude plans with TodoWrite or TaskCreate.',
    ])
    for (const l of lines(tree)) expect(l.color).toBe('inactive')
    const members = [{ name: 'alice', type: 'teammate', status: 'running' as const }]
    expect(lines(renderPane(el, { ...base, view: 'team', members }, act))).toHaveLength(1)
  })
})

describe('header spacing', () => {
  const header = (columns: number, extra = {}) => {
    const tree = renderPane(el, { ...base, selected: 1, isLatest: true, isWorking: true, columns, ...extra }, act)
    // The metrics row, in the header's first part.
    return nodes(byKey(tree, 'pane-header-0')?.children)[0]!
  }
  const texts = (tree: unknown) => nodes(tree).filter(n => n.type === 'Text')

  test('counters are separated by Box gaps, not by padding inside the text', () => {
    for (const columns of [40, 70, 100]) {
      const tree = header(columns, { thinking: { count: 2, text: 'x' } })
      for (const t of texts(tree)) {
        const s = text(t)
        expect(s, `${columns}`).toBe(s.trim())
      }
      for (const row of nodes(tree).filter(n => n.type === 'Box' && n.props['flexShrink'] !== undefined))
        expect(row.props['gap'] ?? row.props['columnGap'], `${columns}`).toBeGreaterThan(0)
    }
  })

  test('below 80 columns the header shows only the context percent', () => {
    expect(text(header(79))).toContain('62%')
    expect(text(header(79))).not.toContain('▰')
    expect(text(header(80))).toContain('▰▰▰▰▰▰▱▱▱▱ 62%')
    expect(text(header(100))).not.toContain('ctx')
  })
})

describe('context meter', () => {
  test('the header of the latest turn and the info bar draw the meter in the context color', () => {
    const latest = renderPane(el, { ...base, selected: 1, isLatest: true }, act)
    expect(text(latest)).toContain('▰▰▰▰▰▰▱▱▱▱ 62%')
    expect(nodes(latest).some(n => n.props['color'] === 'warning' && text(n).includes('▰▰▰▰▰▰▱▱▱▱ 62%'))).toBe(true)
    expect(text(renderPane(el, base, act))).not.toContain('▰')
    expect(text(renderPane(el, { ...base, selected: 1, isLatest: true, icons: ICON_SETS.ascii }, act))).toContain(
      '######---- 62%',
    )

    const bar = (columns: number, icons = ICON_SETS.nerd) =>
      renderBar(el, {
        project: 'tail',
        git: null,
        mode: null,
        runningAgents: 0,
        contextTokens: 5000,
        contextPercent: 85,
        columns,
        icons,
      })
    expect(text(bar(100))).toContain('5.0k ctx ▰▰▰▰▰▰▰▰▰▱ 85%')
    expect(text(bar(99))).not.toContain('▰')
    expect(text(bar(99))).toContain('85%')
    expect(nodes(bar(100)).some(n => n.props['color'] === 'error' && text(n).includes('▰▰▰▰▰▰▰▰▰▱ 85%'))).toBe(true)
    expect(text(bar(120, ICON_SETS.ascii))).toContain('#########- 85%')
  })
})

describe('renderBar', () => {
  test('a running Workflow shows as a badge', () => {
    const bar = (workflow: { isRunning: true; agents: number } | { isRunning: false }) =>
      renderBar(el, { project: 'tail', git: null, mode: null, runningAgents: 0, columns: 80, workflow })
    const running = bar({ isRunning: true, agents: 2 })
    expect(text(running)).toBe('tail · workflow running · 2 agents')
    expect(nodes(running).some(n => n.props['color'] === 'success' && text(n).includes('workflow running'))).toBe(true)
    expect(text(bar({ isRunning: true, agents: 1 }))).toBe('tail · workflow running · 1 agent')
    expect(text(bar({ isRunning: true, agents: 0 }))).toBe('tail · workflow running')
    expect(text(bar({ isRunning: false }))).toBe('tail')
  })

  test('project, branch, mode, agents, context and cost', () => {
    const tree = renderBar(el, {
      project: 'tail',
      git: { branch: 'main' },
      mode: 'plan',
      runningAgents: 2,
      contextTokens: 52_700,
      contextPercent: 85,
      costUsd: 1.5,
      columns: 100,
    })
    const all = text(tree)
    for (const part of ['tail', 'main', 'plan', 'agents running · 2', '52.7k ctx', '85%', '$1.50']) {
      expect(all).toContain(part)
    }
    expect(nodes(tree).some(n => n.props['color'] === 'error' && text(n).includes('85%'))).toBe(true)
  })

  test('omits what it does not know', () => {
    const all = text(renderBar(el, { project: 'tail', git: null, mode: null, runningAgents: 0, columns: 80 }))
    expect(all).toBe('tail')
  })
})

describe('diff blocks', () => {
  const editTurn = (input: Record<string, unknown>, tool = 'Edit') =>
    buildTurns([
      { role: 'user', text: 'go', toolUses: [] },
      { role: 'assistant', text: '', toolUses: [{ tool_use_id: 'd1', tool, input, text: 'ok' }] },
    ])
  const drawn = (turns: ReturnType<typeof buildTurns>, extra: Record<string, unknown> = {}) =>
    renderPane(el, { ...base, turns, selected: 0, expanded: new Set(['d1']), ...extra }, act)

  test('an Edit draws a Code with format diff and copies the whole diff', () => {
    const tree = drawn(editTurn({ file_path: '/a.go', old_string: 'x', new_string: 'y' }))
    const code = nodes(tree).filter(n => n.type === 'Code')
    expect(code).toHaveLength(1)
    expect(code[0]?.props['format']).toBe('diff')
    expect(code[0]?.props['source']).toBe('@@ -1,1 +1,1 @@\n-x\n+y')
    calls.length = 0
    ;(byKey(tree, 'copy:d1:diff')?.props['onPress'] as (p: unknown) => void)({ surface: 'terminal' })
    expect(calls).toEqual(['copy:terminal:@@ -1,1 +1,1 @@\n-x\n+y'])
  })

  test('a long diff previews 60 lines as a valid diff and shows all on request', () => {
    const turns = editTurn({
      file_path: '/a.go',
      old_string: '',
      new_string: Array.from({ length: 200 }, (_, i) => `n${i}`).join('\n'),
    })
    const preview = nodes(drawn(turns)).filter(n => n.type === 'Code')
    expect(preview).toHaveLength(1)
    const source = preview[0]?.props['source'] as string
    expect(source.split('\n')).toHaveLength(60)
    expect(source.startsWith('@@ -0,0 +1,59 @@\n+n0')).toBe(true)
    expect(text(drawn(turns))).toContain('141 lines hidden')

    const all = nodes(drawn(turns, { full: new Set(['d1:diff']) })).filter(n => n.type === 'Code')
    const lines = all.flatMap(n => (n.props['source'] as string).split('\n').filter(l => l[0] === '+'))
    expect(lines).toHaveLength(200)
    for (const piece of all) expect(piece.props['format']).toBe('diff')
    expect(all.every(n => (n.props['source'] as string).startsWith('@@'))).toBe(true)
  })

  test('a diff the pane budget has no room for draws no empty Code', () => {
    const body = Array.from({ length: 150 }, (_, i) => `line ${i} ${'x'.repeat(50)}`).join('\n')
    const uses = Array.from({ length: 14 }, (_, i) => ({
      tool_use_id: `m${i}`,
      tool: 'Edit',
      input: { file_path: '/a.go', old_string: '', new_string: body },
      text: 'ok',
    }))
    const turns = buildTurns([
      { role: 'user', text: 'go', toolUses: [] },
      { role: 'assistant', text: '', toolUses: uses },
    ])
    const open = new Set(uses.map(u => u.tool_use_id))
    const tree = renderPane(
      el,
      { ...base, turns, selected: 0, expanded: open, full: new Set(uses.map(u => `${u.tool_use_id}:diff`)) },
      act,
    )
    const code = nodes(tree).filter(n => n.type === 'Code')
    expect(code.length).toBeGreaterThan(1)
    expect(code.some(n => n.props['source'] === '')).toBe(false)
    expect(text(tree)).toContain('pane text budget reached')
    expect(code.reduce((sum, n) => sum + (n.props['source'] as string).length, 0)).toBeLessThanOrEqual(85_000)
  })
})

describe('code blocks', () => {
  const readTurn = (path: string, result: string, tool = 'Read') =>
    buildTurns([
      { role: 'user', text: 'go', toolUses: [] },
      {
        role: 'assistant',
        text: '',
        toolUses: [{ tool_use_id: 'c1', tool, input: { file_path: path, content: result }, text: result }],
      },
    ])
  const codes = (turns: ReturnType<typeof buildTurns>, extra: Record<string, unknown> = {}) =>
    nodes(renderPane(el, { ...base, turns, selected: 0, expanded: new Set(['c1']), ...extra }, act)).filter(
      n => n.type === 'Code',
    )

  test('a numbered Read draws the bare lines with startLine and infers the language from the path', () => {
    const [code] = codes(readTurn('/a/b.go', '    12→package a\n    13→func b() {}'))
    expect(code?.props['source']).toBe('package a\nfunc b() {}')
    expect(code?.props['startLine']).toBe(12)
    expect(code?.props['path']).toBe('/a/b.go')
    expect(code?.props).not.toHaveProperty('language')
    expect(code?.props).not.toHaveProperty('format')
  })

  test('numbers that do not run on stay in the text and no gutter is asked for', () => {
    const [code] = codes(readTurn('/a/b.go', '1→x\n9→y'))
    expect(code?.props['source']).toBe('1→x\n9→y')
    expect(code?.props).not.toHaveProperty('startLine')
  })

  test('a Write draws its content by path, and a language-less shell block keeps its language', () => {
    const [write] = codes(readTurn('/a/s.py', 'print(1)', 'Write'))
    expect(write?.props['path']).toBe('/a/s.py')
    expect(write?.props).not.toHaveProperty('startLine')
    const bash = buildTurns([
      { role: 'user', text: 'go', toolUses: [] },
      { role: 'assistant', text: '', toolUses: [{ tool_use_id: 'c1', tool: 'Bash', input: { command: 'ls' } }] },
    ])
    expect(codes(bash)[0]?.props['language']).toBe('bash')
  })

  test('the gutter continues over the pieces of a long block shown whole', () => {
    const rows = Array.from({ length: 1500 }, (_, i) => `${i + 5}→${'x'.repeat(20)}`).join('\n')
    const turns = readTurn('/a/b.go', rows)
    const all = codes(turns, { full: new Set(['c1:output']) })
    expect(all.length).toBeGreaterThan(1)
    let at = 5
    for (const piece of all) {
      expect(piece.props['startLine']).toBe(at)
      at += (piece.props['source'] as string).split('\n').length
    }
    expect(at).toBe(1505)
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
    expect(displayWidth(cjk)).toBeLessThanOrEqual(75)
    expect(displayWidth(cjk)).toBeGreaterThanOrEqual(74)
    expect(cjk.endsWith('…')).toBe(true)
  })

  test('a wide tool name pads to the same name column as an ASCII one', () => {
    const name = rowLabel('same', 'mcp__srv__日本')
    expect(displayWidth(name.split(' - ')[0]!)).toBe(12)
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
    for (const id of ['b1', 'e1', 'a1', 'p1']) expect(displayWidth(text(bar(tree, id)))).toBe(8)
  })

  test('a row without a duration keeps the column blank', () => {
    expect(text(bar(renderPane(el, base, act), 'e1'))).toBe('        ')
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
    // Fixed columns take 16 cells, and the bar 9 more while it shows.
    expect(label(70)).toBe(70 - 16 - 9)
    expect(label(69)).toBe(69 - 16)
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
    expect(String(byKey(tree, 'group:g0')?.props['label'])).toBe('Read ×3 · 3 files')
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
    expect(String(byKey(tree, 'group:ag/t1')?.props['label'])).toBe('Grep ×3 · 3 patterns')
    expect(byKey(tree, 'ag/t2')).toBeDefined()
    expect(text(tree)).toMatch(/└─ /)
  })

  test('the ascii set groups with x and draws only ASCII', () => {
    const tree = renderPane(el, { ...grouped, icons: ICON_SETS.ascii, expanded: new Set(['group:g0']) }, act)
    expect(String(byKey(tree, 'group:g0')?.props['label'])).toBe('Read x3 . 3 files')
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

  test('the selected row is bold text, the others buttons', () => {
    const tree = table(100, { selected: 1 })
    expect(byKey(tree, 'turn-1')?.type).toBe('Text')
    expect(byKey(tree, 'turn-1')?.props['bold']).toBe(true)
    expect(byKey(tree, 'turn-0')?.type).toBe('Button')
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

describe('group and bar regressions', () => {
  test('hover scopes stay unique and within 64 characters with groups open', () => {
    const tree = renderPane(el, { ...base, turns: foldedTurn, timings: foldedTimings, expanded: foldedOpen }, act)
    const scopes = nodes(tree)
      .map(n => (n.props['hover'] as { scope?: string } | undefined)?.scope)
      .filter((scope): scope is string => scope !== undefined)
    for (const scope of new Set(scopes)) {
      expect(scope.length).toBeGreaterThanOrEqual(1)
      expect(scope.length).toBeLessThanOrEqual(64)
    }
    expect(scopes).toContain('row:group:fr1')
    expect(scopes).toContain('row:fr1')
  })

  test('the pane text stays within the engine limit with a thousand folded calls', () => {
    const many = buildTurns([
      { role: 'user', text: 'go', toolUses: [] },
      {
        role: 'assistant',
        text: '',
        toolUses: Array.from({ length: 1000 }, (_, n) => ({
          tool_use_id: `m${n}`,
          tool: 'Read',
          input: { file_path: `/s/${n}.ts` },
          text: 'x'.repeat(50),
        })),
      },
    ])
    const tree = renderPane(el, { ...base, turns: many, expanded: new Set(['group:m0']) }, act)
    expect(text(tree).length).toBeLessThan(100_000)
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

describe('pane budget with everything on', () => {
  // Every text a node carries: its own string children, joined, and the
  // text-like props.
  const own = (children: unknown): string =>
    typeof children === 'string' || typeof children === 'number'
      ? String(children)
      : Array.isArray(children)
        ? children.map(own).join('')
        : ''
  const pieces = (tree: unknown) =>
    nodes(tree).flatMap(n => [
      own(n.children),
      ...['label', 'text', 'source'].flatMap(key => (typeof n.props[key] === 'string' ? [n.props[key] as string] : [])),
    ])

  const everything = (outputs: number) => {
    const output = Array.from({ length: 300 }, (_, n) => `line ${n} ${'x'.repeat(30)}`).join('\n')
    const table = ['| a | b |', '|---|---|', ...Array.from({ length: 200 }, (_, n) => `| ${n} | ${'t'.repeat(40)} |`)]
    const turn = buildTurns([
      { role: 'user', text: 'go', toolUses: [] },
      {
        role: 'assistant',
        text: table.join('\n'),
        toolUses: [
          ...Array.from({ length: outputs }, (_, n) => ({
            tool_use_id: `o${n}`,
            tool: 'Bash',
            input: { command: `cat big${n}` },
            text: output,
          })),
          ...Array.from({ length: 1500 }, (_, n) => ({
            tool_use_id: `k${n}`,
            tool: n % 2 === 0 ? 'Bash' : 'Edit',
            input:
              n % 2 === 0
                ? { command: `echo ${n} ${'q'.repeat(300)}` }
                : { file_path: `/src/f${n}.go`, old_string: 'a\nb\nc', new_string: 'd\ne\nf' },
            text: 'ok',
          })),
        ],
      },
    ])
    const open = turn[0]!.items.filter(item => item.kind === 'output' || item.id.startsWith('o')).map(item => item.id)
    return renderPane(
      el,
      {
        ...base,
        turns: turn,
        expanded: new Set(open),
        full: new Set(open.flatMap(id => [`${id}:output`, `${id}:command`, id])),
        cursor: 'k3',
        columns: 100,
      },
      act,
    )
  }

  test('rows, show-all outputs, cards, a table and the cursor stay under the engine limits', () => {
    for (const outputs of [3, 9]) {
      const tree = everything(outputs)
      const all = pieces(tree)
      expect(all.join('').length).toBeLessThan(100_000)
      for (const piece of all) expect(piece.length).toBeLessThan(10_000)
      expect(nodes(tree).length).toBeLessThan(20_000)
      expect(text(tree)).toMatch(/\d+ more rows/)
    }
    expect(byKey(everything(3), 'card-k0')).toBeDefined()
  })

  test('the frames of 300 open rows are charged too: titles, paths and notes', () => {
    const turn = buildTurns([
      { role: 'user', text: 'go', toolUses: [] },
      {
        role: 'assistant',
        text: '',
        toolUses: Array.from({ length: 300 }, (_, n) => ({
          tool_use_id: `w${n}`,
          tool: 'Write',
          input: { file_path: `/${'p'.repeat(400)}/f${n}.go`, content: 'x' },
          text: 'y',
        })),
      },
    ])
    const ids = turn[0]!.items.map(item => item.id)
    for (const icons of [ICON_SETS.nerd, ICON_SETS.unicode, ICON_SETS.ascii]) {
      const tree = renderPane(el, { ...base, turns: turn, expanded: new Set(ids), columns: 40, icons }, act)
      expect(pieces(tree).join('').length).toBeLessThan(100_000)
    }
  })

  test('a row that does not fit is counted, not drawn, and the cards draw from what is left', () => {
    const turn = buildTurns([
      { role: 'user', text: 'go', toolUses: [] },
      {
        role: 'assistant',
        text: '',
        toolUses: Array.from({ length: 2000 }, (_, n) => ({
          tool_use_id: `r${n}`,
          tool: 'Bash',
          input: { command: `echo ${n} ${'q'.repeat(590)}` },
          text: 'ok',
        })),
      },
    ])
    const tree = renderPane(el, { ...base, turns: turn, columns: 300 }, act)
    expect(text(tree).length).toBeLessThan(100_000)
    expect(byKey(tree, 'item-r0')).toBeDefined()
    expect(byKey(tree, 'item-r1999')).toBeUndefined()
    const shown = nodes(tree).filter(n => String(n.props['key']).startsWith('item-r')).length
    expect(text(tree)).toContain(`${2000 - shown} more rows`)
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
