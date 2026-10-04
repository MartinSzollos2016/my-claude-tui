import type { SessionMessage } from 'claude-code'
import { describe, expect, test } from 'claude-code/testing'

import type { ToolTiming } from '../types'
import { buildTurns } from '../hooks/model'
import {
  MAX_TIMINGS,
  memo,
  nextSelectedTurn,
  recordToolEnd,
  recordToolStart,
  remember,
  statFor,
  toggleId,
  turnStatFrom,
} from '../hooks/session'

const prompt = (text: string): SessionMessage => ({ role: 'user', text, toolUses: [] })

describe('tool timings', () => {
  test('records the start and the end of a call', () => {
    const started = recordToolStart({}, 'a', 100)
    expect(started).toEqual({ a: { start: 100 } })
    expect(recordToolEnd(started, 'a', 350)).toEqual({ a: { start: 100, end: 350 } })
  })

  test('an end whose start was dropped falls back to the given start, else to the end', () => {
    expect(recordToolEnd({}, 'b', 500, 200)).toEqual({ b: { start: 200, end: 500 } })
    expect(recordToolEnd({}, 'c', 500)).toEqual({ c: { start: 500, end: 500 } })
  })

  test('drops the older half once MAX_TIMINGS calls are kept', () => {
    let all: Record<string, ToolTiming> = {}
    for (let i = 0; i < MAX_TIMINGS; i++) all = recordToolStart(all, `t${i}`, i)
    const next = recordToolStart(all, 'new', 1)
    expect(Object.keys(next).length).toBe(MAX_TIMINGS / 2 + 1)
    expect(next['t0']).toBeUndefined()
    expect(next[`t${MAX_TIMINGS - 1}`]).toEqual({ start: MAX_TIMINGS - 1 })
    expect(next['new']).toEqual({ start: 1 })
  })
})

describe('turnStatFrom', () => {
  test('sums every input token kind and keeps the model', () => {
    const usage = {
      model: 'claude-opus-5-5',
      input_tokens: 600,
      cache_read_input_tokens: 300,
      cache_creation_input_tokens: 100,
      output_tokens: 500,
    }
    expect(turnStatFrom({ durationMs: 65_000, usage }, 'Fix the bug', 42)).toEqual({
      prompt: 'Fix the bug',
      durationMs: 65_000,
      endedAt: 42,
      model: 'claude-opus-5-5',
      inputTokens: 1_000,
      outputTokens: 500,
    })
  })

  test('leaves the token fields empty without usage', () => {
    const stat = turnStatFrom({ durationMs: 10 }, 'hi', 1)
    expect(stat.inputTokens).toBeUndefined()
    expect(stat.outputTokens).toBeUndefined()
    expect(stat.model).toBeUndefined()
  })
})

describe('nextSelectedTurn', () => {
  test('steps back and forth, clamps at the first turn and follows the latest', () => {
    expect(nextSelectedTurn(null, 2, -1)).toBe(1)
    expect(nextSelectedTurn(1, 2, -1)).toBe(0)
    expect(nextSelectedTurn(0, 2, -1)).toBe(0)
    expect(nextSelectedTurn(0, 2, 1)).toBe(1)
    expect(nextSelectedTurn(1, 2, 1)).toBe(null)
    expect(nextSelectedTurn(0, 2, null)).toBe(null)
    expect(nextSelectedTurn(5, 2, -1)).toBe(1)
  })
})

describe('toggleId', () => {
  test('removes an id that is there, appends one that is not, keeping the newest max', () => {
    expect(toggleId(['a'], 'a', 3)).toEqual([])
    expect(toggleId(['a', 'b', 'c'], 'd', 3)).toEqual(['b', 'c', 'd'])
  })
})

describe('statFor', () => {
  test('picks the latest stat for the turn prompt', () => {
    const turn = buildTurns([prompt('Fix the bug'), prompt('Thanks')])[1]!
    const stats = [
      { prompt: 'Thanks', durationMs: 1, endedAt: 0 },
      { prompt: 'Thanks', durationMs: 2, endedAt: 0 },
    ]
    expect(statFor(stats, turn)?.durationMs).toBe(2)
    expect(statFor(stats, undefined)).toBe(undefined)
    expect(statFor([], turn)).toBe(undefined)
  })
})

describe('memo', () => {
  test('builds once per key', () => {
    let builds = 0
    const build = () => ++builds
    const first = memo(undefined, 'a', build)
    expect(memo(first, 'a', build)).toBe(first)
    expect(memo(first, 'b', build).value).toBe(2)
    expect(builds).toBe(2)
  })
})

describe('remember', () => {
  test('keeps the newest max entries and refreshes a key it sets again', () => {
    const map = new Map<string, number>()
    remember(map, 'a', 1, 2)
    remember(map, 'b', 2, 2)
    remember(map, 'a', 3, 2)
    remember(map, 'c', 4, 2)
    expect([...map.entries()]).toEqual([
      ['a', 3],
      ['c', 4],
    ])
  })
})
