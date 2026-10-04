import type { AgentStatus } from 'claude-code'
import { describe, expect, test } from 'claude-code/testing'

import { parseCommand } from '../hooks/commands'
import { ICON_SETS } from '../hooks/icons'
import {
  callInput,
  clampScroll,
  compactCall,
  contentRows,
  durationSuffix,
  engineScroll,
  finishedSince,
  finishedWorkflows,
  followCursor,
  footerLayout,
  footerPads,
  overflowRows,
  pageScroll,
  paneColumns,
  resultLine,
  runningTool,
  scrollToRow,
  searchTurns,
  spinnerMessage,
  splitMatch,
  statusText,
  stepCursor,
  turnTable,
} from '../hooks/model'
import { buildTurns } from '../hooks/model/turns'
import type { ToolItem, Turn } from '../hooks/model/types'
import { displayWidth } from '../hooks/model/width'
import { tool } from './fixtures/model'

describe('paneColumns', () => {
  test('asks for the share of the terminal, keeping room for the transcript', () => {
    expect(paneColumns(200, 60)).toBe(120)
    expect(paneColumns(200, 80)).toBe(160)
    expect(paneColumns(200, 95)).toBe(160)
    expect(paneColumns(120, 30)).toBe(40)
    expect(paneColumns(70, 60)).toBe(undefined)
  })
})

describe('resultLine', () => {
  test('summarizes a tool result as one line', () => {
    expect(resultLine({ stdout: 'a\nb\nc', stderr: '' }, false)).toBe('3 lines')
    expect(resultLine('one', false)).toBe('1 line')
    expect(resultLine({ file: { content: 'x\ny' } }, false)).toBe('2 lines')
    expect(resultLine({ filenames: ['a', 'b'] }, false)).toBe('2 items')
    expect(resultLine(undefined, false)).toBe('done')
    expect(resultLine({ stdout: '', stderr: '' }, false)).toBe('no output')
  })

  test('shows the first line of an error, sanitized and cut', () => {
    expect(resultLine('Error: boom\nstack', true)).toBe('error: Error: boom')
    expect(resultLine('x\u001b[31m'.repeat(50), true).length).toBeLessThanOrEqual(87)
    expect(resultLine('x\u001b[31m', true)).toBe('error: x')
  })
})

