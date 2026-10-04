// Rendering: the detail view (pane) and the info bar (band). Takes plain
// data plus callbacks and returns element trees; no engine calls here.
import type { RenderChildren, RenderElement } from 'claude-code'

import type { GitInfo } from '../types'
import { ICON_SETS, type Icons } from './icons'
import { agentStatusColor, C, contextColor, modeColor, modelColor, TONE, type ThemeKey } from './theme'
import type { WorkflowState } from './model/activity'
import { groupLabel, hoverCard } from './model/card'
import { chunkText, clampText } from './model/clamp'
import { clampDiff, splitDiff } from './model/diff'
import {
  contextMeter,
  formatClock,
  formatDuration,
  formatTokens,
  shortMode,
  shortModel,
  treePrefix,
} from './model/format'
import { groupRuns, type GroupItem } from './model/groups'
import { sanitizeText } from './model/sanitize'
import { clampScroll, contentRows, overflowRows, type RowBlock, type ScrollFrame } from './model/scroll'
import { splitMatch } from './model/search'
import { cachedSections, firstErrorLine, pieceStarts, reserveSections, type Section } from './model/sections'
import { itemName, itemSummary } from './model/summaries'
import { taskMark, type TaskEntry, type TeamMember } from './model/team'
import { EMPTY_TURN_TEXT, turnTable } from './model/turn-table'
import { isAgentRunning, isSubagent, itemStatus, traceStats, type ItemStatus } from './model/turns'
import type { Item, ToolItem, Turn } from './model/types'
import { displayWidth, durationBar, fitPath, padEndDisplay, pathOf, truncateMiddle } from './model/width'
import {
  CARD_BUDGET,
  CARD_INDENT,
  CARD_SLACK,
  CODE_GUTTER,
  DIFF_HEADER_SLACK,
  drawn,
  EXPANDED_INDENT,
  FOOTER_BUDGET,
  FRAME_INSET,
  groupDuration,
  hasExpandedContent,
  INPUT_ROWS,
  itemDuration,
  LINE,
  longestCall,
  PANE_TEXT_BUDGET,
  PREVIEW,
  ROW_SLACK,
  rowInset,
  TEXT_CHUNK,
  textLine,
  tracesOf,
  wrapWidth,
  type Ctx,
  type HeaderPart,
  type PaneActions,
  type PaneData,
  type PaneParts,
  type TreePlace,
} from './view/context'
import { focusChord, footerRowsOf, renderFooter, STATUS_INSET } from './view/footer'
import {
  BAR_CELLS,
  BAR_METER_COLUMNS,
  BAR_MIN_COLUMNS,
  buttonHover,
  cutter,
  endWrap,
  HEADER_METER_COLUMNS,
  HOVER_TEXT,
  isUnicodeCut,
  itemIcon,
  METER_CELLS,
  middleWrap,
  scopeOf,
  statusMark,
  TRACE_INDENT,
  type El,
} from './view/kit'

// -- Detail view --------------------------------------------------------------

