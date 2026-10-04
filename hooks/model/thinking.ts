// Thinking: how many thinking blocks each turn has and their readable text.
import { sanitizeText } from './sanitize'

//
// The rows ($.session.messages()) carry no thinking; the Messages API form
// ($.session.messages({ as: 'api' })) does, as `thinking` blocks (their text
// may be empty) and `redacted_thinking` blocks (no text at all).

export type ApiLike = { role: 'user' | 'assistant'; content?: readonly { type: string; [field: string]: unknown }[] }

export type TurnThinking = { count: number; text: string }

// Thinking per turn, turns opened as buildTurns opens them: on a user
// message with text that is not a tool result.
export function thinkingCounts(messages: readonly ApiLike[]): TurnThinking[] {
  const turns: { count: number; texts: string[] }[] = []
  let current: { count: number; texts: string[] } | undefined
  const open = () => {
    current = { count: 0, texts: [] }
    turns.push(current)
    return current
  }

  for (const m of messages) {
    if (m === null || typeof m !== 'object') continue
    const blocks =
      typeof m.content === 'string'
        ? [{ type: 'text', text: m.content }]
        : Array.isArray(m.content)
          ? m.content.filter(block => block !== null && typeof block === 'object')
          : []
    if (m.role === 'user') {
      const isResult = blocks.some(block => block.type === 'tool_result')
      const hasText = blocks.some(block => {
        const value = block['text']
        return block.type === 'text' && typeof value === 'string' && value.trim() !== ''
      })
      if (hasText && !isResult) open()
      continue
    }
    const turn = current ?? open()
    for (const block of blocks) {
      if (block.type !== 'thinking' && block.type !== 'redacted_thinking') continue
      turn.count += 1
      const thought = block['thinking']
      const clean = typeof thought === 'string' ? sanitizeText(thought).trim() : ''
      if (clean !== '') turn.texts.push(clean)
    }
  }
  return turns.map(turn => ({ count: turn.count, text: turn.texts.join('\n\n') }))
}

// The entry of `items` for turn `index` of `total` turns, the lists paired
// from their ends: both end with the latest turn, while the API form may
// hold fewer early turns after a compaction.
export function alignFromEnd<T>(items: readonly T[], total: number, index: number): T | undefined {
  const at = items.length - (total - index)
  return at >= 0 ? items[at] : undefined
}
