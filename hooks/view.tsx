// Rendering: the detail view (pane) and the info bar (band). Takes plain
// data plus callbacks and returns element trees; no engine calls here.
import type {
  AgentStatus,
  BoxProps,
  RenderChildren,
  RenderElement,
  RenderSurface,
  ElementConstructor,
  Elements,
  TextProps,
} from 'claude-code'

import type { AgentStat, GitInfo, ToolTiming, TurnStat } from '../types'
import {
  cachedSections,
  chunkMarkdown,
  chunkText,
  clampDiff,
  clampText,
  contextMeter,
  displayWidth,
  durationBar,
  formatClock,
  EMPTY_TURN_TEXT,
  formatDuration,
  firstErrorLine,
  groupLabel,
  groupRuns,
  type GroupItem,
  fitPath,
  formatTokens,
  isAgentRunning,
  isSubagent,
  itemName,
  itemStatus,
  type ItemStatus,
  itemSummary,
  padEndDisplay,
  pathOf,
  pieceStarts,
  sanitizeText,
  shortMode,
  shortModel,
  splitDiff,
  splitMatch,
  taskMark,
  toolCategory,
  treePrefix,
  turnTable,
  type Section,
  type TaskEntry,
  type TeamMember,
  traceStats,
  truncateDisplay,
  truncateMiddle,
  type Item,
  type ToolItem,
  type Turn,
  type TurnMatch,
  type TurnThinking,
  type WorkflowState,
} from './model'
import { ICON_SETS, type Icons } from './icons'
import { agentStatusColor, C, contextColor, modeColor, modelColor, TONE, type ThemeKey } from './theme'

// Text narrowed to theme keys: tsc rejects a raw color (hex, rgb, ansi)
// anywhere in the views, so everything follows the person's /theme.
type ThemedTextProps = Omit<TextProps, 'color' | 'backgroundColor'> & { color?: ThemeKey; backgroundColor?: ThemeKey }
type ThemedBoxProps = Omit<BoxProps, 'backgroundColor' | 'borderColor'> & {
  backgroundColor?: ThemeKey
  borderColor?: ThemeKey
}

export type El = Pick<Elements['terminal'], 'Button' | 'Markdown' | 'Code'> & {
  Box: ElementConstructor<ThemedBoxProps>
  Text: ElementConstructor<ThemedTextProps>
  // Optional: the mobile surface draws no field.
  Input?: Elements['terminal']['Input']
}

// A hovered button reads at full contrast: its idle label is the theme grey.
const HOVER_TEXT = { color: C.text, bold: true } as const
// A hover scope the engine accepts: 1 to 64 characters. Ids can be long (a
// subagent's tool id carries its agent id), so an over-long tail is replaced
// by a short stable hash (32-bit FNV-1a, base36) of the whole string.
const SCOPE_MAX = 64
function scopeOf(prefix: string, id: string): string {
  const full = `${prefix}${id}`
  if (full.length <= SCOPE_MAX) return full
  let hash = 0x811c9dc5
  for (let i = 0; i < full.length; i++) hash = Math.imul(hash ^ full.charCodeAt(i), 0x01000193) >>> 0
  const tail = hash.toString(36)
  return `${full.slice(0, SCOPE_MAX - tail.length - 1)}~${tail}`
}
// What a cut text ends in comes from the icon set, so the engine's own
// ellipsis (a Unicode one) is only left to draw where the set allows it.
const cutter = (icons: Icons) => (text: string, max: number) => truncateDisplay(text, max, icons.ellipsis)
const isUnicodeCut = (icons: Icons) => icons.ellipsis === ICON_SETS.nerd.ellipsis
const endWrap = (icons: Icons) => (isUnicodeCut(icons) ? 'truncate-end' : 'wrap')
const middleWrap = (icons: Icons) => (isUnicodeCut(icons) ? 'truncate-middle' : 'wrap')

// The context meter's length, and the info bar width it needs to show.
const METER_CELLS = 10
const BAR_METER_COLUMNS = 100
// The duration bar's cells, and the pane width it needs to show.
const BAR_CELLS = 8
const BAR_MIN_COLUMNS = 70
const HEADER_METER_COLUMNS = 80

