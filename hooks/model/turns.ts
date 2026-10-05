// Engine session rows -> turns: the items a reply produced, their status,
// a subagent's trace, and whether agents still run.
import type { AgentStatus, SessionMessage } from 'claude-code'
import { sanitizePrompt, sanitizeText, sanitizeValue } from './sanitize'
import { toolSummary } from './summaries'
import { SUBAGENT_TOOLS, type Item, type ToolItem, type Turn } from './types'

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

type ToolUse = SessionMessage['toolUses'][number]
type ToolPiece = Omit<ToolItem, 'kind' | 'id'>

// The sanitized pieces of a row, independent of where the row sits: a user
// row's prompt (undefined when it opens no turn), an assistant row's text,
// a tool use's fields. Turn indexes and output ids depend on position, so
// they are not part of a piece.
type Pieces = {
  prompt: (text: string, hasResults: boolean) => string | undefined
  output: (text: string) => string
  tool: (use: ToolUse) => ToolPiece
}

const fresh: Pieces = {
  prompt: (text, hasResults) => {
    const clean = sanitizeText(text).trim()
    return clean === '' || hasResults ? undefined : sanitizePrompt(clean)
  },
  output: text => sanitizeText(text).trim(),
  tool: use => {
    const input = sanitizeValue(use.input) as Record<string, unknown>
    const tool = sanitizeText(use.tool)
    return {
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
  },
}

// Groups the transcript into turns: a turn opens on a user prompt and holds
// every assistant message up to the next one. Tool-result rows carry nothing
// new (each toolUses entry already has its result), so they are skipped.
export function buildTurns(messages: readonly SessionMessage[], idPrefix = ''): Turn[] {
  return assemble(messages, idPrefix, fresh)
}

// Where a text's memo entry is looked for: a short text is its own key, a
// longer one is keyed by its length and a hash of a fixed sample (both ends
// and strided points), so the key costs the same for any length. A key only
// finds the entry; a hit also needs the entry's source to equal the text.
const WHOLE = 256
const SAMPLE = 64

export function textPrint(text: string): string {
  if (text.length <= WHOLE) return `=${text}`
  let hash = 0x811c9dc5
  const mix = (at: number) => {
    hash = Math.imul(hash ^ text.charCodeAt(at), 0x01000193)
  }
  const n = text.length
  for (let i = 0; i < SAMPLE; i++) mix(i)
  for (let i = n - SAMPLE; i < n; i++) mix(i)
  const step = n / SAMPLE
  for (let i = 0; i < SAMPLE; i++) mix(Math.floor(i * step))
  return `#${n}:${(hash >>> 0).toString(36)}`
}

// A tool use's fields its piece is built from; `input` as JSON, or undefined
// when it does not serialize (a cycle, a bigint), which never matches.
type ToolSource = {
  tool: string
  text: string | undefined
  isError: boolean
  isInterrupted: boolean
  agentId: string | undefined
  durationMs: number | undefined
  input: string | undefined
}

function toolSource(use: ToolUse): ToolSource {
  let input: string | undefined
  try {
    input = JSON.stringify(use.input) ?? String(use.input)
  } catch {
    input = undefined
  }
  return {
    tool: use.tool,
    text: use.text,
    isError: use.isError === true,
    isInterrupted: isInterruptedResult(use.result),
    agentId: use.agentId,
    durationMs: use.durationMs,
    input,
  }
}

const sameSource = (a: ToolSource, b: ToolSource): boolean =>
  a.input !== undefined &&
  a.input === b.input &&
  a.tool === b.tool &&
  a.text === b.text &&
  a.isError === b.isError &&
  a.isInterrupted === b.isInterrupted &&
  a.agentId === b.agentId &&
  a.durationMs === b.durationMs

// Builds turns like buildTurns, keeping each row's sanitized pieces between
// builds so a rebuild after the tail changed sanitizes only the new or
// changed rows. Each read of the transcript may hand out new objects, so a
// piece is found by content (a row by its text's key, a tool use by its id
// and its input's and result's keys)
// and reused only when its source equals the row's in full. Only the pieces
// the last build used are kept, so the memo is bounded by the transcript.
// `work` counts the pieces built, for tests.
export function incrementalTurns(): {
  build: (messages: readonly SessionMessage[], idPrefix?: string) => Turn[]
  work: { messages: number; tools: number }
} {
  type Row = { source: string; value: string | undefined }
  type Tool = { source: ToolSource; value: ToolPiece }
  const work = { messages: 0, tools: 0 }
  let rows = new Map<string, Row>()
  let tools = new Map<string, Tool>()
  let nextRows = new Map<string, Row>()
  let nextTools = new Map<string, Tool>()

  const row = (kind: string, text: string, make: () => string | undefined): string | undefined => {
    const key = kind + textPrint(text)
    let entry = nextRows.get(key) ?? rows.get(key)
    if (entry?.source !== text) {
      entry = { source: text, value: make() }
      work.messages += 1
    }
    nextRows.set(key, entry)
    return entry.value
  }

  const pieces: Pieces = {
    prompt: (text, hasResults) => row(hasResults ? 'ur' : 'u', text, () => fresh.prompt(text, hasResults)),
    output: text => row('a', text, () => fresh.output(text)) ?? '',
    tool: use => {
      const source = toolSource(use)
      const key = [
        use.tool_use_id,
        textPrint(source.input ?? ''),
        source.text === undefined ? '-' : textPrint(source.text),
      ].join('\u0000')
      let entry = nextTools.get(key) ?? tools.get(key)
      if (entry === undefined || !sameSource(entry.source, source)) {
        entry = { source, value: fresh.tool(use) }
        work.tools += 1
      }
      nextTools.set(key, entry)
      return entry.value
    },
  }

  const build = (messages: readonly SessionMessage[], idPrefix = ''): Turn[] => {
    const turns = assemble(messages, idPrefix, pieces)
    rows = nextRows
    tools = nextTools
    nextRows = new Map()
    nextTools = new Map()
    return turns
  }

  return { build, work }
}

function assemble(messages: readonly SessionMessage[], idPrefix: string, pieces: Pieces): Turn[] {
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
      const prompt = pieces.prompt(m.text, (m.toolResults?.length ?? 0) > 0)
      if (prompt !== undefined) current = open(prompt)
      continue
    }

    current ??= open('')
    const text = pieces.output(m.text)
    if (text !== '') {
      current.items.push({
        kind: 'output',
        id: `${idPrefix}t${current.index}:o${current.outputCount}`,
        text,
      })
      current.outputCount += 1
    }
    for (const use of m.toolUses) {
      const item: ToolItem = { kind: 'tool', id: idPrefix + use.tool_use_id, ...pieces.tool(use) }
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
