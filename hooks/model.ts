// Pure transformations: engine session rows -> turns -> display items, plus
// the formatters and per-tool one-line summaries ported from tail-claude /
// agent-ouija (claude/tools/summary.go). No engine calls here.
import type { SessionMessage } from 'claude-code'

export type OutputItem = { kind: 'output'; id: string; text: string }

export type ToolItem = {
  kind: 'tool'
  id: string
  tool: string
  input: Record<string, unknown>
  summary: string
  resultText?: string
  isError: boolean
  isPending: boolean
  agentId?: string
  durationMs?: number
}

export type Item = OutputItem | ToolItem

export type Turn = {
  index: number
  prompt: string
  items: Item[]
  toolCount: number
  outputCount: number
  subagentCount: number
}

const SUBAGENT_TOOLS = new Set(['Agent', 'Task'])

// -- Untrusted text -----------------------------------------------------------
//
// Tool results, model output and tool inputs are untrusted: a fetched page or
// a file can carry terminal escape sequences (OSC 52 writes the clipboard,
// OSC 8 spoofs links, CSI moves the cursor over other rows) or bidi controls
// that make code read differently than it runs (Trojan Source). Everything
// from the transcript passes through sanitizeText before it is drawn.

// CSI, OSC (BEL or ST terminated), DCS/SOS/PM/APC strings, two-byte escapes.
const ESCAPE_SEQUENCES =
  /\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007\u001b]*(?:\u0007|\u001b\\)?|[PX^_][^\u001b]*(?:\u001b\\)?|[@-Z\\-_])/g
// C0 controls except tab and newline (CR included: it overdraws a line), DEL, C1.
const CONTROL_CHARS = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g
// Bidi embeddings, overrides and isolates, plus the implicit marks.
const BIDI_CONTROLS = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g

const MAX_DEPTH = 32

export function sanitizeText(text: string): string {
  return text.replace(ESCAPE_SEQUENCES, '').replace(CONTROL_CHARS, '').replace(BIDI_CONTROLS, '')
}

// Deep-sanitizes the string leaves of a JSON-like value (a tool's input).
// Depth is capped so a pathological input cannot exhaust the stack.
export function sanitizeValue(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') return sanitizeText(value)
  if (value === null || typeof value !== 'object') return value
  if (depth >= MAX_DEPTH) return '…'
  if (Array.isArray(value)) return value.map(v => sanitizeValue(v, depth + 1))
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [sanitizeText(k), sanitizeValue(v, depth + 1)]))
}

export const isSubagent = (item: Item): item is ToolItem & { agentId: string } =>
  item.kind === 'tool' && SUBAGENT_TOOLS.has(item.tool) && item.agentId !== undefined

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

// Turns XML-ish wrappers the engine injects into a readable one-liner.
export function sanitizePrompt(text: string): string {
  const command = /<command-name>\s*([^<]+?)\s*<\/command-name>/.exec(text)
  if (command) {
    const args = /<command-args>\s*([^<]*?)\s*<\/command-args>/.exec(text)?.[1] ?? ''
    return args ? `${command[1]} ${args}` : command[1]!
  }
  const task = /<task-notification>[\s\S]*?<summary>\s*([^<]+?)\s*<\/summary>/.exec(text)
  if (task) return `Task notification: ${task[1]}`
  return text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').replace(/<[^>]+>/g, '').trim()
}

// -- Formatters (tail-claude format.go) --------------------------------------

// "claude-opus-4-6" -> "opus4.6", "claude-sonnet-5-20260203" -> "sonnet5"
export function shortModel(model: string): string {
  const m = model.replace(/^claude-/, '').replace(/\[.*\]$/, '')
  const dash = m.indexOf('-')
  if (dash < 0) return m
  const family = m.slice(0, dash)
  const v = m.slice(dash + 1).split('-')
  let version = v[0] ?? ''
  if (v.length >= 2 && (v[1] ?? '').length <= 2) version = `${v[0]}-${v[1]}`
  return family + version.replaceAll('-', '.')
}

export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return String(Math.round(n))
}

export function formatDuration(ms: number): string {
  const secs = ms / 1000
  const s = Math.round(secs)
  if (s >= 60) return `${Math.floor(s / 60)}m ${s % 60}s`
  if (secs >= 10) return `${s}s`
  return `${secs.toFixed(1)}s`
}

