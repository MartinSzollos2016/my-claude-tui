// The turn-level logic added for spec items 1-11: fingerprints, text
// reports, search, thinking, Workflow state and the team board.
import type { SessionMessage, ToolUseSummary } from 'claude-code'
import { describe, expect, test } from 'claude-code/testing'
import {
  alignFromEnd,
  EMPTY_TURN_TEXT,
  searchTurns,
  taskBoard,
  taskMark,
  teamMembers,
  thinkingCounts,
  turnListText,
  turnTail,
  turnText,
  workflowState,
  type ApiLike,
} from '../hooks/model'
import { buildTurns, isAgentFinished, isAgentRunning, turnsKey } from '../hooks/model/turns'

const prompt = (text: string): SessionMessage => ({ role: 'user', text, toolUses: [] })

const read: ToolUseSummary = { tool_use_id: 'u1', tool: 'Read', input: { file_path: '/a.go' } }
const transcript: SessionMessage[] = [prompt('Go'), { role: 'assistant', text: 'Hi', toolUses: [read] }]

describe('turnsKey', () => {
  test('stays the same while nothing happened', () => {
    expect(turnsKey([...transcript])).toBe(turnsKey(transcript))
    expect(turnsKey([])).toBe('0')
  })

  test('changes on a new message, a tool answer and grown text', () => {
    const key = turnsKey(transcript)
    expect(turnsKey([...transcript, prompt('More')])).not.toBe(key)
    expect(turnsKey([transcript[0]!, { role: 'assistant', text: 'Hi', toolUses: [{ ...read, text: 'x' }] }])).not.toBe(
      key,
    )
    expect(turnsKey([transcript[0]!, { role: 'assistant', text: 'Hi there', toolUses: [read] }])).not.toBe(key)
    const answered: SessionMessage = {
      role: 'user',
      text: '',
      toolUses: [],
      toolResults: [{ tool_use_id: 'u1', text: 'ok', isError: false }],
    }
    expect(turnsKey([...transcript, answered])).not.toBe(key)
  })

  test('changes when a capped transcript fills a result in place', () => {
    const capped: SessionMessage[] = Array.from({ length: 4096 }, (_, i) =>
      i % 2 === 0 ? prompt(`p${i}`) : { role: 'assistant', text: '', toolUses: [{ ...read, tool_use_id: `u${i}` }] },
    )
    const last = capped.at(-1)!
    const filled = [...capped.slice(0, -1), { ...last, toolUses: [{ ...last.toolUses[0]!, text: 'done' }] }]
    expect(filled.length).toBe(capped.length)
    expect(turnsKey(filled)).not.toBe(turnsKey(capped))
  })
})

describe('agent status', () => {
  test('running is running, pending or waiting', () => {
    for (const status of ['running', 'pending', 'waiting'] as const) expect(isAgentRunning(status)).toBe(true)
    for (const status of ['completed', 'failed', 'killed', 'idle', undefined] as const)
      expect(isAgentRunning(status)).toBe(false)
  })

  test('finished is completed, failed or killed', () => {
    for (const status of ['completed', 'failed', 'killed'] as const) expect(isAgentFinished(status)).toBe(true)
    for (const status of ['pending', 'running', 'waiting', 'idle', undefined] as const)
      expect(isAgentFinished(status)).toBe(false)
  })
})

const main: SessionMessage[] = [
  prompt('Fix the bug'),
  {
    role: 'assistant',
    text: 'Looking.',
    toolUses: [
      { tool_use_id: 'r1', tool: 'Read', input: { file_path: '/a/b/main.go' }, text: 'package main' },
      {
        tool_use_id: 'a1',
        tool: 'Agent',
        input: { subagent_type: 'Explore', description: 'Find callers' },
        agentId: 'agent-1',
        text: 'done',
        durationMs: 4200,
      },
      { tool_use_id: 'x1', tool: 'Bash', input: { command: 'false' }, text: 'boom', isError: true },
      { tool_use_id: 'p1', tool: 'Bash', input: { command: 'sleep 9' } },
    ],
  },
]

describe('turnTail', () => {
  const turn = buildTurns(main)[0]!
  test('counts, then the duration when a stat is known', () => {
    expect(turnTail(turn)).toBe('3 tools · 1 agent')
    expect(turnTail(turn, { durationMs: 65_000 })).toBe('3 tools · 1 agent · 1m 5s')
    expect(turnTail(buildTurns([prompt('hi')])[0]!, { durationMs: 2_000 })).toBe('reply · 2.0s')
  })
})

