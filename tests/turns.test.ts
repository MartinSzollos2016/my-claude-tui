// The turn-level logic added for spec items 1-11: fingerprints, text
// reports, search, thinking, Workflow state and the team board.
import type { SessionMessage, ToolUseSummary } from 'claude-code'
import { describe, expect, test } from 'claude-code/testing'
import { workflowState } from '../hooks/model'
import { buildTurns, isAgentFinished, isAgentRunning, turnsKey } from '../hooks/model/turns'
import { prompt } from './fixtures/model'

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