export function formatClock(ms: number): string {
  const d = new Date(ms)
  const h = d.getHours()
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${h % 12 === 0 ? 12 : h % 12}:${pad(d.getMinutes())}:${pad(d.getSeconds())} ${h < 12 ? 'AM' : 'PM'}`
}

export function shortMode(mode: string): string {
  switch (mode) {
    case 'bypassPermissions':
      return 'bypass'
    case 'acceptEdits':
      return 'accept edits'
    case 'default':
      return ''
    default:
      return mode
  }
}

export function truncate(s: string, max: number): string {
  const one = s.replaceAll('\n', ' ')
  const chars = [...one]
  return chars.length <= max ? one : chars.slice(0, max - 1).join('') + '…'
}

export function shortPath(path: string, n: number): string {
  const segments = path.replaceAll('\\', '/').split('/').filter(Boolean)
  return segments.slice(-n).join('/')
}

const basename = (p: string) => shortPath(p, 1)

// -- Tool summaries (agent-ouija claude/tools/summary.go) ---------------------

const str = (f: Record<string, unknown>, key: string): string =>
  typeof f[key] === 'string' ? (f[key] as string) : ''

const num = (f: Record<string, unknown>, key: string): number =>
  typeof f[key] === 'number' ? Math.trunc(f[key] as number) : 0

const lineCount = (s: string) => s.split('\n').length

export function toolSummary(name: string, f: Record<string, unknown>): string {
  switch (name) {
    case 'Read': {
      const fp = str(f, 'file_path')
      if (!fp) return 'Read'
      const limit = num(f, 'limit')
      if (limit > 0) {
        const offset = num(f, 'offset') || 1
        return `${shortPath(fp, 2)} - lines ${offset}-${offset + limit - 1}`
      }
      return shortPath(fp, 2)
    }
    case 'Write': {
      const fp = str(f, 'file_path')
      if (!fp) return 'Write'
      const content = str(f, 'content')
      return content ? `${shortPath(fp, 2)} - ${lineCount(content)} lines` : shortPath(fp, 2)
    }
    case 'Edit': {
      const fp = str(f, 'file_path')
      if (!fp) return 'Edit'
      const oldS = str(f, 'old_string')
      const newS = str(f, 'new_string')
      if (oldS && newS) {
        const a = lineCount(oldS)
        const b = lineCount(newS)
        if (a === b) return `${shortPath(fp, 2)} - ${a} line${a > 1 ? 's' : ''}`
        return `${shortPath(fp, 2)} - ${a} -> ${b} lines`
      }
      return shortPath(fp, 2)
    }
    case 'Bash': {
      const desc = str(f, 'description')
      const cmd = str(f, 'command')
      if (desc && cmd) return truncate(`${desc}: ${cmd}`, 60)
      if (desc || cmd) return truncate(desc || cmd, 60)
      return 'Bash'
    }
    case 'Grep':
    case 'Glob': {
      const pattern = str(f, 'pattern')
      if (!pattern) return name
      const pat = `"${truncate(pattern, 30)}"`
      const glob = name === 'Grep' ? str(f, 'glob') : ''
      if (glob) return `${pat} in ${glob}`
      const p = str(f, 'path')
      return p ? `${pat} in ${basename(p)}` : pat
    }
    case 'Task':
    case 'Agent':
    case 'Skill': {
      const type = str(f, 'subagent_type') || str(f, 'skill')
      const desc = str(f, 'description')
      const prefix = type ? `${type} - ` : ''
      if (desc) return prefix + truncate(desc, 40)
      return type || 'Task'
    }
    case 'Workflow':
      return str(f, 'name') || (str(f, 'scriptPath') ? basename(str(f, 'scriptPath')) : 'inline script')
    case 'LSP': {
      const op = str(f, 'operation')
      if (!op) return 'LSP'
      const fp = str(f, 'filePath')
      return fp ? `${op} - ${basename(fp)}` : op
    }
    case 'WebFetch': {
      const raw = str(f, 'url')
      if (!raw) return 'WebFetch'
      try {
        const u = new URL(raw)
        return truncate(u.hostname + u.pathname, 50)
      } catch {
        return truncate(raw, 50)
      }
    }
    case 'WebSearch': {
      const q = str(f, 'query')
      return q ? `"${truncate(q, 40)}"` : 'WebSearch'
    }
    case 'TodoWrite': {
      const todos = f['todos']
      if (!Array.isArray(todos)) return 'TodoWrite'
      return `${todos.length} item${todos.length === 1 ? '' : 's'}`
    }
    case 'NotebookEdit': {
      const nb = str(f, 'notebook_path')
      if (!nb) return 'NotebookEdit'
      const mode = str(f, 'edit_mode')
      return mode ? `${mode} - ${basename(nb)}` : basename(nb)
    }
    case 'TaskCreate':
      return str(f, 'subject') ? truncate(str(f, 'subject'), 50) : 'Create task'
    case 'TaskUpdate': {
      const parts: string[] = []
      if (str(f, 'taskId')) parts.push(`#${str(f, 'taskId')}`)
      if (str(f, 'status')) parts.push(str(f, 'status'))
      if (str(f, 'owner')) parts.push(`-> ${str(f, 'owner')}`)
      return parts.length > 0 ? parts.join(' ') : 'Update task'
    }
    case 'SendMessage': {
      const type = str(f, 'type')
      const to = str(f, 'recipient') || str(f, 'to')
      const summary = str(f, 'summary')
      if (type === 'shutdown_request' && to) return `Shutdown ${to}`
      if (type === 'shutdown_response') return 'Shutdown response'
      if (type === 'broadcast') return `Broadcast: ${truncate(summary, 30)}`
      if (to) return `To ${to}: ${truncate(summary || str(f, 'message'), 30)}`
      return 'Send message'
    }
    case 'ToolSearch':
      return str(f, 'query') ? truncate(str(f, 'query'), 50) : 'ToolSearch'
    default:
      return summaryDefault(name, f)
  }
}

