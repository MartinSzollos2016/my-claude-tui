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
  chunkMarkdown,
  chunkText,
  clampText,
  formatClock,
  EMPTY_TURN_TEXT,
  formatDuration,
  formatTokens,
  isAgentRunning,
  isSubagent,
  itemName,
  itemSummary,
  sanitizeText,
  shortMode,
  shortModel,
  toolCategory,
  toolSections,
  turnTail,
  type Section,
  traceStats,
  truncate,
  type Item,
  type ToolItem,
  type Turn,
  type TurnMatch,
  type TurnThinking,
} from './model'
import { C, contextColor, modeColor, modelColor, TONE, type ThemeKey } from './theme'

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

const G = {
  robot: '\u{F167A}',
  wrench: '\u{F0BE0}',
  folderSearch: '\u{F0968}',
  penNib: '\uEE75',
  book: '\uE28B',
  web: '\u{F059F}',
  output: '\u{F0182}',
  thinking: '\u{F09D1}',
  clock: '\uF017',
  token: '\uEDE8',
  collapsed: '\uF054',
  expanded: '\uF078',
  drill: '\uF061',
  selected: '│',
  system: '\uF120',
  branch: '\uF418',
  dot: '·',
}

const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

function itemIcon(item: Item): { glyph: string; color?: ThemeKey } {
  if (item.kind === 'output') return { glyph: G.output, color: C.accent }
  if (item.isError) return { glyph: G.wrench, color: C.error }
  switch (toolCategory(item.tool)) {
    case 'read':
      return { glyph: G.book }
    case 'edit':
      return { glyph: G.penNib }
    case 'search':
      return { glyph: G.folderSearch }
    case 'task':
      return { glyph: G.robot, color: isSubagent(item) ? C.accent : undefined }
    case 'web':
      return { glyph: G.web }
    default:
      return { glyph: G.wrench }
  }
}

// -- Detail view --------------------------------------------------------------

export type Trace = { items: Item[] } | { denied: string }

type PaneData = {
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
  view: 'detail' | 'turns'
  stats: readonly (TurnStat | undefined)[]
  // The turn search: what is typed, and the turns that match it.
  query?: string
  matches?: readonly TurnMatch[]
}

// The engine refuses a tree with a text over 10000 characters or over 100000
// characters of text in total. Long blocks are cut into TEXT_CHUNK pieces,
// and every block draws from one budget per pane, leaving room for the rows.
const TEXT_CHUNK = 8000
const PANE_TEXT_BUDGET = 70_000

const PREVIEW = {
  text: { lines: 100, chars: TEXT_CHUNK },
  code: { lines: 60, chars: TEXT_CHUNK },
  markdown: { lines: Infinity, chars: 30_000 },
} as const

// Render-time state: what is left of the pane's text budget.
type Ctx = PaneData & { budget: { left: number } }

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
  pickTurn: (index: number) => void
  search: (query: string) => void
  submitSearch: (query: string) => void
  focusSearch: () => void
}

