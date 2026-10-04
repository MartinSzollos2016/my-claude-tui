import { describe, expect, test } from 'claude-code/testing'
import { alignFromEnd, thinkingCounts, type ApiLike } from '../hooks/model/thinking'

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
