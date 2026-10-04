// What a drawing of the pane knows and may do: its data and budgets, the rows
// it records for the scroll estimate, and the actions its buttons call.
import type { AgentStatus, RenderSurface } from 'claude-code'
import type { Icons } from '../icons'
import type { AgentStat, ToolTiming, TurnStat } from '../../types'
import type { RenderElement } from 'claude-code'
import { groupRuns, type GroupItem } from '../model/groups'
import type { RowBlock, ScrollFrame } from '../model/scroll'
import type { TurnMatch } from '../model/search'
import type { TaskEntry, TeamMember } from '../model/team'
import type { TurnThinking } from '../model/thinking'
import { isSubagent } from '../model/turns'
import type { Item, Turn } from '../model/types'
import { TRACE_INDENT } from './kit'

export type Trace = { items: Item[] } | { denied: string }

export type PaneData = {
  // Whether the person has given the pane the keyboard; left out when the
  // engine does not say.
  isFocused?: boolean
  // Whether the info bar shows above the prompt: it takes the first
  // ctrl+x tab, the pane the second.
  isBarShown?: boolean
  // The turn the turn list's cursor stands on; null or left out for none.
  turnCursor?: number | null
  // Thinking of the shown turn: how many blocks, and their readable text.
  thinking?: TurnThinking
  turns: Turn[]
  selected: number
  expanded: ReadonlySet<string>
  timings: Record<string, ToolTiming>
  turnStat?: TurnStat
  sessionModel: string
  contextPercent?: number
  isLatest: boolean
  isWorking: boolean
  // The glyph set; Nerd Font when left out.
  icons?: Icons
  now: number
  frame: number
  agents: ReadonlyMap<string, AgentStatus>
  agentStats: Record<string, AgentStat>
  traces: ReadonlyMap<string, Trace>
  columns: number
  // The rows the engine gives the pane's body: the pane is drawn exactly this tall.
  rows: number
  // How many rows the shown view's content is scrolled up in its window; 0
  // when left out, clamped to the content when drawn.
  scrollTop?: number
  // Blocks shown whole instead of previewed, by block id.
  full: ReadonlySet<string>
  // What the pane shows, and the stat recorded for each turn (by index).
  view: 'detail' | 'turns' | 'team'
  stats: readonly (TurnStat | undefined)[]
  // The turn search: what is typed, and the turns that match it.
  query?: string
  matches?: readonly TurnMatch[]
  // The team board: teammates and the tasks of TaskCreate / TaskUpdate.
  members?: readonly TeamMember[]
  tasks?: readonly TaskEntry[]
  // The row the keyboard cursor stands on; none when null or left out.
  cursor?: string | null
}

// The engine refuses a tree with a text over 10000 characters or over 100000
// characters of text in total. Long blocks are cut into TEXT_CHUNK pieces,
// and every row, block and card draws from one budget per pane; what is left
// over is room for the header, the nav and the footer.
export const TEXT_CHUNK = 8000

export const PANE_TEXT_BUDGET = 85_000

// What a row is charged beyond its width: its fixed columns may carry a few
// characters that take no cell.
export const ROW_SLACK = 8

// What the pinned footer and the window's more above / below rows are charged
// out of the pane's budget: buttons, rule and status text, with room to spare.
export const FOOTER_BUDGET = 1500

// What a hunk header the splitting of a long diff adds may take at most.
export const DIFF_HEADER_SLACK = 40

// What all hover cards of a pane may carry together, out of the pane's
// budget; rows after it have none.
export const CARD_BUDGET = 20_000

// A card sits this far in from the row's edge, and is this much narrower
// than the row (its border and padding).
export const CARD_INDENT = 4

export const CARD_SLACK = 8

export const PREVIEW = {
  text: { lines: 100, chars: TEXT_CHUNK },
  code: { lines: 60, chars: TEXT_CHUNK },
  diff: { lines: 60, chars: TEXT_CHUNK },
  markdown: { lines: Infinity, chars: 30_000 },
} as const

// Render-time state: what is left of the pane's text budget.
export type Ctx = PaneData & {
  icons: Icons
  budget: { left: number }
  // The most the hover cards may still take of `budget`.
  cardBudget: { left: number }
  // The longest measured call of the shown turn: what a bar is relative to.
  maxMs: number
  // The content's blocks as drawn, top to bottom: what its rows are estimated from.
  layout: RowBlock[]
}

// One row of the content (an item row with its id), recorded as it is drawn.
export const LINE: RowBlock = { kind: 'line' }

// The cells a text of the content wraps at: the pane's body less `inset`
// cells (indents, borders). Measured in the engine: the body is
// `columns` wide, a frame's body under an open row `columns - 8`.
export const wrapWidth = (data: Ctx, inset: number) => Math.max(1, data.columns - inset)

