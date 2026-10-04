// Grouped runs: three or more calls of one category in a row fold into one row.
import { toolCategory, type ToolCategory } from './summaries'
import type { Item, ToolItem } from './types'

//
// Three or more consecutive calls of one read, search or web tool in a turn
// fold into one row; an error call, another tool or a message ends the run.

export type GroupItem = { kind: 'group'; id: string; tool: string; items: ToolItem[] }
export type Row = Item | GroupItem

const MIN_RUN = 3
const GROUPED_CATEGORIES = new Set<ToolCategory>(['read', 'search', 'web'])

const isGroupable = (item: Item): item is ToolItem =>
  item.kind === 'tool' && !item.isError && GROUPED_CATEGORIES.has(toolCategory(item.tool))

// The id derives from the first call, so an open group stays open as the
// run grows with every tick.
export function groupRuns(items: readonly Item[]): Row[] {
  const rows: Row[] = []
  let at = 0
  while (at < items.length) {
    const first = items[at]!
    let end = at + 1
    if (isGroupable(first)) while (end < items.length && isRunOf(first, items[end]!)) end++
    if (end - at >= MIN_RUN) {
      rows.push({
        kind: 'group',
        id: `group:${first.id}`,
        tool: (first as ToolItem).tool,
        items: items.slice(at, end) as ToolItem[],
      })
    } else rows.push(...items.slice(at, end))
    at = end
  }
  return rows
}

const isRunOf = (first: ToolItem, item: Item): boolean => isGroupable(item) && item.tool === first.tool