export function renderPane(el: El, input: PaneData, act: PaneActions) {
  const { Box, Text } = el
  const turn = input.turns[input.selected]
  const data: Ctx = {
    ...input,
    icons: input.icons ?? ICON_SETS.nerd,
    budget: { left: PANE_TEXT_BUDGET - FOOTER_BUDGET },
    cardBudget: { left: CARD_BUDGET },
    maxMs: longestCall(input, turn),
    layout: [],
  }
  const lists = [turn?.items ?? [], ...tracesOf(turn?.items ?? [], input.traces)]
  reserveSections(lists.reduce((sum, items) => sum + items.length, 0))
  const trunc = cutter(data.icons)
  if (data.view === 'team') return paneBody(el, data, act, renderTeam(el, data))

  if (!turn) {
    const sep = data.icons.groupSep
    const hint = `Keys: t turns ${sep} s search ${sep} e expand ${sep} click or ${focusChord(data)} for keys`
    data.layout.push(
      textLine(data, 'No turns yet.', 0),
      textLine(data, 'Send a prompt; tool calls and subagents appear here.', 0),
      textLine(data, hint, 0),
    )
    return paneBody(el, data, act, {
      header: [],
      content: (
        <Box flexDirection="column">
          <Text key="empty-title" color={C.text}>
            No turns yet.
          </Text>
          <Text key="empty-send" color={C.muted}>
            Send a prompt; tool calls and subagents appear here.
          </Text>
          <Text key="empty-keys" color={C.muted}>
            {hint}
          </Text>
        </Box>
      ),
    })
  }
  if (data.view === 'turns') return paneBody(el, data, act, renderTurnList(el, data, act))

  // The prompt is cut to one row, so the header keeps its height.
  const hasPrompt = turn.prompt !== ''
  const promptRoom = Math.max(8, data.columns - STATUS_INSET - displayWidth(data.icons.prompt) - 1)
  const isEmpty = turn.items.length === 0 && (data.thinking?.text ?? '') === ''
  const emptyText = data.isWorking && data.isLatest ? `Working${data.icons.ellipsis}` : EMPTY_TURN_TEXT
  // The blank row above the items.
  data.layout.push(LINE)
  return paneBody(el, data, act, {
    // The metrics row is clipped to its one row where its parts would wrap.
    header: [
      { node: renderHeader(el, turn, data), rows: 1 },
      ...(hasPrompt
        ? [
            {
              node: (
                <Text key="prompt" color={C.muted} wrap={endWrap(data.icons)}>
                  {`${data.icons.prompt} `}
                  {trunc(turn.prompt, promptRoom)}
                </Text>
              ),
              rows: 1,
            },
          ]
        : []),
    ],
    content: (
      <Box flexDirection="column" marginTop={1}>
        {renderThinking(el, turn, data, act)}
        {isEmpty && drawn(data, <Text color={C.muted}>{emptyText}</Text>, textLine(data, emptyText, 0))}
        {renderRows(el, turn.items, data, act)}
      </Box>
    ),
  })
}

// Every turn of the session, newest first: one button per turn that opens
// it in the detail view. A search narrows the list to the matching turns
// and shows where each one matched.
function renderTurnList(el: El, data: Ctx, act: PaneActions): PaneParts {
  const trunc = cutter(data.icons)
  const { Box, Button, Input, Text } = el
  const query = data.query ?? ''
  const isFiltered = query.trim() !== ''
  const snippets = new Map((data.matches ?? []).map(match => [match.index, match.snippet] as const))
  const table = turnTable(data.turns, data.stats, data.columns, data.icons)
  const rows = table.rows
    .filter(row => !isFiltered || snippets.has(row.index))
    .map(row => ({
      index: row.index,
      snippet: snippets.get(row.index) ?? '',
      label: `${row.index === data.selected ? data.icons.marker : ' '} ${row.label}`,
    }))

  data.budget.left -= table.header.length + 2
  // Every row draws from the pane's text budget; what does not fit is counted.
  const shown: typeof rows = []
  for (const row of rows.reverse()) {
    const cost = row.label.length + row.snippet.length
    if (cost > data.budget.left) break
    data.budget.left -= cost
    shown.push(row)
  }
  const hidden = rows.length - shown.length
  const isNoMatch = isFiltered && rows.length === 0
  const noMatch = `No turn matches "${trunc(sanitizeText(query), 40)}".`
  const hiddenNote = `${hidden} more turn${hidden === 1 ? '' : 's'}${isFiltered ? ` ${data.icons.dash} refine the search` : ''}`
  data.layout.push(
    LINE,
    ...(rows.length > 0 ? [LINE] : []),
    ...(isNoMatch ? [textLine(data, noMatch, 0), textLine(data, NO_MATCH_HINT, 0)] : []),
    ...shown.map((row): RowBlock => {
      const id = turnRowId(row.index)
      return row.snippet === ''
        ? { kind: 'turn', id }
        : isUnicodeCut(data.icons)
          ? { kind: 'turn', id, snippet: row.snippet }
          : { kind: 'turn', id, snippet: `${SNIPPET_INDENT}${row.snippet}`, width: wrapWidth(data, 0) }
    }),
    ...(hidden > 0 ? [textLine(data, hiddenNote, 0)] : []),
  )

  const header: HeaderPart[] = [
    {
      rows: 1,
      node: (
        <Box key="turns-title" flexDirection="row" gap={2}>
          <Text bold color={C.brand}>
            {isFiltered ? `Turns (${rows.length} of ${data.turns.length})` : `Turns (${data.turns.length})`}
          </Text>
        </Box>
      ),
    },
  ]
  if (Input)
    header.push({
      rows: INPUT_ROWS,
      node: (
        <Box key="turns-search" flexDirection="row" gap={2}>
          <Input
            key="turn-search"
            placeholder="Search turns"
            value={query}
            submitLabel="open"
            onInput={value => act.search(value)}
            onSubmit={value => act.submitSearch(value)}
          />
          {isFiltered && (
            <Button
              key="search-clear"
              plain
              dimColor
              hover={buttonHover('btn:search-clear')}
              label="clear"
              onPress={() => act.search('')}
            />
          )}
        </Box>
      ),
    })
  const content = (
    <Box flexDirection="column">
      <Box flexDirection="column" marginTop={1}>
        {rows.length > 0 && (
          <Text key="turn-header" color={C.muted}>
            {`  ${table.header}`}
          </Text>
        )}
        {isNoMatch && (
          <Box flexDirection="column">
            <Text color={C.muted}>{noMatch}</Text>
            <Text key="empty-search" color={C.muted}>
              {NO_MATCH_HINT}
            </Text>
          </Box>
        )}
        {shown.map(row => {
          // The cursor takes the row's first cell, in the accent.
          const isCursor = row.index === data.turnCursor
          const label = isCursor ? row.label.slice(1) : row.label
          return (
            <Box key={`turn-row-${row.index}`} flexDirection="column">
              <Box flexDirection="row">
                {isCursor && (
                  <Text key={`turn-cursor-${row.index}`} color={C.accent}>
                    {data.icons.cursor}
                  </Text>
                )}
                {row.index === data.selected ? (
                  <Text key={`turn-${row.index}`} bold color={C.text}>
                    {label}
                  </Text>
                ) : (
                  <Button
                    key={`turn-${row.index}`}
                    plain
                    dimColor
                    label={label}
                    hover={{ scope: `turn:${row.index}`, backgroundColor: C.rowHover, ...HOVER_TEXT }}
                    onPress={() => act.pickTurn(row.index)}
                  />
                )}
              </Box>
              {row.snippet !== '' && renderSnippet(el, row.snippet, query, data)}
            </Box>
          )
        })}
        {hidden > 0 && <Text color={C.muted}>{hiddenNote}</Text>}
      </Box>
    </Box>
  )
  return { header, content }
}

