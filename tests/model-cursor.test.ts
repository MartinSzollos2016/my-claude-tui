import { describe, expect, test } from 'claude-code/testing'
import { ICON_SETS } from '../hooks/icons'
import { cursorRows, moveCursor, rowText } from '../hooks/model/cursor'
import type { ToolItem } from '../hooks/model/types'

describe('moveCursor', () => {
  const ids = ['a', 'b', 'c']

  test('steps one row and clips at the first and the last', () => {
    expect(moveCursor(ids, 'a', 1)).toBe('b')
    expect(moveCursor(ids, 'c', -1)).toBe('b')
    expect(moveCursor(ids, 'c', 1)).toBe('c')
    expect(moveCursor(ids, 'a', -1)).toBe('a')
  })

  test('no cursor yet enters at the first row going down and the last going up', () => {
    expect(moveCursor(ids, null, 1)).toBe('a')
    expect(moveCursor(ids, null, -1)).toBe('c')
    expect(moveCursor(ids, 'gone', 1)).toBe('a')
  })

  test('an empty list has no cursor', () => {
    expect(moveCursor([], null, 1)).toBeNull()
    expect(moveCursor([], 'a', -1)).toBeNull()
  })
})

describe('cursorRows', () => {
  const t = (id: string, name = 'Bash', agentId?: string): ToolItem => ({
    kind: 'tool',
    id,
    tool: name,
    input: {},
    summary: '',
    isError: false,
    isPending: false,
    ...(agentId === undefined ? {} : { agentId }),
  })
  const kid = t('ag/k1')
  const childrenOf = (agentId: string) => (agentId === 'ag' ? [kid] : undefined)

  test('a subagent trace counts only while the subagent is open', () => {
    const items = [t('x1'), t('a1', 'Agent', 'ag'), t('x2')]
    expect(cursorRows(items, new Set(), childrenOf)).toEqual(['x1', 'a1', 'x2'])
    expect(cursorRows(items, new Set(['a1']), childrenOf)).toEqual(['x1', 'a1', 'ag/k1', 'x2'])
    expect(cursorRows(items, new Set(['a1']), () => undefined)).toEqual(['x1', 'a1', 'x2'])
  })

  test('a folded run is one row, and its calls count only while it is open', () => {
    const items = [t('r1', 'Read'), t('r2', 'Read'), t('r3', 'Read')]
    expect(cursorRows(items, new Set(), childrenOf)).toEqual(['group:r1'])
    expect(cursorRows(items, new Set(['group:r1']), childrenOf)).toEqual(['group:r1', 'r1', 'r2', 'r3'])
  })
})

describe('rowText', () => {
  const bash: ToolItem = {
    kind: 'tool',
    id: 'b1',
    tool: 'Bash',
    input: { command: 'go test ./...' },
    summary: '',
    isError: false,
    isPending: false,
    resultText: 'ok',
  }
  const none = () => undefined

  test('is the whole text of the sections of the row, found at any depth', () => {
    const text = rowText([bash], 'b1', none, ICON_SETS.nerd)!
    expect(text).toContain('go test ./...')
    expect(text).toContain('ok')
    const agent: ToolItem = { ...bash, id: 'a1', tool: 'Agent', agentId: 'ag', input: { description: 'd' } }
    expect(rowText([agent], 'b1', id => (id === 'ag' ? [bash] : undefined), ICON_SETS.nerd)).toContain('go test')
  })

  test('a group joins its calls, an output row is its message, an unknown id has no text', () => {
    const second = { ...bash, id: 'b2', input: { command: 'go vet' } }
    const group = rowText([bash, second], 'group:b1', none, ICON_SETS.nerd)
    expect(group).toBeUndefined()
    const reads = ['1', '2', '3'].map(n => ({ ...bash, id: `r${n}`, tool: 'Read', input: { file_path: `/f${n}` } }))
    expect(rowText(reads, 'group:r1', none, ICON_SETS.nerd)).toMatch(/f1[\s\S]*f2[\s\S]*f3/)
    const out = { kind: 'output' as const, id: 'o1', text: 'All done' }
    expect(rowText([out], 'o1', none, ICON_SETS.nerd)).toBe('All done')
    expect(rowText([out], 'nope', none, ICON_SETS.nerd)).toBeUndefined()
  })
})
