// The turn stats store's keys and values (hooks/stats-store.ts); the store
// calls themselves are tested through the hooks in register.vitest.ts.
import { describe, expect, test } from 'vitest'

import { promptDigest } from '../hooks/model/sanitize'
import { pruneSessions } from '../hooks/session'
import { isOnValue, isStatsKey, newestEnd, statsKeyOf, statsOf, storedValue } from '../hooks/stats-store'
import type { TurnStat } from '../types'

const DAY = 86_400_000
const stat = (prompt: string, endedAt: number): TurnStat => ({ key: promptDigest(prompt), durationMs: 1_000, endedAt })

describe('stats store', () => {
  test('a stored value round-trips through JSON and holds no prompt text', () => {
    const stats = [stat('Fix the login bug', 1), stat('Ship it', 2)]
    const json = JSON.stringify(storedValue(stats))
    expect(json).not.toContain('login')
    expect(statsOf(JSON.parse(json))).toEqual(stats)
  })

  test('statsOf returns [] for a missing or malformed value and drops malformed stats', () => {
    expect(statsOf(undefined)).toEqual([])
    expect(statsOf(null)).toEqual([])
    expect(statsOf({ v: 1, stats: 'nope' })).toEqual([])
    expect(statsOf({ v: 1, stats: [{ key: 'k', endedAt: 'x' }, null, stat('ok', 3)] })).toEqual([stat('ok', 3)])
  })

  test('keys: one per session under tail-view.stats., the switch itself is none', () => {
    expect(statsKeyOf('s1')).toBe('tail-view.stats.s1')
    expect(isStatsKey(statsKeyOf('s1'))).toBe(true)
    expect(isStatsKey('tail-view.stats')).toBe(false)
    expect(isStatsKey('paneWidth')).toBe(false)
  })

  test('the switch is on unless stored false', () => {
    expect(isOnValue(undefined)).toBe(true)
    expect(isOnValue(true)).toBe(true)
    expect(isOnValue(false)).toBe(false)
  })

  test('newestEnd is the newest endedAt, 0 for none', () => {
    expect(newestEnd(storedValue([stat('a', 3), stat('b', 7)]))).toBe(7)
    expect(newestEnd(undefined)).toBe(0)
  })

  test('pruneSessions drops those older than 30 days and beyond the 20 newest, never the kept one', () => {
    const now = 40 * DAY
    const entries = Array.from({ length: 25 }, (_, i) => ({ key: `k${i}`, newest: now - i * DAY }))
    const dropped = pruneSessions(entries, now, 'k24')
    expect(dropped).toEqual(['k20', 'k21', 'k22', 'k23'])
    expect(pruneSessions([{ key: 'old', newest: now - 31 * DAY }], now, 'x')).toEqual(['old'])
  })
})