const SNIPPET_INDENT = '      '

// A turn row's id in the content's rows: where the turn list's cursor finds it.
export const turnRowId = (index: number) => `turn:${index}`
const NO_MATCH_HINT = 'Clear the search or try fewer words.'

// The line a search hit gets under its turn: the matched part underlined and
// bold in the accent, the surrounding text muted.
function renderSnippet(el: El, snippet: string, query: string, data: Ctx) {
  const { Text } = el
  const { before, match, after } = splitMatch(sanitizeText(snippet), query, data.icons.ellipsis)
  return (
    <Text color={C.muted} wrap={endWrap(data.icons)}>
      {`${SNIPPET_INDENT}${before}`}
      {match !== '' && (
        <Text bold underline color={C.accent}>
          {match}
        </Text>
      )}
      {after}
    </Text>
  )
}

// The team board: each teammate with its type and status, then the tasks
// with their TodoWrite marks and owners.
const NO_MEMBERS = 'No teammates in this session.'
const NO_MEMBERS_HINT = 'Teammates show up once Claude starts a team.'
const NO_TASKS = 'No tasks yet.'
const NO_TASKS_HINT = 'Tasks show up when Claude plans with TodoWrite or TaskCreate.'

function renderTeam(el: El, data: Ctx): PaneParts {
  const trunc = cutter(data.icons)
  const { Box, Text } = el
  const members = data.members ?? []
  const tasks = data.tasks ?? []

  // Every row draws from the pane's text budget; what does not fit is counted.
  const memberRows: { member: TeamMember; name: string; type: string; cost: number }[] = []
  for (const member of members) {
    const name = padEndDisplay(trunc(member.name, 24), 24)
    const type = padEndDisplay(trunc(member.type, 20), 20)
    const cost = name.length + type.length + member.status.length + 4
    if (cost > data.budget.left) break
    data.budget.left -= cost
    memberRows.push({ member, name, type, cost })
  }
  const taskRows: { task: TaskEntry; label: string }[] = []
  for (const task of tasks) {
    const owner = task.owner ? `  ${data.icons.arrow} ${trunc(task.owner, 40)}` : ''
    const label = `${taskMark(task.status, data.icons)} #${trunc(task.id, 20)} ${trunc(task.subject, 200)}${owner}`
    if (label.length > data.budget.left) break
    data.budget.left -= label.length
    taskRows.push({ task, label })
  }
  const hiddenMembers = members.length - memberRows.length
  const hiddenTasks = tasks.length - taskRows.length
  // A blank row and the members (or the two empty lines), then a blank row,
  // the tasks heading and the tasks (or the two empty lines), each wrapped.
  const line = (text: string, isCut = false) => textLine(data, text, 0, isCut)
  data.layout.push(
    LINE,
    ...(members.length === 0 ? [line(NO_MEMBERS), line(NO_MEMBERS_HINT)] : []),
    ...memberRows.map(row => line(`${data.icons.bullet} ${row.name} ${row.type} ${row.member.status}`)),
    ...(hiddenMembers > 0 ? [line(`${hiddenMembers} more teammates`)] : []),
    LINE,
    LINE,
    ...(tasks.length === 0 ? [line(NO_TASKS), line(NO_TASKS_HINT)] : []),
    ...taskRows.map(row => line(row.label, isUnicodeCut(data.icons))),
    ...(hiddenTasks > 0 ? [line(`${hiddenTasks} more tasks`)] : []),
  )

  const header = [
    {
      rows: 1,
      node: (
        <Box key="team-title" flexDirection="row" gap={2}>
          <Text bold color={C.brand}>{`Team (${members.length})`}</Text>
        </Box>
      ),
    },
  ]
  const content = (
    <Box flexDirection="column">
      <Box flexDirection="column" marginTop={1}>
        {members.length === 0 && (
          <Box flexDirection="column">
            <Text color={C.muted}>{NO_MEMBERS}</Text>
            <Text key="empty-members" color={C.muted}>
              {NO_MEMBERS_HINT}
            </Text>
          </Box>
        )}
        {memberRows.map((row, i) => (
          <Box key={`member-${i}`} flexDirection="row">
            <Text color={agentStatusColor(row.member.status)}>{`${data.icons.bullet} `}</Text>
            <Text bold color={C.text}>
              {row.name}
            </Text>
            <Text color={C.muted}>{` ${row.type} `}</Text>
            <Text color={agentStatusColor(row.member.status)}>{row.member.status}</Text>
          </Box>
        ))}
        {hiddenMembers > 0 && <Text color={C.muted}>{`${hiddenMembers} more teammates`}</Text>}
      </Box>
      <Box flexDirection="column" marginTop={1}>
        <Text bold color={C.text}>{`Tasks (${tasks.length})`}</Text>
        {tasks.length === 0 && (
          <Box flexDirection="column">
            <Text color={C.muted}>{NO_TASKS}</Text>
            <Text key="empty-tasks" color={C.muted}>
              {NO_TASKS_HINT}
            </Text>
          </Box>
        )}
        {taskRows.map(row => (
          <Text
            key={`task-${row.task.id}`}
            color={row.task.status === 'completed' ? C.muted : C.text}
            wrap={endWrap(data.icons)}
          >
            {row.label}
          </Text>
        ))}
        {hiddenTasks > 0 && <Text color={C.muted}>{`${hiddenTasks} more tasks`}</Text>}
      </Box>
    </Box>
  )
  return { header, content }
}

