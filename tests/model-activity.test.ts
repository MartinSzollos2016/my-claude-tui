import { describe, expect, test } from 'claude-code/testing'
import type { AgentStatus } from 'claude-code'
import { ICON_SETS } from '../hooks/icons'
import {
  callInput,
  compactCall,
  finishedSince,
  finishedWorkflows,
  runningTool,
  spinnerMessage,
  statusText,
  workflowState,
} from '../hooks/model/activity'
import { durationSuffix } from '../hooks/model/transcript'
import { buildTurns } from '../hooks/model/turns'
import type { ToolItem, Turn } from '../hooks/model/types'
import { prompt, tool } from './fixtures/model'

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