describe('turnText', () => {
  const turn = buildTurns(main)[0]!
  const stat = { prompt: 'Fix the bug', turnIndex: 0, durationMs: 65_000, endedAt: 0, model: 'claude-opus-5-5' }

  test('the header, the prompt and one line per row', () => {
    const lines = turnText(turn, stat).split('\n')
    expect(lines[0]).toBe('Turn 1 · 3 tools · 1 agent · opus5.5 · 1m 5s')
    expect(lines[1]).toBe('❯ Fix the bug')
    expect(lines[2]).toBe('  Output       Looking.')
    expect(lines[3]).toBe('  Read         b/main.go')
    expect(lines[4]).toBe('  Explore      Find callers  4.2s')
    expect(lines[5]).toBe('  Bash         false (error)')
    expect(lines[6]).toBe('  Bash         sleep 9 (no result yet)')
  })

  test('without a stat, without rows and without turns', () => {
    expect(turnText(turn, undefined).split('\n')[0]).toBe('Turn 1 · 3 tools · 1 agent')
    expect(turnText(buildTurns([prompt('hi')])[0], undefined)).toBe(`Turn 1 · reply\n❯ hi\n  ${EMPTY_TURN_TEXT}`)
    expect(turnText(undefined, undefined)).toBe('No turns yet. Send a prompt and /tail lists its tool calls.')
  })

  test('stays under the 8000-character limit', () => {
    const huge = buildTurns([
      prompt('go'),
      {
        role: 'assistant',
        text: '',
        toolUses: Array.from({ length: 400 }, (_, i) => ({
          tool_use_id: `b${i}`,
          tool: 'Bash',
          input: { command: 'x'.repeat(200) },
          text: 'ok',
        })),
      },
    ])[0]
    const report = turnText(huge, undefined)
    expect(report.length).toBeLessThan(8_100)
    expect(report).toContain('chars hidden')
  })
})

describe('turnListText', () => {
  test('one line per turn with its counts and time', () => {
    const turns = buildTurns([...main, prompt('Thanks'), { role: 'assistant', text: 'Welcome.', toolUses: [] }])
    const stats = [{ prompt: 'Fix the bug', durationMs: 2_000, endedAt: 0 }, undefined]
    expect(turnListText(turns, stats)).toBe(
      'Turns (2), newest last:\n#1   Fix the bug  3 tools · 1 agent · 2.0s\n#2   Thanks  reply',
    )
    expect(turnListText([], [])).toBe('No turns yet.')
  })
})

describe('searchTurns', () => {
  const turns = buildTurns([
    ...main,
    prompt('Now add TESTS'),
    { role: 'assistant', text: 'Added.', toolUses: [] },
    prompt('Explain (a+)+$[ please'),
    { role: 'assistant', text: 'It is a pattern.', toolUses: [] },
  ])

  test('finds prompts, outputs, summaries and results, ignoring case', () => {
    expect(searchTurns(turns, 'tests').map(m => m.index)).toEqual([1])
    expect(searchTurns(turns, 'PACKAGE MAIN').map(m => m.index)).toEqual([0])
    expect(searchTurns(turns, 'find callers').map(m => m.index)).toEqual([0])
    expect(searchTurns(turns, 'looking').map(m => m.index)).toEqual([0])
    expect(searchTurns(turns, 'nowhere')).toEqual([])
  })

  test('an empty query matches nothing, so the list shows every turn', () => {
    expect(searchTurns(turns, '')).toEqual([])
    expect(searchTurns(turns, '   ')).toEqual([])
  })

  test('matches regex-special characters literally', () => {
    expect(searchTurns(turns, '(a+)+$[').map(m => m.index)).toEqual([2])
    expect(searchTurns(turns, '.*')).toEqual([])
    expect(searchTurns(turns, 'a.*(b')).toEqual([])
    const literal = buildTurns([prompt('see a.*(b here')])
    expect(searchTurns(literal, 'a.*(b').map(m => m.index)).toEqual([0])
  })

  test('a snippet of at most 80 characters around the first hit', () => {
    const long = buildTurns([prompt(`${'a'.repeat(200)} needle ${'b'.repeat(200)}`)])
    const [match] = searchTurns(long, 'needle')
    expect(match!.snippet.length).toBeLessThanOrEqual(80)
    expect(match!.snippet).toContain('needle')
    expect(match!.snippet.startsWith('…')).toBe(true)
    expect(match!.snippet.endsWith('…')).toBe(true)
    expect(searchTurns(buildTurns([prompt('short\nline')]), 'line')[0]!.snippet).toBe('short line')
  })

  test('never splits a surrogate pair or loses the hit when lowercasing changes the length', () => {
    const lone = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/
    for (let pad = 0; pad < 16; pad++) {
      const dense = buildTurns([prompt(`${'😀'.repeat(60 + pad)}needle${'😀'.repeat(60 + pad)}`)])
      const snippet = searchTurns(dense, 'needle')[0]!.snippet
      expect(snippet).toContain('needle')
      expect(lone.test(snippet)).toBe(false)
    }
    const dotted = buildTurns([prompt(`${'İ'.repeat(100)}needle${'İ'.repeat(100)}`)])
    const [match] = searchTurns(dotted, 'needle')
    expect(match!.snippet).toContain('needle')
    expect(lone.test(match!.snippet)).toBe(false)
  })

  test('stays linear on a long input', () => {
    const big = buildTurns([prompt('x'), { role: 'assistant', text: 'a'.repeat(1_000_000), toolUses: [] }])
    const started = performance.now()
    expect(searchTurns(big, 'ab')).toEqual([])
    expect(searchTurns(big, 'a'.repeat(50) + 'b')).toEqual([])
    expect(performance.now() - started).toBeLessThan(500)
  })
})