// The pane body, painted edge to edge in the theme's background and exactly
// as tall as the engine's window, so the engine has nothing to scroll: the
// header stays on top, the content moves up by `scrollTop` rows (a negative
// top margin, in flow: the engine clamps an absolute box at the tree's top)
// in a clipped window of its own, and the footer stays in flow under it.
function paneBody(el: El, data: Ctx, act: PaneActions, parts: PaneParts) {
  const { Box, Text } = el
  const { icons } = data
  const layout = footerRowsOf(data, act)
  // A pane too short for the header and a row of content drops the header.
  const fullHeader = parts.header.reduce((sum, part) => sum + part.rows, 0)
  const header = data.rows - fullHeader - layout.rows >= 1 ? parts.header : []
  const headerRows = header === parts.header ? fullHeader : 0
  const windowRows = Math.max(1, data.rows - headerRows - layout.rows)
  const rows = contentRows(data.layout)
  const scrollTop = clampScroll(data.scrollTop ?? 0, rows.total, windowRows)
  const frame: ScrollFrame = { scrollTop, windowRows, total: rows.total, starts: rows.starts }
  // A window of two rows or less has no room for the indicator rows.
  const more = windowRows > 2 ? overflowRows(scrollTop, rows.total, windowRows) : { above: 0, below: 0 }
  act.measure(frame)
  // A row over the window's top or bottom edge: part of the window, so
  // nothing moves when it shows.
  const edge = (key: string, top: number, text: string) => (
    <Box key={key} position="absolute" top={top} left={0} width={data.columns} backgroundColor={C.paneBackground}>
      <Text color={C.muted}>{text}</Text>
    </Box>
  )
  return (
    <Box flexDirection="column" width={data.columns} height={data.rows} backgroundColor={C.paneBackground}>
      {headerRows > 0 && (
        <Box key="pane-header" flexDirection="column" height={headerRows} flexShrink={0} overflow="hidden">
          {header.map((part, i) => (
            <Box key={`pane-header-${i}`} flexDirection="column" height={part.rows} flexShrink={0} overflow="hidden">
              {part.node}
            </Box>
          ))}
        </Box>
      )}
      <Box key="pane-window" flexDirection="column" height={windowRows} flexShrink={0} overflow="hidden">
        <Box
          key="pane-content"
          flexDirection="column"
          marginTop={scrollTop > 0 ? -scrollTop : 0}
          flexShrink={0}
          width={data.columns}
        >
          {parts.content}
        </Box>
        {more.above > 0 && edge('more-above', 0, `${icons.moreAbove} ${more.above} more above`)}
        {more.below > 0 && edge('more-below', windowRows - 1, `${icons.moreBelow} ${more.below} more below`)}
      </Box>
      {renderFooter(el, data, act, layout, frame)}
    </Box>
  )
}

