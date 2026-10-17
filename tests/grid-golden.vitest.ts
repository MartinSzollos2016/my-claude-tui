// The terminal's pane (the grid) as drawn before the desktop layout: every
// scenario's tree is kept in fixtures/grid-golden.json.gz (gzipped JSON,
// 87 KB instead of 3.4 MB) and must stay equal.
// UPDATE_GOLDEN=1 writes the file anew; a missing file fails otherwise.
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { gunzipSync, gzipSync } from 'node:zlib'
import { describe, expect, test } from 'vitest'

// The header's clock is local time: one zone for every machine and CI.
process.env.TZ = 'UTC'

import { ICON_SETS } from '../hooks/icons'
import { buildTurns } from '../hooks/model/turns'
import { renderPane } from '../hooks/view/pane'
import type { PaneData } from '../hooks/view/context'
import { act, base, el, foldedOpen, foldedTimings, foldedTurn } from './fixtures/view'

const FILE = join(__dirname, 'fixtures', 'grid-golden.json.gz')

const trace = buildTurns(
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

const folded = { turns: foldedTurn, timings: foldedTimings, stats: [undefined] }
const stats = [
  { key: 'k0', turnIndex: 0, durationMs: 4_000, endedAt: 1, inputTokens: 900, outputTokens: 100 },
  { key: 'k1', turnIndex: 1, durationMs: 9_000, endedAt: 2, inputTokens: 2_000, outputTokens: 300 },
]

const scenarios: Record<string, Partial<PaneData>> = {
  detail: {},
  'detail-folded': folded,
  'detail-folded-open': { ...folded, expanded: foldedOpen },
  'detail-thinking': { thinking: { count: 1, text: 'pondering the bug' } },
  'detail-trace': { expanded: new Set(['a1']), traces: new Map([['ag', { items: trace }]]) },
  'detail-cursor': { ...folded, expanded: foldedOpen, cursor: 'fe' },
  'detail-working': { isWorking: true, isLatest: true },
  'detail-unfocused-collapsed': { isFocused: false, isFooterOpen: false },
  'detail-inline-12': { placement: 'inline', rows: 12, isFooterOpen: false },
  'detail-inline-6': { placement: 'inline', rows: 6, isFooterOpen: false },
  turns: { view: 'turns', stats },
  'turns-query': { view: 'turns', stats, query: 'bug', matches: [{ index: 0, snippet: 'Fix the bug now' }] },
  'turns-cursor': { view: 'turns', stats, turnCursor: 1 },
  team: {
    view: 'team',
    members: [{ name: 'alice', type: 'teammate', status: 'running' }],
    tasks: [{ id: '1', subject: 'Write tests', status: 'in_progress', owner: 'alice' }],
  },
  empty: { turns: [] },
}

// A tree as plain data: each node's children once (the fixture's elements
// carry them under props and beside them), functions and the JSX
// transform's __source / __self dropped.
function plain(tree: unknown): unknown {
  if (Array.isArray(tree)) return tree.map(plain)
  if (tree === null || typeof tree !== 'object') return typeof tree === 'function' ? undefined : tree
  const node = tree as { type?: unknown; props?: Record<string, unknown> }
  if (node.type === undefined || node.props === undefined) return tree
  const props: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(node.props))
    if (key !== 'children' && !key.startsWith('__') && typeof value !== 'function')
      props[key] = JSON.parse(JSON.stringify(value) ?? 'null')
  return { type: node.type, props, children: plain(node.props['children']) }
}

// Every scenario in every icon set at three widths.
function drawAll(): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [name, scenario] of Object.entries(scenarios))
    for (const [set, icons] of Object.entries(ICON_SETS))
      for (const columns of [60, 100, 140]) {
        const tree = renderPane(el, { ...base, ...scenario, icons, columns } as PaneData, act)
        out[`${name}/${set}/${columns}`] = JSON.parse(JSON.stringify(plain(tree)))
      }
  return out
}

// Where two trees first differ: the path and both values, or undefined.
function firstDiff(a: unknown, b: unknown, path = ''): string | undefined {
  if (a === b) return undefined
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null)
    return `${path}: ${JSON.stringify(a)} != ${JSON.stringify(b)}`
  const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])]
  for (const key of keys) {
    const found = firstDiff((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key], `${path}.${key}`)
    if (found !== undefined) return found
  }
  return undefined
}

describe('the terminal grid', () => {
  test('draws every scenario as it did before the desktop layout', () => {
    const drawn = drawAll()
    if (process.env['UPDATE_GOLDEN'] === '1') writeFileSync(FILE, gzipSync(JSON.stringify(drawn), { level: 9 }))
    expect(existsSync(FILE)).toBe(true)
    const golden = JSON.parse(gunzipSync(readFileSync(FILE)).toString('utf8')) as Record<string, unknown>
    expect(Object.keys(drawn)).toEqual(Object.keys(golden))
    for (const key of Object.keys(golden)) expect(firstDiff(drawn[key], golden[key]), key).toBeUndefined()
  })
})
