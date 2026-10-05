// Turn search: the turns whose prompt or reply match a query, with a snippet.
import type { Turn } from './types'
import { expandTabs } from './width'

export type TurnMatch = { index: number; snippet: string }

const SNIPPET = 80

// The texts a turn is searched in, as written and lowercased. A turn is not
// changed once built (a new transcript builds new turns), so each is
// lowercased once rather than on every keystroke.
type Haystacks = { texts: readonly string[]; lowered: readonly string[] }
const haystacks = new WeakMap<Turn, Haystacks>()

function haystacksOf(turn: Turn): Haystacks {
  let found = haystacks.get(turn)
  if (found === undefined) {
    const texts = searchable(turn)
    found = { texts, lowered: texts.map(text => text.toLowerCase()) }
    haystacks.set(turn, found)
  }
  return found
}

// The last search. A text holding a query holds every part of it, so a query
// that extends the last one over the same turns looks only in the turns that
// matched.
let last: { turns: readonly Turn[]; needle: string; hits: readonly Turn[] } | undefined

// Turns whose prompt, output, tool summaries or tool results contain `query`
// as plain text (case-insensitive, no pattern syntax), each with a one-line
// snippet around its first hit. indexOf keeps it linear in the text.
export function searchTurns(turns: readonly Turn[], query: string, ellipsis = '…'): TurnMatch[] {
  const needle = query.trim().toLowerCase()
  if (needle === '') return []
  const pool = last !== undefined && last.turns === turns && needle.includes(last.needle) ? last.hits : turns
  const matches: TurnMatch[] = []
  const hits: Turn[] = []
  for (const turn of pool) {
    const { texts, lowered } = haystacksOf(turn)
    for (let i = 0; i < lowered.length; i++) {
      const at = lowered[i]!.indexOf(needle)
      if (at >= 0) {
        hits.push(turn)
        matches.push({ index: turn.index, snippet: snippetAt(texts[i]!, at, ellipsis) })
        break
      }
    }
  }
  last = { turns, needle, hits }
  return matches
}

function searchable(turn: Turn): string[] {
  const texts = [turn.prompt]
  for (const item of turn.items) {
    if (item.kind === 'output') texts.push(item.text)
    else texts.push(item.summary, item.resultText ?? '')
  }
  return texts
}

// The index of the code point of `chars` that holds offset `at` of their
// lowercased text, whose length can differ from the original's.
function charIndexAt(chars: readonly string[], at: number): number {
  let hit = 0
  for (let pos = 0; hit < chars.length - 1; hit++) {
    pos += chars[hit]!.toLowerCase().length
    if (pos > at) break
  }
  return hit
}

// Cuts by code point, so no surrogate pair is split. `at` is an offset into
// the lowercased text, mapped back to a code point of `text` first.
function snippetAt(text: string, at: number, ellipsis: string): string {
  const chars = [...text]
  const hit = charIndexAt(chars, at)
  const start = Math.max(0, Math.min(hit - 20, chars.length - SNIPPET))
  const end = Math.min(chars.length, start + SNIPPET)
  const width = [...ellipsis].length
  const head = start > 0 ? ellipsis : ''
  const tail = end < chars.length ? ellipsis : ''
  const body = chars.slice(start > 0 ? start + width : start, end < chars.length ? end - width : end).join('')
  return head + expandTabs(body).replaceAll('\n', ' ') + tail
}

// A snippet in three parts around the first hit of `query` (case-insensitive,
// offsets mapped as snippetAt does): what precedes it, the hit as written, and
// what follows. No hit leaves the whole snippet in `before`.
export function splitMatch(
  snippet: string,
  query: string,
  ellipsis = '…',
): { before: string; match: string; after: string } {
  const whole = { before: snippet, match: '', after: '' }
  const needle = query.trim().toLowerCase()
  if (needle === '') return whole
  // The ellipsis marking a cut at either end is not part of the text.
  const lead = snippet.startsWith(ellipsis) ? ellipsis : ''
  const tail = snippet.length > lead.length && snippet.endsWith(ellipsis) ? ellipsis : ''
  const core = snippet.slice(lead.length, snippet.length - tail.length)
  const at = core.toLowerCase().indexOf(needle)
  if (at < 0) return whole
  const chars = [...core]
  const start = charIndexAt(chars, at)
  let end = start
  for (let covered = 0; end < chars.length && covered < needle.length; end++)
    covered += chars[end]!.toLowerCase().length
  return {
    before: lead + chars.slice(0, start).join(''),
    match: chars.slice(start, end).join(''),
    after: chars.slice(end).join('') + tail,
  }
}