function renderHeader(el: El, turn: Turn, data: Ctx) {
  const { icons } = data
  const { Box, Text } = el
  const stat = data.turnStat
  const model = shortModel(stat?.model ?? data.sessionModel)
  const subagents = turn.items.filter(isSubagent)

  return (
    <Box flexDirection="row" justifyContent="space-between" width={data.columns}>
      <Box flexDirection="row" flexShrink={1} columnGap={1}>
        <Text key="brand-mark" bold={data.isFocused === true} color={data.isFocused === true ? C.brand : C.muted}>
          {icons.robot}
        </Text>
        <Text bold color={C.text}>
          Claude
        </Text>
        <Text color={modelColor(model) ?? C.text}>{model}</Text>
        {(turn.toolCount > 0 || turn.outputCount > 0) && <Text color={C.muted}>{icons.dot}</Text>}
        {turn.toolCount > 0 && <Text color={C.muted}>{`${icons.wrench} ${turn.toolCount}`}</Text>}
        {turn.outputCount > 0 && (
          <Box flexDirection="row" columnGap={1}>
            <Text color={C.accent}>{icons.output}</Text>
            <Text color={C.muted}>{`${turn.outputCount}`}</Text>
          </Box>
        )}
        {data.thinking !== undefined && data.thinking.count > 0 && (
          <Text color={C.muted}>{`${icons.thinking} ${data.thinking.count}`}</Text>
        )}
        {subagents.map(item => (
          <Text color={isAgentRunning(data.agents.get(item.agentId)) ? C.ongoing : C.accent}>{icons.robot}</Text>
        ))}
      </Box>
      <Box flexDirection="row" flexShrink={0} columnGap={2}>
        {stat?.outputTokens !== undefined && (
          <Text color={C.muted}>{`${icons.token} ${formatTokens((stat.inputTokens ?? 0) + stat.outputTokens)}`}</Text>
        )}
        {data.isLatest && data.contextPercent !== undefined && (
          <Text color={contextColor(data.contextPercent)}>
            {`${data.columns >= HEADER_METER_COLUMNS ? `${contextMeter(data.contextPercent, METER_CELLS, icons)} ` : ''}${Math.round(data.contextPercent)}%`}
          </Text>
        )}
        {stat && <Text color={C.muted}>{`${icons.clock} ${formatDuration(stat.durationMs)}`}</Text>}
        {data.isLatest && data.isWorking && (
          <Text color={C.ongoing}>{icons.spinner[data.frame % icons.spinner.length]}</Text>
        )}
        {stat && <Text color={C.muted}>{formatClock(stat.endedAt)}</Text>}
      </Box>
    </Box>
  )
}

