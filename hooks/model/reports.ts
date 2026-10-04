// Text reports for surfaces that draw no pane (VS Code, claude -p).
import type { TurnStat } from '../../types'
import { clampText } from './clamp'
import { formatDuration, shortModel } from './format'
import { itemName, itemSummary } from './summaries'
import { turnTail } from './transcript'
import { EMPTY_TURN_TEXT } from './turn-table'
import type { Turn } from './types'
import { padEndDisplay, truncate, truncateDisplay } from './width'

//
// VS Code and `claude -p` draw no pane, so /tail and /tail-turns answer with
// the same content as text, capped like one text element.

const REPORT_CHARS = 8000

function clampReport(text: string): string {
  const shown = clampText(text, Infinity, REPORT_CHARS)
  return shown.note === undefined ? shown.text : `${shown.text}\n${shown.note}`
}

export function turnText(turn: Turn | undefined, stat: TurnStat | undefined): string {
  if (!turn) return 'No turns yet. Send a prompt and /tail lists its tool calls.'
  const head = [`Turn ${turn.index + 1}`, turnTail(turn)]
  if (stat?.model) head.splice(2, 0, shortModel(stat.model))
  if (stat) head.push(formatDuration(stat.durationMs))
  const lines = [head.join(' · ')]
  if (turn.prompt !== '') lines.push(`❯ ${truncate(turn.prompt, 200)}`)
  if (turn.items.length === 0) lines.push(`  ${EMPTY_TURN_TEXT}`)
  for (const item of turn.items) {
    const state = item.kind !== 'tool' ? '' : item.isError ? ' (error)' : item.isPending ? ' (no result yet)' : ''
    const duration = item.kind === 'tool' && item.durationMs !== undefined ? `  ${formatDuration(item.durationMs)}` : ''
    lines.push(`  ${padEndDisplay(itemName(item), 12)} ${itemSummary(item)}${state}${duration}`)
  }
  return clampReport(lines.join('\n'))
}

export function turnListText(turns: readonly Turn[], stats: readonly (TurnStat | undefined)[]): string {
  if (turns.length === 0) return 'No turns yet.'
  const lines = turns.map(
    (turn, i) =>
      `${padEndDisplay(`#${i + 1}`, 5)}${truncateDisplay(turn.prompt || '(no prompt)', 60)}  ${turnTail(turn, stats[i])}`,
  )
  return clampReport([`Turns (${turns.length}), newest last:`, ...lines].join('\n'))
}
