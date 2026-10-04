// Pure transformations: engine session rows -> turns -> display items, plus
// the formatters and per-tool one-line summaries ported from tail-claude /
// agent-ouija (claude/tools/summary.go). No engine calls here.
import type { AgentStatus, SessionMessage } from 'claude-code'

import type { TurnStat } from '../types'

type OutputItem = { kind: 'output'; id: string; text: string }

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

// The text between the first `open` at or after `from` and the next `close`,
// trimmed. indexOf rather than a regex: prompts are untrusted, and the
// regexes this replaced backtracked cubically on long runs of whitespace.
function between(text: string, open: string, close: string, from = 0): string | undefined {
  const start = text.indexOf(open, from)
  if (start < 0) return undefined
  const end = text.indexOf(close, start + open.length)
  return end < 0 ? undefined : text.slice(start + open.length, end).trim()
}

function stripBlocks(text: string, open: string, close: string): string {
  let out = ''
  let at = 0
  for (;;) {
    const start = text.indexOf(open, at)
    if (start < 0) return out + text.slice(at)
    const end = text.indexOf(close, start + open.length)
    if (end < 0) return out + text.slice(at)
    out += text.slice(at, start)
    at = end + close.length
  }
}

// Turns XML-ish wrappers the engine injects into a readable one-liner.
export function sanitizePrompt(text: string): string {
  const command = between(text, '<command-name>', '</command-name>')
  if (command && !command.includes('<')) {
    const args = between(text, '<command-args>', '</command-args>') ?? ''
    return args && !args.includes('<') ? `${command} ${args}` : command
  }
  const notification = text.indexOf('<task-notification>')
  const summary = notification < 0 ? undefined : between(text, '<summary>', '</summary>', notification)
  if (summary && !summary.includes('<')) return `Task notification: ${summary}`
  return stripTags(stripBlocks(text, '<system-reminder>', '</system-reminder>')).trim()
}

