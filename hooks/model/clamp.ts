// Caps on long text: lines and characters with a note on what was cut, and
// pieces small enough for one element.

// Caps text to maxLines and maxChars, with a note on what was cut.
export type Clamped = { text: string; note?: string }

export function clampText(text: string, maxLines: number, maxChars: number, ellipsis = '…'): Clamped {
  const lines = text.split('\n')
  const kept = lines.length > maxLines ? lines.slice(0, maxLines).join('\n') : text
  const hiddenLines = Math.max(0, lines.length - maxLines)
  const chars = [...kept]
  if (chars.length > maxChars) {
    const hiddenChars = chars.length - maxChars
    const more = hiddenLines > 0 ? `, ${hiddenLines} more line${hiddenLines === 1 ? '' : 's'}` : ''
    return { text: chars.slice(0, maxChars).join(''), note: `${ellipsis} (${hiddenChars} chars hidden${more})` }
  }
  return hiddenLines > 0
    ? { text: kept, note: `${ellipsis} (${hiddenLines} line${hiddenLines === 1 ? '' : 's'} hidden)` }
    : { text }
}

// Splits text into pieces of at most `size` characters, at a newline when
// one falls in the second half of a piece, so each piece stays under the
// engine's per-element limit while a long output can still be shown whole.
// Joining the pieces with '\n' where the cut fell on a newline restores the
// text; a hard cut (no newline) joins with ''.
export function chunkText(text: string, size: number): string[] {
  const chunks: string[] = []
  let rest = text
  while (rest.length > size) {
    const cut = rest.lastIndexOf('\n', size)
    if (cut >= size / 2) {
      chunks.push(rest.slice(0, cut))
      rest = rest.slice(cut + 1)
    } else {
      chunks.push(rest.slice(0, size))
      rest = rest.slice(size)
    }
  }
  chunks.push(rest)
  return chunks
}
