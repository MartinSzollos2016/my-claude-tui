// Pure state transitions behind register.tsx's hooks: what a tool call, a
// finished turn or a key press does to the plugin's state. register.tsx only
// reads the engine and writes the atoms, so this file is unit tested whole.
import type { RenderSurface, TurnUsage } from 'claude-code'

import type { ToolTiming, TurnStat } from '../types'
import type { Turn } from './model/types'

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

export function turnStatFrom(
  input: { durationMs: number; usage?: TurnUsage },
  prompt: string,
  now: number,
  index?: number,
): TurnStat {
  const usage = input.usage
  return {
    prompt,
    ...(index === undefined ? {} : { turnIndex: index }),
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

// The stat recorded for this turn. An index match counts only while the
// turn at that index still has the stat's prompt: $.session.messages() holds
// the newest rows only, so indexes shift as old rows leave the window. Else
// the newest stat with the turn's prompt that no other turn's index claims;
// the latest turn of a fresh session may have none yet.
export function statFor(
  stats: readonly TurnStat[],
  turn: Turn | undefined,
  turns: readonly Turn[],
): TurnStat | undefined {
  if (!turn) return undefined
  const isOwn = (stat: TurnStat, at: Turn | undefined) =>
    at !== undefined && (stat.prompt === at.prompt || at.prompt === '')
  for (let i = stats.length - 1; i >= 0; i--) {
    const stat = stats[i]!
    if (stat.turnIndex === turn.index && isOwn(stat, turn)) return stat
  }
  for (let i = stats.length - 1; i >= 0; i--) {
    const stat = stats[i]!
    const claimed = stat.turnIndex !== undefined && isOwn(stat, turns[stat.turnIndex])
    if (stat.prompt === turn.prompt && !claimed) return stat
  }
  return undefined
}

// The stat a transcript "Baked for 3s" line belongs to: the newest one with
// exactly its duration (both come from the same turn.complete) and a turn
// index. Undefined when no finished turn has that duration.
export function statOfDuration(stats: readonly TurnStat[], durationMs: number): TurnStat | undefined {
  for (let i = stats.length - 1; i >= 0; i--) {
    const stat = stats[i]!
    if (stat.durationMs === durationMs && stat.turnIndex !== undefined) return stat
  }
  return undefined
}

// The turn `stat` was recorded for, while the turn at its index still has
// its prompt (see statFor); undefined once the rows moved on.
export function turnOfStat(stat: TurnStat, turns: readonly Turn[]): Turn | undefined {
  const turn = turns.find(t => t.index === stat.turnIndex)
  return turn !== undefined && (turn.prompt === stat.prompt || turn.prompt === '') ? turn : undefined
}

// The index buildTurns gives the turn starting with `prompt`: the last turn
// when the transcript already holds the prompt (or the turn has none, a
// continuation), else the one about to open after it.
export function turnIndexAtStart(turns: readonly Turn[], prompt: string): number {
  const last = turns.at(-1)
  if (!last) return 0
  return prompt === '' || last.prompt === prompt ? last.index : turns.length
}

const MAX_PENDING_TURNS = 50

// Indexes of turns whose prompt was submitted but whose turn.start has not
// come yet, oldest first; bounded in case a turn never starts.
export function enqueueTurn(queue: readonly number[], index: number): number[] {
  return [...queue, index].slice(-MAX_PENDING_TURNS)
}

// The queue without the last entry equal to `index` (a prompt that was dropped).
export function dropPending(queue: readonly number[], index: number): number[] {
  const at = queue.lastIndexOf(index)
  return at < 0 ? [...queue] : [...queue.slice(0, at), ...queue.slice(at + 1)]
}

// The queue without entries at or below the last completed turn: their
// turn.start never came, so they would shift every later pairing.
export function discardStale(queue: readonly number[], lastDone: number): number[] {
  return queue.filter(i => i > lastDone)
}

// The oldest pending index, else `fallback` (a turn no submit announced, such
// as one a notification started).
export function takeTurnIndex(queue: readonly number[], fallback: number): { index: number; queue: number[] } {
  return queue.length === 0 ? { index: fallback, queue: [] } : { index: queue[0]!, queue: queue.slice(1) }
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

// Where /tail answers in text instead of opening the pane: VS Code draws no
// pane, and a `claude -p` run draws nothing at all.
export function isTextOnly(surfaces: readonly RenderSurface[]): boolean {
  return surfaces.every(surface => surface === 'vscode')
}

const MAX_WORKFLOW_AGENTS = 500

// A workflow's agents carry ids $.agent.list() never names: an id seen on a
// tool call or a finished turn that the list does not know is counted as
// one of the running workflow's (best effort).
export function noteWorkflowAgent(
  seen: readonly string[],
  agentId: string | undefined,
  known: ReadonlySet<string>,
): readonly string[] {
  if (agentId === undefined || known.has(agentId) || seen.includes(agentId)) return seen
  return [...seen, agentId].slice(-MAX_WORKFLOW_AGENTS)
}

const MAX_NOTIFIED = 500

// The ids already announced as finished with `id` added once, the last 500
// kept: an agent is toasted once however often its status changes.
export function noteNotified(ids: readonly string[], id: string): readonly string[] {
  return ids.includes(id) ? ids : [...ids, id].slice(-MAX_NOTIFIED)
}
