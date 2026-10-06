// The rows of a turn: thinking, calls and output, folded runs and subagent traces,
// each opening into its frames (rows and traces draw each other, so they live together).
import type { RenderElement } from 'claude-code'
import { C, modelColor } from '../theme'
import { groupLabel } from '../model/card'
import { shortModel } from '../model/format'
import { groupRuns, type GroupItem } from '../model/groups'
import { itemName, itemSummary } from '../model/summaries'
import { isAgentFinished, isAgentRunning, isSubagent, itemStatus, traceStats, type ItemStatus } from '../model/turns'
import type { Item, ToolItem } from '../model/types'
import { displayWidth, fitPath, padEndDisplay, pathOf } from '../model/width'
import {
  EXPANDED_INDENT,
  groupDuration,
  hasExpandedContent,
  itemDuration,
  LINE,
  ROW_SLACK,
  rowInset,
  textLine,
  type Ctx,
  type PaneActions,
  type TreePlace,
} from './context'
import { renderFrame, renderLong, renderSections } from './frames'
import { cutter, itemIcon, statusMark, TRACE_INDENT, type El } from './kit'
import { cardFor, renderLine, withWorkflowNote } from './row'

// Draws `rows` while the pane's budget holds a row more, each charged its
// width; the rows that no longer fit are counted on one line instead.
function fitRows<T>(
  el: El,
  rows: readonly T[],
  data: Ctx,
  key: string,
  inset: number,
  draw: (row: T, i: number) => RenderElement,
) {
  const cost = data.columns + ROW_SLACK
  const drawn: RenderElement[] = []
  for (const [i, row] of rows.entries()) {
    if (data.budget.left < cost) break
    data.budget.left -= cost
    drawn.push(draw(row, i))
  }
  const hidden = rows.length - drawn.length
  if (hidden === 0) return drawn
  const note = `${hidden} more row${hidden === 1 ? '' : 's'} ${data.icons.dash} pane text budget reached; collapse rows to see them`
  data.budget.left -= note.length
  data.layout.push(textLine(data, note, inset))
  const { Text } = el
  return [
    ...drawn,
    <Text key={`more-${key}`} color={C.muted}>
      {note}
    </Text>,
  ]
}

// The rows of a turn (no `path`) or of a trace (the guides of its parent
// levels): single items, and folded runs of calls.
export function renderRows(
  el: El,
  items: readonly Item[],
  data: Ctx,
  act: PaneActions,
  path?: readonly boolean[],
  nameWidth = nameWidthOf(items),
) {
  const rows = groupRuns(items)
  return fitRows(el, rows, data, rows[0]?.id ?? 'rows', path === undefined ? 0 : TRACE_INDENT, (row, i) => {
    const at = path === undefined ? undefined : { path, isLast: i === rows.length - 1 }
    return row.kind === 'group' ? renderGroup(el, row, data, act, at) : renderItem(el, row, data, act, at, nameWidth)
  })
}

// The failed calls in a subagent's trace and the traces under it that are
// loaded; interrupted calls do not count. `seen` stops a trace that names an
// agent already counted.
function failedUnder(items: readonly Item[], traces: Ctx['traces'], seen = new Set<string>()): number {
  let failed = 0
  for (const item of items) {
    if (item.kind !== 'tool') continue
    // A call the person interrupted is not a failure.
    if (item.isError && item.isInterrupted !== true) failed += 1
    if (isSubagent(item) && !seen.has(item.agentId)) {
      seen.add(item.agentId)
      const trace = traces.get(item.agentId)
      if (trace !== undefined && 'items' in trace) failed += failedUnder(trace.items, traces, seen)
    }
  }
  return failed
}

// A collapsed finished subagent says how many calls under it failed; open,
// its rows show them, and a running one is not counted yet.
function failedMark(item: Item, isOpen: boolean, data: Ctx): string | undefined {
  if (isOpen || !isSubagent(item) || !isAgentFinished(data.agents.get(item.agentId))) return undefined
  const trace = data.traces.get(item.agentId)
  if (trace === undefined || !('items' in trace)) return undefined
  const failed = failedUnder(trace.items, data.traces, new Set([item.agentId]))
  return failed > 0 ? `${data.icons.error}${failed}` : undefined
}

