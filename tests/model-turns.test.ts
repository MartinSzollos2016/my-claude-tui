import { describe, expect, test } from 'claude-code/testing'
import type { SessionMessage } from 'claude-code'
import {
  buildTurns,
  incrementalTurns,
  isAgentFinished,
  isAgentRunning,
  itemStatus,
  textPrint,
  traceItems,
  turnsKey,
} from '../hooks/model/turns'
import type { ToolItem } from '../hooks/model/types'
import { main, prompt, read, transcript } from './fixtures/model'

describe('buildTurns', () => {
  test('groups assistant rows under the prompt that opened them', () => {
    const turns = buildTurns(transcript)
    expect(turns.length).toBe(2)
    expect(turns[0]!.prompt).toBe('Fix the bug')
    expect(turns[0]!.items.map(i => i.id)).toEqual(['t0:o0', 'r1', 'a1', 't0:o1', 'b1'])
    expect(turns[0]!.toolCount).toBe(3)
    expect(turns[0]!.outputCount).toBe(2)
    expect(turns[0]!.subagentCount).toBe(1)
    expect(turns[1]!.items.length).toBe(1)
  })

  test('marks unanswered tool calls pending', () => {
    const bash = buildTurns(transcript)[0]!.items.at(-1)!
    expect(bash.kind === 'tool' && bash.isPending).toBe(true)
  })

  test('opens an anonymous turn when the transcript starts mid-turn', () => {
    const turns = buildTurns([{ role: 'assistant', text: 'hi', toolUses: [] }])
    expect(turns.length).toBe(1)
    expect(turns[0]!.prompt).toBe('')
  })

  test('prefixes trace ids with the agent id', () => {
    const items = traceItems(transcript, 'agent-1/')
    expect(items[1]!.id).toBe('agent-1/r1')
  })
})

describe('itemStatus from the structured interrupt flag', () => {
  const built = (use: Record<string, unknown>) =>
    buildTurns([
      { role: 'user', text: 'go', toolUses: [] },
      { role: 'assistant', text: '', toolUses: [{ tool_use_id: 'k', tool: 'Bash', input: {}, ...use }] },
    ])[0]!.items[0] as ToolItem
  const quiet = { isLatest: true, isWorking: false }

  test('a Bash result with interrupted: true is interrupted, even when it was not an error', () => {
    expect(itemStatus(built({ text: 'partial', result: { stdout: 'x', interrupted: true } }), quiet)).toBe(
      'interrupted',
    )
    expect(itemStatus(built({ text: 'ok', result: { stdout: 'x', interrupted: false } }), quiet)).toBe('done')
  })

  test('the stored text only counts at its start, so output that mentions it stays an error', () => {
    const quote = built({ text: 'script said: interrupted by user, retrying', isError: true })
    expect(itemStatus(quote, quiet)).toBe('error')
    const stored = built({ text: '[Request interrupted by user for tool use]', isError: true })
    expect(itemStatus(stored, quiet)).toBe('interrupted')
  })
})

describe('itemStatus', () => {
  const tool = (over: Partial<ToolItem>): ToolItem => ({
    kind: 'tool',
    id: 'x',
    tool: 'Bash',
    input: {},
    summary: '',
    isError: false,
    isPending: false,
    ...over,
  })
  const live = { isLatest: true, isWorking: true }
  const quiet = { isLatest: true, isWorking: false }

  test('a finished call is done, a failed one error', () => {
    expect(itemStatus(tool({ resultText: 'ok' }), quiet)).toBe('done')
    expect(itemStatus(tool({ isError: true, resultText: 'boom' }), quiet)).toBe('error')
  })

  test('a pending call runs only on the latest turn while the session works (P6)', () => {
    const pending = tool({ isPending: true })
    expect(itemStatus(pending, live)).toBe('running')
    expect(itemStatus(pending, quiet)).toBe('idle')
    expect(itemStatus(pending, { isLatest: false, isWorking: true })).toBe('idle')
  })

  test('a running subagent runs whatever the turn', () => {
    expect(itemStatus(tool({ isPending: false }), { isLatest: false, isWorking: false, isAgentRunning: true })).toBe(
      'running',
    )
  })

  test('a call ended by the user is interrupted, not an error', () => {
    const stopped = tool({ isError: true, resultText: '[Request interrupted by user for tool use]' })
    expect(itemStatus(stopped, quiet)).toBe('interrupted')
  })
})

const goTranscript: SessionMessage[] = [prompt('Go'), { role: 'assistant', text: 'Hi', toolUses: [read] }]

