// Rendering: the detail view (pane) and the info bar (band). Takes plain
// data plus callbacks and returns element trees; no engine calls here.
import type { AgentStatus, BoxProps, RenderChildren, RenderElement, ElementConstructor, Elements, TextProps } from 'claude-code'

import type { AgentStat, GitInfo, ToolTiming, TurnStat } from '../types'
import {
  chunkMarkdown,
  chunkText,
  clampText,
  formatClock,
  formatDuration,
  formatTokens,
  isSubagent,
  itemName,
  itemSummary,
  shortMode,
  shortModel,
  toolCategory,
  toolSections,
  type Section,
  traceStats,
  truncate,
  type Item,
  type ToolItem,
  type Turn,
} from './model'
import { C, contextColor, modeColor, modelColor, TONE, type ThemeKey } from './theme'

// Text narrowed to theme keys: tsc rejects a raw color (hex, rgb, ansi)
// anywhere in the views, so everything follows the person's /theme.
type ThemedTextProps = Omit<TextProps, 'color' | 'backgroundColor'> & { color?: ThemeKey; backgroundColor?: ThemeKey }
type ThemedBoxProps = Omit<BoxProps, 'backgroundColor' | 'borderColor'> & { backgroundColor?: ThemeKey; borderColor?: ThemeKey }

export type El = Pick<Elements['terminal'], 'Button' | 'Markdown' | 'Code'> & {
  Box: ElementConstructor<ThemedBoxProps>
  Text: ElementConstructor<ThemedTextProps>
}

const G = {
  robot: '\u{F167A}',
  wrench: '\u{F0BE0}',
  folderSearch: '\u{F0968}',
  penNib: '\uEE75',
  book: '\uE28B',
  web: '\u{F059F}',
  output: '\u{F0182}',
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

export const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

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

export type PaneData = {
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
}

// The engine refuses a tree with a text over 10000 characters or over 100000
// characters of text in total. Long blocks are cut into TEXT_CHUNK pieces,
// and every block draws from one budget per pane, leaving room for the rows.
export const TEXT_CHUNK = 8000
export const PANE_TEXT_BUDGET = 70_000

const PREVIEW = {
  text: { lines: 100, chars: TEXT_CHUNK },
  code: { lines: 60, chars: TEXT_CHUNK },
  markdown: { lines: Infinity, chars: 30_000 },
} as const

// Render-time state: what is left of the pane's text budget.
type Ctx = PaneData & { budget: { left: number } }

export type PaneActions = {
  toggle: (id: string) => void
  prev: () => void
  next: () => void
  latest: () => void
  expandAll: () => void
  collapseAll: () => void
  toggleFull: (id: string) => void
}

const isAgentRunning = (status: AgentStatus | undefined) =>
  status === 'running' || status === 'pending' || status === 'waiting'

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
    return paneBody(
      el,
      data,
      <Text dimColor>No turns yet. Send a prompt and the detail view fills in.</Text>,
    )
  }

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
        {turn.items.length === 0 && (
          <Text dimColor>{data.isWorking && data.isLatest ? 'Working…' : 'No tool calls or output in this turn.'}</Text>
        )}
        {turn.items.map(item => renderItem(el, item, data, act, 0))}
      </Box>
    </Box>,
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
      <Button key="nav-expand" plain hotkey="e" label="expand all" onPress={act.expandAll} />
      <Button key="nav-collapse" plain hotkey="c" label="collapse" onPress={act.collapseAll} />
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

  const chevron = !canOpen ? G.selected : isSubagent(item) ? (isOpen ? G.expanded : G.drill) : isOpen ? G.expanded : G.collapsed

  const status = item.kind === 'tool' && item.agentId ? data.agents.get(item.agentId) : undefined
  const isRunning = isAgentRunning(status) || (item.kind === 'tool' && item.isPending && data.isLatest)
  const spinner = isRunning ? `${SPINNER[data.frame % SPINNER.length]} ` : '  '

  const duration = itemDuration(item, data)
  const model = item.kind === 'tool' && item.agentId ? data.agentStats[item.agentId]?.model : undefined
  const modelText = model === undefined ? '' : `${shortModel(model)}  `
  const durationText = duration === undefined ? '' : duration >= 1000 ? formatDuration(duration) : duration > 0 ? '<1s' : ''

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
        <Text color={C.ongoing} hover={hover}>{spinner}</Text>
        <Box flexShrink={0}>
          {modelText !== '' && model !== undefined && <Text color={modelColor(model)} hover={hover}>{modelText}</Text>}
          <Text color={C.ongoing} hover={hover}>{durationText !== '' ? `${G.dot} ` : '  '}</Text>
          <Text dimColor hover={hover}>{durationText.padEnd(7)}</Text>
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
        {renderFrame(el, `frame-${item.id}`, 'message', undefined, C.accent, renderLong(el, item.id, item.text, { kind: 'markdown' }, data, act))}
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
          `frame-${item.id}:${section.kind}`,
          section.title,
          section.meta,
          TONE[section.kind],
          renderLong(el, `${item.id}:${section.kind}`, section.body, longSpec(section), data, act),
        ),
      )}
    </Box>
  )
}

function longSpec(section: Section): LongSpec {
  if (section.format.kind === 'text') return { kind: 'text', isError: section.kind === 'error' }
  return section.format
}

function renderFrame(el: El, key: string, title: string, meta: string | undefined, tone: ThemeKey, body: RenderElement) {
  const { Box, Text } = el
  return (
    <Box key={key} flexDirection="column" borderStyle="round" borderColor={tone} paddingX={1}>
      <Box flexDirection="row">
        <Text bold color={tone}>
          {title}
        </Text>
        {meta !== undefined && meta !== '' && <Text dimColor wrap="truncate-end">{`  ${truncate(meta, 300)}`}</Text>}
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
      {isBudgetCut && <Text color={C.muted}>{`${shown.note} – pane text budget reached; collapse other rows to see more`}</Text>}
      {isPreviewed && (
        <Button key={`full:${id}`} plain dimColor label={`${shown.note} – show all`} onPress={() => act.toggleFull(id)} />
      )}
      {canShrink && !isBudgetCut && <Button key={`full:${id}`} plain dimColor label="show less" onPress={() => act.toggleFull(id)} />}
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

export type BarData = {
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
        {data.git?.isDirty && <Text color={C.dirty}>*</Text>}
        {mode !== '' && sep}
        {mode !== '' && (
          <Text color={modeKey} dimColor={modeKey === undefined} bold={modeKey !== undefined}>
            {mode}
          </Text>
        )}
        {data.runningAgents > 0 && sep}
        {data.runningAgents > 0 && (
          <Text color={C.ongoing}>{`agents running ${G.dot} ${data.runningAgents}`}</Text>
        )}
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