function itemDuration(item: Item, data: Ctx): number | undefined {
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

function hasExpandedContent(item: Item): boolean {
  if (item.kind === 'output') return item.text.trim() !== ''
  return isSubagent(item) || Object.keys(item.input).length > 0 || (item.resultText ?? '') !== ''
}

export function renderPane(el: El, input: PaneData, act: PaneActions) {
  const { Box, Text } = el
  const data: Ctx = { ...input, budget: { left: PANE_TEXT_BUDGET } }
  const turn = data.turns[data.selected]

  if (!turn) {
    return paneBody(el, data, <Text dimColor>No turns yet. Send a prompt and the detail view fills in.</Text>)
  }
  if (data.view === 'turns') return paneBody(el, data, renderTurnList(el, data, act))

  return paneBody(
    el,
    data,
    <Box flexDirection="column">
      {renderHeader(el, turn, data)}
      {turn.prompt !== '' && (
        <Text dimColor wrap="truncate-end">
          {'❯ '}
          {truncate(turn.prompt, data.columns * 2)}
        </Text>
      )}
      {renderNav(el, data, act)}
      <Box flexDirection="column" marginTop={1}>
        {renderThinking(el, turn, data, act)}
        {turn.items.length === 0 && (data.thinking?.text ?? '') === '' && (
          <Text dimColor>{data.isWorking && data.isLatest ? 'Working…' : EMPTY_TURN_TEXT}</Text>
        )}
        {turn.items.map(item => renderItem(el, item, data, act, 0))}
      </Box>
    </Box>,
  )
}

// Every turn of the session, newest first: one button per turn that opens
// it in the detail view. A search narrows the list to the matching turns
// and shows where each one matched.
function renderTurnList(el: El, data: Ctx, act: PaneActions) {
  const { Box, Button, Input, Text } = el
  const width = data.columns - 2
  const query = data.query ?? ''
  const isFiltered = query.trim() !== ''
  const snippets = new Map((data.matches ?? []).map(match => [match.index, match.snippet] as const))
  const rows = data.turns
    .filter(turn => !isFiltered || snippets.has(turn.index))
    .map(turn => {
      const index = turn.index
      const marker = index === data.selected ? '›' : ' '
      const number = `#${index + 1}`.padEnd(5)
      const tail = turnTail(turn, data.stats[index])
      const prompt = truncate(turn.prompt || '(no prompt)', Math.max(10, width - number.length - tail.length - 6))
      return {
        index,
        snippet: snippets.get(index) ?? '',
        label: `${marker} ${number}${prompt.padEnd(Math.max(0, width - number.length - tail.length - 5))}  ${tail}`,
      }
    })

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
        <Button key="nav-detail" plain hotkey="d" label="back to detail" onPress={act.showDetail} />
        <Button key="nav-search" plain hotkey="s" label="search" onPress={act.focusSearch} />
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
          {isFiltered && <Button key="search-clear" plain dimColor label="clear" onPress={() => act.search('')} />}
        </Box>
      )}
      <Box flexDirection="column" marginTop={1}>
        {isFiltered && rows.length === 0 && (
          <Text dimColor>{`No turn matches "${truncate(sanitizeText(query), 40)}".`}</Text>
        )}
        {shown.map(row => (
          <Box key={`turn-row-${row.index}`} flexDirection="column">
            <Button
              key={`turn-${row.index}`}
              plain
              dimColor={row.index !== data.selected}
              label={row.label}
              hover={{ scope: `turn:${row.index}`, backgroundColor: C.rowHover }}
              onPress={() => act.pickTurn(row.index)}
            />
            {row.snippet !== '' && <Text dimColor wrap="truncate-end">{`      ${sanitizeText(row.snippet)}`}</Text>}
          </Box>
        ))}
        {hidden > 0 && (
          <Text
            color={C.muted}
          >{`${hidden} more turn${hidden === 1 ? '' : 's'}${isFiltered ? ' – refine the search' : ''}`}</Text>
        )}
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
  const { Box, Text } = el
  const stat = data.turnStat
  const model = shortModel(stat?.model ?? data.sessionModel)
  const subagents = turn.items.filter(isSubagent)

  return (
    <Box flexDirection="row" justifyContent="space-between" width={data.columns}>
      <Box flexDirection="row" flexShrink={1}>
        <Text bold color={C.brand}>
          {G.robot}{' '}
        </Text>
        <Text bold>Claude </Text>
        <Text color={modelColor(model)}>{model}</Text>
        {(turn.toolCount > 0 || turn.outputCount > 0) && <Text color={C.muted}> {G.dot} </Text>}
        {turn.toolCount > 0 && <Text dimColor>{`${G.wrench} ${turn.toolCount}  `}</Text>}
        {turn.outputCount > 0 && <Text color={C.accent}>{G.output} </Text>}
        {turn.outputCount > 0 && <Text dimColor>{`${turn.outputCount}  `}</Text>}
        {data.thinking !== undefined && data.thinking.count > 0 && (
          <Text dimColor>{`${G.thinking} ${data.thinking.count}  `}</Text>
        )}
        {subagents.map(item => (
          <Text color={isAgentRunning(data.agents.get(item.agentId)) ? C.ongoing : C.accent}>{`${G.robot} `}</Text>
        ))}
      </Box>
      <Box flexDirection="row" flexShrink={0}>
        {stat?.outputTokens !== undefined && (
          <Text dimColor>{`${G.token} ${formatTokens((stat.inputTokens ?? 0) + stat.outputTokens)}  `}</Text>
        )}
        {data.isLatest && data.contextPercent !== undefined && (
          <Text color={contextColor(data.contextPercent)}>{`ctx ${Math.round(data.contextPercent)}%  `}</Text>
        )}
        {stat && <Text dimColor>{`${G.clock} ${formatDuration(stat.durationMs)}  `}</Text>}
        {data.isLatest && data.isWorking && <Text color={C.ongoing}>{`${SPINNER[data.frame % SPINNER.length]} `}</Text>}
        {stat && <Text color={C.muted}>{formatClock(stat.endedAt)}</Text>}
      </Box>
    </Box>
  )
}

