// The turn list as a table: number, prompt, tools, time, tokens and a bar.
import type { Icons } from '../icons'
import type { TurnStat } from '../../types'
import { formatDuration, formatTokens } from './format'
import type { Turn } from './types'
import { displayWidth, durationBar, padEndDisplay, truncateDisplay } from './width'

type TurnCells = { number: string; prompt: string; tools: string; time: string; tokens: string; bar: string }
type TurnTableRow = { index: number; cells: TurnCells; label: string }
export type TurnTable = { header: string; rows: TurnTableRow[] }

const TABLE_BAR_CELLS = 8
const TABLE_GAP = 2
// Pane widths from which tokens and the bar show, and from which tools show.
const TABLE_WIDE = 70
const TABLE_MEDIUM = 55

const padStartDisplay = (text: string, width: number) => ' '.repeat(Math.max(0, width - displayWidth(text))) + text

// The turn list as aligned columns by display width: number, prompt (the
// room that is left), tool count, duration, tokens and a duration bar
// relative to the longest turn. Narrow panes drop tokens and the bar, then
// tools. Rows are as wide as the table, so the marker column the view puts
// in front lines up under the header.
// The last table: the turn list draws on every tick with the same turns.
let last: { turns: readonly Turn[]; statsKey: string; width: number; icons: object; table: TurnTable } | undefined

const statsKeyOf = (stats: readonly (TurnStat | undefined)[]) =>
  stats.map(s => (s === undefined ? '-' : `${s.durationMs},${s.inputTokens ?? ''},${s.outputTokens ?? ''}`)).join(';')

export function turnTable(
  turns: readonly Turn[],
  stats: readonly (TurnStat | undefined)[],
  width: number,
  icons: Pick<Icons, 'ellipsis' | 'bar'>,
): TurnTable {
  const statsKey = statsKeyOf(stats)
  if (last?.turns === turns && last.statsKey === statsKey && last.width === width && last.icons === icons)
    return last.table
  const table = buildTable(turns, stats, width, icons)
  last = { turns, statsKey, width, icons, table }
  return table
}

function buildTable(
  turns: readonly Turn[],
  stats: readonly (TurnStat | undefined)[],
  width: number,
  icons: Pick<Icons, 'ellipsis' | 'bar'>,
): TurnTable {
  const inner = Math.max(0, width - 4)
  const hasTools = width >= TABLE_MEDIUM
  const hasWide = width >= TABLE_WIDE
  const numberWidth = Math.max(3, ...turns.map(turn => `#${turn.index + 1}`.length))
  const fixed = [numberWidth, 7, ...(hasTools ? [5] : []), ...(hasWide ? [7, TABLE_BAR_CELLS] : [])]
  const promptWidth = Math.max(0, inner - fixed.reduce((sum, w) => sum + w, 0) - TABLE_GAP * fixed.length)
  const longest = Math.max(0, ...turns.map(turn => stats[turn.index]?.durationMs ?? 0))

  const line = (c: TurnCells, pad: (text: string, width: number) => string): string =>
    [
      padEndDisplay(c.number, numberWidth),
      padEndDisplay(c.prompt, promptWidth),
      ...(hasTools ? [pad(c.tools, 5)] : []),
      pad(c.time, 7),
      ...(hasWide ? [pad(c.tokens, 7), padEndDisplay(c.bar, TABLE_BAR_CELLS)] : []),
    ].join(' '.repeat(TABLE_GAP))

  // A pane too narrow for even the number and time columns cuts the row.
  const fit = (row: string) => padEndDisplay(truncateDisplay(row, inner, ''), inner)
  const rows = turns.map(turn => {
    const stat = stats[turn.index]
    const cells: TurnCells = {
      number: `#${turn.index + 1}`,
      prompt: truncateDisplay(turn.prompt || '(no prompt)', promptWidth, icons.ellipsis),
      tools: hasTools && turn.toolCount > 0 ? String(turn.toolCount) : '',
      time: stat ? formatDuration(stat.durationMs) : '',
      tokens:
        hasWide && stat?.outputTokens !== undefined ? formatTokens((stat.inputTokens ?? 0) + stat.outputTokens) : '',
      bar: hasWide && stat ? durationBar(stat.durationMs, longest, TABLE_BAR_CELLS, icons) : '',
    }
    return { index: turn.index, cells, label: fit(line(cells, padStartDisplay)) }
  })
  const head = { number: '#', prompt: 'prompt', tools: 'tools', time: 'time', tokens: 'tokens', bar: '' }
  return { header: fit(line(head, padStartDisplay)).trimEnd(), rows }
}

export const EMPTY_TURN_TEXT = 'No tool calls or output in this turn.'
