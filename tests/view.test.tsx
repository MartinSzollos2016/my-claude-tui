// The render functions called directly with stand-in elements, so the views
// are unit tested (and measured by coverage) without mounting them in the
// engine. Each element just records its type, props and children.
import type { SessionMessage } from 'claude-code'
import { describe, expect, test } from 'claude-code/testing'

import { buildTurns } from '../hooks/model'
import { renderBar, renderPane, type El } from '../hooks/view'

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

const calls: string[] = []
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
  pickTurn: (i: number) => calls.push(`pick:${i}`),
  search: (query: string) => calls.push(`search:${query}`),
  submitSearch: (query: string) => calls.push(`submit:${query}`),
  focusSearch: () => calls.push('focusSearch'),
}

describe('renderPane', () => {
  test('header, prompt, navigation and one row per item', () => {
    const tree = renderPane(el, base, act)
    const all = text(tree)
    expect(all).not.toContain('ctx')
    expect(text(renderPane(el, { ...base, selected: 1, isLatest: true }, act))).toContain('ctx 62%')
    expect(all).toContain('opus5.5')
    expect(all).toContain('1.5k')
    expect(all).toContain('1m 5s')
    expect(all).toContain('❯ Fix the bug')
    expect(all).toContain('turn 1/2')
    expect(byKey(tree, 'b1')?.props['label']).toContain('Run tests')
    expect(all).toContain('2.5s')
    expect(all).toContain('haiku4.5')
    expect(byKey(tree, 'nav-prev')?.props['dimColor']).toBe(true)
  })

  test('expanded rows draw input and output frames, errors in red', () => {
    const tree = renderPane(el, { ...base, expanded: new Set(['b1', 'e1', 't0:o0']) }, act)
    const frames = nodes(tree).filter(n => n.type === 'Box' && n.props['borderStyle'] === 'round')
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
    expect(byKey(list, 'turn-0')?.props['label']).toContain('1m 5s')
    expect(byKey(list, 'turn-1')?.props['label']).toContain('reply')
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
    expect(byKey(tree, 'turn-0')?.props['label']).toContain('1m 5s')
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

  test('row buttons call their actions', () => {
    const tree = renderPane(el, base, act)
    for (const key of [
      'b1',
      'nav-prev',
      'nav-next',
      'nav-latest',
      'nav-turns',
      'nav-search',
      'nav-expand',
      'nav-collapse',
    ]) {
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
})

describe('renderBar', () => {
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