function renderNav(el: El, data: Ctx, act: PaneActions) {
  const { Box, Button, Text } = el
  const total = data.turns.length

  return (
    <Box flexDirection="row" gap={2}>
      <Button key="nav-prev" plain hotkey="p" dimColor={data.selected === 0} label="prev" onPress={act.prev} />
      <Text dimColor>{`turn ${data.selected + 1}/${total}${data.isLatest ? ' (live)' : ''}`}</Text>
      <Button key="nav-next" plain hotkey="n" dimColor={data.selected >= total - 1} label="next" onPress={act.next} />
      <Button key="nav-latest" plain hotkey="l" dimColor={data.isLatest} label="latest" onPress={act.latest} />
      <Button key="nav-turns" plain hotkey="t" label="turns" onPress={act.showTurns} />
      <Button key="nav-search" plain hotkey="s" label="search" onPress={act.focusSearch} />
      <Button key="nav-expand" plain hotkey="e" label="expand all" onPress={act.expandAll} />
      <Button key="nav-collapse" plain hotkey="c" label="collapse" onPress={act.collapseAll} />
    </Box>
  )
}

// The turn's thinking as one row above the items, when any of it is
// readable; expanded, it reads as Markdown like the model's output.
function renderThinking(el: El, turn: Turn, data: Ctx, act: PaneActions) {
  const { Box, Button, Text } = el
  const thinking = data.thinking
  if (thinking === undefined || thinking.text === '') return undefined
  const id = `t${turn.index}:thinking`
  const isOpen = data.expanded.has(id)
  const label = truncate(`${'Thinking'.padEnd(12)} - ${thinking.text}`, Math.max(8, data.columns - 8))
  return (
    <Box key={`item-${id}`} flexDirection="column">
      <Box flexDirection="row">
        <Text dimColor={!isOpen}>{`${isOpen ? G.expanded : G.collapsed} `}</Text>
        <Text color={C.accent}>{`${G.thinking} `}</Text>
        <Button key={id} plain label={label} onPress={() => act.toggle(id)} />
      </Box>
      {isOpen && (
        <Box flexDirection="column" marginLeft={4} marginBottom={1}>
          {renderFrame(
            el,
            id,
            'thinking',
            undefined,
            C.accent,
            renderLong(el, id, thinking.text, { kind: 'markdown' }, data, act),
            thinking.text,
            act,
          )}
        </Box>
      )}
    </Box>
  )
}

function renderItem(el: El, item: Item, data: Ctx, act: PaneActions, depth: number) {
  const { Box, Button, Text } = el
  const isOpen = data.expanded.has(item.id)
  const canOpen = hasExpandedContent(item)
  const icon = itemIcon(item)
  const name = itemName(item)
  const summary = itemSummary(item)
  const width = Math.max(20, data.columns - depth * 4)

  const chevron = !canOpen
    ? G.selected
    : isSubagent(item)
      ? isOpen
        ? G.expanded
        : G.drill
      : isOpen
        ? G.expanded
        : G.collapsed

  const status = item.kind === 'tool' && item.agentId ? data.agents.get(item.agentId) : undefined
  const isRunning = isAgentRunning(status) || (item.kind === 'tool' && item.isPending && data.isLatest)
  const spinner = isRunning ? `${SPINNER[data.frame % SPINNER.length]} ` : '  '

  const duration = itemDuration(item, data)
  const model = item.kind === 'tool' && item.agentId ? data.agentStats[item.agentId]?.model : undefined
  const modelText = model === undefined ? '' : `${shortModel(model)}  `
  const durationText =
    duration === undefined ? '' : duration >= 1000 ? formatDuration(duration) : duration > 0 ? '<1s' : ''

  // One button carries name and summary, so a click or Enter anywhere on the
  // row toggles it; the label is cut to the room the fixed columns leave.
  const room = width - 2 - 3 - spinner.length - modelText.length - 2 - 7
  const label = truncate(summary ? `${name.padEnd(12)} - ${summary}` : name, Math.max(8, room))
  const hover = { scope: `row:${item.id}`, backgroundColor: C.rowHover }
  const toggle = () => canOpen && act.toggle(item.id)

  return (
    <Box key={`item-${item.id}`} flexDirection="column" marginLeft={depth * 4}>
      <Box flexDirection="row" width={width}>
        <Text dimColor={!isOpen} hover={hover}>{`${chevron} `}</Text>
        <Text color={icon.color} dimColor={icon.color === undefined} hover={hover}>
          {`${icon.glyph} `}
        </Text>
        <Box flexGrow={1} flexShrink={1}>
          {canOpen ? (
            <Button key={item.id} plain label={label} hover={hover} onPress={toggle} />
          ) : (
            <Text dimColor wrap="truncate-end" hover={hover}>
              {label}
            </Text>
          )}
        </Box>
        <Text color={C.ongoing} hover={hover}>
          {spinner}
        </Text>
        <Box flexShrink={0}>
          {modelText !== '' && model !== undefined && (
            <Text color={modelColor(model)} hover={hover}>
              {modelText}
            </Text>
          )}
          <Text color={C.ongoing} hover={hover}>
            {durationText !== '' ? `${G.dot} ` : '  '}
          </Text>
          <Text dimColor hover={hover}>
            {durationText.padEnd(7)}
          </Text>
        </Box>
      </Box>
      {isOpen && canOpen && renderExpanded(el, item, data, act, depth)}
    </Box>
  )
}

