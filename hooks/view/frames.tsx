// The frames an expanded row opens: one per section (input, code, diff, output),
// with a preview of long blocks, show all / show less and copy.
import type { RenderElement } from 'claude-code'
import { C, TONE, type ThemeKey } from '../theme'
import { chunkText, clampText } from '../model/clamp'
import { clampDiff, expandDiffTabs, splitDiff } from '../model/diff'
import { cachedSections, firstErrorLine, languageFor, pieceStarts, type Section } from '../model/sections'
import type { ToolItem } from '../model/types'
import { displayWidth, expandTabs, truncateMiddle } from '../model/width'
import {
  CODE_GUTTER,
  DIFF_HEADER_SLACK,
  EXPANDED_INDENT,
  FRAME_INSET,
  LINE,
  PREVIEW,
  TEXT_CHUNK,
  wrapWidth,
  type Ctx,
  type PaneActions,
} from './context'
import { buttonHover, cutter, endWrap, isUnicodeCut, middleWrap, scopeOf, type El } from './kit'

// What went in and what came out, each in a frame colored by its kind.
// `inset`: the cells left of the sections' box (a trace's indent).
export function renderSections(el: El, item: ToolItem, data: Ctx, act: PaneActions, inset: number, shown?: string) {
  const { Box } = el
  // A frame title repeating what the row above reads in whole is noise; one
  // the row cut stays, so the text is whole somewhere.
  const repeats = (meta: string) => shown !== undefined && shown.includes(meta)
  const frames = cachedSections(item, data.icons).map(section => {
    const id = `${item.id}:${section.kind}`
    const preview = renderLong(el, id, section.body, longSpec(section), data, act)
    const isError = section.kind === 'error'
    return renderFrame(
      el,
      id,
      isError ? `${data.icons.error} ${section.title}` : section.title,
      section.meta !== undefined && repeats(section.meta) ? undefined : section.meta,
      section.isPathMeta === true,
      TONE[section.kind],
      isError ? withFirstError(el, section.body, preview, data) : preview,
      section.body,
      data,
      act,
      inset + EXPANDED_INDENT,
    )
  })
  // The blank row under the frames.
  data.layout.push(LINE)
  return (
    <Box flexDirection="column" marginLeft={4} marginBottom={1}>
      {frames}
    </Box>
  )
}

// An error's first telling line, in red, above the preview of its output.
function withFirstError(el: El, body: string, preview: Long, data: Ctx): Long {
  const trunc = cutter(data.icons)
  const { Box, Text } = el
  const first = firstErrorLine(body)
  const line = trunc(expandTabs(first), Math.max(8, data.columns - 12))
  // An output that opens with the line already shows it, in red.
  const opening = body
    .split('\n')
    .find(l => l.trim() !== '')
    ?.trim()
  if (line === '' || opening === first || line.length > data.budget.left) return preview
  data.budget.left -= line.length
  return {
    ...preview,
    notes: [isUnicodeCut(data.icons) ? '' : line, ...preview.notes],
    node: (
      <Box flexDirection="column">
        <Text color={C.error} wrap={endWrap(data.icons)}>
          {line}
        </Text>
        {preview.node}
      </Box>
    ),
  }
}

function longSpec(section: Section): LongSpec {
  if (section.format.kind === 'text') return { kind: 'text', isError: section.kind === 'error' }
  return section.format
}