describe('thinkingCounts', () => {
  const api: ApiLike[] = [
    { role: 'user', content: [{ type: 'text', text: 'First' }] },
    {
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: '', signature: 's' },
        { type: 'redacted_thinking', data: 'opaque' },
        { type: 'text', text: 'Hi' },
        { type: 'tool_use', id: 't', name: 'Read', input: {} },
      ],
    },
    {
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 't', content: 'ok' },
        { type: 'text', text: '<system-reminder>r</system-reminder>' },
      ],
    },
    { role: 'assistant', content: [{ type: 'thinking', thinking: 'Check \u001b[31mthe file', signature: 's' }] },
    { role: 'user', content: [{ type: 'text', text: 'Second' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'Done' }] },
  ]

  test('counts thinking and redacted blocks per turn, empty ones included', () => {
    expect(thinkingCounts(api)).toEqual([
      { count: 3, text: 'Check the file' },
      { count: 0, text: '' },
    ])
  })

  test('an assistant message before any prompt opens a turn; rows without content count nothing', () => {
    expect(thinkingCounts([{ role: 'assistant', content: [{ type: 'thinking', thinking: 'x' }] }])).toEqual([
      { count: 1, text: 'x' },
    ])
    expect(thinkingCounts([{ role: 'user' }, { role: 'assistant' }])).toEqual([{ count: 0, text: '' }])
    expect(thinkingCounts([])).toEqual([])
  })

  test('alignFromEnd pairs the two lists from their last entries', () => {
    expect(alignFromEnd(['b', 'c'], 3, 2)).toBe('c')
    expect(alignFromEnd(['b', 'c'], 3, 1)).toBe('b')
    expect(alignFromEnd(['b', 'c'], 3, 0)).toBe(undefined)
  })
})

describe('thinkingCounts, malformed input', () => {
  test('string content opens a turn; null blocks and messages are skipped', () => {
    const api = [
      { role: 'user', content: 'Plain prompt' },
      null,
      { role: 'assistant', content: [null, 'x', { type: 'thinking', thinking: 'a' }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: 'ok' }] },
      { role: 'assistant', content: [{ type: 'redacted_thinking', data: 'z' }] },
      { role: 'user', content: '   ' },
    ] as unknown as ApiLike[]
    expect(thinkingCounts(api)).toEqual([{ count: 2, text: 'a' }])
  })
})

describe('workflowState', () => {
  const wf = (text?: string) =>
    buildTurns([
      prompt('review it'),
      {
        role: 'assistant',
        text: '',
        toolUses: [{ tool_use_id: 'w1', tool: 'Workflow', input: { name: 'review' }, ...(text ? { text } : {}) }],
      },
    ])[0]

  test('a pending Workflow in a working turn runs, with the agents seen', () => {
    expect(workflowState(wf(), 3, true)).toEqual({ isRunning: true, agents: 3 })
    expect(workflowState(wf(), 0, true)).toEqual({ isRunning: true, agents: 0 })
  })

  test('a pending Workflow outside a working turn is not running', () => {
    expect(workflowState(wf(), 2, false)).toEqual({ isRunning: false })
  })

  test('a finished Workflow, a turn without one and no turn are not running', () => {
    expect(workflowState(wf('done'), 2, true)).toEqual({ isRunning: false })
    expect(workflowState(buildTurns([prompt('hi')])[0], 0, true)).toEqual({ isRunning: false })
    expect(workflowState(undefined, 0, true)).toEqual({ isRunning: false })
  })
})

