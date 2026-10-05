// The card a hover on a collapsed row shows: its input in a few lines, and the
// label of a folded run.
import type { Icons } from '../icons'
import { DEFAULT_GLYPHS, type Glyphs } from './format'
import type { GroupItem } from './groups'
import { sanitizeText } from './sanitize'
import { inputSections } from './sections'
import type { ToolItem } from './types'
import { str } from './values'
import { expandTabs, truncateDisplay } from './width'

const CARD_LINES = 6
// A card is a glance, not a frame: never wider than this, however wide the pane.
const CARD_WIDTH = 72
// What one card may carry in all, whatever the width: a pane draws many.
const CARD_CHARS = 600

// The preview a collapsed tool row shows on hover: the first lines of its
// input frame (the command, the path and parameters), each cut to `width`
// cells and the whole to CARD_CHARS characters. Undefined when the call
// has no input to show. Read from the input alone: a pane draws a card for
// every collapsed row, so none builds a diff or the output.
export function hoverCard(item: ToolItem, width: number, glyphs: Glyphs = DEFAULT_GLYPHS): string[] | undefined {
  const source = cardSource(item, glyphs)
  if (source.length === 0) return undefined
  const lines: string[] = []
  const room = Math.max(1, Math.min(width, CARD_WIDTH))
  let left = CARD_CHARS
  for (const raw of source.slice(0, CARD_LINES)) {
    if (left <= 0) break
    const line = [...truncateDisplay(expandTabs(sanitizeText(raw)), room, glyphs.ellipsis)].slice(0, left).join('')
    lines.push(line)
    left -= line.length + 1
  }
  return lines
}

// The first lines of a call's input frame, at most CARD_LINES of them.
function cardSource(item: ToolItem, glyphs: Glyphs): string[] {
  if (item.tool === 'Edit' || item.tool === 'MultiEdit') return editCardLines(item)
  const body = inputSections(item, glyphs)[0]?.body ?? ''
  if (body.trim() === '') return []
  // A tool without its own input frame is drawn as JSON; a card reads it as
  // one `key: value` line per field instead of braces, quotes and indents.
  if (body.trimStart().startsWith('{')) return fieldLines(item.input)
  return body.split('\n', CARD_LINES)
}

function fieldLines(input: Record<string, unknown>): string[] {
  return Object.entries(input)
    .slice(0, CARD_LINES)
    .map(([key, value]) => `${key}: ${typeof value === 'string' ? value : JSON.stringify(value)}`.replace(/\s+/g, ' '))
}

// An edit's card: per edit its first old lines as - and its first new lines
// as +, half the room each unless one side is shorter.
function editCardLines(item: ToolItem): string[] {
  const f = item.input
  const edits = item.tool === 'Edit' ? [f] : Array.isArray(f['edits']) ? (f['edits'] as unknown[]) : []
  const lines: string[] = []
  for (const e of edits) {
    const room = CARD_LINES - lines.length
    if (room <= 0) break
    const edit = e !== null && typeof e === 'object' ? (e as Record<string, unknown>) : {}
    const before = str(edit, 'old_string')
    const after = str(edit, 'new_string')
    if (before === '' && after === '') continue
    const olds = before.split('\n', CARD_LINES)
    const news = after.split('\n', CARD_LINES)
    const oldTake = Math.min(olds.length, Math.max(Math.ceil(room / 2), room - news.length))
    lines.push(...olds.slice(0, oldTake).map(l => `-${l}`), ...news.slice(0, room - oldTake).map(l => `+${l}`))
  }
  return lines
}

// What a call is about, per tool: the noun its distinct values are counted as.
const GROUP_NOUNS: Record<string, { key: string; one: string; many: string }> = {
  Read: { key: 'file_path', one: 'file', many: 'files' },
  Grep: { key: 'pattern', one: 'pattern', many: 'patterns' },
  Glob: { key: 'pattern', one: 'pattern', many: 'patterns' },
  WebFetch: { key: 'url', one: 'page', many: 'pages' },
  WebSearch: { key: 'query', one: 'query', many: 'queries' },
}

// `Read ×7 · 4 files`: the calls, then how many distinct targets they hit.
export function groupLabel(group: GroupItem, icons: Pick<Icons, 'times' | 'dot'>): string {
  const head = `${group.tool} ${icons.times}${group.items.length}`
  const noun = GROUP_NOUNS[group.tool]
  if (noun === undefined) return head
  const distinct = new Set(group.items.map(item => str(item.input, noun.key)).filter(Boolean)).size
  return distinct === 0 ? head : `${head} ${icons.dot} ${distinct} ${distinct === 1 ? noun.one : noun.many}`
}
