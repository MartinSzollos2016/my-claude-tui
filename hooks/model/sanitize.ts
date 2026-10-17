// Untrusted text: what the transcript, tool input and prompts carry is
// cleaned of terminal escapes, control and bidi characters before display.
//
// Tool results, model output and tool inputs are untrusted: a fetched page or
// a file can carry terminal escape sequences (OSC 52 writes the clipboard,
// OSC 8 spoofs links, CSI moves the cursor over other rows) or bidi controls
// that make code read differently than it runs (Trojan Source). Everything
// from the transcript passes through sanitizeText before it is drawn.
import { expandTabs } from './width'

// CSI, OSC (BEL or ST terminated), DCS/SOS/PM/APC strings, two-byte escapes.
const ESCAPE_SEQUENCES =
  /\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007\u001b]*(?:\u0007|\u001b\\)?|[PX^_][^\u001b]*(?:\u001b\\)?|[@-Z\\-_])/g

// C0 controls except tab and newline (CR included: it overdraws a line), DEL, C1.
const CONTROL_CHARS = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g

// Bidi embeddings, overrides and isolates, plus the implicit marks.
const BIDI_CONTROLS = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g

// Any character one of the three above removes (an escape starts with ESC, a
// control); not global, so test() keeps no state. Clean text skips the
// replacements and comes back as it is.
const UNSAFE = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/

const MAX_DEPTH = 32

export function sanitizeText(text: string): string {
  if (!UNSAFE.test(text)) return text
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

// The text between the first `open` at or after `from` and the next `close`,
// trimmed. indexOf rather than a regex: prompts are untrusted, and the
// regexes this replaced backtracked cubically on long runs of whitespace.
function between(text: string, open: string, close: string, from = 0): string | undefined {
  const start = text.indexOf(open, from)
  if (start < 0) return undefined
  const end = text.indexOf(close, start + open.length)
  return end < 0 ? undefined : text.slice(start + open.length, end).trim()
}

export function stripBlocks(text: string, open: string, close: string): string {
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

// The agents a hand-back comes from: the `from` of each `<agent-message>`
// block outside the reminders, once each. Only a block at the top counts:
// the scan follows the open and end tags, so the blocks a report quotes are
// inside its own and name no one. An open tag is a whole tag with quoted
// attributes, so quoted code ('<agent-message'), a longer tag name or an end
// tag inside a quoted value opens or closes nothing. It reads tags, not
// meaning: an unclosed block holds the rest of the text, and a stray end tag
// closes the block it sits in. A text with many blocks names at most
// MAX_SENDERS and is read only up to MAX_BLOCKS top blocks.
const HAND_BACK = '<agent-message'

// Whether a prompt text is an agent's hand-back: the one test every path
// (the turn, its stat, its title) shares, so they always agree.
export const isHandBack = (text: string): boolean => text.includes(HAND_BACK)
const HAND_BACK_TAGS = /<agent-message((?:\s+[\w-]+="[^"]{0,200}"){0,8})\s*>|<\/agent-message>/g
const MAX_SENDERS = 8
const MAX_BLOCKS = 64

// The value of the first attribute named `name` in an open tag's attribute
// list (` a="1" b="2"`), read attribute by attribute so another attribute's
// value never stands in for it; '' when it has none.
function attributeOf(attributes: string, name: string): string {
  for (const attribute of attributes.matchAll(/\s+([\w-]+)="([^"]*)"/g)) if (attribute[1] === name) return attribute[2]!
  return ''
}

export function handBackSenders(text: string): string[] {
  const own = stripBlocks(text, '<system-reminder>', '</system-reminder>')
  const senders = new Set<string>()
  const tags = new RegExp(HAND_BACK_TAGS)
  let depth = 0
  let blocks = 0
  for (let tag = tags.exec(own); tag !== null; tag = tags.exec(own)) {
    const attributes = tag[1]
    if (attributes === undefined) {
      depth = Math.max(0, depth - 1)
      continue
    }
    depth += 1
    if (depth > 1) continue
    if (senders.size >= MAX_SENDERS || blocks >= MAX_BLOCKS) break
    blocks += 1
    const from = attributeOf(attributes, 'from')
    const clean = sanitizeText(from).trim()
    if (clean !== '') senders.add(clean)
  }
  return [...senders]
}

// What a turn's stat is matched by: the prompt, or for a hand-back its
// senders, since its shown name follows the calls in the rows and changes as
// they leave the window.
const handBackKey = (senders: readonly string[]) => `\u0000hand-back:${senders.join(',')}`

export const promptKey = (turn: { prompt: string; senders?: readonly string[] }): string =>
  turn.senders === undefined ? turn.prompt : handBackKey(turn.senders)

// The key of the turn a prompt text opens, before the turn is in the rows
// (turn.start, prompt.submit).
export function statPrompt(text: string): string {
  return isHandBack(text) ? handBackKey(handBackSenders(text)) : sanitizePrompt(sanitizeText(text).trim())
}

// Turns XML-ish wrappers the engine injects into a readable one-liner.
export function sanitizePrompt(text: string): string {
  return expandTabs(promptOf(text))
}

function promptOf(text: string): string {
  // An agent's hand-back: the engine's frame around its report.
  if (isHandBack(text)) return 'Message from agent'
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
