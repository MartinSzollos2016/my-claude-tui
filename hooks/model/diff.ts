// Unified diffs of an edit: hunks with line numbers, split and capped for display.
import { clampText, type Clamped } from './clamp'
import { expandTabs } from './width'

//
// An Edit becomes a unified diff the engine's <Code format="diff"> draws with
// gutters and colors. The diff is a pure function of the two texts; long ones
// are cut only at line boundaries, each piece a valid diff of its own.

const MAX_DIFF_LINES = 2000
// The LCS table of the changed middle may hold this many cells (about 1 MB).
const MAX_DIFF_CELLS = 250_000

type DiffOp = { op: ' ' | '-' | '+'; text: string }

const linesOf = (text: string) => (text === '' ? [] : text.split('\n'))

// Line by line LCS of the changed middle, after the common head and tail.
function diffOps(before: readonly string[], after: readonly string[]): DiffOp[] | null {
  let head = 0
  while (head < before.length && head < after.length && before[head] === after[head]) head++
  let tail = 0
  while (
    tail < before.length - head &&
    tail < after.length - head &&
    before[before.length - 1 - tail] === after[after.length - 1 - tail]
  )
    tail++
  const a = before.slice(head, before.length - tail)
  const b = after.slice(head, after.length - tail)
  if (a.length * b.length > MAX_DIFF_CELLS) return null
  const width = b.length + 1
  const table = new Uint32Array((a.length + 1) * width)
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      table[i * width + j] =
        a[i] === b[j]
          ? table[(i + 1) * width + j + 1]! + 1
          : Math.max(table[(i + 1) * width + j]!, table[i * width + j + 1]!)
    }
  }
  const ops: DiffOp[] = before.slice(0, head).map(text => ({ op: ' ', text }))
  let i = 0
  let j = 0
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      ops.push({ op: ' ', text: a[i]! })
      i++
      j++
    } else if (j >= b.length || (i < a.length && table[(i + 1) * width + j]! >= table[i * width + j + 1]!)) {
      ops.push({ op: '-', text: a[i]! })
      i++
    } else {
      ops.push({ op: '+', text: b[j]! })
      j++
    }
  }
  return ops.concat(after.slice(after.length - tail).map(text => ({ op: ' ', text })))
}

// The header of a hunk whose first old and new lines are numbered `oldNo`
// and `newNo`; an empty side counts from the line before, as diff does.
function formatHeader(oldNo: number, newNo: number, oldCount: number, newCount: number): string {
  return `@@ -${oldCount === 0 ? oldNo - 1 : oldNo},${oldCount} +${newCount === 0 ? newNo - 1 : newNo},${newCount} @@`
}

function hunkHeader(oldNo: number, newNo: number, lines: readonly string[]): string {
  const oldCount = lines.filter(l => l[0] === ' ' || l[0] === '-').length
  const newCount = lines.filter(l => l[0] === ' ' || l[0] === '+').length
  return formatHeader(oldNo, newNo, oldCount, newCount)
}

// Unified-diff hunks turning `oldText` into `newText`, `context` unchanged
// lines around each change (hunks closer than twice that share one), the first
// line numbered `startLine`. '' when the texts are equal; null past 2000 lines
// on a side, where the caller draws its own plain view.
export function unifiedDiff(
  oldText: string,
  newText: string,
  options: { context?: number; startLine?: number } = {},
): string | null {
  const { context = 3, startLine = 1 } = options
  const before = linesOf(oldText)
  const after = linesOf(newText)
  if (before.length > MAX_DIFF_LINES || after.length > MAX_DIFF_LINES) return null
  const ops = diffOps(before, after)
  if (ops === null) return null
  const changed = ops.flatMap((o, i) => (o.op === ' ' ? [] : [i]))
  if (changed.length === 0) return ''

  // Runs of changes whose gap is within 2 * context become one hunk.
  const spans: [number, number][] = []
  for (const at of changed) {
    const last = spans.at(-1)
    if (last !== undefined && at - last[1] <= 2 * context + 1) last[1] = at
    else spans.push([at, at])
  }
  const numbers = (upTo: number) => {
    let oldNo = startLine
    let newNo = startLine
    for (const o of ops.slice(0, upTo)) {
      if (o.op !== '+') oldNo++
      if (o.op !== '-') newNo++
    }
    return { oldNo, newNo }
  }
  return spans
    .map(([first, last]) => {
      const from = Math.max(0, first - context)
      const lines = ops.slice(from, Math.min(ops.length, last + context + 1)).map(o => `${o.op}${o.text}`)
      const { oldNo, newNo } = numbers(from)
      return [hunkHeader(oldNo, newNo, lines), ...lines].join('\n')
    })
    .join('\n')
}

type Hunk = { oldNo: number; newNo: number; lines: string[] }

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/

