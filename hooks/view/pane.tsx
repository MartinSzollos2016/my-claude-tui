// The pane: the header, the view's content in a window of its own scroll, and the
// pinned footer under it; renderPane is what register.tsx draws.
import { ICON_SETS } from '../icons'
import { C, contextColor, modelColor } from '../theme'
import { contextMeter, formatClock, formatDuration, formatTokens, shortModel } from '../model/format'
import { clampScroll, contentRows, overflowRows, type ScrollFrame } from '../model/scroll'
import { reserveSections } from '../model/sections'
import { EMPTY_TURN_TEXT } from '../model/turn-table'
import { isAgentRunning, isSubagent } from '../model/turns'
import type { Turn } from '../model/types'
import { displayWidth } from '../model/width'
import {
  CARD_BUDGET,
  drawn,
  FOOTER_BUDGET,
  LINE,
  longestCall,
  PANE_TEXT_BUDGET,
  textLine,
  tracesOf,
  type CardSpot,
  type Ctx,
  type PaneActions,
  type PaneData,
  type PaneParts,
} from './context'
import { focusChord, footerRowsOf, renderFooter, STATUS_INSET, type FooterMode } from './footer'
import { nameWidthOf, renderRows } from './items'
import { cutter, endWrap, HEADER_METER_COLUMNS, METER_CELLS, scopeOf, type El } from './kit'
import { renderThinking } from './row'
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
    cards: [],
  }
  const lists = [turn?.items ?? [], ...tracesOf(turn?.items ?? [], input.traces, input.expanded)]
  reserveSections(lists.reduce((sum, items) => sum + items.length, 0))
  const trunc = cutter(data.icons)
  if (data.view === 'team') return paneBody(el, data, act, renderTeam(el, data))

  if (!turn) {
    const sep = data.icons.groupSep
    // The keys that act with no turn yet; the focus note as the footer has it.
    const focusNote = data.isFocused === true ? '' : ` ${sep} click or ${focusChord(data)} to use them`
    const hint = `Keys: t turns ${sep} s search ${sep} h keys${focusNote}`
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
  // Thinking shares the name column of the turn's rows.
  const nameWidth = nameWidthOf(turn.items, (data.thinking?.text ?? '') === '' ? [] : ['Thinking'])
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
        {renderThinking(el, turn, data, act, nameWidth)}
        {isEmpty && drawn(data, <Text color={C.muted}>{emptyText}</Text>, textLine(data, emptyText, 0))}
        {renderRows(el, turn.items, data, act, undefined, nameWidth)}
      </Box>
    ),
  })
}

// The fewest content rows an inline pane keeps before it goes compact.
const MIN_INLINE_WINDOW = 4

// The pane body, painted edge to edge in the theme's background and exactly
// as tall as the engine's window, so the engine has nothing to scroll: the
// header stays on top, the content moves up by `scrollTop` rows (a negative
// top margin, in flow: the engine clamps an absolute box at the tree's top)
// in a clipped window of its own, and the footer stays in flow under it.
function paneBody(el: El, data: Ctx, act: PaneActions, parts: PaneParts) {
  const { Box, Text } = el
  const { icons } = data
  const sumRows = (list: PaneParts['header']) => list.reduce((sum, part) => sum + part.rows, 0)
  const short = parts.header.filter((part, i) => i === 0 || part.isKept === true)
  // Inline above the prompt the engine spares few rows: the first of these
  // that leaves the window MIN_INLINE_WINDOW rows wins, the header's prompt
  // line dropped before the footer steps down; the bare row is the floor.
  const tries: [PaneParts['header'], FooterMode][] = [
    [parts.header, 'full'],
    [short, 'full'],
    [short, 'collapsed'],
    [short, 'bare'],
  ]
  const fits = ([head, mode]: [PaneParts['header'], FooterMode]) =>
    data.placement !== 'inline' || data.rows - sumRows(head) - footerRowsOf(data, act, mode).rows >= MIN_INLINE_WINDOW
  const [wanted, mode] = tries.find(fits) ?? [short, 'bare']
  const layout = footerRowsOf(data, act, mode)
  // A pane too short for the header and a row of content drops the header,
  // all but the parts it keeps.
  const header = data.rows - sumRows(wanted) - layout.rows >= 1 ? wanted : wanted.filter(part => part.isKept === true)
  const headerRows = sumRows(header)
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
        {(data.cards ?? []).map(spot => renderCard(el, spot, scrollTop, windowRows, more, data))}
        {more.above > 0 && edge('more-above', 0, `${icons.moreAbove} ${more.above} more above`)}
        {more.below > 0 && edge('more-below', windowRows - 1, `${icons.moreBelow} ${more.below} more below`)}
      </Box>
      {renderFooter(el, data, act, layout, frame)}
    </Box>
  )
}

// A row's hover card over the window, revealed by the hover of its row: above
// the row where the window has room for it under its top edge (and the
// `▲ more above` row), else below the row above the window's bottom edge;
// laid after the content, so no row paints over it. A row out of the window,
// or one with room on neither side, has none.
function renderCard(
  el: El,
  spot: CardSpot,
  scrollTop: number,
  windowRows: number,
  more: { above: number; below: number },
  data: Ctx,
) {
  const { Box, Text } = el
  const at = spot.row - scrollTop
  const height = spot.lines.length + 2
  const top = more.above > 0 ? 1 : 0
  const bottom = windowRows - (more.below > 0 ? 1 : 0)
  if (at < top || at >= bottom) return undefined
  const y = at - height >= top ? at - height : at + 1 + height <= bottom ? at + 1 : undefined
  if (y === undefined) return undefined
  return (
    <Box
      key={`card-${spot.id}`}
      position="absolute"
      display="none"
      top={y}
      left={spot.left}
      backgroundColor={C.paneBackground}
      flexDirection="column"
      borderStyle={data.icons.border}
      borderColor={C.muted}
      paddingX={1}
      hover={{ scope: scopeOf('row:', spot.id), display: 'flex' }}
    >
      {spot.lines.map(text => (
        <Text color={C.muted}>{text}</Text>
      ))}
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
