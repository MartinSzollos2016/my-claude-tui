import { describe, expect, test } from 'claude-code/testing'
import { itemName, itemSummary, toolSummary } from '../hooks/model/summaries'
import { buildTurns } from '../hooks/model/turns'
import { transcript } from './fixtures/model'

describe('summaries', () => {
  test('per-tool one-liners match agent-ouija', () => {
    expect(toolSummary('Read', { file_path: '/x/y/z.go', offset: 10, limit: 5 })).toBe('y/z.go - lines 10-14')
    expect(toolSummary('Edit', { file_path: '/x/z.go', old_string: 'a', new_string: 'b\nc' })).toBe(
      'x/z.go - 1 -> 2 lines',
    )
    expect(toolSummary('Bash', { command: 'ls', description: 'List' })).toBe('List: ls')
    expect(toolSummary('Grep', { pattern: 'foo', path: '/src/pkg' })).toBe('"foo" in pkg')
    expect(toolSummary('WebFetch', { url: 'https://example.com/docs?q=1' })).toBe('example.com/docs')
    expect(toolSummary('TodoWrite', { todos: [1] })).toBe('1 item')
    expect(toolSummary('mcp__x__y', { query: 'abc' })).toBe('abc')
  })

  test('subagent rows show the type and description', () => {
    const agent = buildTurns(transcript)[0]!.items[2]!
    expect(itemName(agent)).toBe('Explore')
    expect(itemSummary(agent)).toBe('Find callers')
  })
})
