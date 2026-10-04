import { describe, expect, test } from 'claude-code/testing'
import { turnListText, turnText } from '../hooks/model/reports'
import { EMPTY_TURN_TEXT } from '../hooks/model/turn-table'
import { buildTurns } from '../hooks/model/turns'
import { main, prompt } from './fixtures/model'

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