// A trace's rows sit this far in from its subagent's row.
const TRACE_INDENT = 4

const buttonHover = (scope: string) => ({ scope, ...HOVER_TEXT })

// The state of a tool call as a glyph, so it reads without color too.
function statusMark(status: ItemStatus, frame: number, icons: Icons): { glyph: string; color: ThemeKey } {
  switch (status) {
    case 'done':
      return { glyph: icons.done, color: C.ongoing }
    case 'error':
      return { glyph: icons.error, color: C.error }
    case 'running':
      return { glyph: icons.spinner[frame % icons.spinner.length]!, color: C.ongoing }
    case 'interrupted':
      return { glyph: icons.interrupted, color: C.interrupted }
    case 'idle':
      return { glyph: icons.dot, color: C.muted }
  }
}

function itemIcon(item: Item, icons: Icons): { glyph: string; color?: ThemeKey } {
  if (item.kind === 'output') return { glyph: icons.output, color: C.accent }
  if (item.isError) return { glyph: icons.wrench, color: C.error }
  switch (toolCategory(item.tool)) {
    case 'read':
      return { glyph: icons.book }
    case 'edit':
      return { glyph: icons.penNib }
    case 'search':
      return { glyph: icons.folderSearch }
    case 'task':
      return { glyph: icons.robot, color: isSubagent(item) ? C.accent : undefined }
    case 'web':
      return { glyph: icons.web }
    default:
      return { glyph: icons.wrench }
  }
}

// -- Detail view --------------------------------------------------------------

export type Trace = { items: Item[] } | { denied: string }

type PaneData = {
  // Whether the person has given the pane the keyboard; left out when the
  // engine does not say.
  isFocused?: boolean
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
  rows: number
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
}

// The engine refuses a tree with a text over 10000 characters or over 100000
// characters of text in total. Long blocks are cut into TEXT_CHUNK pieces,
// and every block draws from one budget per pane, leaving room for the rows.
const TEXT_CHUNK = 8000
const PANE_TEXT_BUDGET = 70_000
// What a hunk header the splitting of a long diff adds may take at most.
const DIFF_HEADER_SLACK = 40

const PREVIEW = {
  text: { lines: 100, chars: TEXT_CHUNK },
  code: { lines: 60, chars: TEXT_CHUNK },
  diff: { lines: 60, chars: TEXT_CHUNK },
  markdown: { lines: Infinity, chars: 30_000 },
} as const

// Render-time state: what is left of the pane's text budget.
type Ctx = PaneData & {
  icons: Icons
  budget: { left: number }
  // The longest measured call of the shown turn: what a bar is relative to.
  maxMs: number
}

type PaneActions = {
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
}

