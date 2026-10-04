// The turn-level logic added for spec items 1-11: fingerprints, text
// reports, search, thinking, Workflow state and the team board.
import type { SessionMessage, ToolUseSummary } from 'claude-code'
import { describe, expect, test } from 'claude-code/testing'

import { isAgentFinished, isAgentRunning, turnsKey } from '../hooks/model'

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
