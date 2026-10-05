import { describe, expect, test } from 'claude-code/testing'
import { ICON_SETS } from '../hooks/icons'
import { hoverCard } from '../hooks/model/card'
import { resetSectionCache, sectionCacheSize } from '../hooks/model/sections'
import type { ToolItem } from '../hooks/model/types'

describe('hoverCard', () => {
  const bash = (command: string): ToolItem => ({
    kind: 'tool',
    id: 'b1',
    tool: 'Bash',
    input: { command },
    summary: '',
    isError: false,
    isPending: false,
    resultText: 'RESULT',
  })

  test('is the first lines of the input section, never the output', () => {
    const card = hoverCard(bash(Array.from({ length: 9 }, (_, i) => `line${i}`).join('\n')), 40, ICON_SETS.nerd)!
    expect(card).toHaveLength(6)
    expect(card[0]).toBe('line0')
    expect(card.join('\n')).not.toContain('RESULT')
  })

  test('tabs are expanded to stops of 8 before a line is cut to the width', () => {
    const card = hoverCard(bash('for f in *; do\n\techo "$f"\ndone'), 40, ICON_SETS.nerd)!
    expect(card[1]).toBe(`${' '.repeat(8)}echo "$f"`)
    const cut = hoverCard(bash('\t\t\t\tx'), 20, ICON_SETS.nerd)!
    expect(cut[0]).toBe(`${' '.repeat(19)}…`)
  })

  test('lines are cut to the width, the whole card to 600 characters, untrusted text is cleaned', () => {
    const wide = hoverCard(bash('x'.repeat(200)), 30, ICON_SETS.nerd)!
    expect(wide[0]).toHaveLength(30)
    expect(wide[0]!.endsWith('…')).toBe(true)
    const many = hoverCard(bash(Array.from({ length: 6 }, () => 'y'.repeat(300)).join('\n')), 300, ICON_SETS.nerd)!
    expect(many.join('\n').length).toBeLessThanOrEqual(600)
    expect(hoverCard(bash('a\u001b[31mb'), 40, ICON_SETS.nerd)).toEqual(['ab'])
    expect(hoverCard(bash('é'.repeat(100)), 30, ICON_SETS.ascii)![0]!.endsWith('...')).toBe(true)
  })

  test('a call drawn as JSON shows one key: value line per field, never braces or quotes', () => {
    const send: ToolItem = {
      ...bash(''),
      tool: 'SendMessage',
      input: { to: 'a811', summary: 'Wave 5 fix', message: 'line one\nline two', count: 3 },
    }
    expect(hoverCard(send, 60, ICON_SETS.nerd)).toEqual([
      'to: a811',
      'summary: Wave 5 fix',
      'message: line one line two',
      'count: 3',
    ])
  })

  test('a card is at most CARD_WIDTH cells wide however wide the pane', () => {
    const card = hoverCard(bash('x'.repeat(300)), 200, ICON_SETS.nerd)!
    expect(card[0]!.length).toBeLessThanOrEqual(72)
  })

  test('a call with no input has no card', () => {
    expect(hoverCard({ ...bash('x'), input: {} }, 40, ICON_SETS.nerd)).toBeUndefined()
  })

  const lines = (prefix: string, n: number) => Array.from({ length: n }, (_, i) => `${prefix}${i}`).join('\n')
  const edit = (input: Record<string, unknown>, tool = 'Edit'): ToolItem => ({ ...bash(''), id: 'e1', tool, input })

  test('an Edit card is its first old and new lines, read from the input without building the diff', () => {
    resetSectionCache()
    const card = hoverCard(edit({ file_path: '/a.go', old_string: lines('o', 400), new_string: lines('n', 400) }), 40)
    expect(card).toEqual(['-o0', '-o1', '-o2', '+n0', '+n1', '+n2'])
    expect(sectionCacheSize()).toBe(0)
    const short = hoverCard(edit({ file_path: '/a.go', old_string: 'x', new_string: lines('n', 9) }), 40)
    expect(short).toEqual(['-x', '+n0', '+n1', '+n2', '+n3', '+n4'])
  })

  test('a MultiEdit card takes its edits in order; an Edit with nothing to show has no card', () => {
    const multi = edit(
      {
        file_path: '/a.go',
        edits: [
          { old_string: 'a', new_string: 'b' },
          { old_string: 'c', new_string: 'd' },
          { old_string: 'e', new_string: 'f' },
          { old_string: 'g', new_string: 'h' },
        ],
      },
      'MultiEdit',
    )
    expect(hoverCard(multi, 40)).toEqual(['-a', '+b', '-c', '+d', '-e', '+f'])
    expect(hoverCard(edit({ edits: 'bogus' }, 'MultiEdit'), 40)).toBeUndefined()
    expect(hoverCard(edit({ file_path: '/a.go' }), 40)).toBeUndefined()
  })
})
