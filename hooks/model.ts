// Pure transformations: engine session rows -> turns -> display items, plus
// the formatters and per-tool one-line summaries ported from tail-claude /
// agent-ouija (claude/tools/summary.go). No engine calls here.
import type { AgentInfo, AgentStatus, SessionMessage } from 'claude-code'

import type { TurnStat } from '../types'
import type { Icons } from './icons'

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
  // The tool's own record says an abort ended it (Bash: result.interrupted).
  isInterrupted?: boolean
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

// A turn's duration the way the engine words its closing line: whole
// seconds, then minutes and seconds ("3s", "1m 4s").
export function engineDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  return s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`
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

// The glyphs model text carries, from the chosen icon set; the defaults are
// the Nerd Font and Unicode sets'.
export type Glyphs = Pick<Icons, 'ellipsis' | 'dot' | 'taskDone' | 'taskActive' | 'taskTodo'>
type TaskMarks = Pick<Icons, 'taskDone' | 'taskActive' | 'taskTodo'>

const DEFAULT_GLYPHS: Glyphs = { ellipsis: '…', dot: '·', taskDone: '☑', taskActive: '◐', taskTodo: '☐' }

// The context window as a bar of `cells` cells, round(percent/100*cells) of
// them full, kept within 0..cells.
export function contextMeter(percent: number, cells: number, icons: Pick<Icons, 'meterFull' | 'meterEmpty'>) {
  const full = Math.min(cells, Math.max(0, Math.round((percent / 100) * cells)))
  return icons.meterFull.repeat(full) + icons.meterEmpty.repeat(cells - full)
}

// The guides in front of a row of a subagent's trace. `depthPath` says which
// parent levels still continue (a guide) or ended (blank); `isLast` closes the
// row's own branch.
export function treePrefix(
  depthPath: readonly boolean[],
  isLast: boolean,
  icons: Pick<Icons, 'treeBranch' | 'treeLast' | 'treeGuide'>,
) {
  const blank = ' '.repeat(icons.treeGuide.length)
  return depthPath.map(goes => (goes ? icons.treeGuide : blank)).join('') + (isLast ? icons.treeLast : icons.treeBranch)
}

// -- Display width -------------------------------------------------------------
//
// Columns line up by terminal cells, not by code points: CJK, Hangul and
// fullwidth forms and emoji take two cells, combining marks and variation
// selectors none, and a ZWJ sequence draws as one two-cell emoji. Nerd Font
// glyphs of the Private Use Area count as one cell. Own table, no dependency.

// Without Intl.Segmenter the text falls apart by code points.
const SEGMENTER =
  typeof Intl.Segmenter === 'function' ? new Intl.Segmenter(undefined, { granularity: 'grapheme' }) : undefined

// Wide and fullwidth ranges [from, to], and the emoji blocks.
const WIDE_RANGES: readonly (readonly [number, number])[] = [
  [0x1100, 0x115f],
  [0x2e80, 0x303e],
  [0x3041, 0x33ff],
  [0x3400, 0x4dbf],
  [0x4e00, 0x9fff],
  [0xa000, 0xa4cf],
  [0xa960, 0xa97f],
  [0xac00, 0xd7a3],
  [0xf900, 0xfaff],
  [0xfe30, 0xfe4f],
  [0xff00, 0xff60],
  [0xffe0, 0xffe6],
  [0x1f000, 0x1f2ff],
  [0x1f300, 0x1faff],
  // Default emoji presentation in the BMP.
  [0x231a, 0x231b],
  [0x23e9, 0x23ec],
  [0x2614, 0x2615],
  [0x2648, 0x2653],
  [0x267f, 0x267f],
  [0x2693, 0x2693],
  [0x26a1, 0x26a1],
  [0x26aa, 0x26ab],
  [0x26bd, 0x26be],
  [0x26c4, 0x26c5],
  [0x26ce, 0x26ce],
  [0x26d4, 0x26d4],
  [0x26ea, 0x26ea],
  [0x26f2, 0x26f5],
  [0x26fa, 0x26fa],
  [0x26fd, 0x26fd],
  [0x2705, 0x2705],
  [0x270a, 0x270b],
  [0x2728, 0x2728],
  [0x274c, 0x274c],
  [0x274e, 0x274e],
  [0x2753, 0x2755],
  [0x2757, 0x2757],
  [0x2795, 0x2797],
  [0x27b0, 0x27b0],
  [0x27bf, 0x27bf],
  [0x2b1b, 0x2b1c],
  [0x2b50, 0x2b50],
  [0x2b55, 0x2b55],
  [0x20000, 0x3fffd],
]
const ZERO_WIDTH = /^[\p{M}\p{Cf}\u200b-\u200d\ufe00-\ufe0f]+$/u
const EMOJI_PRESENTATION = '\ufe0f'

function graphemeWidth(grapheme: string): number {
  const first = grapheme.codePointAt(0)!
  if (ZERO_WIDTH.test(grapheme)) return 0
  if (WIDE_RANGES.some(([from, to]) => first >= from && first <= to)) return 2
  if (grapheme.includes(EMOJI_PRESENTATION)) return 2
  // A flag: two regional indicators.
  if (first >= 0x1f1e6 && first <= 0x1f1ff) return 2
  return 1
}

const graphemesOf = (text: string): string[] =>
  SEGMENTER === undefined ? Array.from(text) : Array.from(SEGMENTER.segment(text), part => part.segment)

const PRINTABLE_ASCII = /^[\x20-\x7e]*$/

export function displayWidth(text: string): number {
  if (PRINTABLE_ASCII.test(text)) return text.length
  let width = 0
  for (const grapheme of graphemesOf(text)) width += graphemeWidth(grapheme)
  return width
}

// Pads with spaces to `width` cells; text that is wider is left whole.
export function padEndDisplay(text: string, width: number): string {
  return text + ' '.repeat(Math.max(0, width - displayWidth(text)))
}

// The longest run of whole graphemes from the start that fits `cells`.
function takeDisplay(graphemes: readonly string[], cells: number): { text: string; width: number } {
  let width = 0
  let text = ''
  for (const grapheme of graphemes) {
    const w = graphemeWidth(grapheme)
    if (width + w > cells) break
    width += w
    text += grapheme
  }
  return { text, width }
}

// Cuts to `max` cells, the ellipsis included, at the end; never splits a
// grapheme. Line breaks become spaces.
export function truncateDisplay(s: string, max: number, ellipsis = '…'): string {
  const one = s.replaceAll('\n', ' ')
  if (displayWidth(one) <= max) return one
  const room = max - displayWidth(ellipsis)
  if (room < 0) return takeDisplay(graphemesOf(one), max).text
  return takeDisplay(graphemesOf(one), room).text + ellipsis
}

// Cuts to `max` code points, the ellipsis included, at the end.
export function truncate(s: string, max: number, ellipsis = '…'): string {
  const one = s.replaceAll('\n', ' ')
  const chars = [...one]
  if (chars.length <= max) return one
  const width = [...ellipsis].length
  return max < width ? chars.slice(0, max).join('') : chars.slice(0, max - width).join('') + ellipsis
}

// Cuts to `max` cells from the middle, keeping more of the end (a path's
// file name) than of the start; the ellipsis marks the cut. Never splits a
// grapheme.
export function truncateMiddle(s: string, max: number, ellipsis = '…'): string {
  const one = s.replaceAll('\n', ' ')
  if (displayWidth(one) <= max) return one
  const width = displayWidth(ellipsis)
  if (max <= width) return takeDisplay(graphemesOf(ellipsis), Math.max(0, max)).text
  const keep = max - width
  const graphemes = graphemesOf(one)
  const head = takeDisplay(graphemes, Math.floor(keep / 3))
  const tail = takeDisplay(graphemes.toReversed(), keep - head.width)
  return `${head.text}${ellipsis}${graphemesOf(tail.text).toReversed().join('')}`
}

// A duration as a bar of up to `cells` cells in eighths of a block, relative
// to the longest call; nothing under one percent. A part of a cell shows the
// set's partial step (ascii: `-`, a whole cell `=`).
export function durationBar(ms: number, maxMs: number, cells: number, icons: Pick<Icons, 'bar'>): string {
  if (!(ms > 0) || !(maxMs > 0)) return ''
  const ratio = Math.min(1, ms / maxMs)
  if (ratio < 0.01) return ''
  const eighths = Math.max(1, Math.round(ratio * cells * 8))
  const whole = Math.floor(eighths / 8)
  const rest = eighths % 8
  return icons.bar[7]!.repeat(whole) + (rest > 0 ? icons.bar[rest - 1]! : '')
}

export function shortPath(path: string, n: number): string {
  const segments = path.replaceAll('\\', '/').split('/').filter(Boolean)
  return segments.slice(-n).join('/')
}

const basename = (p: string) => shortPath(p, 1)

// The file or directory a tool call works on, '' when it has none.
export function pathOf(item: ToolItem): string {
  const f = item.input
  switch (item.tool) {
    case 'Read':
    case 'Write':
    case 'Edit':
    case 'MultiEdit':
      return str(f, 'file_path')
    case 'NotebookEdit':
      return str(f, 'notebook_path')
    case 'Grep':
    case 'Glob':
      return str(f, 'path')
    default:
      return ''
  }
}

const PATH_SEGMENTS = 6

// A summary cut to `max` code points. Where it names a path, the path is
// widened to its last few segments and cut in the middle, so the file name
// stays; the rest of the summary (line range, edit size) is kept whole.
// Everything else is cut at the end.
export function fitPath(item: ToolItem, summary: string, max: number, ellipsis = '…'): string {
  const path = pathOf(item)
  const known = [shortPath(path, 2), shortPath(path, 1)].find(k => k !== '' && summary.includes(k))
  if (path === '' || known === undefined) return truncateDisplay(summary, max, ellipsis)
  const at = summary.lastIndexOf(known)
  const prefix = summary.slice(0, at)
  const suffix = summary.slice(at + known.length)
  const room = max - displayWidth(prefix) - displayWidth(suffix)
  if (room < 4) return truncateDisplay(summary, max, ellipsis)
  return prefix + truncateMiddle(shortPath(path, PATH_SEGMENTS), room, ellipsis) + suffix
}

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
    case 'MultiEdit':
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

// -- Grouped runs ---------------------------------------------------------------
//
// Three or more consecutive calls of one read, search or web tool in a turn
// fold into one row; an error call, another tool or a message ends the run.

export type GroupItem = { kind: 'group'; id: string; tool: string; items: ToolItem[] }
export type Row = Item | GroupItem

const MIN_RUN = 3
const GROUPED_CATEGORIES = new Set<ToolCategory>(['read', 'search', 'web'])

const isGroupable = (item: Item): item is ToolItem =>
  item.kind === 'tool' && !item.isError && GROUPED_CATEGORIES.has(toolCategory(item.tool))

// The id derives from the first call, so an open group stays open as the
// run grows with every tick.
export function groupRuns(items: readonly Item[]): Row[] {
  const rows: Row[] = []
  let at = 0
  while (at < items.length) {
    const first = items[at]!
    let end = at + 1
    if (isGroupable(first)) while (end < items.length && isRunOf(first, items[end]!)) end++
    if (end - at >= MIN_RUN) {
      rows.push({
        kind: 'group',
        id: `group:${first.id}`,
        tool: (first as ToolItem).tool,
        items: items.slice(at, end) as ToolItem[],
      })
    } else rows.push(...items.slice(at, end))
    at = end
  }
  return rows
}

const isRunOf = (first: ToolItem, item: Item): boolean => isGroupable(item) && item.tool === first.tool

// -- Keyboard cursor ----------------------------------------------------------

// The trace rows of a subagent, when they are loaded.
export type ChildrenOf = (agentId: string) => readonly Item[] | undefined

// The ids of the rows the cursor can stand on, top to bottom: a folded run
// is one row and shows its calls only while open; a subagent's trace rows
// count only while the subagent is open.
export function cursorRows(items: readonly Item[], open: ReadonlySet<string>, childrenOf: ChildrenOf): string[] {
  const ids: string[] = []
  for (const row of groupRuns(items)) {
    ids.push(row.id)
    if (row.kind === 'group') {
      if (open.has(row.id)) ids.push(...row.items.map(item => item.id))
    } else if (isSubagent(row) && open.has(row.id)) {
      ids.push(...cursorRows(childrenOf(row.agentId) ?? [], open, childrenOf))
    }
  }
  return ids
}

// The row one step from `current` (`delta` -1 or 1), clipped to the first and
// last row. Without a cursor on the list, going down enters at the first row
// and going up at the last; an empty list has none.
export function moveCursor(ids: readonly string[], current: string | null, delta: number): string | null {
  if (ids.length === 0) return null
  const at = current === null ? -1 : ids.indexOf(current)
  if (at < 0) return delta < 0 ? ids.at(-1)! : ids[0]!
  return ids[Math.min(ids.length - 1, Math.max(0, at + delta))]!
}

// The row with `id` among `items`, a folded run's calls and the loaded traces
// of subagents included. `seen` stops a trace that names itself.
function findRow(items: readonly Item[], id: string, childrenOf: ChildrenOf, seen: Set<string>): Row | undefined {
  for (const row of groupRuns(items)) {
    if (row.id === id) return row
    if (row.kind === 'group') {
      const call = row.items.find(item => item.id === id)
      if (call !== undefined) return call
    } else if (isSubagent(row) && !seen.has(row.agentId)) {
      seen.add(row.agentId)
      const found = findRow(childrenOf(row.agentId) ?? [], id, childrenOf, seen)
      if (found !== undefined) return found
    }
  }
  return undefined
}

function itemFullText(item: Item, glyphs: Glyphs): string {
  if (item.kind === 'output') return item.text
  return cachedSections(item, glyphs)
    .map(section => section.body)
    .join('\n\n')
}

// Everything the row's frames hold, whole (what `y` copies); a folded run
// joins its calls. Undefined when no such row is drawn.
export function rowText(
  items: readonly Item[],
  id: string,
  childrenOf: ChildrenOf,
  glyphs: Glyphs = DEFAULT_GLYPHS,
): string | undefined {
  const row = findRow(items, id, childrenOf, new Set())
  if (row === undefined) return undefined
  if (row.kind === 'group') return row.items.map(item => itemFullText(item, glyphs)).join('\n\n')
  return itemFullText(row, glyphs)
}

// -- Hover card ---------------------------------------------------------------

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
    const line = [...truncateDisplay(sanitizeText(raw), room, glyphs.ellipsis)].slice(0, left).join('')
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

// Caps text to maxLines and maxChars, with a note on what was cut.
type Clamped = { text: string; note?: string }

export function clampText(text: string, maxLines: number, maxChars: number, ellipsis = '…'): Clamped {
  const lines = text.split('\n')
  const kept = lines.length > maxLines ? lines.slice(0, maxLines).join('\n') : text
  const hiddenLines = Math.max(0, lines.length - maxLines)
  const chars = [...kept]
  if (chars.length > maxChars) {
    const hiddenChars = chars.length - maxChars
    const more = hiddenLines > 0 ? `, ${hiddenLines} more line${hiddenLines === 1 ? '' : 's'}` : ''
    return { text: chars.slice(0, maxChars).join(''), note: `${ellipsis} (${hiddenChars} chars hidden${more})` }
  }
  return hiddenLines > 0
    ? { text: kept, note: `${ellipsis} (${hiddenLines} line${hiddenLines === 1 ? '' : 's'} hidden)` }
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

// -- Unified diffs ------------------------------------------------------------
//
// An Edit becomes a unified diff the engine's <Code format="diff"> draws with
// gutters and colors. The diff is a pure function of the two texts; long ones
// are cut only at line boundaries, each piece a valid diff of its own.

const MAX_DIFF_LINES = 2000
// The LCS table of the changed middle may hold this many cells (about 1 MB).
const MAX_DIFF_CELLS = 250_000

type DiffOp = { op: ' ' | '-' | '+'; text: string }

const linesOf = (text: string) => (text === '' ? [] : text.split('\n'))

// Line by line LCS of the changed middle, after the common head and tail.
function diffOps(before: readonly string[], after: readonly string[]): DiffOp[] | null {
  let head = 0
  while (head < before.length && head < after.length && before[head] === after[head]) head++
  let tail = 0
  while (
    tail < before.length - head &&
    tail < after.length - head &&
    before[before.length - 1 - tail] === after[after.length - 1 - tail]
  )
    tail++
  const a = before.slice(head, before.length - tail)
  const b = after.slice(head, after.length - tail)
  if (a.length * b.length > MAX_DIFF_CELLS) return null
  const width = b.length + 1
  const table = new Uint32Array((a.length + 1) * width)
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      table[i * width + j] =
        a[i] === b[j]
          ? table[(i + 1) * width + j + 1]! + 1
          : Math.max(table[(i + 1) * width + j]!, table[i * width + j + 1]!)
    }
  }
  const ops: DiffOp[] = before.slice(0, head).map(text => ({ op: ' ', text }))
  let i = 0
  let j = 0
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      ops.push({ op: ' ', text: a[i]! })
      i++
      j++
    } else if (j >= b.length || (i < a.length && table[(i + 1) * width + j]! >= table[i * width + j + 1]!)) {
      ops.push({ op: '-', text: a[i]! })
      i++
    } else {
      ops.push({ op: '+', text: b[j]! })
      j++
    }
  }
  return ops.concat(after.slice(after.length - tail).map(text => ({ op: ' ', text })))
}

// The header of a hunk whose first old and new lines are numbered `oldNo`
// and `newNo`; an empty side counts from the line before, as diff does.
function formatHeader(oldNo: number, newNo: number, oldCount: number, newCount: number): string {
  return `@@ -${oldCount === 0 ? oldNo - 1 : oldNo},${oldCount} +${newCount === 0 ? newNo - 1 : newNo},${newCount} @@`
}

function hunkHeader(oldNo: number, newNo: number, lines: readonly string[]): string {
  const oldCount = lines.filter(l => l[0] === ' ' || l[0] === '-').length
  const newCount = lines.filter(l => l[0] === ' ' || l[0] === '+').length
  return formatHeader(oldNo, newNo, oldCount, newCount)
}

// Unified-diff hunks turning `oldText` into `newText`, `context` unchanged
// lines around each change (hunks closer than twice that share one), the first
// line numbered `startLine`. '' when the texts are equal; null past 2000 lines
// on a side, where the caller draws its own plain view.
export function unifiedDiff(
  oldText: string,
  newText: string,
  options: { context?: number; startLine?: number } = {},
): string | null {
  const { context = 3, startLine = 1 } = options
  const before = linesOf(oldText)
  const after = linesOf(newText)
  if (before.length > MAX_DIFF_LINES || after.length > MAX_DIFF_LINES) return null
  const ops = diffOps(before, after)
  if (ops === null) return null
  const changed = ops.flatMap((o, i) => (o.op === ' ' ? [] : [i]))
  if (changed.length === 0) return ''

  // Runs of changes whose gap is within 2 * context become one hunk.
  const spans: [number, number][] = []
  for (const at of changed) {
    const last = spans.at(-1)
    if (last !== undefined && at - last[1] <= 2 * context + 1) last[1] = at
    else spans.push([at, at])
  }
  const numbers = (upTo: number) => {
    let oldNo = startLine
    let newNo = startLine
    for (const o of ops.slice(0, upTo)) {
      if (o.op !== '+') oldNo++
      if (o.op !== '-') newNo++
    }
    return { oldNo, newNo }
  }
  return spans
    .map(([first, last]) => {
      const from = Math.max(0, first - context)
      const lines = ops.slice(from, Math.min(ops.length, last + context + 1)).map(o => `${o.op}${o.text}`)
      const { oldNo, newNo } = numbers(from)
      return [hunkHeader(oldNo, newNo, lines), ...lines].join('\n')
    })
    .join('\n')
}

type Hunk = { oldNo: number; newNo: number; lines: string[] }

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/

// The hunks of a unified diff; null when the text is not one. Lines before
// the first hunk (a ---/+++ pair) are read past.
function parseHunks(diff: string): Hunk[] | null {
  const hunks: Hunk[] = []
  for (const line of diff.split('\n')) {
    const header = HUNK_HEADER.exec(line)
    if (header) {
      const [, a, b, c, d] = header
      hunks.push({
        oldNo: b === '0' ? Number(a) + 1 : Number(a),
        newNo: d === '0' ? Number(c) + 1 : Number(c),
        lines: [],
      })
    } else if (hunks.length > 0) {
      const op = line[0]
      if (op !== ' ' && op !== '+' && op !== '-' && op !== '\\') return null
      hunks.at(-1)!.lines.push(line)
    }
  }
  return hunks.length > 0 ? hunks : null
}

// Cuts a unified diff into pieces of at most `maxLines` lines and `maxChars`
// characters, each a valid diff: a hunk cut in the middle continues under a
// header that counts its own lines and carries on the numbers. A text that is
// no diff is returned whole; [] when not even a header and one line fit.
export function splitDiff(diff: string, maxLines: number, maxChars: number): string[] {
  const hunks = parseHunks(diff)
  if (hunks === null) return [diff]
  const pieces: string[] = []
  let done: string[] = []
  let doneChars = 0

  const finishPiece = () => {
    if (done.length > 0) pieces.push(done.join('\n'))
    done = []
    doneChars = 0
  }

  for (const hunk of hunks) {
    let oldNo = hunk.oldNo
    let newNo = hunk.newNo
    let startOld = oldNo
    let startNew = newNo
    let body: string[] = []
    let bodyChars = 0
    let oldCount = 0
    let newCount = 0

    // What the piece would hold with `extra` appended: counters, not a rebuild.
    const size = (extra: string) => {
      const o = oldCount + (extra[0] === ' ' || extra[0] === '-' ? 1 : 0)
      const n = newCount + (extra[0] === ' ' || extra[0] === '+' ? 1 : 0)
      return {
        lines: done.length + 1 + body.length + 1,
        chars: doneChars + formatHeader(startOld, startNew, o, n).length + 1 + bodyChars + extra.length + 1,
      }
    }
    const commit = () => {
      if (body.length === 0) return
      const text = [formatHeader(startOld, startNew, oldCount, newCount), ...body]
      done.push(...text)
      doneChars += text.reduce((sum, l) => sum + l.length + 1, 0)
      body = []
      bodyChars = 0
      oldCount = 0
      newCount = 0
      startOld = oldNo
      startNew = newNo
    }

    for (let line of hunk.lines) {
      let fit = size(line)
      if (fit.lines > maxLines || fit.chars > maxChars) {
        commit()
        finishPiece()
        fit = size(line)
        if (fit.lines > maxLines || fit.chars > maxChars) {
          // A line alone over the limit is cut so the piece stays valid.
          const room = maxChars - (fit.chars - line.length - 1) - 1
          if (room < 1 || maxLines < 2) return []
          line = line.slice(0, room)
        }
      }
      body.push(line)
      bodyChars += line.length + 1
      if (line[0] === ' ' || line[0] === '-') oldCount++
      if (line[0] === ' ' || line[0] === '+') newCount++
      if (line[0] !== '+' && line[0] !== '\\') oldNo++
      if (line[0] !== '-' && line[0] !== '\\') newNo++
    }
    commit()
  }
  finishPiece()
  return pieces
}

// clampText for a diff: the first piece splitDiff gives, with a note of the
// lines left out. '' text when not even a header and a line fit.
export function clampDiff(diff: string, maxLines: number, maxChars: number, ellipsis = '…'): Clamped {
  const hunks = parseHunks(diff)
  if (hunks === null) return clampText(diff, maxLines, maxChars, ellipsis)
  const pieces = splitDiff(diff, maxLines, maxChars)
  const first = pieces[0] ?? ''
  if (pieces.length === 1 && first === diff) return { text: diff }
  const total = hunks.reduce((sum, hunk) => sum + hunk.lines.length, 0)
  const shown = parseHunks(first)?.reduce((sum, hunk) => sum + hunk.lines.length, 0) ?? 0
  const hidden = total - shown
  return { text: first, note: `${ellipsis} (${hidden} line${hidden === 1 ? '' : 's'} hidden)` }
}

// -- Expanded view sections ---------------------------------------------------
//
// An expanded tool call reads as framed sections: what went in (the command,
// file, diff or query) apart from what came out. Each section names its kind,
// which the view maps to a frame color, and how its body is drawn.

export type SectionKind = 'command' | 'input' | 'file' | 'diff' | 'query' | 'output' | 'error'

type SectionFormat =
  | { kind: 'text' }
  // Source drawn by language, or by the language its path says; startLine
  // numbers its first line.
  | { kind: 'code'; language?: string; path?: string; startLine?: number }
  | { kind: 'markdown' }
  // A unified diff, drawn by the engine's <Code format="diff">.
  | { kind: 'diff' }

export type Section = {
  kind: SectionKind
  title: string
  meta?: string
  // The meta is a file path: the view cuts it in the middle.
  isPathMeta?: true
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

// Code the engine infers the language of from the path, when the path names a
// language the plugin knows; plain text otherwise.
const codeOrText = (path: string): SectionFormat =>
  languageFor(path) ? { kind: 'code', path: sanitizeText(path) } : { kind: 'text' }

// A line of Read's output or of an Edit's cat -n snippet: "   12→text" or
// "12<tab>text".
const NUMBERED_LINE = /^\s*(\d+)(?:→|\t)([\s\S]*)$/

// Text whose every line is numbered, the numbers running on by one: the
// first number and the lines without theirs. null for anything else, which
// is then drawn as it is.
export function parseNumbered(text: string): { startLine: number; body: string } | null {
  if (text === '') return null
  const lines = text.split('\n')
  const body: string[] = []
  let startLine = 0
  for (const [i, raw] of lines.entries()) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw
    // The last line may be a blank one whose tab was trimmed off: "13".
    const bare = i > 0 && i === lines.length - 1 ? /^\s*(\d+)$/.exec(line) : null
    const found = NUMBERED_LINE.exec(line) ?? bare
    if (!found) return null
    const n = Number(found[1])
    if (i === 0) startLine = n
    else if (n !== startLine + i) return null
    body.push(found[2] ?? '')
  }
  return { startLine, body: body.join('\n') }
}

// The line (0-based) each piece of chunkText(text) starts at, so a piece
// drawn on its own can be numbered on from the one before.
export function pieceStarts(text: string, pieces: readonly string[]): number[] {
  const starts: number[] = []
  let at = 0
  let line = 0
  for (const piece of pieces) {
    starts.push(line)
    const end = at + piece.length
    line += piece.split('\n').length - 1
    if (text[end] === '\n') line += 1
    at = text[end] === '\n' ? end + 1 : end
  }
  return starts
}

// The number the edited text starts at in the file: where its whole block of
// lines sits in the result's cat -n snippet; 1 when there is no snippet or
// the block is not found in it.
function editStartLine(result: string | undefined, newText: string): number {
  if (result === undefined || newText === '') return 1
  const snippet = result.split('\n').flatMap(line => {
    const found = NUMBERED_LINE.exec(line.endsWith('\r') ? line.slice(0, -1) : line)
    return found ? [{ n: Number(found[1]), text: found[2]! }] : []
  })
  const block = newText.split('\n')
  for (let i = 0; i + block.length <= snippet.length; i++) {
    if (block.every((text, k) => snippet[i + k]!.text === text && snippet[i + k]!.n === snippet[i]!.n + k))
      return snippet[i]!.n
  }
  return 1
}

// The diff section of an Edit or MultiEdit: one hunk per edit. Past what
// unifiedDiff takes (or when an edit changes nothing) the plain - and +
// lines stand in.
function diffSection(
  f: Record<string, unknown>,
  edits: readonly { old: string; new: string }[],
  startLine: number,
): Section {
  const hunks = edits.map(e => unifiedDiff(sanitizeText(e.old), sanitizeText(e.new), { startLine }))
  const isDiffed = hunks.length > 0 && hunks.every(hunk => hunk !== null && hunk !== '')
  const plain = edits
    .flatMap(e => [
      ...sanitizeText(e.old)
        .split('\n')
        .map(l => `-${l}`),
      ...sanitizeText(e.new)
        .split('\n')
        .map(l => `+${l}`),
    ])
    .join('\n')
  return {
    kind: 'diff',
    title: 'diff',
    meta: str(f, 'file_path'),
    isPathMeta: true,
    body: isDiffed ? hunks.join('\n') : plain,
    format: isDiffed ? { kind: 'diff' } : { kind: 'code', language: 'diff' },
  }
}

function inputSections(item: ToolItem, glyphs: Glyphs): Section[] {
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
    case 'Edit':
      return [
        diffSection(
          f,
          [{ old: str(f, 'old_string'), new: str(f, 'new_string') }],
          editStartLine(item.resultText, str(f, 'new_string')),
        ),
      ]
    case 'MultiEdit': {
      const edits = Array.isArray(f['edits']) ? (f['edits'] as unknown[]) : []
      const pairs = edits.map(e => {
        const edit = e !== null && typeof e === 'object' ? (e as Record<string, unknown>) : {}
        return { old: str(edit, 'old_string'), new: str(edit, 'new_string') }
      })
      return [diffSection(f, pairs, 1)]
    }
    case 'Write':
      return [
        {
          kind: 'file',
          title: 'write',
          meta: str(f, 'file_path'),
          isPathMeta: true,
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
      const body = todos.map(t => `${taskMark(str(t, 'status'), glyphs)} ${str(t, 'content')}`).join('\n')
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

const ERROR_LINE = /error|fail|panic|exception/i

// The line of an error output worth reading first: the first one that names
// an error, else the first non-empty one; '' when there is none. Trimmed.
export function firstErrorLine(text: string): string {
  let first = ''
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (line === '') continue
    if (ERROR_LINE.test(line)) return line
    if (first === '') first = line
  }
  return first
}

export function toolSections(item: ToolItem, glyphs: Glyphs = DEFAULT_GLYPHS): Section[] {
  const sections = inputSections(item, glyphs)
  const result = item.resultText?.trimEnd()
  if (result === undefined || result === '') return sections
  // A Read's cat -n numbers become the gutter of its code block.
  const numbered = item.tool === 'Read' && !item.isError ? parseNumbered(result) : null
  const path = sanitizeText(str(item.input, 'file_path'))
  const lines = result.split('\n').length
  const status = item.isError ? 'error' : 'ok'
  sections.push({
    kind: item.isError ? 'error' : 'output',
    title: item.isError ? 'error' : 'output',
    meta: `${status} ${glyphs.dot} ${lines} line${lines === 1 ? '' : 's'}`,
    body: numbered?.body ?? result,
    format: numbered
      ? { kind: 'code', ...(path === '' ? {} : { path }), startLine: numbered.startLine }
      : outputFormat(item),
  })
  return sections
}

const MIN_CACHED_SECTIONS = 200
const MAX_CACHED_SECTIONS = 2000
// How many items the cache keeps: twice the calls of the shown turn, so a
// pass over all of them (a folded run's text) hits on the next drawing.
let sectionRoom = MIN_CACHED_SECTIONS
const sectionCache = new Map<string, { key: string; sections: Section[] }>()

// A cheap fingerprint of what the sections are built from.
function fingerprint(item: ToolItem, glyphs: Glyphs): string {
  const json = JSON.stringify(item.input)
  let hash = 5381
  for (let i = 0; i < json.length; i++) hash = ((hash << 5) + hash + json.charCodeAt(i)) | 0
  const result = item.resultText
  return `${item.tool}|${json.length}|${hash}|${result === undefined ? -1 : result.length}|${item.isError ? 1 : 0}|${glyphs.dot}${glyphs.ellipsis}${glyphs.taskDone}`
}

// Sizes the cache to a turn of `calls` tool calls (its traces included).
export function reserveSections(calls: number): void {
  sectionRoom = Math.min(MAX_CACHED_SECTIONS, Math.max(MIN_CACHED_SECTIONS, 2 * calls))
}

// toolSections kept for the last items drawn (see reserveSections): the pane
// draws again twice a second, and a diff or a numbered Read is not worth
// computing each time.
export function cachedSections(item: ToolItem, glyphs: Glyphs = DEFAULT_GLYPHS): Section[] {
  const key = fingerprint(item, glyphs)
  const cached = sectionCache.get(item.id)
  if (cached?.key === key) return cached.sections
  const sections = toolSections(item, glyphs)
  sectionCache.delete(item.id)
  sectionCache.set(item.id, { key, sections })
  while (sectionCache.size > sectionRoom) sectionCache.delete(sectionCache.keys().next().value as string)
  return sections
}

// For tests: the cache is module state shared by every file that draws, so a
// test that counts on it starts it empty and reads how many items it holds.
export function resetSectionCache(): void {
  sectionCache.clear()
}

export function sectionCacheSize(): number {
  return sectionCache.size
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
function countParts(turn: Turn): string[] {
  const parts: string[] = []
  const tools = turn.toolCount - turn.subagentCount
  if (tools > 0) parts.push(`${tools} tool${tools === 1 ? '' : 's'}`)
  if (turn.subagentCount > 0) parts.push(`${turn.subagentCount} agent${turn.subagentCount === 1 ? '' : 's'}`)
  return parts
}

function turnCounts(turn: Turn, dot: string): string {
  const parts = countParts(turn)
  return parts.length > 0 ? parts.join(` ${dot} `) : 'reply'
}

// What the engine's "Baked for 3s" line gets appended: " . 3 tools . 1 agent"
// for the counts that are not zero, nothing for a turn that only answered.
export function durationSuffix(turn: Turn | undefined, dot: string): string {
  return turn === undefined
    ? ''
    : countParts(turn)
        .map(part => ` ${dot} ${part}`)
        .join('')
}

// A turn row's tail: its counts, then how long it took when that is known.
export function turnTail(turn: Turn, stat?: { durationMs: number }, dot = '·'): string {
  return [turnCounts(turn, dot), stat ? formatDuration(stat.durationMs) : ''].filter(Boolean).join(` ${dot} `)
}

// -- Turn table ------------------------------------------------------------------

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
export function turnTable(
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

// -- Search -------------------------------------------------------------------

export type TurnMatch = { index: number; snippet: string }

const SNIPPET = 80

// Turns whose prompt, output, tool summaries or tool results contain `query`
// as plain text (case-insensitive, no pattern syntax), each with a one-line
// snippet around its first hit. indexOf keeps it linear in the text.
export function searchTurns(turns: readonly Turn[], query: string, ellipsis = '…'): TurnMatch[] {
  const needle = query.trim().toLowerCase()
  if (needle === '') return []
  const matches: TurnMatch[] = []
  for (const turn of turns) {
    for (const hay of searchable(turn)) {
      const at = hay.toLowerCase().indexOf(needle)
      if (at >= 0) {
        matches.push({ index: turn.index, snippet: snippetAt(hay, at, ellipsis) })
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
  return head + body.replaceAll('\n', ' ') + tail
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

// -- Workflow -----------------------------------------------------------------

export type WorkflowState = { isRunning: false } | { isRunning: true; agents: number }

// A Workflow call of the latest turn still waiting for its result runs only
// while the session works: an interrupted turn leaves it pending for good.
export function workflowState(turn: Turn | undefined, unknownAgents: number, isWorking: boolean): WorkflowState {
  const isPending =
    turn?.items.some(item => item.kind === 'tool' && item.tool === 'Workflow' && item.isPending) ?? false
  return isPending && isWorking ? { isRunning: true, agents: unknownAgents } : { isRunning: false }
}

// The one line a tool call gets in the compact transcript: its name and the
// shortest useful summary (a Bash call's description, else its first line).
export function compactCall(tool: string, rawInput: unknown, ellipsis = '…'): { name: string; summary: string } {
  const input = (rawInput !== null && typeof rawInput === 'object' ? sanitizeValue(rawInput) : {}) as Record<
    string,
    unknown
  >
  const name = sanitizeText(tool)
  const item: ToolItem = { kind: 'tool', id: '', tool: name, input, summary: '', isError: false, isPending: false }
  if (name === 'Bash') {
    const line = str(input, 'description') || (str(input, 'command').split('\n')[0] ?? '')
    return { name, summary: truncate(line, 80, ellipsis) }
  }
  const named: ToolItem = { ...item, summary: toolSummary(name, input) }
  return { name: itemName(item), summary: fitPath(named, itemSummary(named), 80, ellipsis) }
}

// -- Finished agents ----------------------------------------------------------

export type AgentSnapshot = { id: string; status: AgentStatus; description: string }

// The agents of `next` that finished since `prev` (their statuses at the last
// look): not finished then, finished now. An agent the last look did not see
// is not reported, so a list read for the first time announces nothing.
export function finishedSince(prev: ReadonlyMap<string, AgentStatus>, next: readonly AgentSnapshot[]): AgentSnapshot[] {
  return next.filter(a => {
    const before = prev.get(a.id)
    return before !== undefined && !isAgentFinished(before) && isAgentFinished(a.status)
  })
}

// -- Finished workflows -------------------------------------------------------

// Follows the Workflow calls of the latest turn by id. `tracked` holds those
// seen pending; a tracked call that now has its result is finished. One left
// pending when the session stops working (an interrupt), gone from the turn
// or ended interrupted is dropped without being reported.
export function finishedWorkflows(
  tracked: ReadonlySet<string>,
  turn: Turn | undefined,
  isWorking: boolean,
): { tracked: Set<string>; finished: string[] } {
  const calls = new Map<string, ToolItem>()
  for (const item of turn?.items ?? []) if (item.kind === 'tool' && item.tool === 'Workflow') calls.set(item.id, item)
  const next = new Set<string>()
  const finished: string[] = []
  for (const [id, item] of calls) {
    if (item.isPending) {
      if (isWorking) next.add(id)
    } else if (tracked.has(id) && item.isInterrupted !== true) finished.push(id)
  }
  return { tracked: next, finished }
}

// -- Status line --------------------------------------------------------------

// A main-loop tool call that has started and not yet ended.
export type RunningTool = { id: string; tool: string; input: unknown; startedAt: number }

export const runningTool = (id: string, tool: string, input: unknown, startedAt: number): RunningTool => ({
  id,
  tool,
  input,
  startedAt,
})

// The input of a tool.call event: the event less the fields that are not the
// tool's own.
export function callInput(event: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const { tool: _tool, tool_use_id: _id, agentId: _agent, ...input } = event
  return input
}

const STATUS_SUMMARY = 60

function statusIcon(tool: string, icons: Icons): string {
  switch (toolCategory(tool)) {
    case 'read':
      return icons.book
    case 'edit':
      return icons.penNib
    case 'search':
      return icons.folderSearch
    case 'task':
      return icons.robot
    case 'web':
      return icons.web
    default:
      return icons.wrench
  }
}

// The line pinned under the prompt while a tool runs: the category icon, the
// tool, its summary cut to 60 characters in the middle and the whole seconds
// it has run, e.g. "$ Bash go test ./... . 12s". The oldest running call is
// the one shown; undefined when nothing runs.
export function statusText(running: readonly RunningTool[], now: number, icons: Icons): string | undefined {
  const oldest = oldestRunning(running)
  if (oldest === undefined) return undefined
  return `${statusIcon(oldest.tool, icons)} ${runningLine(oldest, now, STATUS_SUMMARY, icons)}`
}

const SPINNER_SUMMARY = 40

// The transcript spinner's text while a main-loop tool runs: the tool, its
// summary cut to 40 characters in the middle and the elapsed time, e.g.
// "Bash go test ./... . 12s". Undefined when nothing runs.
export function spinnerMessage(running: readonly RunningTool[], now: number, icons: Icons): string | undefined {
  const oldest = oldestRunning(running)
  return oldest === undefined ? undefined : runningLine(oldest, now, SPINNER_SUMMARY, icons)
}

const oldestRunning = (running: readonly RunningTool[]) =>
  running.reduce<RunningTool | undefined>(
    (best, r) => (best === undefined || r.startedAt < best.startedAt ? r : best),
    undefined,
  )

// "Name summary . 12s": what the status line and the spinner both say.
function runningLine(call: RunningTool, now: number, summaryMax: number, icons: Icons): string {
  const secs = Math.max(0, Math.floor((now - call.startedAt) / 1000))
  const elapsed = secs >= 60 ? `${Math.floor(secs / 60)}m ${secs % 60}s` : `${secs}s`
  const { name, summary } = compactCall(call.tool, call.input, icons.ellipsis)
  const shown = summary === '' ? '' : ` ${truncateMiddle(summary, summaryMax, icons.ellipsis)}`
  return `${name}${shown} ${icons.dot} ${elapsed}`
}

// -- Team board ---------------------------------------------------------------

export type TaskEntry = { id: string; subject: string; status: string; owner?: string }

export const taskMark = (status: string, marks: TaskMarks = DEFAULT_GLYPHS): string =>
  status === 'completed' ? marks.taskDone : status === 'in_progress' ? marks.taskActive : marks.taskTodo

// The team's tasks as the main loop's TaskCreate and TaskUpdate calls left
// them: the latest status, owner and subject win, a deleted task drops out.
// A created task's id is read from its result ("Task #3 created ..."), else
// counted in creation order; an update for a task created elsewhere (by a
// teammate) adds it.
export function taskBoard(turns: readonly Turn[]): TaskEntry[] {
  const tasks = new Map<string, TaskEntry>()
  let created = 0
  for (const turn of turns) {
    for (const item of turn.items) {
      if (item.kind !== 'tool' || item.isError || item.isPending) continue
      if (item.tool === 'TaskCreate') {
        created += 1
        let id = taskIdIn(item.resultText ?? '')
        if (id === undefined) {
          let next = created
          while (tasks.has(String(next))) next += 1
          id = String(next)
        }
        tasks.set(id, { id, subject: str(item.input, 'subject') || 'Untitled task', status: 'pending' })
      } else if (item.tool === 'TaskUpdate') {
        const raw = item.input['taskId']
        const id = typeof raw === 'number' ? String(raw) : str(item.input, 'taskId')
        if (id === '') continue
        const status = str(item.input, 'status')
        if (status === 'deleted') {
          tasks.delete(id)
          continue
        }
        const task = tasks.get(id) ?? { id, subject: `Task #${id}`, status: 'pending' }
        const owner = str(item.input, 'owner')
        const subject = str(item.input, 'subject')
        tasks.set(id, {
          ...task,
          ...(status ? { status } : {}),
          ...(owner ? { owner } : {}),
          ...(subject ? { subject } : {}),
        })
      }
    }
  }
  return [...tasks.values()]
}

