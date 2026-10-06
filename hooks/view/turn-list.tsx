// The turn list: a table of the session's turns with search, its snippets, and
// the row ids its cursor walks.
import { C } from '../theme'
import { sanitizeText } from '../model/sanitize'
import type { RowBlock } from '../model/scroll'
import { splitMatch } from '../model/search'
import { turnTable } from '../model/turn-table'
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
import { buttonHover, cutter, endWrap, HOVER_TEXT, isUnicodeCut, type El } from './kit'

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
              hover={buttonHover('btn:search-clear')}
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
                {/* Every turn is a button, the selected one too: the focus
                    ring follows the cursor onto it, and Enter opens it. */}
                <Button
                  key={`turn-${row.index}`}
                  plain
                  dimColor={row.index !== data.selected}
                  label={label}
                  hover={{ scope: `turn:${row.index}`, backgroundColor: C.rowHover, ...HOVER_TEXT }}
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
