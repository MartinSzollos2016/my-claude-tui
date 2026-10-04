// Rendering: the detail view (pane) and the info bar (band). Takes plain
// data plus callbacks and returns element trees; no engine calls here.
import type { AgentStatus, BoxProps, RenderChildren, ElementConstructor, Elements, TextProps } from 'claude-code'

import type { AgentStat, GitInfo, ToolTiming, TurnStat } from '../types'
import {
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
  traceStats,
  truncate,
  type Item,
  type ToolItem,
  type Turn,
} from './model'
import { C, contextColor, modeColor, modelColor, type ThemeKey } from './theme'

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
}

export type PaneActions = {
  toggle: (id: string) => void
  prev: () => void
  next: () => void
  latest: () => void
  expandAll: () => void
  collapseAll: () => void
}

const isAgentRunning = (status: AgentStatus | undefined) =>
  status === 'running' || status === 'pending' || status === 'waiting'

function itemDuration(item: Item, data: PaneData): number | undefined {
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

export function renderPane(el: El, data: PaneData, act: PaneActions) {
  const { Box, Text } = el
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
function paneBody(el: El, data: PaneData, children: RenderChildren) {
  const { Box } = el
  return (
    <Box flexDirection="column" width={data.columns} minHeight={data.rows} backgroundColor={C.paneBackground}>
      {children}
    </Box>
  )
}

function renderHeader(el: El, turn: Turn, data: PaneData) {
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

function renderNav(el: El, data: PaneData, act: PaneActions) {
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

function renderItem(el: El, item: Item, data: PaneData, act: PaneActions, depth: number) {
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
  const durationText = duration === undefined ? '' : duration >= 1000 ? formatDuration(duration) : duration > 0 ? '<1s' : ''

  return (
    <Box key={`item-${item.id}`} flexDirection="column" marginLeft={depth * 4}>
      <Box flexDirection="row" width={width}>
        <Button key={item.id} plain dimColor={!canOpen} label={chevron} onPress={() => canOpen && act.toggle(item.id)} />
        <Text color={icon.color} dimColor={icon.color === undefined}>
          {` ${icon.glyph} `}
        </Text>
        <Text bold>{name.padEnd(12)}</Text>
        <Text color={C.ongoing}>{spinner}</Text>
        <Box flexGrow={1} flexShrink={1}>
          <Text dimColor wrap="truncate-end">
            {summary ? `- ${summary}` : ''}
          </Text>
        </Box>
        <Box flexShrink={0}>
          {model !== undefined && <Text color={modelColor(model)}>{`${shortModel(model)}  `}</Text>}
          {durationText !== '' && <Text color={C.ongoing}>{`${G.dot} `}</Text>}
          <Text dimColor>{durationText.padEnd(7)}</Text>
        </Box>
      </Box>
      {isOpen && canOpen && renderExpanded(el, item, data, act, depth)}
    </Box>
  )
}

function renderExpanded(el: El, item: Item, data: PaneData, act: PaneActions, depth: number) {
  const { Box } = el

  if (item.kind === 'output') {
    return (
      <Box marginLeft={4} marginBottom={1}>
        {renderMarkdown(el, item.text)}
      </Box>
    )
  }

  if (isSubagent(item)) {
    return renderTrace(el, item, data, act, depth)
  }

  return (
    <Box flexDirection="column" marginLeft={4} marginBottom={1}>
      {renderToolInput(el, item)}
      {item.resultText !== undefined && item.resultText !== '' && renderBlock(el, item.isError ? 'Error' : 'Result', item.resultText, 20, item.isError)}
    </Box>
  )
}

function renderToolInput(el: El, item: ToolItem) {
  const { Box, Text } = el
  const input = item.input
  const s = (k: string) => (typeof input[k] === 'string' ? (input[k] as string) : '')

  if (item.tool === 'Bash' && s('command')) {
    return (
      <Box flexDirection="column">
        <Text dimColor>Command</Text>
        {renderCode(el, 'bash', s('command'), 15)}
      </Box>
    )
  }
  if (item.tool === 'Edit' && (s('old_string') || s('new_string'))) {
    const diff = [
      ...s('old_string').split('\n').map(l => `-${l}`),
      ...s('new_string').split('\n').map(l => `+${l}`),
    ].join('\n')
    return (
      <Box flexDirection="column">
        <Text dimColor>{truncate(s('file_path'), 300)}</Text>
        {renderCode(el, 'diff', diff, 30)}
      </Box>
    )
  }
  if (Object.keys(input).length === 0) return null
  return (
    <Box flexDirection="column">
      <Text dimColor>Input</Text>
      {renderCode(el, 'json', JSON.stringify(input, null, 2), 20)}
    </Box>
  )
}

function renderBlock(el: El, label: string, text: string, maxLines: number, isError: boolean) {
  const { Box, Text } = el
  const shown = clampText(text.trimEnd(), maxLines)
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text dimColor>{label}</Text>
      <Text color={isError ? C.error : undefined} dimColor={!isError}>
        {shown.text}
      </Text>
      {shown.note !== undefined && <Text color={C.muted}>{shown.note}</Text>}
    </Box>
  )
}

function renderCode(el: El, language: string, source: string, maxLines: number) {
  const { Box, Code, Text } = el
  const shown = clampText(source, maxLines)
  return (
    <Box flexDirection="column">
      <Code language={language} source={shown.text} />
      {shown.note !== undefined && <Text color={C.muted}>{shown.note}</Text>}
    </Box>
  )
}

function renderMarkdown(el: El, text: string) {
  const { Box, Markdown, Text } = el
  const shown = clampText(text, 200)
  return (
    <Box flexDirection="column">
      <Markdown text={shown.text} />
      {shown.note !== undefined && <Text color={C.muted}>{shown.note}</Text>}
    </Box>
  )
}

function renderTrace(el: El, item: ToolItem & { agentId: string }, data: PaneData, act: PaneActions, depth: number) {
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
        {item.resultText !== undefined && renderBlock(el, 'Result', item.resultText, 20, item.isError)}
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