// A row of text that wraps at the room `inset` leaves; one row where it is cut.
export const textLine = (data: Ctx, text: string, inset: number, isCut = false): RowBlock =>
  isCut ? LINE : { kind: 'line', text, width: wrapWidth(data, inset) }

// What a row of the turn or a trace is moved in by: the first trace level.
export const rowInset = (place: TreePlace | undefined) => (place === undefined ? 0 : TRACE_INDENT)

// A frame's border and padding, both sides, and the indent of an open
// row's frames under it.
export const FRAME_INSET = 4

export const EXPANDED_INDENT = 4

// Beside numbered code the engine draws its widest line number and 2 cells.
export const CODE_GUTTER = 2

export type PaneActions = {
  copy: (text: string, surface?: RenderSurface) => void
  toggle: (id: string) => void
  prev: () => void
  next: () => void
  latest: () => void
  expandAll: () => void
  collapseAll: () => void
  toggleFull: (id: string) => void
  showTurns: () => void
  showDetail: () => void
  showTeam: () => void
  pickTurn: (index: number) => void
  search: (query: string) => void
  submitSearch: (query: string) => void
  focusSearch: () => void
  // The cursor keys get where the window stands and where each row starts,
  // to keep the row under the cursor in view.
  cursorDown: (at: ScrollFrame) => void
  cursorUp: (at: ScrollFrame) => void
  // Scrolls the shown view's content to `scrollTop` rows.
  scroll: (scrollTop: number) => void
  // Told where the window stands at each drawing: the engine's wheel and
  // scroll keys move the content from there.
  measure: (at: ScrollFrame) => void
  // Expands or collapses the row under the cursor.
  cursorOpen: () => void
  // Copies the whole text of the row under the cursor.
  copyCursor: (surface?: RenderSurface) => void
}

export function itemDuration(item: Item, data: Pick<PaneData, 'agentStats' | 'timings' | 'now'>): number | undefined {
  if (item.kind !== 'tool') return undefined
  if (item.agentId !== undefined) {
    const d = item.durationMs ?? data.agentStats[item.agentId]?.durationMs
    if (d !== undefined) return d
  }
  if (item.durationMs !== undefined) return item.durationMs
  const timing = data.timings[item.id.split('/').at(-1) ?? item.id]
  if (!timing) return undefined
  return (timing.end ?? (item.isPending ? data.now : timing.start)) - timing.start
}

type Timed = Pick<PaneData, 'agentStats' | 'timings' | 'now'>

// A group's time: the sum of its measured calls, none when none is measured.
export function groupDuration(group: GroupItem, data: Timed): number | undefined {
  const times = group.items.map(item => itemDuration(item, data)).filter(d => d !== undefined)
  return times.length === 0 ? undefined : times.reduce((sum, d) => sum + d, 0)
}

// The loaded traces of the subagents among `items`, nested ones included.
export function tracesOf(items: readonly Item[], traces: PaneData['traces']): Item[][] {
  return items.filter(isSubagent).flatMap(item => {
    const trace = traces.get(item.agentId)
    return trace && 'items' in trace ? [trace.items, ...tracesOf(trace.items, traces)] : []
  })
}

// The longest measured row among the turn's and its loaded traces' (a
// folded run counts as its total).
export function longestCall(input: PaneData, turn: Turn | undefined): number {
  const lists = [turn?.items ?? [], ...tracesOf(turn?.items ?? [], input.traces)]
  const rows = lists.flatMap(items => groupRuns(items))
  return Math.max(
    0,
    ...rows.map(row => (row.kind === 'group' ? groupDuration(row, input) : itemDuration(row, input)) ?? 0),
  )
}

export function hasExpandedContent(item: Item): boolean {
  if (item.kind === 'output') return item.text.trim() !== ''
  return isSubagent(item) || Object.keys(item.input).length > 0 || (item.resultText ?? '') !== ''
}

// Records a block of the content as it is drawn and returns it.
export function drawn<T>(data: Ctx, node: T, block: RowBlock): T {
  data.layout.push(block)
  return node
}

// What a view draws: the rows that stay on top (and how many), and the
// content that scrolls in the window under them.
export type PaneParts = { header: readonly HeaderPart[]; content: RenderElement }

// One part of the header and the rows it is given: each part is drawn in a
// box of exactly that height, so the header is as tall as their sum.
export type HeaderPart = { node: RenderElement; rows: number }

// The search field: "every surface's one-line text field" (InputProps), with
// its submit label beside it while focused.
export const INPUT_ROWS = 1

// Where a row of a subagent's trace sits in the tree: which parent levels
// still continue, and whether it is the last of its siblings.
export type TreePlace = { path: readonly boolean[]; isLast: boolean }
