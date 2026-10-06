import { describe, expect, test } from 'claude-code/testing'
import { thinkingByStart, type ApiLike } from '../hooks/model/thinking'

describe('thinkingByStart, malformed input', () => {
  test('string content opens a turn; null blocks and messages are skipped', () => {
    const api = [
      { role: 'user', content: 'Plain prompt' },
      null,
      { role: 'assistant', content: [null, 'x', { type: 'thinking', thinking: 'a' }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: 'ok' }] },
      {
        role: 'assistant',
        content: [
          { type: 'redacted_thinking', data: 'z' },
          { type: 'text', text: 'reply' },
        ],
      },
      { role: 'user', content: '   ' },
    ] as unknown as ApiLike[]
    expect(thinkingByStart(api).get('tx:reply')).toEqual({ count: 2, text: 'a' })
    expect(thinkingByStart([])).toEqual(new Map())
  })
})

describe('thinkingByStart', () => {
  test('thinking belongs to the start its assistant messages follow, a hand-back included', () => {
    const map = thinkingByStart([
      { role: 'user', content: [{ type: 'text', text: 'go' }] },
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'plan' },
          { type: 'text', text: 'spawned' },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Another Claude session sent a message: <agent-message from="a">x</agent-message>' },
        ],
      },
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'read it' },
          { type: 'redacted_thinking' },
          { type: 'text', text: 'Both failed' },
        ],
      },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'x', content: 'ok' }] },
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'more' },
          { type: 'text', text: 'end' },
        ],
      },
    ])
    expect(map.get('tx:spawned')).toEqual({ count: 1, text: 'plan' })
    expect(map.get('tx:Both failed')).toEqual({ count: 3, text: 'read it\n\nmore' })
  })

  test('a thinking-only message before the reply counts toward the start the reply opens', () => {
    const map = thinkingByStart([
      { role: 'user', content: [{ type: 'text', text: 'go' }] },
      { role: 'assistant', content: [{ type: 'thinking', thinking: 'first' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'answer' }] },
    ])
    expect(map.get('tx:answer')).toEqual({ count: 1, text: 'first' })
  })
})
