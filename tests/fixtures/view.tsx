import type { SessionMessage } from 'claude-code'
import { buildTurns } from '../../hooks/model/turns'
import type { El } from '../../hooks/view/kit'
const make =
  (type: string) =>
  (props: Record<string, unknown>): Node => ({ type, props, children: props['children'] })

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

export const calls: string[] = []

// The windows each drawing reports, apart from the calls of the keys.
export const measured: { scrollTop: number; windowRows: number; total: number }[] = []

export type Node = { type: string; props: Record<string, unknown>; children: unknown }

export function text(tree: unknown): string {
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

export const el = {
  Box: make('Box'),
  Text: make('Text'),
  Button: make('Button'),
  Markdown: make('Markdown'),
  Code: make('Code'),
  Input: make('Input'),
} as unknown as El

export function nodes(tree: unknown, found: Node[] = []): Node[] {
  if (Array.isArray(tree)) for (const child of tree) nodes(child, found)
  else if (tree !== null && typeof tree === 'object' && 'type' in tree) {
    found.push(tree as Node)
    nodes((tree as Node).children, found)
  }
  return found
}

export const byKey = (tree: unknown, key: string) => nodes(tree).find(n => n.props['key'] === key)

// Presses the footer key `key` (always a Button with its hotkey) and says
// whether it reached an action; a key out of reach swallows the press.
export function acts(tree: unknown, key: string): boolean {
  const button = byKey(tree, key)
  if (button?.type !== 'Button' || typeof button.props['hotkey'] !== 'string') throw new Error(`no key ${key}`)
  const before = calls.length
  ;(button.props['onPress'] as (e: unknown) => void)({ surface: 'terminal' })
  return calls.length > before
}

const turns = buildTurns(messages)

export const base = {
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

export const act = {
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