// The digits after the first '#', as TaskCreate's result names the new task.
function taskIdIn(text: string): string | undefined {
  const at = text.indexOf('#')
  if (at < 0) return undefined
  let end = at + 1
  while (end < text.length && text[end]! >= '0' && text[end]! <= '9') end += 1
  return end > at + 1 ? text.slice(at + 1, end) : undefined
}

export type TeamMember = { name: string; type: string; status: AgentStatus }

// The session's teammates (agents with a teammateId, `<name>@<team>`).
export function teamMembers(agents: readonly AgentInfo[]): TeamMember[] {
  return agents.flatMap(agent =>
    agent.teammateId === undefined
      ? []
      : [
          {
            name: sanitizeText(agent.teammateId.split('@')[0] || agent.teammateId),
            type: sanitizeText(agent.type),
            status: agent.status,
          },
        ],
  )
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

// -- Pinned footer ------------------------------------------------------------

export type FooterLayout = {
  // Rows the footer takes: the rule, the groups and the status line.
  rows: number
  // Groups side by side in two rows, or one group per row.
  columns: 'two' | 'stacked'
  // Whether the buttons carry their labels; without, only key and glyph.
  labels: boolean
}

const FOOTER_TWO_COLUMNS_FROM = 64
const FOOTER_LABELS_FROM = 40

export function footerLayout(columns: number): FooterLayout {
  if (columns >= FOOTER_TWO_COLUMNS_FROM) return { rows: 4, columns: 'two', labels: true }
  return { rows: 6, columns: 'stacked', labels: columns >= FOOTER_LABELS_FROM }
}

// -- Own scroll ---------------------------------------------------------------
//
// The pane is exactly as tall as its window, so the engine has nothing to
// scroll: the content sits in a clipped window of its own and moves by
// `scrollTop` rows. Its height is estimated from what the view draws.

// One block of the content in drawing order, with the text that may wrap and
// the cells it wraps at (`width`); a text without a width is cut to one row.
// - `line`: one row (an item row carries its id), or a wrapping text.
// - `frame`: two borders, the header row, the pieces of its body (narrowed by
//   the `gutter` of numbered code and diffs) and its note rows (show all, a
//   budget note, an error line), all wrapped at the frame's inner width.
// - `turn`: a row of the turn list and its search snippet.
export type RowBlock =
  | { kind: 'line'; id?: string; text?: string; width?: number }
  | { kind: 'frame'; body: readonly string[]; notes: readonly string[]; width: number; gutter?: number; head?: string }
  | { kind: 'turn'; snippet?: string; width?: number }

export type ContentRows = { total: number; starts: Readonly<Record<string, number>> }

// The two borders of a frame.
const FRAME_BORDERS = 2
// What a tab is drawn as.
const TAB = '    '

// Measured texts by width: a pane draws the same pieces on every tick.
const wrapCache = new Map<string, number>()
const MAX_WRAP_CACHE = 2000

// The rows `text` takes wrapped at `width` cells: each of its lines at least
// one, a long one a row per `width`; a trailing newline adds none.
function wrappedRows(text: string, width: number): number {
  const key = `${width}\u0000${text}`
  const cached = wrapCache.get(key)
  if (cached !== undefined) return cached
  const lines = text.split('\n')
  if (lines.length > 1 && lines.at(-1) === '') lines.pop()
  const cells = Math.max(1, width)
  const rows = lines.reduce(
    (sum, line) => sum + Math.max(1, Math.ceil(displayWidth(line.replaceAll('\t', TAB)) / cells)),
    0,
  )
  if (wrapCache.size >= MAX_WRAP_CACHE) wrapCache.clear()
  wrapCache.set(key, rows)
  return rows
}

const textRows = (text: string | undefined, width: number | undefined): number =>
  text === undefined || width === undefined ? 1 : wrappedRows(text, width)

function blockRows(block: RowBlock): number {
  switch (block.kind) {
    case 'line':
      return textRows(block.text, block.width)
    case 'turn':
      return 1 + (block.snippet === undefined ? 0 : textRows(block.snippet, block.width))
    case 'frame': {
      const bodyWidth = block.width - (block.gutter ?? 0)
      return (
        FRAME_BORDERS +
        textRows(block.head, block.width) +
        block.body.reduce((sum, piece) => sum + wrappedRows(piece, bodyWidth), 0) +
        block.notes.reduce((sum, note) => sum + wrappedRows(note, block.width), 0)
      )
    }
  }
}

// The rows of the content and the row each item row starts on. Every text
// is counted as wrapped at the width the view gives it.
export function contentRows(blocks: readonly RowBlock[]): ContentRows {
  const starts: Record<string, number> = {}
  let total = 0
  for (const block of blocks) {
    if (block.kind === 'line' && block.id !== undefined) starts[block.id] = total
    total += blockRows(block)
  }
  return { total, starts }
}

// How far past its end the content may scroll: the estimate can fall short,
// so the last rows always come into view.
const SCROLL_SLACK = 2

// The scroll kept between the top and two rows past the end; none while the
// content fits the window.
export function clampScroll(scrollTop: number, contentRows: number, windowRows: number): number {
  const max = contentRows > windowRows ? contentRows - windowRows + SCROLL_SLACK : 0
  return Math.min(Math.max(0, scrollTop), max)
}

// One page down (`delta` 1) or up (-1): the window less its two indicator rows.
export function pageScroll(scrollTop: number, delta: number, windowRows: number): number {
  return Math.max(0, scrollTop + delta * Math.max(1, windowRows - SCROLL_SLACK))
}

// The scroll that shows the row starting at `rowStart`, one row in from the
// edge it left by (the indicator rows cover the edges); unchanged when it shows.
export function followCursor(scrollTop: number, rowStart: number, windowRows: number): number {
  const margin = windowRows > SCROLL_SLACK ? 1 : 0
  if (rowStart < scrollTop + margin) return Math.max(0, rowStart - margin)
  if (rowStart > scrollTop + windowRows - 1 - margin) return rowStart - windowRows + 1 + margin
  return scrollTop
}

// The rows out of view above and below the window, the rows under the
// indicators included; none while the content fits.
export function overflowRows(scrollTop: number, total: number, windowRows: number): { above: number; below: number } {
  if (total <= windowRows) return { above: 0, below: 0 }
  return { above: scrollTop > 0 ? scrollTop + 1 : 0, below: Math.max(0, total - scrollTop - windowRows + 1) }
}

// Where the window stands as drawn: what a key that moves the cursor needs to
// keep the cursor's row in view.
export type ScrollFrame = {
  scrollTop: number
  windowRows: number
  total: number
  starts: Readonly<Record<string, number>>
}

// The scroll that keeps row `id` in view; unchanged for a row not drawn.
export function scrollToRow(frame: ScrollFrame, id: string | null): number {
  const start = id === null ? undefined : frame.starts[id]
  if (start === undefined) return frame.scrollTop
  return clampScroll(followCursor(frame.scrollTop, start, frame.windowRows), frame.total, frame.windowRows)
}

// One row of the cursor (`delta` -1 or 1) over `ids`. Without a cursor on the
// list, j enters at the first row inside the window as drawn and k at the
// last, so the content does not jump; with none inside, at the ends.
export function stepCursor(
  ids: readonly string[],
  current: string | null,
  delta: number,
  frame: ScrollFrame,
): string | null {
  if (current !== null && ids.includes(current)) return moveCursor(ids, current, delta)
  const margin = frame.windowRows > SCROLL_SLACK ? 1 : 0
  const first = frame.scrollTop + margin
  const last = frame.scrollTop + frame.windowRows - 1 - margin
  const inside = ids.filter(id => {
    const start = frame.starts[id]
    return start !== undefined && start >= first && start <= last
  })
  const entry = delta < 0 ? inside.at(-1) : inside[0]
  return entry ?? moveCursor(ids, null, delta)
}