describe('turnsKey', () => {
  test('stays the same while nothing happened', () => {
    expect(turnsKey([...goTranscript])).toBe(turnsKey(goTranscript))
    expect(turnsKey([])).toBe('0')
  })

  test('changes on a new message, a tool answer and grown text', () => {
    const key = turnsKey(goTranscript)
    expect(turnsKey([...goTranscript, prompt('More')])).not.toBe(key)
    expect(
      turnsKey([goTranscript[0]!, { role: 'assistant', text: 'Hi', toolUses: [{ ...read, text: 'x' }] }]),
    ).not.toBe(key)
    expect(turnsKey([goTranscript[0]!, { role: 'assistant', text: 'Hi there', toolUses: [read] }])).not.toBe(key)
    const answered: SessionMessage = {
      role: 'user',
      text: '',
      toolUses: [],
      toolResults: [{ tool_use_id: 'u1', text: 'ok', isError: false }],
    }
    expect(turnsKey([...goTranscript, answered])).not.toBe(key)
  })

  test('changes when a capped goTranscript fills a result in place', () => {
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

describe('incrementalTurns', () => {
  // Undefined fields count: the result must match a fresh build field for field.
  const exact = (value: unknown) => JSON.stringify(value, (_, v: unknown) => (v === undefined ? '<undefined>' : v))
  const same = (built: unknown, messages: readonly SessionMessage[], idPrefix?: string) => {
    expect(built).toEqual(buildTurns(messages, idPrefix))
    expect(exact(built)).toBe(exact(buildTurns(messages, idPrefix)))
  }
  // New row objects and strings, as the engine may hand out on each read.
  const copy = (rows: readonly SessionMessage[]): SessionMessage[] =>
    rows.map(r => ({
      ...r,
      text: ` ${r.text}`.slice(1),
      toolUses: r.toolUses.map(u => ({ ...u, input: JSON.parse(JSON.stringify(u.input)) as Record<string, unknown> })),
    }))
  const long = (seed: string) => `${seed} \u001b[31m${'x'.repeat(5000)}‮${seed}`

  test('matches a fresh build while the transcript grows row by row', () => {
    const turns = incrementalTurns()
    const rows: SessionMessage[] = []
    for (const m of [...transcript, ...main, prompt('<command-name>/tail</command-name>'), prompt(long('p'))]) {
      rows.push(m)
      same(turns.build(copy(rows)), rows)
    }
  })

  test('matches a fresh build when the last message is edited or a tool answered', () => {
    const turns = incrementalTurns()
    const rows: SessionMessage[] = [prompt('go'), { role: 'assistant', text: 'Wor', toolUses: [] }]
    same(turns.build(copy(rows)), rows)
    rows[1] = { role: 'assistant', text: 'Working \u001b]52;c;x\u0007on it', toolUses: [{ ...read }] }
    same(turns.build(copy(rows)), rows)
    rows[1] = { ...rows[1], toolUses: [{ ...read, text: long('out') }] }
    same(turns.build(copy(rows)), rows)
    rows[1] = { ...rows[1], toolUses: [{ ...read, text: long('out'), isError: true }] }
    same(turns.build(copy(rows)), rows)
    rows[1] = { ...rows[1], toolUses: [{ ...read, text: long('out'), result: { interrupted: true } }] }
    same(turns.build(copy(rows)), rows)
    rows[1] = { ...rows[1], toolUses: [{ ...read, input: { file_path: '/b.go' }, text: 'x', durationMs: 5 }] }
    same(turns.build(copy(rows)), rows)
    rows[1] = { ...rows[1], text: long('a') }
    same(turns.build(copy(rows)), rows)
    rows[1] = { ...rows[1], text: long('b') }
    same(turns.build(copy(rows)), rows)
  })

  test('matches a fresh build when the rolling window drops the first rows', () => {
    const turns = incrementalTurns()
    const rows: SessionMessage[] = [...transcript, ...transcript, ...main]
    same(turns.build(copy(rows)), rows)
    // The window shifts: the transcript starts mid-turn, an anonymous turn
    // opens and every turn index (and output id) moves down.
    for (let n = 1; n < 6; n++) same(turns.build(copy(rows.slice(n))), rows.slice(n))
  })

  test('a long text changed where the fingerprint does not look is still rebuilt', () => {
    // Equal length, equal at every sampled index: only full equality tells them apart.
    const n = 10_000
    const unsampled = Array.from({ length: n }, (_, i) => i).find(i => {
      const probe = 'x'.repeat(i) + 'y' + 'x'.repeat(n - i - 1)
      return textPrint(probe) === textPrint('x'.repeat(n))
    })!
    expect(unsampled).toBeDefined()
    const first = 'x'.repeat(n)
    const second = 'x'.repeat(unsampled) + 'y' + 'x'.repeat(n - unsampled - 1)
    expect(textPrint(second)).toBe(textPrint(first))
    for (const at of ['text', 'prompt', 'result', 'input'] as const) {
      const turns = incrementalTurns()
      const rows = (text: string): SessionMessage[] => [
        prompt(at === 'prompt' ? text : 'go'),
        {
          role: 'assistant',
          text: at === 'text' ? text : '',
          toolUses: [
            { ...read, input: { file_path: at === 'input' ? text : '/a.go' }, text: at === 'result' ? text : 'ok' },
          ],
        },
      ]
      same(turns.build(copy(rows(first))), rows(first))
      same(turns.build(copy(rows(second))), rows(second))
    }
  })

  test('keeps the id prefix it is given', () => {
    const turns = incrementalTurns()
    same(turns.build(copy(transcript), 'agent-1/'), transcript, 'agent-1/')
    same(turns.build(copy(transcript)), transcript)
  })

  test('sanitizes only what changed after a row is appended', () => {
    const turns = incrementalTurns()
    const rows: SessionMessage[] = [...transcript, ...main]
    turns.build(copy(rows))
    const before = { ...turns.work }
    expect(before.messages).toBeGreaterThan(0)
    expect(before.tools).toBeGreaterThan(0)
    turns.build(copy(rows))
    expect(turns.work).toEqual(before)
    rows.push({ role: 'assistant', text: 'One more.', toolUses: [{ ...read, tool_use_id: 'n1' }] })
    turns.build(copy(rows))
    expect(turns.work).toEqual({ messages: before.messages + 1, tools: before.tools + 1 })
  })
})
