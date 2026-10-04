// The pinned footer's layout: rows, columns and labels by the pane's width, and
// the trailing cells each key takes so a click between two keys lands.

export type FooterLayout = {
  // Rows the footer takes: the rule, the groups and the status line.
  rows: number
  // Groups side by side in two rows, or one group per row.
  columns: 'two' | 'stacked'
  // Whether the buttons carry their labels; without, only key and glyph.
  labels: boolean
}

const FOOTER_TWO_COLUMNS_FROM = 64
const FOOTER_LABELS_FROM = 40

// `groupRows`: the rows of keys the view draws; by default all of them.
export function footerLayout(columns: number, groupRows?: number): FooterLayout {
  const isTwo = columns >= FOOTER_TWO_COLUMNS_FROM
  const rows = 2 + (groupRows ?? (isTwo ? 2 : 4))
  if (isTwo) return { rows, columns: 'two', labels: true }
  return { rows, columns: 'stacked', labels: columns >= FOOTER_LABELS_FROM }
}

// The cells after each key of a row that belong to it, so a click between
// two keys lands on one: the gap to the next key, and for the last key of a
// column `width` wide the room up to it.
export function footerPads(widths: readonly number[], gap: number, width?: number): number[] {
  const used = widths.reduce((sum, w) => sum + w, 0) + gap * Math.max(0, widths.length - 1)
  return widths.map((_, i) => (i < widths.length - 1 ? gap : Math.max(0, (width ?? used) - used)))
}