describe('taskBoard', () => {
  const use = (id: string, tool: string, input: Record<string, unknown>, text?: string): ToolUseSummary => ({
    tool_use_id: id,
    tool,
    input,
    ...(text === undefined ? {} : { text }),
  })

  test('creates, reassigns and completes tasks, the latest state winning', () => {
    const board = taskBoard(
      buildTurns([
        prompt('Plan'),
        {
          role: 'assistant',
          text: '',
          toolUses: [
            use('c1', 'TaskCreate', { subject: 'Write tests' }, 'Task #1 created successfully: Write tests'),
            use('c2', 'TaskCreate', { subject: 'Ship' }, 'Task #2 created successfully: Ship'),
            use('c3', 'TaskCreate', { subject: 'Drop me' }, 'Task #3 created successfully: Drop me'),
          ],
        },
        prompt('Go'),
        {
          role: 'assistant',
          text: '',
          toolUses: [
            use('u1', 'TaskUpdate', { taskId: '1', status: 'in_progress', owner: 'alice' }, 'Updated task #1'),
            use('u2', 'TaskUpdate', { taskId: '1', owner: 'bob', subject: 'Write more tests' }, 'ok'),
            use('u3', 'TaskUpdate', { taskId: '2', status: 'completed' }, 'ok'),
            use('u4', 'TaskUpdate', { taskId: '3', status: 'deleted' }, 'ok'),
            use('u5', 'TaskUpdate', { taskId: '7', status: 'in_progress' }, 'ok'),
            use('u6', 'TaskUpdate', { status: 'completed' }, 'ok'),
            use('u7', 'TaskCreate', { subject: 'Failed' }, 'boom'),
          ],
        },
      ]),
    )
    expect(board).toEqual([
      { id: '1', subject: 'Write more tests', status: 'in_progress', owner: 'bob' },
      { id: '2', subject: 'Ship', status: 'completed' },
      { id: '7', subject: 'Task #7', status: 'in_progress' },
      { id: '4', subject: 'Failed', status: 'pending' },
    ])
  })

  test('skips failed calls and numbers a task whose result has no id', () => {
    const board = taskBoard(
      buildTurns([
        prompt('Plan'),
        {
          role: 'assistant',
          text: '',
          toolUses: [
            { ...use('c1', 'TaskCreate', { subject: 'Nope' }, 'error'), isError: true },
            use('c2', 'TaskCreate', {}, 'ok'),
            use('c3', 'TaskCreate', { subject: 'Waiting' }),
          ],
        },
      ]),
    )
    expect(board).toEqual([{ id: '1', subject: 'Untitled task', status: 'pending' }])
    expect(taskBoard([])).toEqual([])
  })

  test('marks a task as TodoWrite does', () => {
    expect(taskMark('pending')).toBe('☐')
    expect(taskMark('in_progress')).toBe('◐')
    expect(taskMark('completed')).toBe('☑')
  })
})

describe('taskBoard edge cases', () => {
  const use = (id: string, tool: string, input: Record<string, unknown>, text?: string): ToolUseSummary => ({
    tool_use_id: id,
    tool,
    input,
    ...(text === undefined ? {} : { text }),
  })

  test('a fallback id never overwrites a real one, and a pending create does not shift numbering', () => {
    const board = taskBoard(
      buildTurns([
        prompt('Plan'),
        {
          role: 'assistant',
          text: '',
          toolUses: [
            use('u1', 'TaskUpdate', { taskId: '2', status: 'in_progress' }, 'ok'),
            use('c0', 'TaskCreate', { subject: 'Pending' }),
            use('c1', 'TaskCreate', { subject: 'First' }, 'ok'),
            use('c2', 'TaskCreate', { subject: 'Second' }, 'ok'),
          ],
        },
      ]),
    )
    expect(board.map(t => [t.id, t.subject])).toEqual([
      ['2', 'Task #2'],
      ['1', 'First'],
      ['3', 'Second'],
    ])
  })

  test('accepts a numeric taskId', () => {
    const board = taskBoard(
      buildTurns([
        prompt('Plan'),
        {
          role: 'assistant',
          text: '',
          toolUses: [
            use('c1', 'TaskCreate', { subject: 'A' }, 'Task #5 created'),
            use('u1', 'TaskUpdate', { taskId: 5, status: 'completed' }, 'ok'),
          ],
        },
      ]),
    )
    expect(board).toEqual([{ id: '5', subject: 'A', status: 'completed' }])
  })

  test('an empty name falls back to the whole teammate id', () => {
    expect(teamMembers([{ id: 'a', description: 'd', type: 'x', status: 'idle', teammateId: '@crew' }])[0]?.name).toBe(
      '@crew',
    )
  })
})

describe('teamMembers', () => {
  test('lists teammates only, by the name before @', () => {
    expect(
      teamMembers([
        { id: 'a', description: 'd', type: 'teammate', status: 'idle', teammateId: 'alice@crew' },
        { id: 'b', description: 'd', type: 'Explore', status: 'running' },
        { id: 'c', description: 'd', type: 'reviewer', status: 'running', teammateId: 'bo\u001b[31mb@crew' },
      ]),
    ).toEqual([
      { name: 'alice', type: 'teammate', status: 'idle' },
      { name: 'bob', type: 'reviewer', status: 'running' },
    ])
  })
})
