// The turn stats store (hooks/stats-store.ts) against the fake engine's $.store.
import { describe, expect, test } from 'vitest'

import { promptDigest } from '../hooks/model/sanitize'
import { pruneSessions } from '../hooks/session'
import {
  deleteAllStats,
  loadSessionStats,
  pruneStats,
  saveSessionStats,
  statsKeyOf,
  statsSummary,
} from '../hooks/stats-store'
import type { TurnStat } from '../types'
import { fakeEngine } from './coverage/engine'

const DAY = 86_400_000
const stat = (prompt: string, endedAt: number): TurnStat => ({ key: promptDigest(prompt), durationMs: 1_000, endedAt })

describe('stats store', () => {
  test('save then load round-trips a session and stores no prompt text', async () => {
    const { $, world } = fakeEngine()
    const stats = [stat('Fix the login bug', 1), stat('Ship it', 2)]
    await saveSessionStats($, 's1', stats)
    expect(await loadSessionStats($, 's1')).toEqual(stats)
    expect(JSON.stringify([...world.store])).not.toContain('login')
    expect(world.store.get(statsKeyOf('s1'))).toEqual({ v: 1, stats })
  })

  test('save writes nothing while the switch is off', async () => {
    const { $, world } = fakeEngine()
    world.store.set('tail-view.stats', false)
    await saveSessionStats($, 's1', [stat('a', 1)])
    expect(world.store.has(statsKeyOf('s1'))).toBe(false)
  })

  test('save keeps the newest 200', async () => {
    const { $ } = fakeEngine()
    await saveSessionStats(
      $,
      's1',
      Array.from({ length: 250 }, (_, i) => stat(`p${i}`, i + 1)),
    )
    const loaded = await loadSessionStats($, 's1')
    expect(loaded).toHaveLength(200)
    expect(loaded[0]!.endedAt).toBe(51)
  })

  test('a rejected set does not throw', async () => {
    const { $, world } = fakeEngine()
    world.storeFull = true
    await expect(saveSessionStats($, 's1', [stat('a', 1)])).resolves.toBeUndefined()
  })

  test('load returns [] for a missing or malformed value', async () => {
    const { $, world } = fakeEngine()
    expect(await loadSessionStats($, 'none')).toEqual([])
    world.store.set(statsKeyOf('bad'), { v: 1, stats: 'nope' })
    expect(await loadSessionStats($, 'bad')).toEqual([])
    world.store.set(statsKeyOf('odd'), { v: 1, stats: [{ key: 'k', endedAt: 'x' }, stat('ok', 3)] })
    expect(await loadSessionStats($, 'odd')).toEqual([stat('ok', 3)])
  })

  test('pruneSessions drops those older than 30 days and beyond the 20 newest, never the kept one', () => {
    const now = 40 * DAY
    const entries = Array.from({ length: 25 }, (_, i) => ({ key: `k${i}`, newest: now - i * DAY }))
    const dropped = pruneSessions(entries, now, 'k24')
    expect(dropped).toEqual(['k20', 'k21', 'k22', 'k23'])
    expect(pruneSessions([{ key: 'old', newest: now - 31 * DAY }], now, 'x')).toEqual(['old'])
  })

  test('pruneStats deletes old and surplus sessions and never the kept key', async () => {
    const { $, world } = fakeEngine()
    world.now = 40 * DAY
    for (let i = 0; i < 22; i++) world.store.set(statsKeyOf(`s${i}`), { v: 1, stats: [stat('a', world.now - i * DAY)] })
    world.store.set(statsKeyOf('ancient'), { v: 1, stats: [stat('a', world.now - 35 * DAY)] })
    world.store.set('paneWidth', 70)
    await pruneStats($, 's21')
    const left = [...world.store.keys()]
    expect(left).toContain(statsKeyOf('s21'))
    expect(left).not.toContain(statsKeyOf('ancient'))
    expect(left).not.toContain(statsKeyOf('s20'))
    expect(left.filter(k => k.startsWith('tail-view.stats.'))).toHaveLength(21)
    expect(world.store.get('paneWidth')).toBe(70)
  })

  test('deleteAllStats removes every tail-view.stats.* key and keeps the preferences', async () => {
    const { $, world } = fakeEngine()
    world.store.set(statsKeyOf('a'), { v: 1, stats: [stat('x', 1), stat('y', 2)] })
    world.store.set(statsKeyOf('b'), { v: 1, stats: [stat('z', 3)] })
    world.store.set('paneWidth', 70)
    world.store.set('tail-view.icons', 'ascii')
    world.store.set('tail-view.stats', true)
    expect(await statsSummary($)).toEqual({ sessions: 2, turns: 3 })
    expect(await deleteAllStats($)).toEqual({ sessions: 2, turns: 3 })
    expect([...world.store.keys()].sort()).toEqual(['paneWidth', 'tail-view.icons', 'tail-view.stats'])
  })
})
