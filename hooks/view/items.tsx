// The rows of a turn: thinking, calls and output, folded runs and subagent traces,
// each opening into its frames (rows and traces draw each other, so they live together).
import type { RenderChildren, RenderElement } from 'claude-code'
import { C, modelColor, type ThemeKey } from '../theme'
import { groupLabel, hoverCard } from '../model/card'
import { formatDuration, shortModel, treePrefix } from '../model/format'
import { groupRuns, type GroupItem } from '../model/groups'
import { itemName, itemSummary } from '../model/summaries'
import { isAgentRunning, isSubagent, itemStatus, traceStats, type ItemStatus } from '../model/turns'
import type { Item, ToolItem, Turn } from '../model/types'
import { displayWidth, durationBar, fitPath, padEndDisplay, pathOf } from '../model/width'
import {
  CARD_INDENT,
  CARD_SLACK,
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
import {
  BAR_CELLS,
  BAR_MIN_COLUMNS,
  buttonHover,
  cutter,
  endWrap,
  HOVER_TEXT,
  itemIcon,
  scopeOf,
  statusMark,
  TRACE_INDENT,
  type El,
} from './kit'

// The turn's thinking as one row above the items, when any of it is
// readable; expanded, it reads as highlighted Markdown like the model's output.
export function renderThinking(el: El, turn: Turn, data: Ctx, act: PaneActions) {
  const trunc = cutter(data.icons)
  const { icons } = data
  const { Box, Button, Text } = el
  const thinking = data.thinking
  if (thinking === undefined || thinking.text === '') return undefined
  const id = `t${turn.index}:thinking`
  const isOpen = data.expanded.has(id)
  // The label fills the row after its chevron and glyph columns (6 cells).
  const label = padEndDisplay(
    trunc(`${padEndDisplay('Thinking', 12)} - ${thinking.text}`, Math.max(8, data.columns - 8)),
    Math.max(8, data.columns - 6),
  )
  data.layout.push({ kind: 'line', id })
  const frame =
    isOpen &&
    renderFrame(
      el,
      id,
      'thinking',
      undefined,
      false,
      C.accent,
      renderLong(el, id, thinking.text, { kind: 'markdown' }, data, act),
      thinking.text,
      data,
      act,
      EXPANDED_INDENT,
    )
  // The blank row under an open frame.
  if (isOpen) data.layout.push(LINE)
  return (
    <Box key={`item-${id}`} flexDirection="column">
      <Box flexDirection="row">
        <Button
          key={`chevron-${id}`}
          plain
          dimColor
          hover={buttonHover(scopeOf('chev:', id))}
          label={`${isOpen ? icons.expanded : icons.collapsed} `}
          onPress={() => act.toggle(id)}
        />
        <Text color={C.muted}>{'  '}</Text>
        <Text color={C.accent}>{`${icons.thinking} `}</Text>
        <Button
          key={id}
          plain
          dimColor
          hover={buttonHover(scopeOf('btn:', id))}
          label={label}
          onPress={() => act.toggle(id)}
        />
      </Box>
      {isOpen && (
        <Box flexDirection="column" marginLeft={4} marginBottom={1}>
          {frame}
        </Box>
      )}
    </Box>
  )
}

// A Workflow row says where it stands: running while the latest turn works,
// done once it answered, no result when its turn ended without one.
function withWorkflowNote(item: Item, summary: string, data: Ctx): string {
  const { icons } = data
  if (item.kind !== 'tool' || item.tool !== 'Workflow') return summary
  const note = !item.isPending ? 'done' : data.isLatest && data.isWorking ? 'running' : 'no result'
  return summary === '' ? note : `${summary} ${icons.dot} ${note}`
}

// What one row of the item list shows; renderLine lays it out in the fixed
// columns (chevron, status, icon, label, model, duration, bar).
type Line = {
  id: string
  isOpen: boolean
  canOpen: boolean
  chevron: string
  mark?: { glyph: string; color: ThemeKey }
  icon: { glyph: string; color?: ThemeKey }
  // The label cut to the room (cells) the fixed columns leave.
  label: (room: number) => string
  duration?: number
  model?: string
  onPress: () => void
  // The lines of the card a hover on the row reveals.
  card?: readonly string[]
}

// `below` draws what an open row shows under it, after the row itself is
// recorded, so the rows of the content are recorded top to bottom.
function renderLine(el: El, line: Line, data: Ctx, place: TreePlace | undefined, below?: () => RenderChildren) {
  data.layout.push({ kind: 'line', id: line.id })
  const under = below?.()
  const { icons } = data
  const { Box, Button, Text } = el
  const { id, isOpen, canOpen, icon, mark, duration, model } = line
  const guide = place === undefined ? '' : treePrefix(place.path, place.isLast, icons)
  // Only the first level is moved in; deeper rows start in the same column
  // and the tree prefix alone draws their indent.
  const indent = place === undefined || place.path.length > 0 ? 0 : TRACE_INDENT
  const width = Math.max(20, data.columns - (place === undefined ? 0 : TRACE_INDENT))
  const modelText = model === undefined ? '' : `${shortModel(model)}  `
  const durationText =
    duration === undefined ? '' : duration >= 1000 ? formatDuration(duration) : duration > 0 ? '<1s' : ''

  // One button carries name and summary, so a click or Enter anywhere on the
  // row toggles it; the label is cut to the room the fixed columns leave.
  const hasBar = data.columns >= BAR_MIN_COLUMNS
  const barRoom = hasBar ? BAR_CELLS + 1 : 0
  // Once a cursor exists every row keeps one cell for its marker.
  const hasCursorColumn = data.cursor !== undefined && data.cursor !== null
  const room =
    width - displayWidth(guide) - 2 - 3 - 2 - displayWidth(modelText) - 2 - 7 - barRoom - (hasCursorColumn ? 1 : 0)
  // A row that opens takes a click anywhere from the chevron to the model
  // column: the chevron is a button too, and the label fills its room.
  const label = canOpen ? padEndDisplay(line.label(room), room) : line.label(room)
  const hover = { scope: scopeOf('row:', id), backgroundColor: C.rowHover }

  return (
    <Box key={`item-${id}`} flexDirection="column" marginLeft={indent}>
      <Box flexDirection="row" width={width}>
        {hasCursorColumn && (
          <Text key={`cursor-${id}`} color={data.cursor === id ? C.accent : C.muted}>
            {data.cursor === id ? icons.cursor : ' '}
          </Text>
        )}
        {guide !== '' && (
          <Text key={`guide-${id}`} color={C.muted}>
            {guide}
          </Text>
        )}
        {canOpen ? (
          <Button
            key={`chevron-${id}`}
            plain
            dimColor
            label={`${line.chevron} `}
            hover={buttonHover(scopeOf('chev:', id))}
            onPress={line.onPress}
          />
        ) : (
          <Text color={isOpen ? C.text : C.muted} hover={hover}>{`${line.chevron} `}</Text>
        )}
        <Text key={`status-${id}`} color={mark?.color ?? C.muted} hover={hover}>
          {mark === undefined ? '  ' : `${mark.glyph} `}
        </Text>
        <Text color={icon.color ?? C.muted} hover={hover}>
          {`${icon.glyph} `}
        </Text>
        <Box flexGrow={1} flexShrink={1}>
          {canOpen ? (
            <Button key={id} plain dimColor label={label} hover={{ ...hover, ...HOVER_TEXT }} onPress={line.onPress} />
          ) : (
            <Text color={C.muted} wrap={endWrap(data.icons)} hover={hover}>
              {label}
            </Text>
          )}
        </Box>
        <Box flexShrink={0}>
          {modelText !== '' && model !== undefined && (
            <Text color={modelColor(model) ?? C.text} hover={hover}>
              {modelText}
            </Text>
          )}
          <Text color={C.ongoing} hover={hover}>
            {durationText !== '' ? `${icons.dot} ` : '  '}
          </Text>
          <Text color={C.muted} hover={hover}>
            {`${padEndDisplay(durationText, 7)}${hasBar ? ' ' : ''}`}
          </Text>
          {hasBar && (
            <Text
              key={`bar-${id}`}
              color={duration !== undefined && duration > 0 && duration >= data.maxMs ? C.accent : C.muted}
              hover={hover}
            >
              {padEndDisplay(
                duration === undefined ? '' : durationBar(duration, data.maxMs, BAR_CELLS, icons),
                BAR_CELLS,
              )}
            </Text>
          )}
        </Box>
      </Box>
      {line.card !== undefined && (
        <Box
          key={`card-${id}`}
          position="absolute"
          display="none"
          // Above its row: an absolute Box is painted over what comes before
          // it, and the rows after it would draw over a card placed below.
          bottom={1}
          left={CARD_INDENT}
          backgroundColor={C.paneBackground}
          flexDirection="column"
          borderStyle={icons.border}
          borderColor={C.muted}
          paddingX={1}
          hover={{ scope: scopeOf('row:', id), display: 'flex' }}
        >
          {line.card.map(text => (
            <Text color={C.muted}>{text}</Text>
          ))}
        </Box>
      )}
      {under}
    </Box>
  )
}

// The hover card of a collapsed tool row: the first lines of its input, while
// the cards' share of the pane's budget lasts. The first card that does not
// fit spends it, so the rows after it build none.
function cardFor(item: Item, data: Ctx, place: TreePlace | undefined): readonly string[] | undefined {
  if (item.kind !== 'tool' || data.cardBudget.left <= 0) return undefined
  const width = data.columns - CARD_SLACK - (place === undefined ? 0 : TRACE_INDENT)
  const lines = hoverCard(item, Math.max(8, width), data.icons)
  if (lines === undefined) return undefined
  const cost = lines.reduce((sum, line) => sum + line.length, 0)
  if (cost > Math.min(data.cardBudget.left, data.budget.left)) {
    data.cardBudget.left = 0
    return undefined
  }
  data.cardBudget.left -= cost
  data.budget.left -= cost
  return lines
}

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