function renderExpanded(el: El, item: Item, data: Ctx, act: PaneActions, depth: number) {
  const { Box } = el

  if (item.kind === 'output') {
    return (
      <Box flexDirection="column" marginLeft={4} marginBottom={1}>
        {renderFrame(
          el,
          item.id,
          'message',
          undefined,
          C.accent,
          renderLong(el, item.id, item.text, { kind: 'markdown' }, data, act),
          item.text,
          act,
        )}
      </Box>
    )
  }

  if (isSubagent(item)) {
    return renderTrace(el, item, data, act, depth)
  }

  return renderSections(el, item, data, act)
}

// What went in and what came out, each in a frame colored by its kind.
function renderSections(el: El, item: ToolItem, data: Ctx, act: PaneActions) {
  const { Box } = el
  return (
    <Box flexDirection="column" marginLeft={4} marginBottom={1}>
      {toolSections(item).map(section =>
        renderFrame(
          el,
          `${item.id}:${section.kind}`,
          section.title,
          section.meta,
          TONE[section.kind],
          renderLong(el, `${item.id}:${section.kind}`, section.body, longSpec(section), data, act),
          section.body,
          act,
        ),
      )}
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
  tone: ThemeKey,
  body: RenderElement,
  copyText: string,
  act: PaneActions,
) {
  const { Box, Button, Text } = el
  return (
    <Box key={`frame-${blockId}`} flexDirection="column" borderStyle="round" borderColor={tone} paddingX={1}>
      <Box flexDirection="row" justifyContent="space-between">
        <Box flexDirection="row" flexShrink={1}>
          <Text bold color={tone}>
            {title}
          </Text>
          {meta !== undefined && meta !== '' && <Text dimColor wrap="truncate-end">{`  ${truncate(meta, 300)}`}</Text>}
        </Box>
        <Button
          key={`copy:${blockId}`}
          plain
          dimColor
          label="copy"
          onPress={press => act.copy(copyText, press.surface)}
        />
      </Box>
      {body}
    </Box>
  )
}

type LongSpec = { kind: 'text'; isError: boolean } | { kind: 'code'; language: string } | { kind: 'markdown' }

// A block of any length: previewed by lines and characters until the person
// asks for all of it, cut into pieces under the per-element limit, and drawn
// from the pane's text budget so the tree never crosses the engine's total.
function renderLong(el: El, id: string, text: string, spec: LongSpec, data: Ctx, act: PaneActions) {
  const { Box, Button, Code, Markdown, Text } = el
  const isFull = data.full.has(id)
  const preview = PREVIEW[spec.kind]
  const limit = isFull ? { lines: Infinity, chars: Infinity } : preview
  const allowed = Math.min(limit.chars, data.budget.left)
  const shown = clampText(text, limit.lines, allowed)
  data.budget.left -= shown.text.length

  const isBudgetCut = shown.note !== undefined && allowed < limit.chars
  const isPreviewed = !isFull && shown.note !== undefined && !isBudgetCut
  const canShrink = isFull && clampText(text, preview.lines, preview.chars).note !== undefined

  const pieces = spec.kind === 'markdown' ? chunkMarkdown(shown.text, TEXT_CHUNK) : chunkText(shown.text, TEXT_CHUNK)

  return (
    <Box flexDirection="column">
      {pieces.map(piece =>
        spec.kind === 'markdown' ? (
          <Markdown text={piece} />
        ) : spec.kind === 'code' ? (
          <Code language={spec.language} source={piece} />
        ) : (
          <Text color={spec.isError ? C.error : undefined} dimColor={!spec.isError}>
            {piece}
          </Text>
        ),
      )}
      {isBudgetCut && (
        <Text color={C.muted}>{`${shown.note} – pane text budget reached; collapse other rows to see more`}</Text>
      )}
      {isPreviewed && (
        <Button
          key={`full:${id}`}
          plain
          dimColor
          label={`${shown.note} – show all`}
          onPress={() => act.toggleFull(id)}
        />
      )}
      {canShrink && !isBudgetCut && (
        <Button key={`full:${id}`} plain dimColor label="show less" onPress={() => act.toggleFull(id)} />
      )}
    </Box>
  )
}

function renderTrace(el: El, item: ToolItem & { agentId: string }, data: Ctx, act: PaneActions, depth: number) {
  const { Box, Text } = el
  const trace = data.traces.get(item.agentId)
  const model = data.agentStats[item.agentId]?.model

  if (!trace) {
    return (
      <Box marginLeft={4}>
        <Text dimColor>Loading trace…</Text>
      </Box>
    )
  }
  if ('denied' in trace) {
    return (
      <Box flexDirection="column" marginLeft={4} marginBottom={1}>
        <Text dimColor>{`Trace unavailable: ${truncate(trace.denied, 300)}`}</Text>
        {renderSections(el, item, data, act)}
      </Box>
    )
  }

  const stats = traceStats(trace.items)
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box flexDirection="row" marginLeft={4}>
        <Text dimColor>{`${G.system}  `}</Text>
        <Text bold>Execution Trace</Text>
        <Text dimColor>{` ${G.dot} ${stats.tools} tool calls, ${stats.messages} messages`}</Text>
        {model !== undefined && <Text dimColor>{` ${G.dot} `}</Text>}
        {model !== undefined && <Text color={modelColor(model)}>{shortModel(model)}</Text>}
      </Box>
      {trace.items.map(child => renderItem(el, child, data, act, depth + 1))}
    </Box>
  )
}

