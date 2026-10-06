import { describe, expect, test } from 'claude-code/testing'
import { thinkingByStart, thinkingOf, type ApiLike } from '../hooks/model/thinking'
import { apiTurnStarts, buildTurns } from '../hooks/model/turns'

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
    expect(thinkingByStart(api).get('tx:reply')).toEqual([{ count: 2, text: 'a' }])
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
    expect(map.get('tx:spawned')).toEqual([{ count: 1, text: 'plan' }])
    expect(map.get('tx:Both failed')).toEqual([{ count: 3, text: 'read it\n\nmore' }])
  })

  test('a thinking-only message before the reply counts toward the start the reply opens', () => {
    const map = thinkingByStart([
      { role: 'user', content: [{ type: 'text', text: 'go' }] },
      { role: 'assistant', content: [{ type: 'thinking', thinking: 'first' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'answer' }] },
    ])
    expect(map.get('tx:answer')).toEqual([{ count: 1, text: 'first' }])
  })
})

describe('thinking of turns that start alike', () => {
  test('two turns whose replies start the same keep their own thinking, paired from the end', () => {
    const map = thinkingByStart([
      { role: 'user', content: [{ type: 'text', text: 'first' }] },
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'A-think' },
          { type: 'text', text: 'OK' },
        ],
      },
      { role: 'user', content: [{ type: 'text', text: 'second' }] },
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'B-think' },
          { type: 'text', text: 'OK' },
        ],
      },
    ])
    expect(map.get('tx:OK')).toEqual([
      { count: 1, text: 'A-think' },
      { count: 1, text: 'B-think' },
    ])
  })
})

describe('thinkingOf', () => {
  test('each of two turns that start alike shows its own thinking', () => {
    const api: ApiLike[] = [
      { role: 'user', content: [{ type: 'text', text: 'first' }] },
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'A-think' },
          { type: 'text', text: 'OK' },
        ],
      },
      { role: 'user', content: [{ type: 'text', text: 'second' }] },
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'B-think' },
          { type: 'text', text: 'OK' },
        ],
      },
    ]
    const turns = buildTurns(
      [
        { role: 'user', text: 'first', toolUses: [] },
        { role: 'assistant', text: 'OK', toolUses: [] },
        { role: 'user', text: 'second', toolUses: [] },
        { role: 'assistant', text: 'OK', toolUses: [] },
      ],
      '',
      apiTurnStarts(api),
    )
    const map = thinkingByStart(api)
    expect(thinkingOf(turns, turns[0], map)?.text).toBe('A-think')
    expect(thinkingOf(turns, turns[1], map)?.text).toBe('B-think')
  })
})
