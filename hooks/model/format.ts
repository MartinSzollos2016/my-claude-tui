// Formatters (ported from tail-claude format.go): models, tokens, durations,
// clocks, modes, the context meter and the trace tree prefix.
import type { Icons } from '../icons'

// "claude-opus-4-6" -> "opus4.6", "claude-sonnet-5-20260203" -> "sonnet5"
export function shortModel(model: string): string {
  const m = model.replace(/^claude-/, '').replace(/\[.*\]$/, '')
  const dash = m.indexOf('-')
  if (dash < 0) return m
  const family = m.slice(0, dash)
  const v = m.slice(dash + 1).split('-')
  let version = v[0] ?? ''
  if (v.length >= 2 && (v[1] ?? '').length <= 2) version = `${v[0]}-${v[1]}`
  return family + version.replaceAll('-', '.')
}

export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return String(Math.round(n))
}

export function formatDuration(ms: number): string {
  const secs = ms / 1000
  const s = Math.round(secs)
  if (s >= 60) return `${Math.floor(s / 60)}m ${s % 60}s`
  if (secs >= 10) return `${s}s`
  return `${secs.toFixed(1)}s`
}

// A turn's duration the way the engine words its closing line: whole
// seconds, then minutes and seconds ("3s", "1m 4s").
export function engineDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  return s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`
}

export function formatClock(ms: number): string {
  const d = new Date(ms)
  const hours = d.getHours()
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${hours % 12 === 0 ? 12 : hours % 12}:${pad(d.getMinutes())}:${pad(d.getSeconds())} ${hours < 12 ? 'AM' : 'PM'}`
}

export function shortMode(mode: string): string {
  switch (mode) {
    case 'bypassPermissions':
      return 'bypass'
    case 'acceptEdits':
      return 'accept edits'
    case 'default':
      return ''
    default:
      return mode
  }
}

// The glyphs model text carries, from the chosen icon set; the defaults are
// the Nerd Font and Unicode sets'.
export type Glyphs = Pick<Icons, 'ellipsis' | 'dot' | 'taskDone' | 'taskActive' | 'taskTodo'>
export type TaskMarks = Pick<Icons, 'taskDone' | 'taskActive' | 'taskTodo'>

export const DEFAULT_GLYPHS: Glyphs = { ellipsis: '…', dot: '·', taskDone: '☑', taskActive: '◐', taskTodo: '☐' }

// The context window as a bar of `cells` cells, round(percent/100*cells) of
// them full, kept within 0..cells.
export function contextMeter(percent: number, cells: number, icons: Pick<Icons, 'meterFull' | 'meterEmpty'>) {
  const full = Math.min(cells, Math.max(0, Math.round((percent / 100) * cells)))
  return icons.meterFull.repeat(full) + icons.meterEmpty.repeat(cells - full)
}

// The guides in front of a row of a subagent's trace. `depthPath` says which
// parent levels still continue (a guide) or ended (blank); `isLast` closes the
// row's own branch.
export function treePrefix(
  depthPath: readonly boolean[],
  isLast: boolean,
  icons: Pick<Icons, 'treeBranch' | 'treeLast' | 'treeGuide'>,
) {
  const blank = ' '.repeat(icons.treeGuide.length)
  return depthPath.map(goes => (goes ? icons.treeGuide : blank)).join('') + (isLast ? icons.treeLast : icons.treeBranch)
}