describe('parseCommand', () => {
  test('routes subcommands and their /tail shorthand alike', () => {
    expect(parseCommand('tail', '')).toEqual({ sub: 'open', arg: '' })
    expect(parseCommand('tail', 'width 70')).toEqual({ sub: 'width', arg: '70' })
    expect(parseCommand('tail-width', ' 70 ')).toEqual({ sub: 'width', arg: '70' })
    expect(parseCommand('tail', 'help')).toEqual({ sub: 'help', arg: '' })
    expect(parseCommand('tail', 'nonsense')).toEqual({ sub: 'open', arg: 'nonsense' })
    expect(parseCommand('tail-turns', '')).toEqual({ sub: 'turns', arg: '' })
    expect(parseCommand('tail', 'turns')).toEqual({ sub: 'turns', arg: '' })
    expect(parseCommand('tail-icons', ' ascii ')).toEqual({ sub: 'icons', arg: 'ascii' })
    expect(parseCommand('tail', 'icons unicode')).toEqual({ sub: 'icons', arg: 'unicode' })
    expect(parseCommand('tail-status', ' off ')).toEqual({ sub: 'status', arg: 'off' })
    expect(parseCommand('tail', 'status on')).toEqual({ sub: 'status', arg: 'on' })
    expect(parseCommand('tail-notify', 'on')).toEqual({ sub: 'notify', arg: 'on' })
    expect(parseCommand('tail', 'notify off')).toEqual({ sub: 'notify', arg: 'off' })
    expect(parseCommand('other', '')).toBe(undefined)
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

describe('icon sets', () => {
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

  test('no set draws the paused mark as a spinner frame, and the unicode set avoids the wide U+23F8', () => {
    for (const set of Object.values(ICON_SETS)) expect(set.spinner).not.toContain(set.idle)
    expect(ICON_SETS.unicode.interrupted).not.toBe('\u23f8')
    expect(ICON_SETS.nerd.interrupted).toBe('\u23f8')
  })

  test('each glyph is one cell wide in the unicode and ascii sets, the spinner has frames', () => {
    for (const set of [ICON_SETS.unicode, ICON_SETS.ascii])
      for (const [key, value] of Object.entries(set).filter(([k]) => !MULTI.includes(k)))
        for (const glyph of [value].flat()) expect([...glyph].length, key).toBe(1)
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
})

describe('splitMatch', () => {
  test('splits a snippet around the query, whatever the case', () => {
    expect(splitMatch('foo Bar baz', 'bar')).toEqual({ before: 'foo ', match: 'Bar', after: ' baz' })
    expect(splitMatch('foo Bar baz', '  BAR ')).toEqual({ before: 'foo ', match: 'Bar', after: ' baz' })
    expect(splitMatch('…tail Bar', 'bar')).toEqual({ before: '…tail ', match: 'Bar', after: '' })
  })

  test('no match, or no query, leaves the snippet whole', () => {
    expect(splitMatch('foo', 'zzz')).toEqual({ before: 'foo', match: '', after: '' })
    expect(splitMatch('foo', '  ')).toEqual({ before: 'foo', match: '', after: '' })
  })

  test('maps offsets like snippetAt: lowercase length changes and surrogate pairs', () => {
    // "İ" lowercases to two UTF-16 units, so offsets in the lowercased text drift.
    expect(splitMatch('İx', 'x')).toEqual({ before: 'İ', match: 'x', after: '' })
    expect(splitMatch('😀 Bar 😀', 'bar')).toEqual({ before: '😀 ', match: 'Bar', after: ' 😀' })
    expect(splitMatch('😀😀', '😀')).toEqual({ before: '', match: '😀', after: '😀' })
  })

  test('agrees with searchTurns: the snippet it made holds the match it finds', () => {
    const long = `${'a'.repeat(60)} needle ${'b'.repeat(60)}`
    const turns = buildTurns([
      { role: 'user', text: long, toolUses: [] },
      { role: 'assistant', text: 'ok', toolUses: [] },
    ])
    const [hit] = searchTurns(turns, 'NEEDLE')
    const split = splitMatch(hit!.snippet, 'NEEDLE')
    expect(split.match).toBe('needle')
    expect(split.before.startsWith('…')).toBe(true)
    expect(split.after.endsWith('…')).toBe(true)
  })
})

describe('compactCall paths', () => {
  test('a long path is cut in the middle and keeps the file name', () => {
    const { summary } = compactCall('Read', { file_path: `/home/dev/${`${'d'.repeat(20)}/`.repeat(6)}session.ts` })
    expect([...summary].length).toBeLessThanOrEqual(80)
    expect(summary).toContain('…')
    expect(summary.endsWith('session.ts')).toBe(true)
  })
})

describe('callInput', () => {
  test("is the event without the fields that are not the tool's own", () => {
    expect(callInput({ tool: 'Bash', tool_use_id: 'x', agentId: 'a', command: 'ls', timeout: 5 })).toEqual({
      command: 'ls',
      timeout: 5,
    })
  })
})

describe('statusText', () => {
  const started = (tool: string, input: Record<string, unknown>, at: number, id = tool) =>
    runningTool(id, tool, input, at)

  test('the category icon, the tool, its summary and the elapsed seconds', () => {
    const bash = started('Bash', { command: 'go test ./...' }, 0)
    expect(statusText([bash], 12_400, ICON_SETS.nerd)).toBe(`${ICON_SETS.nerd.wrench} Bash go test ./... · 12s`)
    expect(statusText([bash], 72_000, ICON_SETS.unicode)).toBe(
      `${ICON_SETS.unicode.wrench} Bash go test ./... · 1m 12s`,
    )
    const read = started('Read', { file_path: '/a/b/main.go' }, 5_000)
    expect(statusText([read], 6_900, ICON_SETS.nerd)).toBe(`${ICON_SETS.nerd.book} Read a/b/main.go · 1s`)
  })

  test('the oldest running call is the one shown, and nothing running has no status', () => {
    const first = started('Grep', { pattern: 'x' }, 1_000)
    const second = started('Bash', { command: 'ls' }, 4_000)
    expect(statusText([first, second], 6_000, ICON_SETS.nerd)).toContain('Grep')
    expect(statusText([], 6_000, ICON_SETS.nerd)).toBeUndefined()
  })

  test('the summary is cut to 60 characters in the middle', () => {
    const long = started('Bash', { command: `echo ${'x'.repeat(30)}${'y'.repeat(30)}` }, 0)
    const line = statusText([long], 0, ICON_SETS.nerd)!
    const summary = line.slice(line.indexOf('Bash ') + 5, line.lastIndexOf(' · '))
    expect([...summary]).toHaveLength(60)
    expect(summary).toContain('…')
    expect(summary.startsWith('echo x')).toBe(true)
    expect(summary.endsWith('y')).toBe(true)
  })

  test('the ascii set gives an ASCII line, untrusted text is cleaned', () => {
    const bash = started('Bash', { command: `echo \u001b[31mhi\u202e ${'z'.repeat(80)}` }, 0)
    const line = statusText([bash], 3_000, ICON_SETS.ascii)!
    expect(line).toMatch(/^[\x20-\x7e]+$/)
    expect(line).toContain('Bash echo hi')
    expect(line.endsWith(' . 3s')).toBe(true)
  })
})

describe('finishedSince', () => {
  const agent = (id: string, status: AgentStatus) => ({ id, status, description: `job ${id}` })

  test('an agent that was not finished and now is, whichever way it ended', () => {
    const prev = new Map<string, AgentStatus>([
      ['a', 'running'],
      ['b', 'waiting'],
      ['c', 'pending'],
      ['d', 'idle'],
    ])
    const next = [agent('a', 'completed'), agent('b', 'failed'), agent('c', 'killed'), agent('d', 'completed')]
    expect(finishedSince(prev, next).map(a => a.id)).toEqual(['a', 'b', 'c', 'd'])
  })

  test('still running, already finished and never seen agents are not reported', () => {
    const prev = new Map<string, AgentStatus>([
      ['run', 'running'],
      ['old', 'completed'],
    ])
    const next = [agent('run', 'running'), agent('old', 'completed'), agent('new', 'completed')]
    expect(finishedSince(prev, next)).toEqual([])
    expect(finishedSince(new Map(), next)).toEqual([])
  })

  test('carries the description with the id', () => {
    const found = finishedSince(new Map([['a', 'running' as const]]), [agent('a', 'completed')])
    expect(found).toEqual([{ id: 'a', status: 'completed', description: 'job a' }])
  })
})

describe('finishedWorkflows', () => {
  const wf = (id: string, over: Partial<ToolItem> = {}): ToolItem =>
    tool({ id, tool: 'Workflow', isPending: true, ...over })
  const turn = (...items: ToolItem[]) => ({
    index: 0,
    prompt: '',
    items,
    toolCount: items.length,
    outputCount: 0,
    subagentCount: 0,
  })

  test('tracks pending Workflow calls while the session works', () => {
    expect(finishedWorkflows(new Set(), turn(wf('w1')), true)).toEqual({ tracked: new Set(['w1']), finished: [] })
  })

  test('a tracked call that got its result is finished, once', () => {
    const done = finishedWorkflows(new Set(['w1']), turn(wf('w1', { isPending: false, resultText: 'ok' })), true)
    expect(done).toEqual({ tracked: new Set(), finished: ['w1'] })
  })

  test('a call left pending when the session stops working is dropped without a toast', () => {
    expect(finishedWorkflows(new Set(['w1']), turn(wf('w1')), false)).toEqual({ tracked: new Set(), finished: [] })
  })

  test('a call that left the latest turn or ended interrupted is dropped without a toast', () => {
    expect(finishedWorkflows(new Set(['w1']), turn(), true)).toEqual({ tracked: new Set(), finished: [] })
    const stopped = wf('w1', { isPending: false, isInterrupted: true })
    expect(finishedWorkflows(new Set(['w1']), turn(stopped), true)).toEqual({ tracked: new Set(), finished: [] })
    expect(finishedWorkflows(new Set(), undefined, true)).toEqual({ tracked: new Set(), finished: [] })
  })
})

describe('turnTable', () => {
  const turns = buildTurns([
    { role: 'user', text: 'Fix the bug', toolUses: [] },
    {
      role: 'assistant',
      text: '',
      toolUses: [
        { tool_use_id: 'a', tool: 'Bash', input: {}, text: 'x' },
        { tool_use_id: 'b', tool: 'Read', input: {}, text: 'x' },
      ],
    },
    { role: 'user', text: '日本語'.repeat(30), toolUses: [] },
    { role: 'assistant', text: 'ok', toolUses: [] },
    { role: 'user', text: 'Third', toolUses: [] },
    { role: 'assistant', text: 'ok', toolUses: [] },
  ])
  const stats = [
    { prompt: 'Fix the bug', durationMs: 65_000, endedAt: 0, inputTokens: 1000, outputTokens: 500 },
    { prompt: '', durationMs: 32_500, endedAt: 0, inputTokens: 40, outputTokens: 2 },
    undefined,
  ]
  const table = (width: number, icons = ICON_SETS.nerd) => turnTable(turns, stats, width, icons)
  const row = (t: ReturnType<typeof table>, i: number) => t.rows[i]!

  test('a very narrow pane never overflows', () => {
    for (const width of [40, 30, 20, 10]) {
      const t = table(width)
      for (const r of t.rows) expect(displayWidth(r.label)).toBeLessThanOrEqual(Math.max(0, width - 4))
    }
  })

  test('a wide pane shows number, prompt, tools, time, tokens and the bar', () => {
    const t = table(100)
    expect(t.header).toMatch(/^#\s+prompt\s+tools\s+time\s+tokens$/)
    expect(row(t, 0).cells).toMatchObject({ number: '#1', tools: '2', time: '1m 5s', tokens: '1.5k' })
    expect(row(t, 0).cells.bar).toBe('████████')
    expect(row(t, 1).cells.bar).toBe('████')
    expect(row(t, 2).cells).toMatchObject({ tools: '', time: '', tokens: '', bar: '' })
  })

  test('every row label is exactly as wide as the table, wide characters included', () => {
    for (const width of [100, 70, 69, 55, 54, 40]) {
      const t = table(width)
      const widths = new Set(t.rows.map(r => displayWidth(r.label)))
      expect(widths.size).toBe(1)
      expect(displayWidth(t.header)).toBeLessThanOrEqual([...widths][0]!)
      expect([...widths][0]).toBeLessThanOrEqual(width - 4)
    }
  })

  test('under 70 columns tokens and the bar are left out, under 55 tools too', () => {
    const mid = table(69)
    expect(mid.header).not.toContain('tokens')
    expect(mid.header).toContain('tools')
    expect(row(mid, 0).cells.bar).toBe('')
    expect(row(mid, 0).cells.tokens).toBe('')
    const narrow = table(54)
    expect(narrow.header).not.toContain('tools')
    expect(narrow.header).toContain('time')
    expect(row(narrow, 0).cells.tools).toBe('')
    expect(table(70).header).toContain('tokens')
    expect(table(55).header).toContain('tools')
  })

  test('the prompt is cut by cells with the set ellipsis and keeps its room', () => {
    const t = table(100)
    expect(row(t, 1).cells.prompt.endsWith('…')).toBe(true)
    expect(displayWidth(row(t, 1).cells.prompt)).toBeLessThanOrEqual(56)
    expect(displayWidth(row(t, 1).cells.prompt)).toBeGreaterThanOrEqual(55)
    const a = table(100, ICON_SETS.ascii)
    expect(row(a, 1).cells.prompt.endsWith('...')).toBe(true)
    expect(a.rows[0]!.label).toMatch(/^[\x20-\x7e]*$/)
    expect(a.header).toMatch(/^[\x20-\x7e]*$/)
  })

  test('a turn without a prompt reads (no prompt) and no turns give no rows', () => {
    const none = turnTable(buildTurns([{ role: 'assistant', text: 'hi', toolUses: [] }]), [], 100, ICON_SETS.nerd)
    expect(none.rows[0]!.cells.prompt).toContain('(no prompt)')
    expect(turnTable([], [], 100, ICON_SETS.nerd).rows).toEqual([])
  })
})

describe('spinnerMessage and durationSuffix', () => {
  const started = (tool: string, input: Record<string, unknown>, at: number) => runningTool(tool, tool, input, at)

  test('the spinner says the tool, a 40 character summary and the elapsed time', () => {
    const bash = started('Bash', { command: 'go test ./...' }, 0)
    expect(spinnerMessage([bash], 12_400, ICON_SETS.nerd)).toBe('Bash go test ./... · 12s')
    expect(spinnerMessage([bash], 72_000, ICON_SETS.ascii)).toBe('Bash go test ./... . 1m 12s')
    const long = started('Bash', { command: `echo ${'x'.repeat(100)}` }, 0)
    const summary = spinnerMessage([long], 0, ICON_SETS.nerd)!.slice('Bash '.length, -' · 0s'.length)
    expect([...summary]).toHaveLength(40)
    expect(spinnerMessage([], 0, ICON_SETS.nerd)).toBeUndefined()
    expect(spinnerMessage([started('Task', {}, 0)], 1_000, ICON_SETS.nerd)).toBe('Subagent Task · 1s')
  })

  test('the oldest running call is the one the spinner names', () => {
    const calls = [started('Bash', { command: 'ls' }, 5_000), started('Grep', { pattern: 'x' }, 1_000)]
    expect(spinnerMessage(calls, 6_000, ICON_SETS.nerd)).toBe('Grep "x" · 5s')
  })

  test('the suffix counts tools and agents when they are not zero', () => {
    const turn = (toolCount: number, subagentCount: number): Turn => ({
      index: 0,
      prompt: '',
      items: [],
      toolCount,
      outputCount: 0,
      subagentCount,
    })
    expect(durationSuffix(turn(4, 1), '·')).toBe(' · 3 tools · 1 agent')
    expect(durationSuffix(turn(1, 0), '.')).toBe(' . 1 tool')
    expect(durationSuffix(turn(2, 2), '·')).toBe(' · 2 agents')
    expect(durationSuffix(turn(0, 0), '·')).toBe('')
    expect(durationSuffix(undefined, '·')).toBe('')
  })
})

describe('footerLayout', () => {
  test('two columns with labels from 64 columns up', () => {
    expect(footerLayout(100)).toEqual({ rows: 4, columns: 'two', labels: true })
    expect(footerLayout(64)).toEqual({ rows: 4, columns: 'two', labels: true })
  })

  test('stacked groups with labels from 40 to 63 columns', () => {
    expect(footerLayout(63)).toEqual({ rows: 6, columns: 'stacked', labels: true })
    expect(footerLayout(40)).toEqual({ rows: 6, columns: 'stacked', labels: true })
  })

  test('stacked groups without labels under 40 columns', () => {
    expect(footerLayout(39)).toEqual({ rows: 6, columns: 'stacked', labels: false })
    expect(footerLayout(0)).toEqual({ rows: 6, columns: 'stacked', labels: false })
  })
})

describe('footerLayout with the rows a view draws', () => {
  test('the footer is the rule, the group rows the view draws and the status row', () => {
    expect(footerLayout(100, 2).rows).toBe(4)
    expect(footerLayout(100, 1).rows).toBe(3)
    expect(footerLayout(60, 3).rows).toBe(5)
    expect(footerLayout(36, 4)).toEqual({ rows: 6, columns: 'stacked', labels: false })
  })
})

describe('contentRows of the turn list', () => {
  test('a turn row with an id has its start, as an item row does', () => {
    const rows = contentRows([
      { kind: 'line' },
      { kind: 'turn', id: 'turn:2' },
      { kind: 'turn', id: 'turn:1', snippet: 'x' },
    ])
    expect(rows.starts).toEqual({ 'turn:2': 1, 'turn:1': 2 })
    expect(rows.total).toBe(4)
  })
})

describe('footerPads', () => {
  test('every key but the last takes the gap after it', () => {
    expect(footerPads([9, 9, 9], 2)).toEqual([2, 2, 0])
    expect(footerPads([4], 2)).toEqual([0])
    expect(footerPads([], 2)).toEqual([])
  })

  test('with a width the last key fills the row up to it, never below zero', () => {
    expect(footerPads([9, 9, 9], 2, 35)).toEqual([2, 2, 4])
    expect(footerPads([9, 9, 9], 2, 31)).toEqual([2, 2, 0])
    expect(footerPads([9, 9, 9], 2, 20)).toEqual([2, 2, 0])
  })
})

describe('contentRows', () => {
  test('an item row is one row and its start is where it begins', () => {
    const rows = contentRows([{ kind: 'line' }, { kind: 'line', id: 'a' }, { kind: 'line', id: 'b' }])
    expect(rows.total).toBe(3)
    expect(rows.starts).toEqual({ a: 1, b: 2 })
  })

  test('a frame is two borders, a header and one row per line of each piece', () => {
    const rows = contentRows([
      { kind: 'line', id: 'a' },
      { kind: 'frame', body: ['one\ntwo', 'three'], notes: [], width: 72 },
      { kind: 'line', id: 'b' },
    ])
    expect(rows.total).toBe(1 + 2 + 1 + 3 + 1)
    expect(rows.starts['b']).toBe(7)
    expect(contentRows([{ kind: 'frame', body: [], notes: [], width: 72 }]).total).toBe(3)
  })

  test('a show all line under the body counts as a note', () => {
    expect(contentRows([{ kind: 'frame', body: ['x'], notes: ['show all'], width: 72 }]).total).toBe(5)
    expect(contentRows([{ kind: 'frame', body: ['x'], notes: ['note', 'show all'], width: 72 }]).total).toBe(6)
  })

  test('a turn of the list is one row, two with a search snippet', () => {
    const rows = contentRows([{ kind: 'turn' }, { kind: 'turn', snippet: 'a match' }])
    expect(rows.total).toBe(3)
  })

  test('the team board counts its headings, members and tasks', () => {
    const lines = ['Tasks (2)', 'alice', 'bob', '', 'Tasks', 'one', 'two'].map(() => ({ kind: 'line' as const }))
    expect(contentRows(lines).total).toBe(7)
  })

  test('a line wider than its width takes a row per width, a cut one row', () => {
    const paragraph = 'word '.repeat(60).trim()
    expect(paragraph.length).toBe(299)
    expect(contentRows([{ kind: 'line', text: paragraph, width: 72 }]).total).toBe(5)
    expect(contentRows([{ kind: 'line', text: paragraph, width: 32 }]).total).toBe(10)
    expect(contentRows([{ kind: 'line', text: paragraph }]).total).toBe(1)
    expect(contentRows([{ kind: 'line', text: '', width: 10 }]).total).toBe(1)
  })

  test('twenty 300-character paragraphs wrap in an 80 and a 40 column frame', () => {
    const prose = Array.from({ length: 20 }, () => 'x'.repeat(300)).join('\n\n')
    // 20 paragraphs and 19 blank lines between them, plus the frame's 3 rows.
    expect(contentRows([{ kind: 'frame', body: [prose], notes: [], width: 70 }]).total).toBe(3 + 20 * 5 + 19)
    expect(contentRows([{ kind: 'frame', body: [prose], notes: [], width: 30 }]).total).toBe(3 + 20 * 10 + 19)
  })

  test('one-line JSON of 8000 characters is many rows, the gutter of numbered code narrows the body', () => {
    const json = JSON.stringify({ data: 'y'.repeat(7989) })
    expect(json.length).toBe(8000)
    expect(contentRows([{ kind: 'frame', body: [json], notes: [], width: 70 }]).total).toBe(3 + 115)
    expect(contentRows([{ kind: 'frame', body: [json], notes: [], width: 30 }]).total).toBe(3 + 267)
    expect(contentRows([{ kind: 'frame', body: ['z'.repeat(70)], notes: [], width: 70, gutter: 5 }]).total).toBe(5)
  })

  test('a frame header and notes wrap at the frame width, a trailing newline adds no row', () => {
    expect(
      contentRows([{ kind: 'frame', body: ['a\n'], notes: ['n'.repeat(100)], width: 50, headRows: 2 }]).total,
    ).toBe(2 + 2 + 1 + 2)
    expect(contentRows([{ kind: 'frame', body: ['tab\there'], notes: [], width: 8 }]).total).toBe(3 + 2)
  })

  // Calibrated against the real engine (a pyte-rendered session): Code with
  // language markdown drops empty lines; a diff draws no ---, +++ or @@ line
  // and puts its line number and the +/- marker in a gutter of digits + 3.
  test('markdown counts no row for an empty line', () => {
    const prose = ['p'.repeat(250), '', 'q'.repeat(250), '', '', 'r'].join('\n')
    expect(contentRows([{ kind: 'frame', body: [prose], notes: [], width: 100, format: 'markdown' }]).total).toBe(
      3 + 3 + 3 + 1,
    )
    expect(contentRows([{ kind: 'frame', body: [prose], notes: [], width: 100 }]).total).toBe(3 + 3 + 1 + 3 + 2 + 1)
  })

  test('a diff counts only its changed and context lines, beside a gutter of its widest line number', () => {
    const diff = ['--- a', '+++ b', '@@ -10,2 +10,2 @@', `-${'y'.repeat(247)}`, `+${'z'.repeat(247)}`, ' same'].join(
      '\n',
    )
    // Line numbers up to 11: 2 digits + 3 = 5 cells, 95 left: 247 cells take 3 rows.
    expect(contentRows([{ kind: 'frame', body: [diff], notes: [], width: 100, format: 'diff' }]).total).toBe(
      3 + 3 + 3 + 1,
    )
    const small = ['--- a', '+++ b', '@@ -1,8 +1,8 @@', `-${'y'.repeat(247)}`].join('\n')
    // Up to line 8: 1 digit + 3 = 4 cells, 96 left: 3 rows.
    expect(contentRows([{ kind: 'frame', body: [small], notes: [], width: 100, format: 'diff' }]).total).toBe(3 + 3)
  })

  test('a search snippet wraps at its width', () => {
    expect(contentRows([{ kind: 'turn', snippet: 's'.repeat(90), width: 40 }]).total).toBe(1 + 3)
  })

  test('no blocks is no rows', () => {
    expect(contentRows([])).toEqual({ total: 0, starts: {} })
  })
})

describe('clampScroll', () => {
  test('content that fits the window does not scroll', () => {
    expect(clampScroll(5, 8, 10)).toBe(0)
    expect(clampScroll(5, 10, 10)).toBe(0)
  })

  test('longer content scrolls to two rows past its end, never above the top', () => {
    expect(clampScroll(100, 30, 10)).toBe(22)
    expect(clampScroll(7, 30, 10)).toBe(7)
    expect(clampScroll(-3, 30, 10)).toBe(0)
  })
})

describe('pageScroll', () => {
  test('moves a window less two rows down or up, never above the top', () => {
    expect(pageScroll(0, 1, 10)).toBe(8)
    expect(pageScroll(8, -1, 10)).toBe(0)
    expect(pageScroll(3, -1, 10)).toBe(0)
  })

  test('a window of two rows or less still moves by one', () => {
    expect(pageScroll(0, 1, 2)).toBe(1)
    expect(pageScroll(0, 1, 0)).toBe(1)
  })
})

describe('followCursor', () => {
  test('a row already inside the window keeps the scroll', () => {
    expect(followCursor(5, 6, 10)).toBe(5)
    expect(followCursor(5, 13, 10)).toBe(5)
  })

  test('a row below the window scrolls it to one row above the bottom edge', () => {
    expect(followCursor(0, 9, 10)).toBe(1)
    expect(followCursor(5, 30, 10)).toBe(22)
  })

  test('a row above the window scrolls it to one row below the top edge', () => {
    expect(followCursor(10, 10, 10)).toBe(9)
    expect(followCursor(10, 2, 10)).toBe(1)
    expect(followCursor(10, 0, 10)).toBe(0)
  })

  test('a window of two rows or less has no margin', () => {
    expect(followCursor(0, 5, 2)).toBe(4)
    expect(followCursor(5, 3, 2)).toBe(3)
  })
})

describe('overflowRows', () => {
  test('nothing more above or below while the content fits', () => {
    expect(overflowRows(0, 10, 10)).toEqual({ above: 0, below: 0 })
  })

  test('counts the rows out of the window and under the indicator rows', () => {
    expect(overflowRows(0, 30, 10)).toEqual({ above: 0, below: 21 })
    expect(overflowRows(5, 30, 10)).toEqual({ above: 6, below: 16 })
    expect(overflowRows(21, 30, 10)).toEqual({ above: 22, below: 0 })
    expect(overflowRows(22, 30, 10)).toEqual({ above: 23, below: 0 })
  })
})

describe('scrollToRow', () => {
  const frame = { scrollTop: 0, windowRows: 10, total: 30, starts: { a: 2, z: 29 } }

  test('scrolls so the row stays visible, clamped to the content', () => {
    expect(scrollToRow(frame, 'a')).toBe(0)
    expect(scrollToRow(frame, 'z')).toBe(21)
    expect(scrollToRow({ ...frame, scrollTop: 20 }, 'a')).toBe(1)
  })

  test('a row with no known start, or no row, keeps the scroll', () => {
    expect(scrollToRow({ ...frame, scrollTop: 4 }, 'nope')).toBe(4)
    expect(scrollToRow({ ...frame, scrollTop: 4 }, null)).toBe(4)
  })
})

describe('stepCursor', () => {
  const ids = ['a', 'b', 'c', 'd', 'e', 'f']
  // a..f start on rows 1..6 of a window of four rows scrolled to row 3.
  const frame = { scrollTop: 3, windowRows: 4, total: 30, starts: { a: 1, b: 2, c: 3, d: 4, e: 5, f: 6 } }

  test('without a cursor, j enters at the first row inside the window and k at the last, so it does not move', () => {
    expect(stepCursor(ids, null, 1, frame)).toBe('d')
    expect(stepCursor(ids, null, -1, frame)).toBe('e')
    expect(scrollToRow(frame, 'd')).toBe(3)
    expect(scrollToRow(frame, 'e')).toBe(3)
  })

  test('at the top of the content it enters at the first row as before', () => {
    expect(stepCursor(ids, null, 1, { ...frame, scrollTop: 0 })).toBe('a')
  })

  test('with no row inside the window, or a cursor not on the list, it falls back to the ends', () => {
    expect(stepCursor(ids, null, 1, { ...frame, scrollTop: 20 })).toBe('a')
    expect(stepCursor(ids, null, -1, { ...frame, scrollTop: 20 })).toBe('f')
    expect(stepCursor(ids, 'gone', 1, { ...frame, scrollTop: 20 })).toBe('a')
  })

  test('a cursor scrolled out of the window enters inside it again instead of pulling the view back', () => {
    expect(stepCursor(ids, 'a', 1, frame)).toBe('d')
    expect(stepCursor(ids, 'a', -1, frame)).toBe('e')
  })

  test('a cursor on the list moves one row as moveCursor does', () => {
    expect(stepCursor(ids, 'd', 1, frame)).toBe('e')
    expect(stepCursor(ids, 'a', -1, { ...frame, scrollTop: 0 })).toBe('a')
    expect(stepCursor([], null, 1, frame)).toBe(null)
  })
})

describe('engineScroll', () => {
  const frame = { scrollTop: 0, windowRows: 34, total: 200, starts: {} }
  const move = (by: number) => ({ by, bodyRows: 40, contentRows: 40 })

  test('a wheel step moves its rows, clamped to the content', () => {
    expect(engineScroll(10, move(3), frame)).toBe(13)
    expect(engineScroll(1, move(-3), frame)).toBe(0)
  })

  test('a page key, the whole body, moves one page of the own window', () => {
    expect(engineScroll(10, move(40), frame)).toBe(42)
    expect(engineScroll(42, move(-40), frame)).toBe(10)
  })

  test('Home and End beyond the body go to the top and the end', () => {
    expect(engineScroll(50, move(-500), frame)).toBe(0)
    expect(engineScroll(50, move(500), frame)).toBe(168)
  })
})
