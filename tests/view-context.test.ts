import { describe, expect, test } from 'claude-code/testing'
import type { ToolItem } from '../hooks/model/types'
import { groupDuration, rowInset, textLine, wrapWidth } from '../hooks/view/context'

const pane = (columns: number) => ({ columns }) as unknown as Parameters<typeof wrapWidth>[0]
const tool = (id: string, durationMs?: number): ToolItem => ({
  kind: 'tool',
  id,
  tool: 'Read',
  input: {},
  summary: '',
  isError: false,
  isPending: false,
  ...(durationMs === undefined ? {} : { durationMs }),
})

describe('rows of text', () => {
  test('a text wraps at the pane width less its inset, at least one cell', () => {
    expect(wrapWidth(pane(80), 4)).toBe(76)
    expect(wrapWidth(pane(3), 10)).toBe(1)
  })

  test('a text row carries its text and width; a cut one is a single row', () => {
    expect(textLine(pane(80), 'abc', 2)).toEqual({ kind: 'line', text: 'abc', width: 78 })
    expect(textLine(pane(80), 'abc', 2, true)).toEqual({ kind: 'line' })
  })

  test('a trace row is moved in, a row of the turn is not', () => {
    expect(rowInset(undefined)).toBe(0)
    expect(rowInset({ path: [], isLast: true })).toBe(4)
  })
})

describe('groupDuration', () => {
  const timed = { agentStats: {}, timings: {}, now: 0 }

  test('sums the measured calls of a group', () => {
    expect(
      groupDuration({ kind: 'group', id: 'g', tool: 'Read', items: [tool('a', 100), tool('b', 200)] }, timed),
    ).toBe(300)
  })

  test('has no time when no call is measured', () => {
    expect(groupDuration({ kind: 'group', id: 'g', tool: 'Read', items: [tool('a')] }, timed)).toBeUndefined()
  })
})