// A section in a frame colored by its kind; the header carries a copy
// button that copies the whole block, not the preview drawn below it.
export function renderFrame(
  el: El,
  blockId: string,
  title: string,
  meta: string | undefined,
  isPathMeta: boolean,
  tone: ThemeKey,
  body: Long,
  copyText: string,
  data: Ctx,
  act: PaneActions,
  // The cells left of the frame's border: the indents it sits in.
  inset: number,
) {
  const { Box, Button, Text } = el
  const trunc = cutter(data.icons)
  const metaText =
    meta === undefined || meta === ''
      ? ''
      : `  ${isPathMeta ? truncateMiddle(meta, isUnicodeCut(data.icons) ? 300 : Math.max(8, data.columns - 30), data.icons.ellipsis) : trunc(meta, 300)}`
  // The frame's own line draws from the pane's budget like its body.
  data.budget.left -= title.length + metaText.length + 'copy'.length
  // Its header row wraps only where the set leaves the meta uncut.
  const inner = wrapWidth(data, inset + FRAME_INSET)
  data.layout.push({
    kind: 'frame',
    body: body.pieces,
    notes: body.notes,
    width: inner,
    ...(body.gutter === undefined ? {} : { gutter: body.gutter }),
    ...(body.format === undefined ? {} : { format: body.format }),
    ...(isUnicodeCut(data.icons) || metaText === '' ? {} : { headRows: metaRows(title, metaText, inner) }),
  })
  return (
    <Box
      key={`frame-${blockId}`}
      flexDirection="column"
      borderStyle={data.icons.border}
      borderColor={tone}
      paddingX={1}
    >
      <Box flexDirection="row" justifyContent="space-between">
        <Box flexDirection="row" flexShrink={1}>
          {/* The title keeps its cells (measured: it wrapped under a long meta). */}
          <Box flexShrink={0}>
            <Text bold color={tone}>
              {title}
            </Text>
          </Box>
          {metaText !== '' && (
            <Text color={C.muted} wrap={isPathMeta ? middleWrap(data.icons) : endWrap(data.icons)}>
              {metaText}
            </Text>
          )}
        </Box>
        <Button
          key={`copy:${blockId}`}
          plain
          dimColor
          hover={buttonHover(scopeOf('btn:copy:', blockId))}
          label="copy"
          onPress={press => act.copy(copyText, press.surface)}
        />
      </Box>
      {body.node}
    </Box>
  )
}

// The rows of a frame header whose meta wraps beside its title and the copy
// button (the button and the gap before it: 6 cells).
const metaRows = (title: string, meta: string, width: number) =>
  Math.max(1, Math.ceil(displayWidth(meta) / Math.max(1, width - displayWidth(title) - 6)))

type LongSpec =
  | { kind: 'text'; isError: boolean }
  | { kind: 'code'; language?: string; path?: string; startLine?: number }
  | { kind: 'diff' }
  | { kind: 'markdown' }

// A drawn block: its element, the pieces of text in it and the rows under
// them (a note, show all, show less, an error line), for the row estimate.
type Long = {
  node: RenderElement
  pieces: readonly string[]
  notes: readonly string[]
  gutter?: number
  format?: 'markdown' | 'diff'
}

// Code the engine draws as Markdown, without empty lines: a markdown
// language or a .md path (a Write). Numbered code (a Read) keeps them.
const isMarkdownCode = (spec: LongSpec): boolean =>
  spec.kind === 'code' &&
  spec.startLine === undefined &&
  (spec.language ?? (spec.path === undefined ? undefined : languageFor(spec.path))) === 'markdown'

