import type { SessionMessage } from 'claude-code'
import { describe, expect, test } from 'claude-code/testing'

import type { ToolTiming } from '../types'
import {
  MAX_TIMINGS,
  isTextOnly,
  memo,
  nextSelectedTurn,
  recordToolEnd,
  recordToolStart,
  remember,
  statFor,
  statOfDuration,
  turnOfStat,
  mergeStats,
  turnScrollKey,
  noteNotified,
  noteWorkflowAgent,
  takeTurnIndex,
  toggleId,
  turnIndexAtStart,
  turnStatFrom,
  enqueueTurn,
  dropPending,
  discardStale,
} from '../hooks/session'
import { promptDigest } from '../hooks/model/sanitize'
import { buildTurns } from '../hooks/model/turns'

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
    expect(turnStatFrom({ durationMs: 65_000, usage }, promptDigest('Fix the bug'), 42)).toEqual({
      key: promptDigest('Fix the bug'),
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

describe('statOfDuration and turnOfStat', () => {
  const two = buildTurns([prompt('One'), prompt('Two')])
  // A continuation: a turn with no prompt of its own.
  const turns = [...two, { ...two[1]!, index: 2, prompt: '' }]
  const stats = [
    { key: promptDigest('One'), turnIndex: 0, durationMs: 3_000, endedAt: 1 },
    { key: promptDigest('Two'), durationMs: 5_000, endedAt: 2 },
    { key: promptDigest('Two'), turnIndex: 1, durationMs: 3_000, endedAt: 3 },
  ]

  test('the newest stat with the exact duration and a turn index', () => {
    expect(statOfDuration(stats, 3_000)?.endedAt).toBe(3)
    expect(statOfDuration(stats, 5_000)).toBeUndefined()
    expect(statOfDuration([], 3_000)).toBeUndefined()
  })

  test('the turn at the stat index while it keeps the prompt; a continuation has none', () => {
    expect(turnOfStat(stats[0]!, turns)?.prompt).toBe('One')
    expect(turnOfStat({ ...stats[0]!, turnIndex: 1 }, turns)).toBeUndefined()
    expect(turnOfStat({ ...stats[0]!, turnIndex: 2 }, turns)?.index).toBe(2)
    expect(turnOfStat({ ...stats[0]!, turnIndex: 9 }, turns)).toBeUndefined()
  })

  test("a window's cut first turn (no prompt, index 0) claims no stat by index", () => {
    const cut = buildTurns([prompt('other'), prompt('fix')]).map(t => ({ ...t, index: t.index + 1 }))
    const shifted = [{ ...cut[0]!, index: 0, prompt: '' }, ...cut]
    const fix = { key: promptDigest('fix'), turnIndex: 0, durationMs: 2_000, endedAt: 1 }
    expect(turnOfStat(fix, shifted)).toBeUndefined()
    expect(statFor([fix], shifted[0], shifted)).toBeUndefined()
    expect(statFor([fix], shifted[2], shifted)).toBe(fix)
    // The continuation at index 2 above still claims its stat.
    expect(statFor([{ ...stats[0]!, turnIndex: 2 }], turns[2], turns)?.endedAt).toBe(1)
  })
})

describe('statFor', () => {
  test('picks the latest stat for the turn prompt', () => {
    const all = buildTurns([prompt('Fix the bug'), prompt('Thanks')])
    const turn = all[1]!
    const stats = [
      { key: promptDigest('Thanks'), durationMs: 1, endedAt: 0 },
      { key: promptDigest('Thanks'), durationMs: 2, endedAt: 0 },
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
      { key: promptDigest('ok'), turnIndex: 0, durationMs: 1_000, endedAt: 0 },
      { key: promptDigest('ok'), turnIndex: 1, durationMs: 9_000, endedAt: 0 },
    ]
    expect(statFor(stats, turns[0], turns)?.durationMs).toBe(1_000)
    expect(statFor(stats, turns[1], turns)?.durationMs).toBe(9_000)
    expect(statFor(stats, turns[2], turns)).toBe(undefined)
  })

  test('a stat without an index still matches by prompt', () => {
    expect(statFor([{ key: promptDigest('Thanks'), durationMs: 5, endedAt: 0 }], turns[2], turns)?.durationMs).toBe(5)
    expect(statFor([{ key: promptDigest('ok'), turnIndex: 1, durationMs: 5, endedAt: 0 }], turns[0], turns)).toBe(
      undefined,
    )
  })

  test('the running turn does not take the stat of an earlier identical prompt', () => {
    expect(statFor([{ key: promptDigest('ok'), turnIndex: 0, durationMs: 1_000, endedAt: 0 }], turns[1], turns)).toBe(
      undefined,
    )
  })

  test('an index that now points at another prompt falls back to the prompt (a shifted window)', () => {
    const shifted = buildTurns([prompt('Beta'), prompt('Gamma')])
    const stats = [
      { key: promptDigest('Alpha'), turnIndex: 0, durationMs: 1_000, endedAt: 0 },
      { key: promptDigest('Beta'), turnIndex: 1, durationMs: 9_000, endedAt: 0 },
    ]
    expect(statFor(stats, shifted[0], shifted)?.durationMs).toBe(9_000)
    expect(statFor(stats, shifted[1], shifted)).toBe(undefined)
  })

  test('the starting turn is the last one when the transcript holds it, else the next', () => {
    expect(turnIndexAtStart([], 'ok')).toBe(0)
    expect(turnIndexAtStart(turns, promptDigest('Thanks'))).toBe(2)
    expect(turnIndexAtStart(turns, promptDigest('Something new'))).toBe(3)
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

describe('noteNotified', () => {
  test('adds an id once and keeps the last 500', () => {
    expect(noteNotified(['a'], 'a')).toEqual(['a'])
    expect(noteNotified(['a'], 'b')).toEqual(['a', 'b'])
    let ids: readonly string[] = []
    for (let i = 0; i < 600; i++) ids = noteNotified(ids, `id-${i}`)
    expect(ids).toHaveLength(500)
    expect(ids[0]).toBe('id-100')
    expect(ids.at(-1)).toBe('id-599')
  })
})

describe('turnScrollKey', () => {
  const turn = (index: number, prompt: string, senders?: string[]) => ({
    index,
    prompt,
    items: [],
    toolCount: 0,
    outputCount: 0,
    subagentCount: 0,
    ...(senders === undefined ? {} : { senders }),
  })

  test('a hand-back keeps its scroll key when its shown name changes', () => {
    expect(turnScrollKey(turn(1, 'Message from Explore · Scan', ['a1']))).toBe(
      turnScrollKey(turn(1, 'Message from agent', ['a1'])),
    )
    expect(turnScrollKey(turn(1, 'Fix it'))).not.toBe(turnScrollKey(turn(1, 'Fix that')))
    expect(turnScrollKey(turn(1, 'Fix it'))).not.toBe(turnScrollKey(turn(2, 'Fix it')))
    expect(turnScrollKey(undefined)).toBe('')
  })
})

describe('digest-keyed stats', () => {
  const turn = (index: number, prompt: string) => ({
    index,
    prompt,
    items: [],
    toolCount: 0,
    outputCount: 0,
    subagentCount: 0,
  })
  const stat = (prompt: string, endedAt: number, turnIndex?: number) => ({
    key: promptDigest(prompt),
    durationMs: endedAt,
    endedAt,
    ...(turnIndex === undefined ? {} : { turnIndex }),
  })

  test('a stat matches its turn by digest, also after the index shifted', () => {
    const turns = [turn(0, 'Older'), turn(1, 'Fix it')]
    const shifted = stat('Fix it', 5, 0)
    expect(statFor([shifted], turns[1], turns)).toBe(shifted)
    expect(statFor([shifted], turns[0], turns)).toBe(undefined)
  })

  test('two turns with the same prompt keep their own stats', () => {
    const turns = [turn(0, 'Go'), turn(1, 'Go')]
    const first = stat('Go', 1, 0)
    const second = stat('Go', 2, 1)
    expect(statFor([first, second], turns[0], turns)).toBe(first)
    expect(statFor([first, second], turns[1], turns)).toBe(second)
  })

  test('mergeStats unions by endedAt, keeps order and the newest 200', () => {
    const [s1, s2, s3] = [stat('a', 1), stat('b', 2), stat('c', 3)]
    expect(mergeStats([s1!, s2!], [s2!, s3!])).toEqual([s1, s2, s3])
    const many = Array.from({ length: 250 }, (_, i) => stat(`p${i}`, i + 1))
    const merged = mergeStats(many.slice(0, 150), many.slice(100))
    expect(merged).toHaveLength(200)
    expect(merged.at(-1)!.endedAt).toBe(250)
    expect(merged[0]!.endedAt).toBe(51)
  })

  test('turnStatFrom keeps a key and no prompt', () => {
    const made = turnStatFrom({ durationMs: 3 }, promptDigest('Fix it'), 9, 1)
    expect(made).toEqual({ key: promptDigest('Fix it'), turnIndex: 1, durationMs: 3, endedAt: 9 })
    expect(made).not.toHaveProperty('prompt')
  })
})
