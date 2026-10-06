// The keyboard cursor over the detail rows: which rows it stands on, a step,
// and the text of the row under it.
import { DEFAULT_GLYPHS, type Glyphs } from './format'
import { groupRuns, type Row } from './groups'
import { cachedSections } from './sections'
import { isSubagent } from './turns'
import type { Item } from './types'

// The trace rows of a subagent, when they are loaded.
export type ChildrenOf = (agentId: string) => readonly Item[] | undefined

// The ids of the rows the cursor can stand on, top to bottom: a folded run
// is one row and shows its calls only while open; a subagent's trace rows
// count only while the subagent is open. `seen` stops a trace that names an
// agent already walked (itself, or a cycle of two).
export function cursorRows(
  items: readonly Item[],
  open: ReadonlySet<string>,
  childrenOf: ChildrenOf,
  seen = new Set<string>(),
): string[] {
  const ids: string[] = []
  for (const row of groupRuns(items)) {
    ids.push(row.id)
    if (row.kind === 'group') {
      if (open.has(row.id)) ids.push(...row.items.map(item => item.id))
    } else if (isSubagent(row) && open.has(row.id) && !seen.has(row.agentId)) {
      seen.add(row.agentId)
      ids.push(...cursorRows(childrenOf(row.agentId) ?? [], open, childrenOf, seen))
    }
  }
  return ids
}

// The row one step from `current` (`delta` -1 or 1), clipped to the first and
// last row. Without a cursor on the list, going down enters at the first row
// and going up at the last; an empty list has none.
export function moveCursor(ids: readonly string[], current: string | null, delta: number): string | null {
  if (ids.length === 0) return null
  const at = current === null ? -1 : ids.indexOf(current)
  if (at < 0) return delta < 0 ? ids.at(-1)! : ids[0]!
  return ids[Math.min(ids.length - 1, Math.max(0, at + delta))]!
}

// The row with `id` among `items`, a folded run's calls and the loaded traces
// of subagents included. `seen` stops a trace that names itself.
function findRow(items: readonly Item[], id: string, childrenOf: ChildrenOf, seen: Set<string>): Row | undefined {
  for (const row of groupRuns(items)) {
    if (row.id === id) return row
    if (row.kind === 'group') {
      const call = row.items.find(item => item.id === id)
      if (call !== undefined) return call
    } else if (isSubagent(row) && !seen.has(row.agentId)) {
      seen.add(row.agentId)
      const found = findRow(childrenOf(row.agentId) ?? [], id, childrenOf, seen)
      if (found !== undefined) return found
    }
  }
  return undefined
}

function itemFullText(item: Item, glyphs: Glyphs): string {
  if (item.kind === 'output') return item.text
  return cachedSections(item, glyphs)
    .map(section => section.body)
    .join('\n\n')
}

// Everything the row's frames hold, whole (what `y` copies); a folded run
// joins its calls. Undefined when no such row is drawn.
export function rowText(
  items: readonly Item[],
  id: string,
  childrenOf: ChildrenOf,
  glyphs: Glyphs = DEFAULT_GLYPHS,
): string | undefined {
  const row = findRow(items, id, childrenOf, new Set())
  if (row === undefined) return undefined
  if (row.kind === 'group') return row.items.map(item => itemFullText(item, glyphs)).join('\n\n')
  return itemFullText(row, glyphs)
}
