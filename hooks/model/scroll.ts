// The pane's own scroll.//
// The pane is exactly as tall as its window, so the engine has nothing to
// scroll: the content sits in a clipped window of its own and moves by
// `scrollTop` rows. Its height is estimated from what the view draws.
import { moveCursor } from './cursor'
import { displayWidth } from './width'

// One block of the content in drawing order, with the text that may wrap and
// the cells it wraps at (`width`); a text without a width is cut to one row.
// - `line`: one row (an item row carries its id), or a wrapping text.
// - `frame`: two borders, the header row, the pieces of its body (narrowed by
//   the `gutter` of numbered code and diffs) and its note rows (show all, a
//   budget note, an error line), all wrapped at the frame's inner width.
// - `turn`: a row of the turn list and its search snippet.
export type RowBlock =
  | { kind: 'line'; id?: string; text?: string; width?: number }
  | {
      kind: 'frame'
      body: readonly string[]
      notes: readonly string[]
      width: number
      gutter?: number
      // The header row's rows: more than one where the set leaves its meta uncut.
      headRows?: number
      // How the engine draws the body: Markdown drops empty lines; a diff
      // draws no ---, +++ or @@ line and puts each line's number and marker
      // in a gutter as wide as its widest number and 3 cells.
      format?: 'markdown' | 'diff'
    }
  | { kind: 'turn'; id?: string; snippet?: string; width?: number }

export type ContentRows = { total: number; starts: Readonly<Record<string, number>> }

// The two borders of a frame.
const FRAME_BORDERS = 2

// Measured texts by width: a pane draws the same pieces on every tick.
const wrapCache = new Map<string, number>()
const MAX_WRAP_CACHE = 2000

// The rows `text` takes wrapped at `width` cells: each of its lines at least
// one, a long one a row per `width`; a trailing newline adds none. The view
// expands tabs before it draws (expandTabs), so the text measured has none.
// A text's key: its width, length and a hash of all of it (FNV-1a), so the
// cache holds no copy of the text.
function wrapKey(text: string, width: number): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 0x01000193)
  return `${width}:${text.length}:${(hash >>> 0).toString(36)}`
}

export const resetWrapCache = (): void => wrapCache.clear()
export const wrapCacheKeyChars = (): number => [...wrapCache.keys()].reduce((sum, key) => sum + key.length, 0)

function wrappedRows(text: string, width: number): number {
  const key = wrapKey(text, width)
  const cached = wrapCache.get(key)
  if (cached !== undefined) return cached
  const lines = text.split('\n')
  if (lines.length > 1 && lines.at(-1) === '') lines.pop()
  const cells = Math.max(1, width)
  const rows = lines.reduce((sum, line) => sum + Math.max(1, Math.ceil(displayWidth(line) / cells)), 0)
  if (wrapCache.size >= MAX_WRAP_CACHE) wrapCache.clear()
  wrapCache.set(key, rows)
  return rows
}

// A diff piece's drawn lines without their marker, and its gutter's cells.
const DIFF_HEADER = /^(?:--- |\+\+\+ |@@ )/
const HUNK_RANGES = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/

function diffRows(piece: string, width: number): number {
  const lines = piece.split('\n')
  let last = 1
  for (const line of lines) {
    const m = HUNK_RANGES.exec(line)
    if (m) last = Math.max(last, Number(m[1]) + Number(m[2] ?? 1), Number(m[3]) + Number(m[4] ?? 1))
  }
  const room = width - (String(last).length + 3)
  const drawn = lines.filter(line => line !== '' && !DIFF_HEADER.test(line)).map(line => line.slice(1))
  return drawn.reduce((sum, line) => sum + wrappedRows(line, room), 0)
}

// The rows of one piece of a frame's body as the engine draws its format.
function pieceRows(piece: string, width: number, format: 'markdown' | 'diff' | undefined): number {
  if (format === 'diff') return diffRows(piece, width)
  if (format !== 'markdown') return wrappedRows(piece, width)
  return piece
    .split('\n')
    .filter(line => line.trim() !== '')
    .reduce((sum, line) => sum + wrappedRows(line, width), 0)
}

const textRows = (text: string | undefined, width: number | undefined): number =>
  text === undefined || width === undefined ? 1 : wrappedRows(text, width)

function blockRows(block: RowBlock): number {
  switch (block.kind) {
    case 'line':
      return textRows(block.text, block.width)
    case 'turn':
      return 1 + (block.snippet === undefined ? 0 : textRows(block.snippet, block.width))
    case 'frame': {
      const bodyWidth = block.width - (block.gutter ?? 0)
      return (
        FRAME_BORDERS +
        (block.headRows ?? 1) +
        block.body.reduce((sum, piece) => sum + pieceRows(piece, bodyWidth, block.format), 0) +
        block.notes.reduce((sum, note) => sum + wrappedRows(note, block.width), 0)
      )
    }
  }
}

