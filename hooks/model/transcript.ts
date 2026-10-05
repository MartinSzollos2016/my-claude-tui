// Layout and the compact transcript: the pane's share of the terminal, a tool
// result's one line, and a turn's tail of counts and duration.
import { formatDuration } from './format'
import { sanitizeText } from './sanitize'
import type { Turn } from './types'
import { truncate } from './width'

const MIN_PANE = 40
const MIN_TRANSCRIPT = 40

// The dock width to ask for: `percent` of the terminal, but never so wide the
// transcript drops under MIN_TRANSCRIPT nor so narrow the pane drops under
// MIN_PANE. Undefined when the terminal holds neither.
export function paneColumns(total: number, percent: number): number | undefined {
  if (total < MIN_PANE + MIN_TRANSCRIPT) return undefined
  const wanted = Math.round((total * percent) / 100)
  return Math.min(total - MIN_TRANSCRIPT, Math.max(MIN_PANE, wanted))
}

// The cells a dock takes beside its body: the border toward the transcript.
const DOCK_FRAME = 1

// The terminal's width from a drawing of the pane: beside a docked pane the
// viewport is the transcript's column, so the dock (body and border) is added;
// inline the viewport is the terminal.
export function terminalWidth(viewportColumns: number, placement: 'dock' | 'inline', bodyColumns: number): number {
  return placement === 'dock' ? viewportColumns + bodyColumns + DOCK_FRAME : viewportColumns
}

const MIN_PANE_ROWS = 12

// The body rows to ask for while the pane sits inline above the prompt (the
// dock ignores them): half the terminal, never under MIN_PANE_ROWS; the
// engine still caps it at what the layout spares.
export function paneRows(total: number): number {
  return Math.max(MIN_PANE_ROWS, Math.floor(total / 2))
}

// The rows to draw inline. The inline block is only as tall as the tree, so
// drawing the `bodyRows` it reports would keep a first empty drawing empty:
// until the engine reports a window, draw the rows asked for (`wanted`),
// then the window it granted.
export function inlineRows(bodyRows: number, wanted: number): number {
  return bodyRows > 0 ? bodyRows : wanted
}

const lineWord = (n: number) => `${n} line${n === 1 ? '' : 's'}`

// The text a tool's structured result carries, by the fields the built-in
// tools use; undefined when none is text.
function resultText(output: unknown): string | undefined {
  if (typeof output === 'string') return output
  if (output === null || typeof output !== 'object') return undefined
  const o = output as Record<string, unknown>
  for (const key of ['stdout', 'content', 'text', 'output', 'result']) {
    if (typeof o[key] === 'string')
      return [o[key], typeof o['stderr'] === 'string' ? o['stderr'] : ''].filter(Boolean).join('\n')
  }
  if (o['file'] !== null && typeof o['file'] === 'object') return resultText(o['file'])
  return undefined
}

// One line for a tool result in the compact transcript; the detail is in
// the pane. Errors keep their first line so a failure still reads at a glance.
export function resultLine(output: unknown, isErrored: boolean): string {
  if (isErrored) {
    const first =
      sanitizeText(resultText(output) ?? String(output ?? ''))
        .trim()
        .split('\n')[0] ?? ''
    return truncate(`error: ${first}`, 80)
  }
  const text = resultText(output)
  if (text !== undefined) return text.trim() === '' ? 'no output' : lineWord(text.trimEnd().split('\n').length)
  if (output !== null && typeof output === 'object') {
    const list = Object.values(output as Record<string, unknown>).find(Array.isArray)
    if (list) return `${list.length} item${list.length === 1 ? '' : 's'}`
  }
  return 'done'
}

// The counts a turn list row shows: "3 tools · 1 agent", or "reply" for a
// turn that only answered.
function countParts(turn: Turn): string[] {
  const parts: string[] = []
  const tools = turn.toolCount - turn.subagentCount
  if (tools > 0) parts.push(`${tools} tool${tools === 1 ? '' : 's'}`)
  if (turn.subagentCount > 0) parts.push(`${turn.subagentCount} agent${turn.subagentCount === 1 ? '' : 's'}`)
  return parts
}

function turnCounts(turn: Turn, dot: string): string {
  const parts = countParts(turn)
  return parts.length > 0 ? parts.join(` ${dot} `) : 'reply'
}

// What the engine's "Baked for 3s" line gets appended: " . 3 tools . 1 agent"
// for the counts that are not zero, nothing for a turn that only answered.
export function durationSuffix(turn: Turn | undefined, dot: string): string {
  return turn === undefined
    ? ''
    : countParts(turn)
        .map(part => ` ${dot} ${part}`)
        .join('')
}

// A turn row's tail: its counts, then how long it took when that is known.
export function turnTail(turn: Turn, stat?: { durationMs: number }, dot = '·'): string {
  return [turnCounts(turn, dot), stat ? formatDuration(stat.durationMs) : ''].filter(Boolean).join(` ${dot} `)
}
