// One row of a turn: the thinking row and a call's row in its fixed columns
// (chevron, status, icon, label, model, duration, bar), with its hover card.
import type { RenderChildren } from 'claude-code'
import { hoverCard } from '../model/card'
import { formatDuration, shortModel, treePrefix } from '../model/format'
import type { Item, Turn } from '../model/types'
import { displayWidth, durationBar, padEndDisplay } from '../model/width'
import { C, modelColor, type ThemeKey } from '../theme'
import { CARD_INDENT, CARD_SLACK, EXPANDED_INDENT, LINE, type Ctx, type PaneActions, type TreePlace } from './context'
import { renderFrame, renderLong } from './frames'
import {
  BAR_CELLS,
  BAR_MIN_COLUMNS,
  buttonHover,
  cutter,
  endWrap,
  HOVER_TEXT,
  scopeOf,
  TRACE_INDENT,
  type El,
} from './kit'

// The turn's thinking as one row above the items, when any of it is
// readable; expanded, it reads as highlighted Markdown like the model's output.
export function renderThinking(el: El, turn: Turn, data: Ctx, act: PaneActions, nameWidth: number) {
  const trunc = cutter(data.icons)
  const { icons } = data
  const { Box, Button, Text } = el
  const thinking = data.thinking
  if (thinking === undefined || thinking.text === '') return undefined
  const id = `t${turn.index}:thinking`
  const isOpen = data.expanded.has(id)
  // The label fills the row after its chevron and glyph columns (6 cells).
  const label = padEndDisplay(
    trunc(`${padEndDisplay('Thinking', nameWidth)}  ${thinking.text}`, Math.max(8, data.columns - 8)),
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
export function withWorkflowNote(item: Item, summary: string, data: Ctx): string {
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

// The cells the time of a timed row takes, right-aligned.
const DURATION_CELLS = 7

// `below` draws what an open row shows under it, after the row itself is
// recorded, so the rows of the content are recorded top to bottom.
export function renderLine(el: El, line: Line, data: Ctx, place: TreePlace | undefined, below?: () => RenderChildren) {
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
  const durationText =
    duration === undefined ? '' : duration >= 1000 ? formatDuration(duration) : duration > 0 ? '<1s' : ''
  const hasDuration = durationText !== ''
  const modelText = model === undefined ? '' : hasDuration ? `${shortModel(model)} ` : shortModel(model)

  // One button carries name and summary, so a click or Enter anywhere on the
  // row toggles it; the label is cut to the room the other columns leave.
  // The time and its bar stand at the right edge only on a timed row; an
  // untimed row lets its label run to the edge.
  const hasBar = hasDuration && data.columns >= BAR_MIN_COLUMNS
  const timeRoom = hasDuration ? 1 + DURATION_CELLS + (hasBar ? 1 + BAR_CELLS : 0) : 0
  // Once a cursor exists every row keeps one cell for its marker.
  const hasCursorColumn = data.cursor !== undefined && data.cursor !== null
  const room = width - displayWidth(guide) - 2 - 3 - 2 - displayWidth(modelText) - timeRoom - (hasCursorColumn ? 1 : 0)
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
        {(modelText !== '' || hasDuration) && (
          <Box flexShrink={0}>
            {modelText !== '' && model !== undefined && (
              <Text color={modelColor(model) ?? C.text} hover={hover}>
                {modelText}
              </Text>
            )}
            {hasDuration && (
              <Text color={C.muted} hover={hover}>
                {` ${' '.repeat(Math.max(0, DURATION_CELLS - displayWidth(durationText)))}${durationText}${hasBar ? ' ' : ''}`}
              </Text>
            )}
            {hasBar && duration !== undefined && (
              <Text key={`bar-${id}`} color={duration > 0 && duration >= data.maxMs ? C.accent : C.muted} hover={hover}>
                {padEndDisplay(durationBar(duration, data.maxMs, BAR_CELLS, icons), BAR_CELLS)}
              </Text>
            )}
          </Box>
        )}
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
export function cardFor(item: Item, data: Ctx, place: TreePlace | undefined): readonly string[] | undefined {
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