// The rows of the content and the row each item row starts on. Every text
// is counted as wrapped at the width the view gives it.
export function contentRows(blocks: readonly RowBlock[]): ContentRows {
  const starts: Record<string, number> = {}
  let total = 0
  for (const block of blocks) {
    if ((block.kind === 'line' || block.kind === 'turn') && block.id !== undefined) starts[block.id] = total
    total += blockRows(block)
  }
  return { total, starts }
}

// How far past its end the content may scroll: the estimate can fall short,
// so the last rows always come into view.
const SCROLL_SLACK = 2

// The scroll kept between the top and two rows past the end; none while the
// content fits the window.
export function clampScroll(scrollTop: number, contentRows: number, windowRows: number): number {
  const max = contentRows > windowRows ? contentRows - windowRows + SCROLL_SLACK : 0
  return Math.min(Math.max(0, scrollTop), max)
}

// One page down (`delta` 1) or up (-1): the window less its two indicator rows.
export function pageScroll(scrollTop: number, delta: number, windowRows: number): number {
  return Math.max(0, scrollTop + delta * Math.max(1, windowRows - SCROLL_SLACK))
}

// The scroll that shows the row starting at `rowStart`, one row in from the
// edge it left by (the indicator rows cover the edges); unchanged when it shows.
export function followCursor(scrollTop: number, rowStart: number, windowRows: number): number {
  const margin = windowRows > SCROLL_SLACK ? 1 : 0
  if (rowStart < scrollTop + margin) return Math.max(0, rowStart - margin)
  if (rowStart > scrollTop + windowRows - 1 - margin) return rowStart - windowRows + 1 + margin
  return scrollTop
}

// The rows out of view above and below the window, the rows under the
// indicators included; none while the content fits.
export function overflowRows(scrollTop: number, total: number, windowRows: number): { above: number; below: number } {
  if (total <= windowRows) return { above: 0, below: 0 }
  return { above: scrollTop > 0 ? scrollTop + 1 : 0, below: Math.max(0, total - scrollTop - windowRows + 1) }
}

// Where the window stands as drawn: what a key that moves the cursor needs to
// keep the cursor's row in view.
export type ScrollFrame = {
  scrollTop: number
  windowRows: number
  total: number
  starts: Readonly<Record<string, number>>
}

// The scroll that keeps row `id` in view; unchanged for a row not drawn.
export function scrollToRow(frame: ScrollFrame, id: string | null): number {
  const start = id === null ? undefined : frame.starts[id]
  if (start === undefined) return frame.scrollTop
  return clampScroll(followCursor(frame.scrollTop, start, frame.windowRows), frame.total, frame.windowRows)
}

// One row of the cursor (`delta` -1 or 1) over `ids`. Without a cursor on the
// list, or with one f/b scrolled out of view, j enters at the first row inside
// the window as drawn and k at the last, so the content does not jump; with
// none inside, at the ends.
export function stepCursor(
  ids: readonly string[],
  current: string | null,
  delta: number,
  frame: ScrollFrame,
): string | null {
  const margin = frame.windowRows > SCROLL_SLACK ? 1 : 0
  const first = frame.scrollTop + margin
  const last = frame.scrollTop + frame.windowRows - 1 - margin
  const at = current === null ? undefined : frame.starts[current]
  // A cursor in view (or with no known row) steps on; one scrolled out of
  // view enters the window again.
  const isInView = at === undefined || (at >= first && at <= last)
  if (current !== null && ids.includes(current) && isInView) return moveCursor(ids, current, delta)
  const inside = ids.filter(id => {
    const start = frame.starts[id]
    return start !== undefined && start >= first && start <= last
  })
  const entry = delta < 0 ? inside.at(-1) : inside[0]
  return entry ?? moveCursor(ids, null, delta)
}

// A move the engine asks of the pane's window: `by` rows, out of a body of
// `bodyRows` over a tree of `contentRows`.
export type EngineScroll = { by: number; bodyRows: number; contentRows: number }

// Where the engine's move takes the own scroll: a page key arrives as the
// whole body (header and footer included), so it moves one page of the own
// window as f and b do; Home and End, beyond the tree, go to the top and the
// end; a wheel step moves its rows.
export function engineScroll(scrollTop: number, move: EngineScroll, frame: ScrollFrame): number {
  const base = clampScroll(scrollTop, frame.total, frame.windowRows)
  const size = Math.abs(move.by)
  const next =
    size > Math.max(move.bodyRows, move.contentRows)
      ? move.by < 0
        ? 0
        : Infinity
      : size >= move.bodyRows
        ? pageScroll(base, Math.sign(move.by), frame.windowRows)
        : base + move.by
  return clampScroll(next, frame.total, frame.windowRows)
}
