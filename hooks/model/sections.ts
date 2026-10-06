// The sections an expanded tool row shows (input, code, diff, output, error),
// and the cache that keeps them while the item does not change.
import { unifiedDiff } from './diff'
import { DEFAULT_GLYPHS, type Glyphs } from './format'
import { sanitizeText } from './sanitize'
import { taskMark } from './team'
import type { ToolItem } from './types'
import { num, str } from './values'
import { basename } from './width'

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

export function inputSections(item: ToolItem, glyphs: Glyphs): Section[] {
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

// How many inputs were fingerprinted, for tests.
export const sectionWork = { fingerprints: 0 }

// The input's part of the fingerprint, once per item: a turn's items live
// until the transcript changes, and the pane draws them again and again.
const inputPrints = new WeakMap<ToolItem, string>()

function inputPrint(item: ToolItem): string {
  const cached = inputPrints.get(item)
  if (cached !== undefined) return cached
  sectionWork.fingerprints += 1
  const json = JSON.stringify(item.input)
  let hash = 5381
  for (let i = 0; i < json.length; i++) hash = ((hash << 5) + hash + json.charCodeAt(i)) | 0
  const print = `${item.tool}|${json.length}|${hash}`
  inputPrints.set(item, print)
  return print
}

// A cheap fingerprint of what the sections are built from.
function fingerprint(item: ToolItem, glyphs: Glyphs): string {
  const result = item.resultText
  return `${inputPrint(item)}|${result === undefined ? -1 : result.length}|${item.isError ? 1 : 0}|${glyphs.dot}${glyphs.ellipsis}${glyphs.taskDone}`
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
