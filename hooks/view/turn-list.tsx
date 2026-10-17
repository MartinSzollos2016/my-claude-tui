// The turn list: a table of the session's turns with search, its snippets, and
// the row ids its cursor walks.
import type { RenderChildren } from 'claude-code'

import { C } from '../theme'
import { sanitizeText } from '../model/sanitize'
import type { RowBlock } from '../model/scroll'
import { splitMatch } from '../model/search'
import { turnTable, type TurnTable } from '../model/turn-table'
import {
  INPUT_ROWS,
  LINE,
  textLine,
  wrapWidth,
  type Ctx,
  type HeaderPart,
  type PaneActions,
  type PaneParts,
} from './context'
import { flowBar } from './bars'
import { buttonHoverOf, cutter, endWrap, hoverText, isUnicodeCut, type El } from './kit'

// Every turn of the session, newest first: one button per turn that opens
// it in the detail view. A search narrows the list to the matching turns
// and shows where each one matched.
export function renderTurnList(el: El, data: Ctx, act: PaneActions): PaneParts {
  const trunc = cutter(data.icons)
  const { Box, Button, Input, Text } = el
  const query = data.query ?? ''
  // The field is drawn with a seed that typing never changes: the engine puts
  // a drawn value into the field each time it differs, and drawings arrive
  // late, so drawing the query back would undo the keys typed meanwhile.
  const field = data.searchField ?? { gen: 0, seed: query }
  const isFiltered = query.trim() !== ''
  const snippets = new Map((data.matches ?? []).map(match => [match.index, match.snippet] as const))
  const table = turnTable(data.turns, data.stats, data.columns, data.icons)
  // The longest turn: what the desktop app's bars are relative to.
  const longest = data.isFlow === true ? Math.max(0, ...data.stats.map(stat => stat?.durationMs ?? 0)) : 0
  const rows = table.rows
    .filter(row => !isFiltered || snippets.has(row.index))
    .map(row => ({
      index: row.index,
      snippet: snippets.get(row.index) ?? '',
      label: `${row.index === data.selected ? data.icons.marker : ' '} ${row.label}`,
      // The desktop app's row: its cells and the whole prompt cut to the pane.
      ...(data.isFlow === true
        ? { cells: row.cells, prompt: trunc(data.turns[row.index]?.prompt || '(no prompt)', data.columns) }
        : {}),
    }))

  data.budget.left -= table.header.length + 2
  // Every row draws from the pane's text budget; what does not fit is counted.
  const shown: typeof rows = []
  for (const row of rows.reverse()) {
    // What the row draws: the text table's label, or the desktop app's cells.
    const cost =
      row.cells === undefined
        ? row.label.length + row.snippet.length
        : 1 + (row.prompt?.length ?? 0) + flowCellsLength(row.cells) + row.snippet.length
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
      isKept: true,
      node: (
        <Box key="turns-search" flexDirection="row" gap={2}>
          <Input
            key={searchFieldKey(field.gen)}
            placeholder="Search turns"
            value={field.seed}
            submitLabel="open"
            onInput={value => act.search(value)}
            onSubmit={value => act.submitSearch(value)}
          />
          {isFiltered && (
            <Button
              key="search-clear"
              plain
              dimColor
              hover={buttonHoverOf(data, 'btn:search-clear')}
              label="clear"
              onPress={() => act.clearSearch()}
            />
          )}
        </Box>
      ),
    })
  const content = (
    <Box flexDirection="column">
      <Box flexDirection="column" marginTop={1}>
        {rows.length > 0 &&
          (data.isFlow === true ? (
            flowCells(el, 'turn-header', table.columns, {
              marker: '',
              number: <Text color={C.muted}>#</Text>,
              prompt: <Text color={C.muted}>prompt</Text>,
              tools: <Text color={C.muted}>tools</Text>,
              time: <Text color={C.muted}>time</Text>,
              tokens: <Text color={C.muted}>tokens</Text>,
              bar: '',
            })
          ) : (
            <Text key="turn-header" color={C.muted}>
              {`  ${table.header}`}
            </Text>
          ))}
        {isNoMatch && (
          <Box flexDirection="column">
            <Text color={C.muted}>{noMatch}</Text>
            <Text key="empty-search" color={C.muted}>
              {NO_MATCH_HINT}
            </Text>
          </Box>
        )}
        {data.isFlow === true
          ? shown.map(row => renderFlowRow(el, row, table, data, act, query, longest))
          : shown.map(row => {
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
                    {/* Every turn is a button, the selected one too: the focus
                    ring follows the cursor onto it, and Enter opens it. */}
                    <Button
                      key={`turn-${row.index}`}
                      plain
                      dimColor={row.index !== data.selected}
                      label={label}
                      hover={{ scope: `turn:${row.index}`, backgroundColor: C.rowHover, ...hoverText(data) }}
                      onPress={() => act.pickTurn(row.index)}
                    />
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

// The search field's key: clear bumps the generation, and the new key is a new
// field, empty, where the engine would keep an unchanged value's typing.
export const searchFieldKey = (gen: number) => (gen === 0 ? 'turn-search' : `turn-search-${gen}`)

const NO_MATCH_HINT = 'Clear the search or try fewer words.'

type FlowCells = {
  marker: RenderChildren
  number: RenderChildren
  prompt: RenderChildren
  tools: RenderChildren
  time: RenderChildren
  tokens: RenderChildren
  bar: RenderChildren
}

// A row of the desktop app's table: a box per column at the text table's
// widths, the prompt taking what is left, so the header and every row line
// up in the app's proportional font.
function flowCells(el: El, key: string, columns: TurnTable['columns'], cells: FlowCells) {
  const { Box } = el
  const right = (width: number, child: RenderChildren) => (
    <Box width={width} flexShrink={0} justifyContent="flex-end">
      {child}
    </Box>
  )
  return (
    <Box key={key} flexDirection="row" columnGap={1}>
      <Box width={1} flexShrink={0}>
        {cells.marker}
      </Box>
      <Box width={columns.number} flexShrink={0}>
        {cells.number}
      </Box>
      <Box flexGrow={1} flexShrink={1} overflow="hidden">
        {cells.prompt}
      </Box>
      {columns.tools !== undefined && right(columns.tools, cells.tools)}
      {right(columns.time, cells.time)}
      {columns.tokens !== undefined && right(columns.tokens, cells.tokens)}
      {columns.bar !== undefined && (
        <Box width={columns.bar} flexShrink={0}>
          {cells.bar}
        </Box>
      )}
    </Box>
  )
}

// The characters a desktop row draws besides its prompt: every cell but the
// text table's cut prompt.
const flowCellsLength = (cells: TurnTable['rows'][number]['cells']) =>
  cells.number.length + cells.tools.length + cells.time.length + cells.tokens.length + cells.bar.length

// A turn of the desktop app's table: the number and the prompt are buttons
// that open it (a button holds one label, not a row); the prompt is the
// whole one, cut to the pane, and the box clips what the app's font spills.
function renderFlowRow(
  el: El,
  row: { index: number; snippet: string; cells?: TurnTable['rows'][number]['cells']; prompt?: string },
  table: TurnTable,
  data: Ctx,
  act: PaneActions,
  query: string,
  longest: number,
) {
  const { Box, Button, Text } = el
  const { cells } = row
  const isSelected = row.index === data.selected
  const isCursor = row.index === data.turnCursor
  const hover = { scope: `turn:${row.index}`, backgroundColor: C.rowHover }
  const button = (key: string, label: string) => (
    <Button
      key={key}
      plain
      dimColor={!isSelected}
      label={label}
      hover={{ ...hover, ...hoverText(data) }}
      onPress={() => act.pickTurn(row.index)}
    />
  )
  const muted = (text: string | undefined) => (
    <Text color={C.muted} hover={hover}>
      {text ?? ''}
    </Text>
  )
  return (
    <Box key={`turn-row-${row.index}`} flexDirection="column">
      {flowCells(el, `turn-cells-${row.index}`, table.columns, {
        marker: (
          <Text key={`turn-cursor-${row.index}`} color={isCursor ? C.accent : C.text}>
            {isCursor ? data.icons.cursor : isSelected ? data.icons.marker : ' '}
          </Text>
        ),
        // Text: a native button's own padding does not fit the number's box.
        number: (
          <Text key={`turn-num-${row.index}`} color={isSelected ? C.text : C.muted} hover={hover}>
            {cells?.number ?? `#${row.index + 1}`}
          </Text>
        ),
        prompt: button(`turn-${row.index}`, row.prompt ?? ''),
        tools: muted(cells?.tools),
        time: muted(cells?.time),
        tokens: muted(cells?.tokens),
        bar: (() => {
          const ms = data.stats[row.index]?.durationMs
          return ms === undefined || longest <= 0
            ? undefined
            : flowBar(el, `turn-${row.index}`, ms / longest, table.columns.bar ?? 8, ms >= longest)
        })(),
      })}
      {row.snippet !== '' && renderSnippet(el, row.snippet, query, data)}
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
