// Untrusted text: what the transcript, tool input and prompts carry is
// cleaned of terminal escapes, control and bidi characters before display.
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