// The name column of a list: as wide as its widest name, at most NAME_CELLS,
// so the summaries of one turn, trace or folded run start in one column.
const NAME_CELLS = 12

export function nameWidthOf(items: readonly Item[], extra: readonly string[] = []): number {
  const names = [...items.map(itemName), ...extra]
  return Math.min(NAME_CELLS, Math.max(0, ...names.map(name => displayWidth(name))))
}

// A folded run: `Read ×7 · 4 files` with the total time as one bar. Open, it
// lists the original rows under tree guides.
// A group's state from its members, the most telling first.
const STATUS_ORDER: readonly ItemStatus[] = ['running', 'error', 'interrupted', 'idle', 'done']

function groupStatus(group: GroupItem, data: Ctx): ItemStatus {
  const states = group.items.map(item => itemStatus(item, { ...data, isAgentRunning: false }))
  return STATUS_ORDER.find(status => states.includes(status)) ?? 'done'
}

function renderGroup(el: El, group: GroupItem, data: Ctx, act: PaneActions, place?: TreePlace) {
  const { icons } = data
  const { Box } = el
  const isOpen = data.expanded.has(group.id)
  const status = groupStatus(group, data)
  // One name column for the run's calls, measured once.
  const nameWidth = nameWidthOf(group.items)
  const children = () =>
    isOpen && (
      <Box flexDirection="column">
        {fitRows(el, group.items, data, group.id, TRACE_INDENT, (child, i) =>
          renderItem(
            el,
            child,
            data,
            act,
            {
              path: place === undefined ? [] : [...place.path, !place.isLast],
              isLast: i === group.items.length - 1,
            },
            nameWidth,
          ),
        )}
      </Box>
    )
  return renderLine(
    el,
    {
      id: group.id,
      isOpen,
      canOpen: true,
      chevron: isOpen ? icons.expanded : icons.collapsed,
      mark: statusMark(status, data.frame, icons),
      icon: itemIcon(group.items[0]!, icons),
      label: room => cutter(icons)(groupLabel(group, icons), Math.max(8, room)),
      duration: groupDuration(group, data),
      onPress: () => act.toggle(group.id),
    },
    data,
    place,
    children,
  )
}

function renderItem(el: El, item: Item, data: Ctx, act: PaneActions, place: TreePlace | undefined, nameWidth: number) {
  const trunc = cutter(data.icons)
  const { icons } = data
  const isOpen = data.expanded.has(item.id)
  const canOpen = hasExpandedContent(item)
  const name = itemName(item)
  const summary = withWorkflowNote(item, itemSummary(item), data)

  // Only a row that opens has a chevron; the others keep its column blank.
  const chevron = !canOpen
    ? ' '
    : isSubagent(item)
      ? isOpen
        ? icons.expanded
        : icons.drill
      : isOpen
        ? icons.expanded
        : icons.collapsed

  // Tool rows lead with their state; output rows keep the column blank.
  const agent = item.kind === 'tool' && item.agentId ? data.agents.get(item.agentId) : undefined
  const mark =
    item.kind === 'tool'
      ? statusMark(itemStatus(item, { ...data, isAgentRunning: isAgentRunning(agent) }), data.frame, icons)
      : undefined

  const prefix = `${padEndDisplay(name, nameWidth)}  `
  return renderLine(
    el,
    {
      id: item.id,
      isOpen,
      canOpen,
      chevron,
      mark,
      icon: itemIcon(item, icons),
      label: room =>
        summary && item.kind === 'tool' && pathOf(item) !== ''
          ? prefix + fitPath(item, summary, Math.max(8, room - displayWidth(prefix)), icons.ellipsis)
          : trunc(summary ? prefix + summary : name, Math.max(8, room)),
      duration: itemDuration(item, data),
      badge: failedMark(item, isOpen, data),
      model: item.kind === 'tool' && item.agentId ? data.agentStats[item.agentId]?.model : undefined,
      onPress: () => canOpen && act.toggle(item.id),
      ...(isOpen || !canOpen ? {} : { card: cardFor(item, data, place) }),
    },
    data,
    place,
    shown => isOpen && canOpen && renderExpanded(el, item, data, act, place, shown),
  )
}