// A block of any length: previewed by lines and characters until the person
// asks for all of it, cut into pieces under the per-element limit, and drawn
// from the pane's text budget so the tree never crosses the engine's total.
// Its tabs are expanded first: the engine draws a tab narrow while the
// terminal jumps to the next stop, which pushed lines over the frame's border.
export function renderLong(el: El, id: string, raw: string, spec: LongSpec, data: Ctx, act: PaneActions): Long {
  const { Box, Button, Code, Text } = el
  const text = spec.kind === 'diff' ? expandDiffTabs(raw) : expandTabs(raw)
  const isFull = data.full.has(id)
  const preview = PREVIEW[spec.kind]
  const limit = isFull ? { lines: Infinity, chars: Infinity } : preview
  const allowed = Math.min(limit.chars, data.budget.left)
  const clamp = spec.kind === 'diff' ? clampDiff : clampText
  // Cutting a diff into pieces adds a header to each piece after the first.
  const room =
    spec.kind === 'diff' ? allowed - DIFF_HEADER_SLACK * Math.ceil(Math.max(0, allowed) / TEXT_CHUNK) : allowed
  const shown = clamp(text, limit.lines, room, data.icons.ellipsis)

  const isBudgetCut = shown.note !== undefined && allowed < limit.chars
  const isPreviewed = !isFull && shown.note !== undefined && !isBudgetCut
  const canShrink = isFull && clamp(text, preview.lines, preview.chars, data.icons.ellipsis).note !== undefined

  // A diff is cut only into pieces that are valid diffs; nothing drawn when
  // not even a header fits what is left of the budget.
  const pieces =
    spec.kind === 'diff'
      ? shown.text === ''
        ? []
        : splitDiff(shown.text, Infinity, TEXT_CHUNK)
      : chunkText(shown.text, TEXT_CHUNK)
  const starts = spec.kind === 'code' && spec.startLine !== undefined ? pieceStarts(shown.text, pieces) : []
  data.budget.left -= spec.kind === 'diff' ? pieces.reduce((sum, p) => sum + p.length, 0) : shown.text.length
  const budgetNote = `${shown.note} ${data.icons.dash} pane text budget reached; collapse other rows to see more`
  const fullLabel = `${shown.note} ${data.icons.dash} show all`
  data.budget.left -=
    (isBudgetCut ? budgetNote.length : 0) +
    (isPreviewed ? fullLabel.length : 0) +
    (canShrink && !isBudgetCut ? 'show less'.length : 0)
  const notes = [
    ...(isBudgetCut ? [budgetNote] : []),
    ...(isPreviewed ? [fullLabel] : []),
    ...(canShrink && !isBudgetCut ? ['show less'] : []),
  ]
  // Numbered code and diffs draw their line numbers beside the body.
  const lastLine =
    spec.kind === 'code' && spec.startLine !== undefined ? spec.startLine + shown.text.split('\n').length : 0
  const gutter = lastLine > 0 ? String(lastLine).length + CODE_GUTTER : undefined

  const node = (
    <Box flexDirection="column">
      {pieces.map((piece, i) =>
        spec.kind === 'markdown' ? (
          // The engine draws Markdown prose in the terminal's own foreground,
          // unreadable on the pane's theme background when the two disagree;
          // Code's markdown highlighting takes every color from the theme.
          <Code language="markdown" source={piece} />
        ) : spec.kind === 'diff' ? (
          <Code format="diff" source={piece} />
        ) : spec.kind === 'code' ? (
          <Code
            {...(spec.language === undefined ? {} : { language: spec.language })}
            {...(spec.path === undefined ? {} : { path: spec.path })}
            {...(spec.startLine === undefined ? {} : { startLine: spec.startLine + (starts[i] ?? 0) })}
            source={piece}
          />
        ) : (
          <Text color={spec.isError ? C.error : C.muted}>{piece}</Text>
        ),
      )}
      {isBudgetCut && <Text color={C.muted}>{budgetNote}</Text>}
      {isPreviewed && (
        <Button
          key={`full:${id}`}
          plain
          dimColor
          hover={buttonHover(scopeOf('btn:full:', id))}
          label={fullLabel}
          onPress={() => act.toggleFull(id)}
        />
      )}
      {canShrink && !isBudgetCut && (
        <Button
          key={`full:${id}`}
          plain
          dimColor
          hover={buttonHover(scopeOf('btn:full:', id))}
          label="show less"
          onPress={() => act.toggleFull(id)}
        />
      )}
    </Box>
  )
  const format =
    spec.kind === 'markdown' || isMarkdownCode(spec) ? 'markdown' : spec.kind === 'diff' ? 'diff' : undefined
  return {
    node,
    pieces,
    notes,
    ...(gutter === undefined ? {} : { gutter }),
    ...(format === undefined ? {} : { format }),
  }
}
