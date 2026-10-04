// Engine session rows -> turns: the items a reply produced, their status,
// a subagent's trace, and whether agents still run.
import type { AgentStatus, SessionMessage } from 'claude-code'
import { sanitizePrompt, sanitizeText, sanitizeValue } from './sanitize'
import { toolSummary } from './summaries'
import { SUBAGENT_TOOLS, type Item, type ToolItem, type Turn } from './types'

//
// Tool results, model output and tool inputs are untrusted: a fetched page or
// a file can carry terminal escape sequences (OSC 52 writes the clipboard,
// OSC 8 spoofs links, CSI moves the cursor over other rows) or bidi controls
// that make code read differently than it runs (Trojan Source). Everything
// from the transcript passes through sanitizeText before it is drawn.

export const isSubagent = (item: Item): item is ToolItem & { agentId: string } =>
  item.kind === 'tool' && SUBAGENT_TOOLS.has(item.tool) && item.agentId !== undefined

export type ItemStatus = 'done' | 'error' | 'running' | 'idle' | 'interrupted'

const INTERRUPTED = /^\[Request interrupted by user/i

function isInterruptedResult(result: unknown): boolean {
  return typeof result === 'object' && result !== null && (result as { interrupted?: unknown }).interrupted === true
}

// Where a tool call stands. A pending call runs only on the latest turn while
// the session works (rule P6), else it waits; a subagent whose agent runs
// always runs. The session rows carry no interrupt flag, so an interrupted
// call is told by the error text Claude Code stores for it.
export function itemStatus(
  item: ToolItem,
  ctx: { isLatest: boolean; isWorking: boolean; isAgentRunning?: boolean },
): ItemStatus {
  if (ctx.isAgentRunning === true) return 'running'
  if (item.isPending) return ctx.isLatest && ctx.isWorking ? 'running' : 'idle'
  if (item.isInterrupted === true) return 'interrupted'
  if (!item.isError) return 'done'
  return INTERRUPTED.test(item.resultText ?? '') ? 'interrupted' : 'error'
}

// Groups the transcript into turns: a turn opens on a user prompt and holds
// every assistant message up to the next one. Tool-result rows carry nothing
// new (each toolUses entry already has its result), so they are skipped.
export function buildTurns(messages: readonly SessionMessage[], idPrefix = ''): Turn[] {
  const turns: Turn[] = []
  let current: Turn | undefined

  const open = (prompt: string): Turn => {
    const turn: Turn = {
      index: turns.length,
      prompt,
      items: [],
      toolCount: 0,
      outputCount: 0,
      subagentCount: 0,
    }
    turns.push(turn)
    return turn
  }

  for (const m of messages) {
    if (m.role === 'user') {
      const text = sanitizeText(m.text).trim()
      if (text === '' || (m.toolResults?.length ?? 0) > 0) continue
      current = open(sanitizePrompt(text))
      continue
    }

    current ??= open('')
    const text = sanitizeText(m.text).trim()
    if (text !== '') {
      current.items.push({
        kind: 'output',
        id: `${idPrefix}t${current.index}:o${current.outputCount}`,
        text,
      })
      current.outputCount += 1
    }
    for (const use of m.toolUses) {
      const input = sanitizeValue(use.input) as Record<string, unknown>
      const tool = sanitizeText(use.tool)
      const item: ToolItem = {
        kind: 'tool',
        id: idPrefix + use.tool_use_id,
        tool,
        input,
        summary: toolSummary(tool, input),
        resultText: use.text === undefined ? undefined : sanitizeText(use.text),
        isError: use.isError === true,
        isPending: use.text === undefined,
        isInterrupted: isInterruptedResult(use.result),
        agentId: use.agentId,
        durationMs: use.durationMs,
      }
      current.items.push(item)
      current.toolCount += 1
      if (isSubagent(item)) current.subagentCount += 1
    }
  }

  return turns
}

// Flattens every turn of a subagent's conversation into one trace.
export function traceItems(messages: readonly SessionMessage[], idPrefix: string): Item[] {
  return buildTurns(messages, idPrefix).flatMap(turn => turn.items)
}

export function traceStats(items: readonly Item[]): { tools: number; messages: number } {
  let tools = 0
  let messages = 0
  for (const item of items) {
    if (item.kind === 'tool') tools += 1
    else messages += 1
  }
  return { tools, messages }
}

// A cheap fingerprint of a transcript, so buildTurns reruns only when it
// changes: a message added (length, first and last), a tool answered (a new
// result row, or the outcome filled in place once the 4096-message window
// is full), the last message's text grown. It watches the last message, so
// in-place edits to earlier messages are picked up only when the key changes.
export function turnsKey(messages: readonly SessionMessage[]): string {
  const last = messages.at(-1)
  if (!last) return '0'
  const lastTool = last.toolResults?.at(-1)?.tool_use_id ?? last.toolUses.at(-1)?.tool_use_id ?? ''
  const answered = last.toolUses.filter(use => use.text !== undefined).length
  return [messages.length, messages[0]!.text.length, last.role, lastTool, last.text.length, answered].join('|')
}

// One classifier for an agent's status, shared by the pane and the ticker.
export const isAgentRunning = (status: AgentStatus | undefined): boolean =>
  status === 'running' || status === 'pending' || status === 'waiting'

// A finished agent's transcript no longer changes, so its trace is final.
export const isAgentFinished = (status: AgentStatus | undefined): boolean =>
  status === 'completed' || status === 'failed' || status === 'killed'