// The turn's thinking as one row above the items, when any of it is
// readable; expanded, it reads as highlighted Markdown like the model's output.
function renderThinking(el: El, turn: Turn, data: Ctx, act: PaneActions) {
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
function renderRows(el: El, items: readonly Item[], data: Ctx, act: PaneActions, path?: readonly boolean[]) {
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

// What went in and what came out, each in a frame colored by its kind.
// `inset`: the cells left of the sections' box (a trace's indent).
function renderSections(el: El, item: ToolItem, data: Ctx, act: PaneActions, inset: number) {
  const { Box } = el
  const frames = cachedSections(item, data.icons).map(section => {
    const id = `${item.id}:${section.kind}`
    const preview = renderLong(el, id, section.body, longSpec(section), data, act)
    const isError = section.kind === 'error'
    return renderFrame(
      el,
      id,
      isError ? `${data.icons.error} ${section.title}` : section.title,
      section.meta,
      section.isPathMeta === true,
      TONE[section.kind],
      isError ? withFirstError(el, section.body, preview, data) : preview,
      section.body,
      data,
      act,
      inset + EXPANDED_INDENT,
    )
  })
  // The blank row under the frames.
  data.layout.push(LINE)
  return (
    <Box flexDirection="column" marginLeft={4} marginBottom={1}>
      {frames}
    </Box>
  )
}

// An error's first telling line, in red, above the preview of its output.
function withFirstError(el: El, body: string, preview: Long, data: Ctx): Long {
  const trunc = cutter(data.icons)
  const { Box, Text } = el
  const line = trunc(firstErrorLine(body), Math.max(8, data.columns - 12))
  // An output that opens with the line already shows it, in red.
  const opening = body
    .split('\n')
    .find(l => l.trim() !== '')
    ?.trim()
  if (line === '' || opening === firstErrorLine(body) || line.length > data.budget.left) return preview
  data.budget.left -= line.length
  return {
    ...preview,
    notes: [isUnicodeCut(data.icons) ? '' : line, ...preview.notes],
    node: (
      <Box flexDirection="column">
        <Text color={C.error} wrap={endWrap(data.icons)}>
          {line}
        </Text>
        {preview.node}
      </Box>
    ),
  }
}

function longSpec(section: Section): LongSpec {
  if (section.format.kind === 'text') return { kind: 'text', isError: section.kind === 'error' }
  return section.format
}

// A section in a frame colored by its kind; the header carries a copy
// button that copies the whole block, not the preview drawn below it.
function renderFrame(
  el: El,
  blockId: string,
  title: string,
  meta: string | undefined,
  isPathMeta: boolean,
  tone: ThemeKey,
  body: Long,
  copyText: string,
  data: Ctx,
  act: PaneActions,
  // The cells left of the frame's border: the indents it sits in.
  inset: number,
) {
  const { Box, Button, Text } = el
  const trunc = cutter(data.icons)
  const metaText =
    meta === undefined || meta === ''
      ? ''
      : `  ${isPathMeta ? truncateMiddle(meta, isUnicodeCut(data.icons) ? 300 : Math.max(8, data.columns - 30), data.icons.ellipsis) : trunc(meta, 300)}`
  // The frame's own line draws from the pane's budget like its body.
  data.budget.left -= title.length + metaText.length + 'copy'.length
  // Its header row wraps only where the set leaves the meta uncut.
  const inner = wrapWidth(data, inset + FRAME_INSET)
  data.layout.push({
    kind: 'frame',
    body: body.pieces,
    notes: body.notes,
    width: inner,
    ...(body.gutter === undefined ? {} : { gutter: body.gutter }),
    ...(body.format === undefined ? {} : { format: body.format }),
    ...(isUnicodeCut(data.icons) || metaText === '' ? {} : { headRows: metaRows(title, metaText, inner) }),
  })
  return (
    <Box
      key={`frame-${blockId}`}
      flexDirection="column"
      borderStyle={data.icons.border}
      borderColor={tone}
      paddingX={1}
    >
      <Box flexDirection="row" justifyContent="space-between">
        <Box flexDirection="row" flexShrink={1}>
          {/* The title keeps its cells (measured: it wrapped under a long meta). */}
          <Box flexShrink={0}>
            <Text bold color={tone}>
              {title}
            </Text>
          </Box>
          {metaText !== '' && (
            <Text color={C.muted} wrap={isPathMeta ? middleWrap(data.icons) : endWrap(data.icons)}>
              {metaText}
            </Text>
          )}
        </Box>
        <Button
          key={`copy:${blockId}`}
          plain
          dimColor
          hover={buttonHover(scopeOf('btn:copy:', blockId))}
          label="copy"
          onPress={press => act.copy(copyText, press.surface)}
        />
      </Box>
      {body.node}
    </Box>
  )
}

// The rows of a frame header whose meta wraps beside its title and the copy
// button (the button and the gap before it: 6 cells).
const metaRows = (title: string, meta: string, width: number) =>
  Math.max(1, Math.ceil(displayWidth(meta) / Math.max(1, width - displayWidth(title) - 6)))

type LongSpec =
  | { kind: 'text'; isError: boolean }
  | { kind: 'code'; language?: string; path?: string; startLine?: number }
  | { kind: 'diff' }
  | { kind: 'markdown' }

// A drawn block: its element, the pieces of text in it and the rows under
// them (a note, show all, show less, an error line), for the row estimate.
type Long = {
  node: RenderElement
  pieces: readonly string[]
  notes: readonly string[]
  gutter?: number
  format?: 'markdown' | 'diff'
}

// A block of any length: previewed by lines and characters until the person
// asks for all of it, cut into pieces under the per-element limit, and drawn
// from the pane's text budget so the tree never crosses the engine's total.
function renderLong(el: El, id: string, text: string, spec: LongSpec, data: Ctx, act: PaneActions): Long {
  const { Box, Button, Code, Text } = el
  const isFull = data.full.has(id)
  const preview = PREVIEW[spec.kind]
  const limit = isFull ? { lines: Infinity, chars: Infinity } : preview
  const allowed = Math.min(limit.chars, data.budget.left)
  const clamp = spec.kind === 'diff' ? clampDiff : clampText
  // Cutting a diff into pieces adds a header to each piece after the first.
  const room =
    spec.kind === 'diff' ? allowed - DIFF_HEADER_SLACK * Math.ceil(Math.max(0, allowed) / TEXT_CHUNK) : allowed
  const shown = clamp(text, limit.lines, room, data.icons.ellipsis)

  const isBudgetCut = shown.note !== undefined && allowed < limit.chars
  const isPreviewed = !isFull && shown.note !== undefined && !isBudgetCut
  const canShrink = isFull && clamp(text, preview.lines, preview.chars, data.icons.ellipsis).note !== undefined

  // A diff is cut only into pieces that are valid diffs; nothing drawn when
  // not even a header fits what is left of the budget.
  const pieces =
    spec.kind === 'diff'
      ? shown.text === ''
        ? []
        : splitDiff(shown.text, Infinity, TEXT_CHUNK)
      : chunkText(shown.text, TEXT_CHUNK)
  const starts = spec.kind === 'code' && spec.startLine !== undefined ? pieceStarts(shown.text, pieces) : []
  data.budget.left -= spec.kind === 'diff' ? pieces.reduce((sum, p) => sum + p.length, 0) : shown.text.length
  const budgetNote = `${shown.note} ${data.icons.dash} pane text budget reached; collapse other rows to see more`
  const fullLabel = `${shown.note} ${data.icons.dash} show all`
  data.budget.left -=
    (isBudgetCut ? budgetNote.length : 0) +
    (isPreviewed ? fullLabel.length : 0) +
    (canShrink && !isBudgetCut ? 'show less'.length : 0)
  const notes = [
    ...(isBudgetCut ? [budgetNote] : []),
    ...(isPreviewed ? [fullLabel] : []),
    ...(canShrink && !isBudgetCut ? ['show less'] : []),
  ]
  // Numbered code and diffs draw their line numbers beside the body.
  const lastLine =
    spec.kind === 'code' && spec.startLine !== undefined ? spec.startLine + shown.text.split('\n').length : 0
  const gutter = lastLine > 0 ? String(lastLine).length + CODE_GUTTER : undefined

  const node = (
    <Box flexDirection="column">
      {pieces.map((piece, i) =>
        spec.kind === 'markdown' ? (
          // The engine draws Markdown prose in the terminal's own foreground,
          // unreadable on the pane's theme background when the two disagree;
          // Code's markdown highlighting takes every color from the theme.
          <Code language="markdown" source={piece} />
        ) : spec.kind === 'diff' ? (
          <Code format="diff" source={piece} />
        ) : spec.kind === 'code' ? (
          <Code
            {...(spec.language === undefined ? {} : { language: spec.language })}
            {...(spec.path === undefined ? {} : { path: spec.path })}
            {...(spec.startLine === undefined ? {} : { startLine: spec.startLine + (starts[i] ?? 0) })}
            source={piece}
          />
        ) : (
          <Text color={spec.isError ? C.error : C.muted}>{piece}</Text>
        ),
      )}
      {isBudgetCut && <Text color={C.muted}>{budgetNote}</Text>}
      {isPreviewed && (
        <Button
          key={`full:${id}`}
          plain
          dimColor
          hover={buttonHover(scopeOf('btn:full:', id))}
          label={fullLabel}
          onPress={() => act.toggleFull(id)}
        />
      )}
      {canShrink && !isBudgetCut && (
        <Button
          key={`full:${id}`}
          plain
          dimColor
          hover={buttonHover(scopeOf('btn:full:', id))}
          label="show less"
          onPress={() => act.toggleFull(id)}
        />
      )}
    </Box>
  )
  const format = spec.kind === 'markdown' || spec.kind === 'diff' ? spec.kind : undefined
  return {
    node,
    pieces,
    notes,
    ...(gutter === undefined ? {} : { gutter }),
    ...(format === undefined ? {} : { format }),
  }
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

// -- Info bar -----------------------------------------------------------------

type BarData = {
  workflow?: WorkflowState
  project: string
  git: GitInfo | null
  mode: string | null
  runningAgents: number
  contextTokens?: number
  contextPercent?: number
  costUsd?: number
  columns: number
  // The glyph set; Nerd Font when left out.
  icons?: Icons
}

function workflowBadge(state: WorkflowState | undefined, icons: Icons): string {
  if (state === undefined || !state.isRunning) return ''
  if (state.agents === 0) return 'workflow running'
  return `workflow running ${icons.dot} ${state.agents} agent${state.agents === 1 ? '' : 's'}`
}

export function renderBar(el: El, data: BarData) {
  const { Box, Text } = el
  const icons = data.icons ?? ICON_SETS.nerd
  const sep = <Text color={C.muted}>{` ${icons.dot} `}</Text>
  const mode = data.mode ? shortMode(data.mode) : ''
  const modeKey = modeColor(data.mode)
  const workflow = workflowBadge(data.workflow, icons)

  return (
    <Box flexDirection="row" justifyContent="space-between" width={data.columns}>
      <Box flexDirection="row" flexShrink={1}>
        <Text dimColor>{data.project}</Text>
        {data.git && sep}
        {data.git && <Text color={C.branch}>{`${icons.branch} `}</Text>}
        {data.git && <Text dimColor>{data.git.branch}</Text>}
        {mode !== '' && sep}
        {mode !== '' && (
          <Text color={modeKey} dimColor={modeKey === undefined} bold={modeKey !== undefined}>
            {mode}
          </Text>
        )}
        {data.runningAgents > 0 && sep}
        {data.runningAgents > 0 && <Text color={C.ongoing}>{`agents running ${icons.dot} ${data.runningAgents}`}</Text>}
        {workflow !== '' && sep}
        {workflow !== '' && <Text color={C.ongoing}>{workflow}</Text>}
      </Box>
      <Box flexDirection="row" flexShrink={0}>
        {data.contextTokens !== undefined && <Text dimColor>{`${formatTokens(data.contextTokens)} ctx `}</Text>}
        {data.contextPercent !== undefined && (
          <Text color={contextColor(data.contextPercent)}>
            {`${data.columns >= BAR_METER_COLUMNS ? `${contextMeter(data.contextPercent, METER_CELLS, icons)} ` : ''}${Math.round(data.contextPercent)}%`}
          </Text>
        )}
        {data.costUsd !== undefined && <Text dimColor>{`  $${data.costUsd.toFixed(2)}`}</Text>}
      </Box>
    </Box>
  )
}
