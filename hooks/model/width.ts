// Display width: terminal cells of a text (wide CJK, emoji, zero-width marks),
// and padding, cutting and path fitting by cells rather than characters.
import type { Icons } from '../icons'
import type { ToolItem } from './types'
import { str } from './values'

//
// Columns line up by terminal cells, not by code points: CJK, Hangul and
// fullwidth forms and emoji take two cells, combining marks and variation
// selectors none, and a ZWJ sequence draws as one two-cell emoji. Nerd Font
// glyphs of the Private Use Area count as one cell. Own table, no dependency.

// Without Intl.Segmenter the text falls apart by code points.
const SEGMENTER =
  typeof Intl.Segmenter === 'function' ? new Intl.Segmenter(undefined, { granularity: 'grapheme' }) : undefined

// Wide and fullwidth ranges [from, to], and the emoji blocks.
const WIDE_RANGES: readonly (readonly [number, number])[] = [
  [0x1100, 0x115f],
  [0x2e80, 0x303e],
  [0x3041, 0x33ff],
  [0x3400, 0x4dbf],
  [0x4e00, 0x9fff],
  [0xa000, 0xa4cf],
  [0xa960, 0xa97f],
  [0xac00, 0xd7a3],
  [0xf900, 0xfaff],
  [0xfe30, 0xfe4f],
  [0xff00, 0xff60],
  [0xffe0, 0xffe6],
  [0x1f000, 0x1f2ff],
  [0x1f300, 0x1faff],
  // Default emoji presentation in the BMP.
  [0x231a, 0x231b],
  [0x23e9, 0x23ec],
  [0x2614, 0x2615],
  [0x2648, 0x2653],
  [0x267f, 0x267f],
  [0x2693, 0x2693],
  [0x26a1, 0x26a1],
  [0x26aa, 0x26ab],
  [0x26bd, 0x26be],
  [0x26c4, 0x26c5],
  [0x26ce, 0x26ce],
  [0x26d4, 0x26d4],
  [0x26ea, 0x26ea],
  [0x26f2, 0x26f5],
  [0x26fa, 0x26fa],
  [0x26fd, 0x26fd],
  [0x2705, 0x2705],
  [0x270a, 0x270b],
  [0x2728, 0x2728],
  [0x274c, 0x274c],
  [0x274e, 0x274e],
  [0x2753, 0x2755],
  [0x2757, 0x2757],
  [0x2795, 0x2797],
  [0x27b0, 0x27b0],
  [0x27bf, 0x27bf],
  [0x2b1b, 0x2b1c],
  [0x2b50, 0x2b50],
  [0x2b55, 0x2b55],
  [0x20000, 0x3fffd],
]
const ZERO_WIDTH = /^[\p{M}\p{Cf}\u200b-\u200d\ufe00-\ufe0f]+$/u
const EMOJI_PRESENTATION = '\ufe0f'

function graphemeWidth(grapheme: string): number {
  const first = grapheme.codePointAt(0)!
  if (ZERO_WIDTH.test(grapheme)) return 0
  if (WIDE_RANGES.some(([from, to]) => first >= from && first <= to)) return 2
  if (grapheme.includes(EMOJI_PRESENTATION)) return 2
  // A flag: two regional indicators.
  if (first >= 0x1f1e6 && first <= 0x1f1ff) return 2
  return 1
}

const graphemesOf = (text: string): string[] =>
  SEGMENTER === undefined ? Array.from(text) : Array.from(SEGMENTER.segment(text), part => part.segment)

const PRINTABLE_ASCII = /^[\x20-\x7e]*$/

export function displayWidth(text: string): number {
  if (PRINTABLE_ASCII.test(text)) return text.length
  let width = 0
  for (const grapheme of graphemesOf(text)) width += graphemeWidth(grapheme)
  return width
}

// Pads with spaces to `width` cells; text that is wider is left whole.
export function padEndDisplay(text: string, width: number): string {
  return text + ' '.repeat(Math.max(0, width - displayWidth(text)))
}

// The longest run of whole graphemes from the start that fits `cells`.
function takeDisplay(graphemes: readonly string[], cells: number): { text: string; width: number } {
  let width = 0
  let text = ''
  for (const grapheme of graphemes) {
    const w = graphemeWidth(grapheme)
    if (width + w > cells) break
    width += w
    text += grapheme
  }
  return { text, width }
}