// Drops every `<...>` tag; a `<` with no `>` after it ends the scan.
function stripTags(text: string): string {
  let out = ''
  let at = 0
  for (;;) {
    const start = text.indexOf('<', at)
    if (start < 0) return out + text.slice(at)
    const end = text.indexOf('>', start + 1)
    if (end < 0) return out + text.slice(at)
    out += text.slice(at, start)
    at = end + 1
  }
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
  const hours = d.getHours()
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${hours % 12 === 0 ? 12 : hours % 12}:${pad(d.getMinutes())}:${pad(d.getSeconds())} ${hours < 12 ? 'AM' : 'PM'}`
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

const str = (f: Record<string, unknown>, key: string): string => (typeof f[key] === 'string' ? (f[key] as string) : '')

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

type ToolCategory = 'read' | 'edit' | 'search' | 'task' | 'web' | 'other'

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

// Caps text to maxLines and maxChars, with a note on what was cut.
type Clamped = { text: string; note?: string }

export function clampText(text: string, maxLines: number, maxChars: number): Clamped {
  const lines = text.split('\n')
  const kept = lines.length > maxLines ? lines.slice(0, maxLines).join('\n') : text
  const hiddenLines = Math.max(0, lines.length - maxLines)
  const chars = [...kept]
  if (chars.length > maxChars) {
    const hiddenChars = chars.length - maxChars
    const more = hiddenLines > 0 ? `, ${hiddenLines} more line${hiddenLines === 1 ? '' : 's'}` : ''
    return { text: chars.slice(0, maxChars).join(''), note: `… (${hiddenChars} chars hidden${more})` }
  }
  return hiddenLines > 0
    ? { text: kept, note: `… (${hiddenLines} line${hiddenLines === 1 ? '' : 's'} hidden)` }
    : { text }
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

// -- Expanded view sections ---------------------------------------------------
//
// An expanded tool call reads as framed sections: what went in (the command,
// file, diff or query) apart from what came out. Each section names its kind,
// which the view maps to a frame color, and how its body is drawn.

export type SectionKind = 'command' | 'input' | 'file' | 'diff' | 'query' | 'output' | 'error'

type SectionFormat = { kind: 'text' } | { kind: 'code'; language: string } | { kind: 'markdown' }

export type Section = {
  kind: SectionKind
  title: string
  meta?: string
  body: string
  format: SectionFormat
}

const LANGUAGES: Record<string, string> = {
  go: 'go',
  ts: 'typescript',
  tsx: 'tsx',
  js: 'javascript',
  jsx: 'jsx',
  mjs: 'javascript',
  py: 'python',
  rs: 'rust',
  rb: 'ruby',
  java: 'java',
  kt: 'kotlin',
  swift: 'swift',
  c: 'c',
  h: 'c',
  cpp: 'cpp',
  cs: 'csharp',
  php: 'php',
  sh: 'bash',
  bash: 'bash',
  zsh: 'bash',
  json: 'json',
  yaml: 'yaml',
  yml: 'yaml',
  toml: 'toml',
  md: 'markdown',
  html: 'html',
  css: 'css',
  sql: 'sql',
  xml: 'xml',
}

export function languageFor(path: string): string | undefined {
  const name = basename(path)
  const dot = name.lastIndexOf('.')
  return dot > 0 ? LANGUAGES[name.slice(dot + 1).toLowerCase()] : undefined
}

const codeOrText = (path: string): SectionFormat => {
  const language = languageFor(path)
  return language ? { kind: 'code', language } : { kind: 'text' }
}

const TODO_MARKS: Record<string, string> = { completed: '☑', in_progress: '◐' }

function inputSections(item: ToolItem): Section[] {
  const f = item.input
  switch (item.tool) {
    case 'Bash': {
      const desc = str(f, 'description')
      return [
        {
          kind: 'command',
          title: '$ command',
          ...(desc ? { meta: desc } : {}),
          body: str(f, 'command'),
          format: { kind: 'code', language: 'bash' },
        },
      ]
    }
    case 'Read': {
      const limit = num(f, 'limit')
      const offset = num(f, 'offset') || 1
      const meta = limit > 0 ? `lines ${offset}-${offset + limit - 1}` : undefined
      return [
        { kind: 'file', title: 'read', ...(meta ? { meta } : {}), body: str(f, 'file_path'), format: { kind: 'text' } },
      ]
    }
    case 'Edit': {
      const diff = [
        ...str(f, 'old_string')
          .split('\n')
          .map(l => `-${l}`),
        ...str(f, 'new_string')
          .split('\n')
          .map(l => `+${l}`),
      ].join('\n')
      return [
        {
          kind: 'diff',
          title: 'diff',
          meta: str(f, 'file_path'),
          body: diff,
          format: { kind: 'code', language: 'diff' },
        },
      ]
    }
    case 'Write':
      return [
        {
          kind: 'file',
          title: 'write',
          meta: str(f, 'file_path'),
          body: str(f, 'content'),
          format: codeOrText(str(f, 'file_path')),
        },
      ]
    case 'Grep':
    case 'Glob': {
      const where = str(f, 'glob') || str(f, 'path')
      return [
        {
          kind: 'query',
          title: name(item),
          body: where ? `${str(f, 'pattern')}  in ${where}` : str(f, 'pattern'),
          format: { kind: 'text' },
        },
      ]
    }
    case 'WebFetch':
    case 'WebSearch': {
      const target = str(f, 'url') || str(f, 'query')
      const prompt = str(f, 'prompt')
      return [
        { kind: 'query', title: name(item), body: prompt ? `${target}\n${prompt}` : target, format: { kind: 'text' } },
      ]
    }
    case 'TodoWrite': {
      const todos = Array.isArray(f['todos']) ? (f['todos'] as Record<string, unknown>[]) : []
      const body = todos.map(t => `${TODO_MARKS[str(t, 'status')] ?? '☐'} ${str(t, 'content')}`).join('\n')
      return [{ kind: 'input', title: 'todos', body, format: { kind: 'text' } }]
    }
    default:
      if (Object.keys(f).length === 0) return []
      return [
        { kind: 'input', title: 'input', body: JSON.stringify(f, null, 2), format: { kind: 'code', language: 'json' } },
      ]
  }
}

const name = (item: ToolItem) => item.tool.toLowerCase()

function outputFormat(item: ToolItem): SectionFormat {
  if (item.isError) return { kind: 'text' }
  if (item.tool === 'Read') return codeOrText(str(item.input, 'file_path'))
  if (item.tool === 'WebFetch' || item.tool === 'WebSearch') return { kind: 'markdown' }
  return { kind: 'text' }
}

export function toolSections(item: ToolItem): Section[] {
  const sections = inputSections(item)
  const result = item.resultText?.trimEnd()
  if (result === undefined || result === '') return sections
  const lines = result.split('\n').length
  const status = item.isError ? 'error' : 'ok'
  sections.push({
    kind: item.isError ? 'error' : 'output',
    title: item.isError ? 'error' : 'output',
    meta: `${status} · ${lines} line${lines === 1 ? '' : 's'}`,
    body: result,
    format: outputFormat(item),
  })
  return sections
}

// -- Layout and the compact transcript ----------------------------------------

const MIN_PANE = 40
const MIN_TRANSCRIPT = 40

// The dock width to ask for: `percent` of the terminal, but never so wide the
// transcript drops under MIN_TRANSCRIPT nor so narrow the pane drops under
// MIN_PANE. Undefined when the terminal holds neither.
export function paneColumns(total: number, percent: number): number | undefined {
  if (total < MIN_PANE + MIN_TRANSCRIPT) return undefined
  const wanted = Math.round((total * percent) / 100)
  return Math.min(total - MIN_TRANSCRIPT, Math.max(MIN_PANE, wanted))
}

const lineWord = (n: number) => `${n} line${n === 1 ? '' : 's'}`

// The text a tool's structured result carries, by the fields the built-in
// tools use; undefined when none is text.
function resultText(output: unknown): string | undefined {
  if (typeof output === 'string') return output
  if (output === null || typeof output !== 'object') return undefined
  const o = output as Record<string, unknown>
  for (const key of ['stdout', 'content', 'text', 'output', 'result']) {
    if (typeof o[key] === 'string')
      return [o[key], typeof o['stderr'] === 'string' ? o['stderr'] : ''].filter(Boolean).join('\n')
  }
  if (o['file'] !== null && typeof o['file'] === 'object') return resultText(o['file'])
  return undefined
}

// One line for a tool result in the compact transcript; the detail is in
// the pane. Errors keep their first line so a failure still reads at a glance.
export function resultLine(output: unknown, isErrored: boolean): string {
  if (isErrored) {
    const first =
      sanitizeText(resultText(output) ?? String(output ?? ''))
        .trim()
        .split('\n')[0] ?? ''
    return truncate(`error: ${first}`, 80)
  }
  const text = resultText(output)
  if (text !== undefined) return text.trim() === '' ? 'no output' : lineWord(text.trimEnd().split('\n').length)
  if (output !== null && typeof output === 'object') {
    const list = Object.values(output as Record<string, unknown>).find(Array.isArray)
    if (list) return `${list.length} item${list.length === 1 ? '' : 's'}`
  }
  return 'done'
}

// The counts a turn list row shows: "3 tools · 1 agent", or "reply" for a
// turn that only answered.
function turnCounts(turn: Turn): string {
  const parts: string[] = []
  const tools = turn.toolCount - turn.subagentCount
  if (tools > 0) parts.push(`${tools} tool${tools === 1 ? '' : 's'}`)
  if (turn.subagentCount > 0) parts.push(`${turn.subagentCount} agent${turn.subagentCount === 1 ? '' : 's'}`)
  return parts.length > 0 ? parts.join(' · ') : 'reply'
}

// A turn row's tail: its counts, then how long it took when that is known.
export function turnTail(turn: Turn, stat?: { durationMs: number }): string {
  return [turnCounts(turn), stat ? formatDuration(stat.durationMs) : ''].filter(Boolean).join(' · ')
}

export const EMPTY_TURN_TEXT = 'No tool calls or output in this turn.'

// -- Text reports (surfaces that draw no pane) ---------------------------------
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
    lines.push(`  ${itemName(item).padEnd(12)} ${itemSummary(item)}${state}${duration}`)
  }
  return clampReport(lines.join('\n'))
}

export function turnListText(turns: readonly Turn[], stats: readonly (TurnStat | undefined)[]): string {
  if (turns.length === 0) return 'No turns yet.'
  const lines = turns.map(
    (turn, i) => `${`#${i + 1}`.padEnd(5)}${truncate(turn.prompt || '(no prompt)', 60)}  ${turnTail(turn, stats[i])}`,
  )
  return clampReport([`Turns (${turns.length}), newest last:`, ...lines].join('\n'))
}

// -- Search -------------------------------------------------------------------

export type TurnMatch = { index: number; snippet: string }

const SNIPPET = 80

// Turns whose prompt, output, tool summaries or tool results contain `query`
// as plain text (case-insensitive, no pattern syntax), each with a one-line
// snippet around its first hit. indexOf keeps it linear in the text.
export function searchTurns(turns: readonly Turn[], query: string): TurnMatch[] {
  const needle = query.trim().toLowerCase()
  if (needle === '') return []
  const matches: TurnMatch[] = []
  for (const turn of turns) {
    for (const hay of searchable(turn)) {
      const at = hay.toLowerCase().indexOf(needle)
      if (at >= 0) {
        matches.push({ index: turn.index, snippet: snippetAt(hay, at) })
        break
      }
    }
  }
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

// Cuts by code point, so no surrogate pair is split. `at` is an offset into
// the lowercased text, whose length can differ from `text`'s, so it is mapped
// back to a code point of `text` first.
function snippetAt(text: string, at: number): string {
  const chars = [...text]
  let hit = 0
  for (let pos = 0; hit < chars.length - 1; hit++) {
    pos += chars[hit]!.toLowerCase().length
    if (pos > at) break
  }
  const start = Math.max(0, Math.min(hit - 20, chars.length - SNIPPET))
  const end = Math.min(chars.length, start + SNIPPET)
  const head = start > 0 ? '…' : ''
  const tail = end < chars.length ? '…' : ''
  const body = chars.slice(start + head.length, end - tail.length).join('')
  return head + body.replaceAll('\n', ' ') + tail
}

// -- Thinking -----------------------------------------------------------------
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
    const blocks = Array.isArray(m.content) ? m.content : []
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

// The one line a tool call gets in the compact transcript: its name and the
// shortest useful summary (a Bash call's description, else its first line).
export function compactCall(tool: string, rawInput: unknown): { name: string; summary: string } {
  const input = (rawInput !== null && typeof rawInput === 'object' ? sanitizeValue(rawInput) : {}) as Record<
    string,
    unknown
  >
  const name = sanitizeText(tool)
  const item: ToolItem = { kind: 'tool', id: '', tool: name, input, summary: '', isError: false, isPending: false }
  if (name === 'Bash') {
    const line = str(input, 'description') || (str(input, 'command').split('\n')[0] ?? '')
    return { name, summary: truncate(line, 80) }
  }
  const summary = itemSummary({ ...item, summary: toolSummary(name, input) })
  return { name: itemName(item), summary: truncate(summary, 80) }
}

// -- Git branch from .git/HEAD -------------------------------------------------
//
// The info bar's branch comes from reading .git/HEAD rather than running git:
// no program starts, and a cloned repository's config cannot run anything.

// "ref: refs/heads/main" -> main; a detached HEAD (a bare hash) -> its short hash.
export function parseGitHead(content: string): { branch: string } | null {
  const head = sanitizeText(content).trim()
  if (head.startsWith('ref: refs/heads/')) return { branch: head.slice('ref: refs/heads/'.length) }
  return /^[0-9a-f]{40,64}$/.test(head) ? { branch: head.slice(0, 7) } : null
}

// A worktree's .git is a file naming its git directory ("gitdir: <path>"),
// absolute or relative to the worktree.
export function gitDirFrom(root: string, dotGitFile: string): string | null {
  const line = dotGitFile.trim()
  if (!line.startsWith('gitdir: ')) return null
  const dir = line.slice('gitdir: '.length).trim()
  return dir.startsWith('/') ? dir : `${root}/${dir}`
}
