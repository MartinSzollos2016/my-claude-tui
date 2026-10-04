import { describe, expect, test } from 'claude-code/testing'
import { ICON_SETS } from '../hooks/icons'
import { turnTable } from '../hooks/model/turn-table'
import { buildTurns } from '../hooks/model/turns'
import { displayWidth } from '../hooks/model/width'

describe('turnTable', () => {
  const turns = buildTurns([
    { role: 'user', text: 'Fix the bug', toolUses: [] },
    {
      role: 'assistant',
      text: '',
      toolUses: [
        { tool_use_id: 'a', tool: 'Bash', input: {}, text: 'x' },
        { tool_use_id: 'b', tool: 'Read', input: {}, text: 'x' },
      ],
    },
    { role: 'user', text: '日本語'.repeat(30), toolUses: [] },
    { role: 'assistant', text: 'ok', toolUses: [] },
    { role: 'user', text: 'Third', toolUses: [] },
    { role: 'assistant', text: 'ok', toolUses: [] },
  ])
  const stats = [
    { prompt: 'Fix the bug', durationMs: 65_000, endedAt: 0, inputTokens: 1000, outputTokens: 500 },
    { prompt: '', durationMs: 32_500, endedAt: 0, inputTokens: 40, outputTokens: 2 },
    undefined,
  ]
  const table = (width: number, icons = ICON_SETS.nerd) => turnTable(turns, stats, width, icons)
  const row = (t: ReturnType<typeof table>, i: number) => t.rows[i]!

  test('a very narrow pane never overflows', () => {
    for (const width of [40, 30, 20, 10]) {
      const t = table(width)
      for (const r of t.rows) expect(displayWidth(r.label)).toBeLessThanOrEqual(Math.max(0, width - 4))
    }
  })

  test('a wide pane shows number, prompt, tools, time, tokens and the bar', () => {
    const t = table(100)
    expect(t.header).toMatch(/^#\s+prompt\s+tools\s+time\s+tokens$/)
    expect(row(t, 0).cells).toMatchObject({ number: '#1', tools: '2', time: '1m 5s', tokens: '1.5k' })
    expect(row(t, 0).cells.bar).toBe('████████')
    expect(row(t, 1).cells.bar).toBe('████')
    expect(row(t, 2).cells).toMatchObject({ tools: '', time: '', tokens: '', bar: '' })
  })

  test('every row label is exactly as wide as the table, wide characters included', () => {
    for (const width of [100, 70, 69, 55, 54, 40]) {
      const t = table(width)
      const widths = new Set(t.rows.map(r => displayWidth(r.label)))
      expect(widths.size).toBe(1)
      expect(displayWidth(t.header)).toBeLessThanOrEqual([...widths][0]!)
      expect([...widths][0]).toBeLessThanOrEqual(width - 4)
    }
  })

  test('under 70 columns tokens and the bar are left out, under 55 tools too', () => {
    const mid = table(69)
    expect(mid.header).not.toContain('tokens')
    expect(mid.header).toContain('tools')
    expect(row(mid, 0).cells.bar).toBe('')
    expect(row(mid, 0).cells.tokens).toBe('')
    const narrow = table(54)
    expect(narrow.header).not.toContain('tools')
    expect(narrow.header).toContain('time')
    expect(row(narrow, 0).cells.tools).toBe('')
    expect(table(70).header).toContain('tokens')
    expect(table(55).header).toContain('tools')
  })

  test('the prompt is cut by cells with the set ellipsis and keeps its room', () => {
    const t = table(100)
    expect(row(t, 1).cells.prompt.endsWith('…')).toBe(true)
    expect(displayWidth(row(t, 1).cells.prompt)).toBeLessThanOrEqual(56)
    expect(displayWidth(row(t, 1).cells.prompt)).toBeGreaterThanOrEqual(55)
    const a = table(100, ICON_SETS.ascii)
    expect(row(a, 1).cells.prompt.endsWith('...')).toBe(true)
    expect(a.rows[0]!.label).toMatch(/^[\x20-\x7e]*$/)
    expect(a.header).toMatch(/^[\x20-\x7e]*$/)
  })

  test('a turn without a prompt reads (no prompt) and no turns give no rows', () => {
    const none = turnTable(buildTurns([{ role: 'assistant', text: 'hi', toolUses: [] }]), [], 100, ICON_SETS.nerd)
    expect(none.rows[0]!.cells.prompt).toContain('(no prompt)')
    expect(turnTable([], [], 100, ICON_SETS.nerd).rows).toEqual([])
  })
})