// Cuts to `max` cells, the ellipsis included, at the end; never splits a
// grapheme. Line breaks become spaces.
export function truncateDisplay(s: string, max: number, ellipsis = '…'): string {
  const one = s.replaceAll('\n', ' ')
  if (displayWidth(one) <= max) return one
  const room = max - displayWidth(ellipsis)
  if (room < 0) return takeDisplay(graphemesOf(one), max).text
  return takeDisplay(graphemesOf(one), room).text + ellipsis
}

// Cuts to `max` code points, the ellipsis included, at the end.
export function truncate(s: string, max: number, ellipsis = '…'): string {
  const one = s.replaceAll('\n', ' ')
  const chars = [...one]
  if (chars.length <= max) return one
  const width = [...ellipsis].length
  return max < width ? chars.slice(0, max).join('') : chars.slice(0, max - width).join('') + ellipsis
}

// Cuts to `max` cells from the middle, keeping more of the end (a path's
// file name) than of the start; the ellipsis marks the cut. Never splits a
// grapheme.
export function truncateMiddle(s: string, max: number, ellipsis = '…'): string {
  const one = s.replaceAll('\n', ' ')
  if (displayWidth(one) <= max) return one
  const width = displayWidth(ellipsis)
  if (max <= width) return takeDisplay(graphemesOf(ellipsis), Math.max(0, max)).text
  const keep = max - width
  const graphemes = graphemesOf(one)
  const head = takeDisplay(graphemes, Math.floor(keep / 3))
  const tail = takeDisplay(graphemes.toReversed(), keep - head.width)
  return `${head.text}${ellipsis}${graphemesOf(tail.text).toReversed().join('')}`
}

// A duration as a bar of up to `cells` cells in eighths of a block, relative
// to the longest call; nothing under one percent. A part of a cell shows the
// set's partial step (ascii: `-`, a whole cell `=`).
export function durationBar(ms: number, maxMs: number, cells: number, icons: Pick<Icons, 'bar'>): string {
  if (!(ms > 0) || !(maxMs > 0)) return ''
  const ratio = Math.min(1, ms / maxMs)
  if (ratio < 0.01) return ''
  const eighths = Math.max(1, Math.round(ratio * cells * 8))
  const whole = Math.floor(eighths / 8)
  const rest = eighths % 8
  return icons.bar[7]!.repeat(whole) + (rest > 0 ? icons.bar[rest - 1]! : '')
}

export function shortPath(path: string, n: number): string {
  const segments = path.replaceAll('\\', '/').split('/').filter(Boolean)
  return segments.slice(-n).join('/')
}

export const basename = (p: string) => shortPath(p, 1)

// The file or directory a tool call works on, '' when it has none.
export function pathOf(item: ToolItem): string {
  const f = item.input
  switch (item.tool) {
    case 'Read':
    case 'Write':
    case 'Edit':
    case 'MultiEdit':
      return str(f, 'file_path')
    case 'NotebookEdit':
      return str(f, 'notebook_path')
    case 'Grep':
    case 'Glob':
      return str(f, 'path')
    default:
      return ''
  }
}

const PATH_SEGMENTS = 6

// A summary cut to `max` code points. Where it names a path, the path is
// widened to its last few segments and cut in the middle, so the file name
// stays; the rest of the summary (line range, edit size) is kept whole.
// Everything else is cut at the end.
export function fitPath(item: ToolItem, summary: string, max: number, ellipsis = '…'): string {
  const path = pathOf(item)
  const known = [shortPath(path, 2), shortPath(path, 1)].find(k => k !== '' && summary.includes(k))
  if (path === '' || known === undefined) return truncateDisplay(summary, max, ellipsis)
  const at = summary.lastIndexOf(known)
  const prefix = summary.slice(0, at)
  const suffix = summary.slice(at + known.length)
  const room = max - displayWidth(prefix) - displayWidth(suffix)
  if (room < 4) return truncateDisplay(summary, max, ellipsis)
  return prefix + truncateMiddle(shortPath(path, PATH_SEGMENTS), room, ellipsis) + suffix
}