function renderExpanded(el: El, item: Item, data: Ctx, act: PaneActions, place: TreePlace | undefined, shown: string) {
  const { Box, Text } = el

  if (item.kind === 'output') {
    const frame = renderFrame(
      el,
      item.id,
      'message',
      undefined,
      false,
      C.accent,
      renderLong(el, item.id, item.text, { kind: 'markdown' }, data, act),
      item.text,
      data,
      act,
      rowInset(place) + EXPANDED_INDENT,
    )
    data.layout.push(LINE)
    return (
      <Box flexDirection="column" marginLeft={4} marginBottom={1}>
        {frame}
      </Box>
    )
  }

  if (isSubagent(item)) {
    if (data.tracing?.includes(item.agentId)) {
      const note = 'Trace shown above.'
      data.layout.push(textLine(data, note, rowInset(place) + EXPANDED_INDENT))
      return (
        <Box marginLeft={4}>
          <Text color={C.muted}>{note}</Text>
        </Box>
      )
    }
    return renderTrace(el, item, data, act, place)
  }

  return renderSections(el, item, data, act, rowInset(place), shown)
}

function renderTrace(el: El, item: ToolItem & { agentId: string }, data: Ctx, act: PaneActions, place?: TreePlace) {
  const trunc = cutter(data.icons)
  const { icons } = data
  const { Box, Text } = el
  const trace = data.traces.get(item.agentId)
  const model = data.agentStats[item.agentId]?.model

  // The line above the trace draws from the pane's budget like a row.
  data.budget.left -= data.columns + ROW_SLACK
  const inset = rowInset(place) + EXPANDED_INDENT
  if (!trace) {
    data.layout.push(textLine(data, `Loading trace${data.icons.ellipsis}`, inset))
    return (
      <Box marginLeft={4}>
        <Text color={C.muted}>{`Loading trace${data.icons.ellipsis}`}</Text>
      </Box>
    )
  }
  if ('denied' in trace) {
    const denied = `Trace unavailable: ${trunc(trace.denied, 300)}`
    data.budget.left -= denied.length
    data.layout.push(textLine(data, denied, inset))
    const sections = renderSections(el, item, data, act, inset)
    data.layout.push(LINE)
    return (
      <Box flexDirection="column" marginLeft={4} marginBottom={1}>
        <Text color={C.muted}>{denied}</Text>
        {sections}
      </Box>
    )
  }

  const stats = traceStats(trace.items)
  const modelText = model === undefined ? '' : ` ${icons.dot} ${shortModel(model)}`
  data.layout.push(
    textLine(
      data,
      `${icons.system}  Execution Trace ${icons.dot} ${stats.tools} tool calls, ${stats.messages} messages${modelText}`,
      inset,
    ),
  )
  // Its rows, drawn with this agent on the path, so a trace naming it again stops.
  data.tracing?.push(item.agentId)
  const rows = renderRows(el, trace.items, data, act, place === undefined ? [] : [...place.path, !place.isLast])
  data.tracing?.pop()
  const traced = (
    <Box flexDirection="column" marginBottom={1}>
      <Box flexDirection="row" marginLeft={4}>
        <Text color={C.muted}>{`${icons.system}  `}</Text>
        <Text bold color={C.text}>
          Execution Trace
        </Text>
        <Text color={C.muted}>{` ${icons.dot} ${stats.tools} tool calls, ${stats.messages} messages`}</Text>
        {model !== undefined && <Text color={C.muted}>{` ${icons.dot} `}</Text>}
        {model !== undefined && <Text color={modelColor(model) ?? C.text}>{shortModel(model)}</Text>}
      </Box>
      {rows}
    </Box>
  )
  // The blank row under the trace.
  data.layout.push(LINE)
  return traced
}
