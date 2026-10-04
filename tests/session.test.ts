import type { SessionMessage } from 'claude-code'
import { describe, expect, test } from 'claude-code/testing'

import type { ToolTiming } from '../types'
import { buildTurns } from '../hooks/model'
import {
  MAX_TIMINGS,
  isTextOnly,
  memo,
  nextSelectedTurn,
  recordToolEnd,
  recordToolStart,
  remember,
  statFor,
  noteWorkflowAgent,
  takeTurnIndex,
  toggleId,
  turnIndexAtStart,
  turnStatFrom,
  enqueueTurn,
  dropPending,
  discardStale,
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
    const all = buildTurns([prompt('Fix the bug'), prompt('Thanks')])
    const turn = all[1]!
    const stats = [
      { prompt: 'Thanks', durationMs: 1, endedAt: 0 },
      { prompt: 'Thanks', durationMs: 2, endedAt: 0 },
    ]
    expect(statFor(stats, turn, all)?.durationMs).toBe(2)
    expect(statFor(stats, undefined, all)).toBe(undefined)
    expect(statFor([], turn, all)).toBe(undefined)
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

describe('turn index', () => {
  const turns = buildTurns([prompt('ok'), prompt('ok'), prompt('Thanks')])

  test('two identical prompts keep their own stat', () => {
    const stats = [
      { prompt: 'ok', turnIndex: 0, durationMs: 1_000, endedAt: 0 },
      { prompt: 'ok', turnIndex: 1, durationMs: 9_000, endedAt: 0 },
    ]
    expect(statFor(stats, turns[0], turns)?.durationMs).toBe(1_000)
    expect(statFor(stats, turns[1], turns)?.durationMs).toBe(9_000)
    expect(statFor(stats, turns[2], turns)).toBe(undefined)
  })

  test('a stat without an index still matches by prompt', () => {
    expect(statFor([{ prompt: 'Thanks', durationMs: 5, endedAt: 0 }], turns[2], turns)?.durationMs).toBe(5)
    expect(statFor([{ prompt: 'ok', turnIndex: 1, durationMs: 5, endedAt: 0 }], turns[0], turns)).toBe(undefined)
  })

  test('the running turn does not take the stat of an earlier identical prompt', () => {
    expect(statFor([{ prompt: 'ok', turnIndex: 0, durationMs: 1_000, endedAt: 0 }], turns[1], turns)).toBe(undefined)
  })

  test('an index that now points at another prompt falls back to the prompt (a shifted window)', () => {
    const shifted = buildTurns([prompt('Beta'), prompt('Gamma')])
    const stats = [
      { prompt: 'Alpha', turnIndex: 0, durationMs: 1_000, endedAt: 0 },
      { prompt: 'Beta', turnIndex: 1, durationMs: 9_000, endedAt: 0 },
    ]
    expect(statFor(stats, shifted[0], shifted)?.durationMs).toBe(9_000)
    expect(statFor(stats, shifted[1], shifted)).toBe(undefined)
  })

  test('the starting turn is the last one when the transcript holds it, else the next', () => {
    expect(turnIndexAtStart([], 'ok')).toBe(0)
    expect(turnIndexAtStart(turns, 'Thanks')).toBe(2)
    expect(turnIndexAtStart(turns, 'Something new')).toBe(3)
    expect(turnIndexAtStart(turns, '')).toBe(2)
  })

  test('turnStatFrom records the index when it is known', () => {
    expect(turnStatFrom({ durationMs: 1 }, 'ok', 0, 4).turnIndex).toBe(4)
    expect('turnIndex' in turnStatFrom({ durationMs: 1 }, 'ok', 0)).toBe(false)
  })
})

describe('pending turn indexes', () => {
  test('are taken oldest first', () => {
    const queue = enqueueTurn(enqueueTurn([], 4), 5)
    const first = takeTurnIndex(queue, 99)
    expect(first.index).toBe(4)
    expect(takeTurnIndex(first.queue, 99)).toEqual({ index: 5, queue: [] })
  })

  test('an empty queue yields the fallback', () => {
    expect(takeTurnIndex([], 7)).toEqual({ index: 7, queue: [] })
  })

  test('the queue is bounded, the oldest dropped', () => {
    let queue: number[] = []
    for (let i = 0; i < 100; i++) queue = enqueueTurn(queue, i)
    expect(queue.length).toBeLessThan(100)
    expect(queue.at(-1)).toBe(99)
  })
})

describe('pending queue repair', () => {
  test('dropPending removes the last entry equal to the index', () => {
    expect(dropPending([3, 4, 3], 3)).toEqual([3, 4])
    expect(dropPending([3], 9)).toEqual([3])
  })

  test('discardStale keeps only entries after the last completed turn', () => {
    expect(discardStale([2, 3, 5], 3)).toEqual([5])
    expect(discardStale([0], -1)).toEqual([0])
  })
})

describe('isTextOnly', () => {
  test('VS Code alone or nothing drawing answers in text', () => {
    expect(isTextOnly([])).toBe(true)
    expect(isTextOnly(['vscode'])).toBe(true)
    expect(isTextOnly(['vscode', 'terminal'])).toBe(false)
    expect(isTextOnly(['terminal'])).toBe(false)
    expect(isTextOnly(['desktop'])).toBe(false)
  })
})

describe('noteWorkflowAgent', () => {
  test('counts each agent the list does not know, once', () => {
    const known = new Set(['sub-1'])
    let seen = noteWorkflowAgent([], 'wf-1', known)
    seen = noteWorkflowAgent(seen, 'wf-1', known)
    seen = noteWorkflowAgent(seen, 'sub-1', known)
    seen = noteWorkflowAgent(seen, undefined, known)
    expect(seen).toEqual(['wf-1'])
  })
})
