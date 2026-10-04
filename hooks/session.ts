// Pure state transitions behind register.tsx's hooks: what a tool call, a
// finished turn or a key press does to the plugin's state. register.tsx only
// reads the engine and writes the atoms, so this file is unit tested whole.
import type { TurnUsage } from 'claude-code'

import type { ToolTiming, TurnStat } from '../types'
import type { Turn } from './model'

export const MAX_TIMINGS = 500

// Starts timing a call. Past MAX_TIMINGS calls the older half is dropped, so
// a long session cannot grow the state without bound.
export function recordToolStart(
  timings: Readonly<Record<string, ToolTiming>>,
  id: string,
  now: number,
): Record<string, ToolTiming> {
  const keys = Object.keys(timings)
  const kept =
    keys.length >= MAX_TIMINGS
      ? Object.fromEntries(keys.slice(-MAX_TIMINGS / 2).map(k => [k, timings[k]!]))
      : { ...timings }
  return { ...kept, [id]: { start: now } }
}

// Ends a call's timing; `start` stands in when the trim dropped its start.
export function recordToolEnd(
  timings: Readonly<Record<string, ToolTiming>>,
  id: string,
  now: number,
  start = now,
): Record<string, ToolTiming> {
  return { ...timings, [id]: { start: timings[id]?.start ?? start, end: now } }
}

export function turnStatFrom(input: { durationMs: number; usage?: TurnUsage }, prompt: string, now: number): TurnStat {
  const usage = input.usage
  return {
    prompt,
    durationMs: input.durationMs,
    endedAt: now,
    model: usage?.model,
    inputTokens: usage
      ? usage.input_tokens + usage.cache_read_input_tokens + usage.cache_creation_input_tokens
      : undefined,
    outputTokens: usage?.output_tokens,
  }
}

// The selected turn after a step (`delta` -1 or 1) or a jump to the latest
// (`delta` null). null follows the latest turn as new ones arrive.
export function nextSelectedTurn(cur: number | null, latest: number, delta: number | null): number | null {
  if (delta === null) return null
  const n = (cur === null || cur > latest ? latest : cur) + delta
  return n >= latest ? null : Math.max(0, n)
}

// Adds or removes one id of a bounded list (expanded rows, full blocks).
export function toggleId(ids: readonly string[], id: string, max: number): string[] {
  return ids.includes(id) ? ids.filter(x => x !== id) : [...ids, id].slice(-max)
}

// Prefers the stat recorded for this turn's prompt; the latest turn of a
// fresh session may have none yet.
export function statFor(stats: readonly TurnStat[], turn: Turn | undefined): TurnStat | undefined {
  if (!turn) return undefined
  for (let i = stats.length - 1; i >= 0; i--) {
    if (stats[i]!.prompt === turn.prompt) return stats[i]
  }
  return undefined
}

export type Memo<T> = { key: string; value: T }

// The cached value while `key` holds, else a fresh one from `build`.
export function memo<T>(cache: Memo<T> | undefined, key: string, build: () => T): Memo<T> {
  return cache !== undefined && cache.key === key ? cache : { key, value: build() }
}

// Sets `key` in a map kept to `max` entries, the least recently set dropped.
export function remember<K, V>(map: Map<K, V>, key: K, value: V, max: number): void {
  map.delete(key)
  map.set(key, value)
  while (map.size > max) map.delete(map.keys().next().value as K)
}