function itemDuration(item: Item, data: Pick<PaneData, 'agentStats' | 'timings' | 'now'>): number | undefined {
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
function groupDuration(group: GroupItem, data: Timed): number | undefined {
  const times = group.items.map(item => itemDuration(item, data)).filter(d => d !== undefined)
  return times.length === 0 ? undefined : times.reduce((sum, d) => sum + d, 0)
}

// The loaded traces of the subagents among `items`, nested ones included.
function tracesOf(items: readonly Item[], traces: PaneData['traces']): Item[][] {
  return items.filter(isSubagent).flatMap(item => {
    const trace = traces.get(item.agentId)
    return trace && 'items' in trace ? [trace.items, ...tracesOf(trace.items, traces)] : []
  })
}

// The longest measured row among the turn's and its loaded traces' (a
// folded run counts as its total).
function longestCall(input: PaneData, turn: Turn | undefined): number {
  const lists = [turn?.items ?? [], ...tracesOf(turn?.items ?? [], input.traces)]
  const rows = lists.flatMap(items => groupRuns(items))
  return Math.max(
    0,
    ...rows.map(row => (row.kind === 'group' ? groupDuration(row, input) : itemDuration(row, input)) ?? 0),
  )
}

function hasExpandedContent(item: Item): boolean {
  if (item.kind === 'output') return item.text.trim() !== ''
  return isSubagent(item) || Object.keys(item.input).length > 0 || (item.resultText ?? '') !== ''
}

export function renderPane(el: El, input: PaneData, act: PaneActions) {
  const { Box, Text } = el
  const turn = input.turns[input.selected]
  const data: Ctx = {
    ...input,
    icons: input.icons ?? ICON_SETS.nerd,
    budget: { left: PANE_TEXT_BUDGET },
    maxMs: longestCall(input, turn),
  }
  const trunc = cutter(data.icons)
  if (data.view === 'team') return paneBody(el, data, renderTeam(el, data, act))

  if (!turn) {
    const sep = data.icons.groupSep
    return paneBody(
      el,
      data,
      <Box flexDirection="column">
        <Text key="empty-title" color={C.text}>
          No turns yet.
        </Text>
        <Text key="empty-send" color={C.muted}>
          Send a prompt; tool calls and subagents appear here.
        </Text>
        <Text key="empty-keys" color={C.muted}>
          {`Keys: t turns ${sep} s search ${sep} e expand ${sep} ctrl+x tab focuses this pane`}
        </Text>
      </Box>,
    )
  }
  if (data.view === 'turns') return paneBody(el, data, renderTurnList(el, data, act))

  return paneBody(
    el,
    data,
    <Box flexDirection="column">
      {renderHeader(el, turn, data)}
      {turn.prompt !== '' && (
        <Text color={C.muted} wrap={endWrap(data.icons)}>
          {`${data.icons.prompt} `}
          {trunc(turn.prompt, data.columns * 2)}
        </Text>
      )}
      <Box flexDirection="column" marginTop={1}>
        {renderThinking(el, turn, data, act)}
        {turn.items.length === 0 && (data.thinking?.text ?? '') === '' && (
          <Text color={C.muted}>
            {data.isWorking && data.isLatest ? `Working${data.icons.ellipsis}` : EMPTY_TURN_TEXT}
          </Text>
        )}
        {renderRows(el, turn.items, data, act)}
      </Box>
      {renderFooter(el, data, act)}
    </Box>,
  )
}

// Every turn of the session, newest first: one button per turn that opens
// it in the detail view. A search narrows the list to the matching turns
// and shows where each one matched.
function renderTurnList(el: El, data: Ctx, act: PaneActions) {
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

  return (
    <Box flexDirection="column">
      <Box flexDirection="row" gap={2}>
        <Text bold color={C.brand}>
          {isFiltered ? `Turns (${rows.length} of ${data.turns.length})` : `Turns (${data.turns.length})`}
        </Text>
        <Button
          key="nav-detail"
          plain
          dimColor
          hover={buttonHover('btn:nav-detail')}
          hotkey="d"
          label="back to detail"
          onPress={act.showDetail}
        />
        <Button
          key="nav-search"
          plain
          dimColor
          hover={buttonHover('btn:nav-search')}
          hotkey="s"
          label="search"
          onPress={act.focusSearch}
        />
      </Box>
      {Input && (
        <Box flexDirection="row" gap={2}>
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
      )}
      <Box flexDirection="column" marginTop={1}>
        {rows.length > 0 && (
          <Text key="turn-header" color={C.muted}>
            {`  ${table.header}`}
          </Text>
        )}
        {isFiltered && rows.length === 0 && (
          <Box flexDirection="column">
            <Text color={C.muted}>{`No turn matches "${trunc(sanitizeText(query), 40)}".`}</Text>
            <Text key="empty-search" color={C.muted}>
              Clear the search or try fewer words.
            </Text>
          </Box>
        )}
        {shown.map(row => (
          <Box key={`turn-row-${row.index}`} flexDirection="column">
            {row.index === data.selected ? (
              <Text key={`turn-${row.index}`} bold color={C.text}>
                {row.label}
              </Text>
            ) : (
              <Button
                key={`turn-${row.index}`}
                plain
                dimColor
                label={row.label}
                hover={{ scope: `turn:${row.index}`, backgroundColor: C.rowHover, ...HOVER_TEXT }}
                onPress={() => act.pickTurn(row.index)}
              />
            )}
            {row.snippet !== '' && renderSnippet(el, row.snippet, query, data)}
          </Box>
        ))}
        {hidden > 0 && (
          <Text
            color={C.muted}
          >{`${hidden} more turn${hidden === 1 ? '' : 's'}${isFiltered ? ` ${data.icons.dash} refine the search` : ''}`}</Text>
        )}
      </Box>
    </Box>
  )
}

// The line a search hit gets under its turn: the matched part underlined and
// bold in the accent, the surrounding text muted.
function renderSnippet(el: El, snippet: string, query: string, data: Ctx) {
  const { Text } = el
  const { before, match, after } = splitMatch(sanitizeText(snippet), query, data.icons.ellipsis)
  return (
    <Text color={C.muted} wrap={endWrap(data.icons)}>
      {`      ${before}`}
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
function renderTeam(el: El, data: Ctx, act: PaneActions) {
  const trunc = cutter(data.icons)
  const { Box, Button, Text } = el
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

  return (
    <Box flexDirection="column">
      <Box flexDirection="row" gap={2}>
        <Text bold color={C.brand}>{`Team (${members.length})`}</Text>
        <Button
          key="nav-detail"
          plain
          dimColor
          hover={buttonHover('btn:nav-detail')}
          hotkey="d"
          label="back to detail"
          onPress={act.showDetail}
        />
      </Box>
      <Box flexDirection="column" marginTop={1}>
        {members.length === 0 && (
          <Box flexDirection="column">
            <Text color={C.muted}>No teammates in this session.</Text>
            <Text key="empty-members" color={C.muted}>
              Teammates show up once Claude starts a team.
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
            <Text color={C.muted}>No tasks yet.</Text>
            <Text key="empty-tasks" color={C.muted}>
              Tasks show up when Claude plans with TodoWrite or TaskCreate.
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
}

// The pane body, painted edge to edge in the theme's background.
function paneBody(el: El, data: Ctx, children: RenderChildren) {
  const { Box } = el
  return (
    <Box flexDirection="column" width={data.columns} minHeight={data.rows} backgroundColor={C.paneBackground}>
      {children}
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

// Under the items: a thin rule, the navigation on the left and the position
// of the turn on the right.
function renderFooter(el: El, data: Ctx, act: PaneActions) {
  const { Box, Text } = el
  return (
    <Box key="footer" flexDirection="column" marginTop={1} width={data.columns}>
      <Text key="footer-rule" color={C.muted}>
        {data.icons.rule.repeat(data.columns)}
      </Text>
      <Box flexDirection="row" justifyContent="space-between">
        <Box flexShrink={1}>{renderNav(el, data, act)}</Box>
        <Box flexShrink={0}>
          <Text key="turn-position" color={C.muted}>
            {`turn ${data.selected + 1}/${data.turns.length}${data.isLatest ? ' (live)' : ''}`}
          </Text>
        </Box>
      </Box>
      {data.isFocused !== undefined && (
        <Text key="focus-note" color={data.isFocused ? C.accent : C.muted}>
          {data.isFocused ? 'keys active' : 'ctrl+x tab to use keys'}
        </Text>
      )}
    </Box>
  )
}

function renderNav(el: El, data: Ctx, act: PaneActions) {
  const { Box, Button, Text } = el
  const total = data.turns.length
  const hasTeam = (data.members?.length ?? 0) + (data.tasks?.length ?? 0) > 0
  const button = (key: string, hotkey: string, label: string, onPress: () => void) => (
    <Button
      key={key}
      plain
      dimColor
      hover={buttonHover(`btn:${key}`)}
      hotkey={hotkey}
      label={label}
      onPress={onPress}
    />
  )

  // Three groups; one that has nothing to show is left out whole.
  const groups = [
    {
      id: 'move',
      buttons: [
        data.selected > 0 && button('nav-prev', 'p', 'prev', act.prev),
        data.selected < total - 1 && button('nav-next', 'n', 'next', act.next),
        !data.isLatest && button('nav-latest', 'l', 'latest', act.latest),
      ],
    },
    {
      id: 'views',
      buttons: [
        button('nav-turns', 't', 'turns', act.showTurns),
        button('nav-search', 's', 'search', act.focusSearch),
        hasTeam && button('nav-team', 'm', 'team', act.showTeam),
      ],
    },
    {
      id: 'expand',
      buttons: [
        button('nav-expand', 'e', 'expand all', act.expandAll),
        button('nav-collapse', 'c', 'collapse', act.collapseAll),
      ],
    },
  ]
    .map(group => ({ ...group, buttons: group.buttons.filter(b => b !== false) }))
    .filter(group => group.buttons.length > 0)

  return (
    <Box key="nav" flexDirection="row" flexWrap="wrap" columnGap={2}>
      {groups.map((group, i) => (
        <Box key={`nav-group-${group.id}`} flexDirection="row" gap={2}>
          {i > 0 && (
            <Text key={`nav-sep-${group.id}`} color={C.muted}>
              {data.icons.groupSep}
            </Text>
          )}
          {group.buttons}
        </Box>
      ))}
    </Box>
  )
}

// The turn's thinking as one row above the items, when any of it is
// readable; expanded, it reads as Markdown like the model's output.
function renderThinking(el: El, turn: Turn, data: Ctx, act: PaneActions) {
  const trunc = cutter(data.icons)
  const { icons } = data
  const { Box, Button, Text } = el
  const thinking = data.thinking
  if (thinking === undefined || thinking.text === '') return undefined
  const id = `t${turn.index}:thinking`
  const isOpen = data.expanded.has(id)
  const label = trunc(`${padEndDisplay('Thinking', 12)} - ${thinking.text}`, Math.max(8, data.columns - 8))
  return (
    <Box key={`item-${id}`} flexDirection="column">
      <Box flexDirection="row">
        <Text color={isOpen ? C.text : C.muted}>{`${isOpen ? icons.expanded : icons.collapsed} `}</Text>
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
          {renderFrame(
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
          )}
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

// Where a row of a subagent's trace sits in the tree: which parent levels
// still continue, and whether it is the last of its siblings.
type TreePlace = { path: readonly boolean[]; isLast: boolean }

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
}

function renderLine(el: El, line: Line, data: Ctx, place: TreePlace | undefined, below?: RenderChildren) {
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
  const room = width - displayWidth(guide) - 2 - 3 - 2 - displayWidth(modelText) - 2 - 7 - barRoom
  const label = line.label(room)
  const hover = { scope: scopeOf('row:', id), backgroundColor: C.rowHover }

  return (
    <Box key={`item-${id}`} flexDirection="column" marginLeft={indent}>
      <Box flexDirection="row" width={width}>
        {guide !== '' && (
          <Text key={`guide-${id}`} color={C.muted}>
            {guide}
          </Text>
        )}
        <Text color={isOpen ? C.text : C.muted} hover={hover}>{`${line.chevron} `}</Text>
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
      {below}
    </Box>
  )
}

// The rows of a turn (no `path`) or of a trace (the guides of its parent
// levels): single items, and folded runs of calls.
function renderRows(el: El, items: readonly Item[], data: Ctx, act: PaneActions, path?: readonly boolean[]) {
  const rows = groupRuns(items)
  return rows.map((row, i) => {
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
  const children = isOpen && (
    <Box flexDirection="column">
      {group.items.map((child, i) =>
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
    },
    data,
    place,
    isOpen && canOpen && renderExpanded(el, item, data, act, place),
  )
}

function renderExpanded(el: El, item: Item, data: Ctx, act: PaneActions, place?: TreePlace) {
  const { Box } = el

  if (item.kind === 'output') {
    return (
      <Box flexDirection="column" marginLeft={4} marginBottom={1}>
        {renderFrame(
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
        )}
      </Box>
    )
  }

  if (isSubagent(item)) {
    return renderTrace(el, item, data, act, place)
  }

  return renderSections(el, item, data, act)
}

// What went in and what came out, each in a frame colored by its kind.
function renderSections(el: El, item: ToolItem, data: Ctx, act: PaneActions) {
  const { Box } = el
  return (
    <Box flexDirection="column" marginLeft={4} marginBottom={1}>
      {cachedSections(item, data.icons).map(section => {
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
        )
      })}
    </Box>
  )
}

// An error's first telling line, in red, above the preview of its output.
function withFirstError(el: El, body: string, preview: RenderElement, data: Ctx) {
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
  return (
    <Box flexDirection="column">
      <Text color={C.error} wrap={endWrap(data.icons)}>
        {line}
      </Text>
      {preview}
    </Box>
  )
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
  body: RenderElement,
  copyText: string,
  data: Ctx,
  act: PaneActions,
) {
  const { Box, Button, Text } = el
  const trunc = cutter(data.icons)
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
          <Text bold color={tone}>
            {title}
          </Text>
          {meta !== undefined && meta !== '' && (
            <Text color={C.muted} wrap={isPathMeta ? middleWrap(data.icons) : endWrap(data.icons)}>
              {`  ${isPathMeta ? truncateMiddle(meta, isUnicodeCut(data.icons) ? 300 : Math.max(8, data.columns - 30), data.icons.ellipsis) : trunc(meta, 300)}`}
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
      {body}
    </Box>
  )
}

type LongSpec =
  | { kind: 'text'; isError: boolean }
  | { kind: 'code'; language?: string; path?: string; startLine?: number }
  | { kind: 'diff' }
  | { kind: 'markdown' }

// A block of any length: previewed by lines and characters until the person
// asks for all of it, cut into pieces under the per-element limit, and drawn
// from the pane's text budget so the tree never crosses the engine's total.
function renderLong(el: El, id: string, text: string, spec: LongSpec, data: Ctx, act: PaneActions) {
  const { Box, Button, Code, Markdown, Text } = el
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
    spec.kind === 'markdown'
      ? chunkMarkdown(shown.text, TEXT_CHUNK)
      : spec.kind === 'diff'
        ? shown.text === ''
          ? []
          : splitDiff(shown.text, Infinity, TEXT_CHUNK)
        : chunkText(shown.text, TEXT_CHUNK)
  const starts = spec.kind === 'code' && spec.startLine !== undefined ? pieceStarts(shown.text, pieces) : []
  data.budget.left -= spec.kind === 'diff' ? pieces.reduce((sum, p) => sum + p.length, 0) : shown.text.length

  return (
    <Box flexDirection="column">
      {pieces.map((piece, i) =>
        spec.kind === 'markdown' ? (
          <Markdown text={piece} />
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
      {isBudgetCut && (
        <Text
          color={C.muted}
        >{`${shown.note} ${data.icons.dash} pane text budget reached; collapse other rows to see more`}</Text>
      )}
      {isPreviewed && (
        <Button
          key={`full:${id}`}
          plain
          dimColor
          hover={buttonHover(scopeOf('btn:full:', id))}
          label={`${shown.note} ${data.icons.dash} show all`}
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
}

function renderTrace(el: El, item: ToolItem & { agentId: string }, data: Ctx, act: PaneActions, place?: TreePlace) {
  const trunc = cutter(data.icons)
  const { icons } = data
  const { Box, Text } = el
  const trace = data.traces.get(item.agentId)
  const model = data.agentStats[item.agentId]?.model

  if (!trace) {
    return (
      <Box marginLeft={4}>
        <Text color={C.muted}>{`Loading trace${data.icons.ellipsis}`}</Text>
      </Box>
    )
  }
  if ('denied' in trace) {
    return (
      <Box flexDirection="column" marginLeft={4} marginBottom={1}>
        <Text color={C.muted}>{`Trace unavailable: ${trunc(trace.denied, 300)}`}</Text>
        {renderSections(el, item, data, act)}
      </Box>
    )
  }

  const stats = traceStats(trace.items)
  return (
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
