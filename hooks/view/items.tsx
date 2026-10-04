// The rows of a turn: thinking, calls and output, folded runs and subagent traces,
// each opening into its frames (rows and traces draw each other, so they live together).
import type { RenderElement } from 'claude-code'
import { C, modelColor } from '../theme'
import { groupLabel } from '../model/card'
import { shortModel } from '../model/format'
import { groupRuns, type GroupItem } from '../model/groups'
import { itemName, itemSummary } from '../model/summaries'
import { isAgentRunning, isSubagent, itemStatus, traceStats, type ItemStatus } from '../model/turns'
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
export function renderRows(el: El, items: readonly Item[], data: Ctx, act: PaneActions, path?: readonly boolean[]) {
  const rows = groupRuns(items)
  return fitRows(el, rows, data, rows[0]?.id ?? 'rows', path === undefined ? 0 : TRACE_INDENT, (row, i) => {
    const at = path === undefined ? undefined : { path, isLast: i === rows.length - 1 }
    return row.kind === 'group' ? renderGroup(el, row, data, act, at) : renderItem(el, row, data, act, at)
  })
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
  const children = () =>
    isOpen && (
      <Box flexDirection="column">
        {fitRows(el, group.items, data, group.id, TRACE_INDENT, (child, i) =>
          renderItem(el, child, data, act, {
            path: place === undefined ? [] : [...place.path, !place.isLast],
            isLast: i === group.items.length - 1,
          }),
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

function renderItem(el: El, item: Item, data: Ctx, act: PaneActions, place?: TreePlace) {
  const trunc = cutter(data.icons)
  const { icons } = data
  const isOpen = data.expanded.has(item.id)
  const canOpen = hasExpandedContent(item)
  const name = itemName(item)
  const summary = withWorkflowNote(item, itemSummary(item), data)

  const chevron = !canOpen
    ? icons.selected
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

  const prefix = `${padEndDisplay(name, 12)} - `
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
      model: item.kind === 'tool' && item.agentId ? data.agentStats[item.agentId]?.model : undefined,
      onPress: () => canOpen && act.toggle(item.id),
      ...(isOpen || !canOpen ? {} : { card: cardFor(item, data, place) }),
    },
    data,
    place,
    () => isOpen && canOpen && renderExpanded(el, item, data, act, place),
  )
}

function renderExpanded(el: El, item: Item, data: Ctx, act: PaneActions, place?: TreePlace) {
  const { Box } = el

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
    return renderTrace(el, item, data, act, place)
  }

  return renderSections(el, item, data, act, rowInset(place))
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
      {renderRows(el, trace.items, data, act, place === undefined ? [] : [...place.path, !place.isLast])}
    </Box>
  )
  // The blank row under the trace.
  data.layout.push(LINE)
  return traced
}
