// The turn stats kept between sessions in Claude Code's plugin store: one key
// per session (tail-view.stats.<sessionId>), each a { v: 1, stats } of digest-
// keyed TurnStats (no prompt text). Only the keys and values live here: the
// store calls stay in register.tsx, the one file the engine follows `$` in.
import type { TurnStat } from '../types'

// The switch: on unless false, read at every write.
export const STATS_KEY = 'tail-view.stats'
const PREFIX = `${STATS_KEY}.`

export const statsKeyOf = (sessionId: string): string => PREFIX + sessionId

export const isStatsKey = (key: string): boolean => key.startsWith(PREFIX)

export const isOnValue = (value: unknown): boolean => value !== false

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
export function statsOf(value: unknown): TurnStat[] {
  const stats = (value as { stats?: unknown } | null)?.stats
  return Array.isArray(stats) ? stats.filter(isStat) : []
}

// The value stored for a session's stats.
export const storedValue = (stats: readonly TurnStat[]): { v: 1; stats: readonly TurnStat[] } => ({ v: 1, stats })

// When a stored session's newest turn ended; 0 for none.
export const newestEnd = (value: unknown): number => Math.max(0, ...statsOf(value).map(s => s.endedAt))