// The hunks of a unified diff; null when the text is not one. Lines before
// the first hunk (a ---/+++ pair) are read past.
function parseHunks(diff: string): Hunk[] | null {
  const hunks: Hunk[] = []
  for (const line of diff.split('\n')) {
    const header = HUNK_HEADER.exec(line)
    if (header) {
      const [, a, b, c, d] = header
      hunks.push({
        oldNo: b === '0' ? Number(a) + 1 : Number(a),
        newNo: d === '0' ? Number(c) + 1 : Number(c),
        lines: [],
      })
    } else if (hunks.length > 0) {
      const op = line[0]
      if (op !== ' ' && op !== '+' && op !== '-' && op !== '\\') return null
      hunks.at(-1)!.lines.push(line)
    }
  }
  return hunks.length > 0 ? hunks : null
}

// A diff's tabs expanded as the engine draws its lines: the marker sits in
// the gutter, so the tab stops count from the text after it.
export function expandDiffTabs(diff: string): string {
  if (!diff.includes('\t')) return diff
  return diff
    .split('\n')
    .map(line => (line.includes('\t') ? line.slice(0, 1) + expandTabs(line.slice(1)) : line))
    .join('\n')
}

// Cuts a unified diff into pieces of at most `maxLines` lines and `maxChars`
// characters, each a valid diff: a hunk cut in the middle continues under a
// header that counts its own lines and carries on the numbers. A text that is
// no diff is returned whole; [] when not even a header and one line fit.
export function splitDiff(diff: string, maxLines: number, maxChars: number): string[] {
  const hunks = parseHunks(diff)
  if (hunks === null) return [diff]
  const pieces: string[] = []
  let done: string[] = []
  let doneChars = 0

  const finishPiece = () => {
    if (done.length > 0) pieces.push(done.join('\n'))
    done = []
    doneChars = 0
  }

  for (const hunk of hunks) {
    let oldNo = hunk.oldNo
    let newNo = hunk.newNo
    let startOld = oldNo
    let startNew = newNo
    let body: string[] = []
    let bodyChars = 0
    let oldCount = 0
    let newCount = 0

    // What the piece would hold with `extra` appended: counters, not a rebuild.
    const size = (extra: string) => {
      const o = oldCount + (extra[0] === ' ' || extra[0] === '-' ? 1 : 0)
      const n = newCount + (extra[0] === ' ' || extra[0] === '+' ? 1 : 0)
      return {
        lines: done.length + 1 + body.length + 1,
        chars: doneChars + formatHeader(startOld, startNew, o, n).length + 1 + bodyChars + extra.length + 1,
      }
    }
    const commit = () => {
      if (body.length === 0) return
      const text = [formatHeader(startOld, startNew, oldCount, newCount), ...body]
      done.push(...text)
      doneChars += text.reduce((sum, l) => sum + l.length + 1, 0)
      body = []
      bodyChars = 0
      oldCount = 0
      newCount = 0
      startOld = oldNo
      startNew = newNo
    }

    for (let line of hunk.lines) {
      let fit = size(line)
      if (fit.lines > maxLines || fit.chars > maxChars) {
        commit()
        finishPiece()
        fit = size(line)
        if (fit.lines > maxLines || fit.chars > maxChars) {
          // A line alone over the limit is cut so the piece stays valid.
          const room = maxChars - (fit.chars - line.length - 1) - 1
          if (room < 1 || maxLines < 2) return []
          line = line.slice(0, room)
        }
      }
      body.push(line)
      bodyChars += line.length + 1
      if (line[0] === ' ' || line[0] === '-') oldCount++
      if (line[0] === ' ' || line[0] === '+') newCount++
      if (line[0] !== '+' && line[0] !== '\\') oldNo++
      if (line[0] !== '-' && line[0] !== '\\') newNo++
    }
    commit()
  }
  finishPiece()
  return pieces
}

// clampText for a diff: the first piece splitDiff gives, with a note of the
// lines left out. '' text when not even a header and a line fit.
export function clampDiff(diff: string, maxLines: number, maxChars: number, ellipsis = '…'): Clamped {
  const hunks = parseHunks(diff)
  if (hunks === null) return clampText(diff, maxLines, maxChars, ellipsis)
  const pieces = splitDiff(diff, maxLines, maxChars)
  const first = pieces[0] ?? ''
  if (pieces.length === 1 && first === diff) return { text: diff }
  const total = hunks.reduce((sum, hunk) => sum + hunk.lines.length, 0)
  const shown = parseHunks(first)?.reduce((sum, hunk) => sum + hunk.lines.length, 0) ?? 0
  const hidden = total - shown
  return { text: first, note: `${ellipsis} (${hidden} line${hidden === 1 ? '' : 's'} hidden)` }
}
