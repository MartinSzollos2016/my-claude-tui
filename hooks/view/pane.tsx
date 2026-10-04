// The pane: the header, the view's content in a window of its own scroll, and the
// pinned footer under it; renderPane is what register.tsx draws.
import { ICON_SETS } from '../icons'
import { contextMeter, formatClock, formatDuration, formatTokens, shortModel } from '../model/format'
import { clampScroll, contentRows, overflowRows, type ScrollFrame } from '../model/scroll'
import { reserveSections } from '../model/sections'
import { EMPTY_TURN_TEXT } from '../model/turn-table'
import { isAgentRunning, isSubagent } from '../model/turns'
import type { Turn } from '../model/types'
import { displayWidth } from '../model/width'
import { C, contextColor, modelColor } from '../theme'
import {
  CARD_BUDGET,
  drawn,
  FOOTER_BUDGET,
  LINE,
  longestCall,
  PANE_TEXT_BUDGET,
  textLine,
  tracesOf,
  type Ctx,
  type PaneActions,
  type PaneData,
  type PaneParts,
} from './context'
import { focusChord, footerRowsOf, renderFooter, STATUS_INSET } from './footer'
import { renderRows, renderThinking } from './items'
import { cutter, endWrap, HEADER_METER_COLUMNS, METER_CELLS, type El } from './kit'
import { renderTeam } from './team'
import { renderTurnList } from './turn-list'

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
