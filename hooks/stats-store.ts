// The turn stats kept between sessions in Claude Code's plugin store: one key
// per session (tail-view.stats.<sessionId>), each a { v: 1, stats } of digest-
// keyed TurnStats (no prompt text). Every call here catches its failures: a
// full store or a malformed value never reaches a turn or a drawing.
import type { EngineInterface } from 'claude-code'

import type { TurnStat } from '../types'
import { mergeStats, pruneSessions } from './session'

// The switch: on unless false, read at every write.
export const STATS_KEY = 'tail-view.stats'
const PREFIX = `${STATS_KEY}.`

export const statsKeyOf = (sessionId: string): string => PREFIX + sessionId

export async function isStatsOn($: EngineInterface): Promise<boolean> {
  try {
    return (await $.store.get(STATS_KEY)) !== false
  } catch {
    return true
  }
}

const isStat = (value: unknown): value is TurnStat => {
  const s = value as Partial<TurnStat> | null
  return (
    typeof s === 'object' &&
    s !== null &&
    typeof s.key === 'string' &&
    typeof s.endedAt === 'number' &&
    typeof s.durationMs === 'number'
  )
}

// A stored value's stats, oldest first; [] for anything else.
function statsOf(value: unknown): TurnStat[] {
  const stats = (value as { stats?: unknown } | null)?.stats
  return Array.isArray(stats) ? stats.filter(isStat) : []
}

export async function loadSessionStats($: EngineInterface, sessionId: string): Promise<TurnStat[]> {
  try {
    return statsOf(await $.store.get(statsKeyOf(sessionId)))
  } catch {
    return []
  }
}

export async function saveSessionStats(
  $: EngineInterface,
  sessionId: string,
  stats: readonly TurnStat[],
): Promise<void> {
  try {
    if (!(await isStatsOn($))) return
    // Merged with what is stored, so a save never shrinks a session: not one
    // from a process that has not loaded it yet, nor another on the same id.
    const stored = await loadSessionStats($, sessionId)
    await $.store.set(statsKeyOf(sessionId), { v: 1, stats: mergeStats(stored, stats) })
  } catch {
    // A full or failing store leaves the stats in memory only.
  }
}

async function statsKeys($: EngineInterface): Promise<string[]> {
  return (await $.store.keys()).filter(key => key.startsWith(PREFIX))
}

// Deletes the other sessions' stats that are too old or too many; `keepId`'s
// stay whatever their age.
export async function pruneStats($: EngineInterface, keepId: string): Promise<void> {
  try {
    const keys = await statsKeys($)
    const entries = await Promise.all(
      keys.map(async key => ({ key, newest: Math.max(0, ...statsOf(await $.store.get(key)).map(s => s.endedAt)) })),
    )
    const dropped = pruneSessions(entries, await $.clock.now(), statsKeyOf(keepId))
    await Promise.all(dropped.map(key => $.store.delete(key)))
  } catch {
    // Pruning waits for the next session start.
  }
}

// How many sessions and turns the store holds.
export async function statsSummary($: EngineInterface): Promise<{ sessions: number; turns: number }> {
  try {
    const keys = await statsKeys($)
    const counts = await Promise.all(keys.map(async key => statsOf(await $.store.get(key)).length))
    return { sessions: keys.length, turns: counts.reduce((sum, n) => sum + n, 0) }
  } catch {
    return { sessions: 0, turns: 0 }
  }
}

// Deletes every stored session's stats, the preferences kept; what was there.
export async function deleteAllStats($: EngineInterface): Promise<{ sessions: number; turns: number }> {
  const summary = await statsSummary($)
  try {
    await Promise.all((await statsKeys($)).map(key => $.store.delete(key)))
  } catch {
    // What stays is deleted at the next session start while storing is off.
  }
  return summary
}