// -- Info bar -----------------------------------------------------------------

type BarData = {
  project: string
  git: GitInfo | null
  mode: string | null
  runningAgents: number
  contextTokens?: number
  contextPercent?: number
  costUsd?: number
  columns: number
}

export function renderBar(el: El, data: BarData) {
  const { Box, Text } = el
  const sep = <Text color={C.muted}>{` ${G.dot} `}</Text>
  const mode = data.mode ? shortMode(data.mode) : ''
  const modeKey = modeColor(data.mode)

  return (
    <Box flexDirection="row" justifyContent="space-between" width={data.columns}>
      <Box flexDirection="row" flexShrink={1}>
        <Text dimColor>{data.project}</Text>
        {data.git && sep}
        {data.git && <Text color={C.branch}>{`${G.branch} `}</Text>}
        {data.git && <Text dimColor>{data.git.branch}</Text>}
        {mode !== '' && sep}
        {mode !== '' && (
          <Text color={modeKey} dimColor={modeKey === undefined} bold={modeKey !== undefined}>
            {mode}
          </Text>
        )}
        {data.runningAgents > 0 && sep}
        {data.runningAgents > 0 && <Text color={C.ongoing}>{`agents running ${G.dot} ${data.runningAgents}`}</Text>}
      </Box>
      <Box flexDirection="row" flexShrink={0}>
        {data.contextTokens !== undefined && <Text dimColor>{`${formatTokens(data.contextTokens)} ctx `}</Text>}
        {data.contextPercent !== undefined && (
          <Text color={contextColor(data.contextPercent)}>{`${Math.round(data.contextPercent)}%`}</Text>
        )}
        {data.costUsd !== undefined && <Text dimColor>{`  $${data.costUsd.toFixed(2)}`}</Text>}
      </Box>
    </Box>
  )
}
