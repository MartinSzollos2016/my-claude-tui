// Thinking: how many thinking blocks each turn has and their readable text.
import { sanitizeText } from './sanitize'
import { apiKeyOf, apiPromptOf, blocksOf } from './turns'

//
// The rows ($.session.messages()) carry no thinking; the Messages API form
// ($.session.messages({ as: 'api' })) does, as `thinking` blocks (their text
// may be empty) and `redacted_thinking` blocks (no text at all).

export type ApiLike = { role: 'user' | 'assistant'; content?: readonly { type: string; [field: string]: unknown }[] }

export type TurnThinking = { count: number; text: string }

// Thinking by turn start: the thinking of every assistant message from an API
// prompt up to the next one, keyed by the row key of the first of them that
// a row carries (apiKeyOf, as Turn.startKey), so it lands on the turn that
// holds the reply, however the rows group it.
export function thinkingByStart(api: readonly ApiLike[]): ReadonlyMap<string, TurnThinking> {
  type Group = { key?: string; count: number; texts: string[] }
  const groups: Group[] = []
  let current: Group | undefined
  for (const m of api) {
    if (m === null || typeof m !== 'object') continue
    const blocks = blocksOf(m)
    if (m.role === 'user') {
      if (apiPromptOf(blocks) === undefined) continue
      current = { count: 0, texts: [] }
      groups.push(current)
      continue
    }
    if (current === undefined) continue
    current.key ??= apiKeyOf(blocks)
    for (const block of blocks) {
      if (block.type !== 'thinking' && block.type !== 'redacted_thinking') continue
      current.count += 1
      const thought = block['thinking']
      const clean = typeof thought === 'string' ? sanitizeText(thought).trim() : ''
      if (clean !== '') current.texts.push(clean)
    }
  }
  return new Map(
    groups.flatMap(group =>
      group.key === undefined ? [] : [[group.key, { count: group.count, text: group.texts.join('\n\n') }] as const],
    ),
  )
}