function summaryDefault(name: string, f: Record<string, unknown>): string {
  for (const key of ['name', 'path', 'file', 'query', 'command']) {
    if (str(f, key)) return truncate(str(f, key), 50)
  }
  for (const key of Object.keys(f).sort()) {
    if (str(f, key)) return truncate(str(f, key), 40)
  }
  return name
}

export type ToolCategory = 'read' | 'edit' | 'search' | 'task' | 'web' | 'other'

export function toolCategory(name: string): ToolCategory {
  switch (name) {
    case 'Read':
      return 'read'
    case 'Edit':
    case 'Write':
    case 'NotebookEdit':
      return 'edit'
    case 'Grep':
    case 'Glob':
      return 'search'
    case 'Task':
    case 'Agent':
    case 'Skill':
    case 'Workflow':
      return 'task'
    case 'WebFetch':
    case 'WebSearch':
      return 'web'
    default:
      return 'other'
  }
}

// Display name for a row: the subagent type for Agent calls, the tool otherwise.
export function itemName(item: Item): string {
  if (item.kind === 'output') return 'Output'
  if (SUBAGENT_TOOLS.has(item.tool)) return str(item.input, 'subagent_type') || 'Subagent'
  if (item.tool.startsWith('mcp__')) return item.tool.split('__').at(-1) ?? item.tool
  return item.tool
}

export function itemSummary(item: Item): string {
  if (item.kind === 'output') return truncate(item.text, 40)
  if (SUBAGENT_TOOLS.has(item.tool)) return str(item.input, 'description') || item.summary
  return item.summary === item.tool ? '' : item.summary
}

// The engine refuses a whole tree when one text child or Markdown text runs
// over 10000 characters, so every block is capped well below that, by lines
// and by characters (a minified file or a JSON transcript is one huge line).
export const MAX_BLOCK_CHARS = 4000

export type Clamped = { text: string; note?: string }

export function clampText(text: string, maxLines: number, maxChars = MAX_BLOCK_CHARS): Clamped {
  const lines = text.split('\n')
  const kept = lines.length > maxLines ? lines.slice(0, maxLines).join('\n') : text
  const hiddenLines = Math.max(0, lines.length - maxLines)
  const chars = [...kept]
  if (chars.length > maxChars) {
    const hiddenChars = chars.length - maxChars
    const more = hiddenLines > 0 ? `, ${hiddenLines} more lines` : ''
    return { text: chars.slice(0, maxChars).join(''), note: `… (${hiddenChars} chars hidden${more})` }
  }
  return hiddenLines > 0 ? { text: kept, note: `… (${hiddenLines} lines hidden)` } : { text }
}

// Splits text into pieces of at most `size` characters, at a newline when
// one falls in the second half of a piece, so each piece stays under the
// engine's per-element limit while a long output can still be shown whole.
// Joining the pieces with '\n' where the cut fell on a newline restores the
// text; a hard cut (no newline) joins with ''.
export function chunkText(text: string, size: number): string[] {
  const chunks: string[] = []
  let rest = text
  while (rest.length > size) {
    const cut = rest.lastIndexOf('\n', size)
    if (cut >= size / 2) {
      chunks.push(rest.slice(0, cut))
      rest = rest.slice(cut + 1)
    } else {
      chunks.push(rest.slice(0, size))
      rest = rest.slice(size)
    }
  }
  chunks.push(rest)
  return chunks
}

const FENCE = /^\s*(```|~~~)/

// chunkText for Markdown: a piece cut inside a code fence closes it, and the
// next piece reopens it with the same opening line, so each piece renders
// on its own. Pieces may run `fence` characters over `size`.
export function chunkMarkdown(text: string, size: number): string[] {
  const chunks: string[] = []
  let reopen = ''
  for (const raw of chunkText(text, Math.max(1, size - 8))) {
    const piece = reopen ? `${reopen}\n${raw}` : raw
    let open = ''
    for (const line of piece.split('\n')) {
      if (FENCE.test(line)) open = open ? '' : line.trim()
    }
    const closer = open.startsWith('~~~') ? '~~~' : '```'
    chunks.push(open ? `${piece}\n${closer}` : piece)
    reopen = open
  }
  return chunks
}
