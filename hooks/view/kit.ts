// The drawing kit: the elements a surface lends (themed), hover scopes and
// styles, cutting by icon set, meter sizes, and the glyph of a call's state.
import { ICON_SETS, type Icons } from '../icons'
import { C, type ThemeKey } from '../theme'
import type { BoxProps, ElementConstructor, Elements, TextProps } from 'claude-code'
import { toolCategory } from '../model/summaries'
import { isSubagent, type ItemStatus } from '../model/turns'
import type { Item } from '../model/types'
import { truncateDisplay } from '../model/width'

// Text narrowed to theme keys: tsc rejects a raw color (hex, rgb, ansi)
// anywhere in the views, so everything follows the person's /theme.
type ThemedTextProps = Omit<TextProps, 'color' | 'backgroundColor'> & { color?: ThemeKey; backgroundColor?: ThemeKey }

type ThemedBoxProps = Omit<BoxProps, 'backgroundColor' | 'borderColor'> & {
  backgroundColor?: ThemeKey
  borderColor?: ThemeKey
}

export type El = Pick<Elements['terminal'], 'Button' | 'Code'> & {
  Box: ElementConstructor<ThemedBoxProps>
  Text: ElementConstructor<ThemedTextProps>
  // Optional: the mobile surface draws no field.
  Input?: Elements['terminal']['Input']
}

// A hovered button reads at full contrast: its idle label is the theme grey.
export const HOVER_TEXT = { color: C.text, bold: true } as const

// A hover scope the engine accepts: 1 to 64 characters. Ids can be long (a
// subagent's tool id carries its agent id), so an over-long tail is replaced
// by a short stable hash (32-bit FNV-1a, base36) of the whole string.
const SCOPE_MAX = 64

export function scopeOf(prefix: string, id: string): string {
  const full = `${prefix}${id}`
  if (full.length <= SCOPE_MAX) return full
  let hash = 0x811c9dc5
  for (let i = 0; i < full.length; i++) hash = Math.imul(hash ^ full.charCodeAt(i), 0x01000193) >>> 0
  const tail = hash.toString(36)
  return `${full.slice(0, SCOPE_MAX - tail.length - 1)}~${tail}`
}

// What a cut text ends in comes from the icon set, so the engine's own
// ellipsis (a Unicode one) is only left to draw where the set allows it.
export const cutter = (icons: Icons) => (text: string, max: number) => truncateDisplay(text, max, icons.ellipsis)

export const isUnicodeCut = (icons: Icons) => icons.ellipsis === ICON_SETS.nerd.ellipsis

export const endWrap = (icons: Icons) => (isUnicodeCut(icons) ? 'truncate-end' : 'wrap')

export const middleWrap = (icons: Icons) => (isUnicodeCut(icons) ? 'truncate-middle' : 'wrap')

// The context meter's length, and the info bar width it needs to show.
export const METER_CELLS = 10

export const BAR_METER_COLUMNS = 100

// The duration bar's cells, and the pane width it needs to show.
export const BAR_CELLS = 8

export const BAR_MIN_COLUMNS = 70

export const HEADER_METER_COLUMNS = 80

// A trace's rows sit this far in from its subagent's row.
export const TRACE_INDENT = 4

export const buttonHover = (scope: string) => ({ scope, ...HOVER_TEXT })

// The state of a tool call as a glyph, so it reads without color too.
export function statusMark(status: ItemStatus, frame: number, icons: Icons): { glyph: string; color: ThemeKey } {
  switch (status) {
    case 'done':
      return { glyph: icons.done, color: C.ongoing }
    case 'error':
      return { glyph: icons.error, color: C.error }
    case 'running':
      return { glyph: icons.spinner[frame % icons.spinner.length]!, color: C.ongoing }
    case 'interrupted':
      return { glyph: icons.interrupted, color: C.interrupted }
    case 'idle':
      return { glyph: icons.dot, color: C.muted }
  }
}

export function itemIcon(item: Item, icons: Icons): { glyph: string; color?: ThemeKey } {
  if (item.kind === 'output') return { glyph: icons.output, color: C.accent }
  if (item.isError) return { glyph: icons.wrench, color: C.error }
  switch (toolCategory(item.tool)) {
    case 'read':
      return { glyph: icons.book }
    case 'edit':
      return { glyph: icons.penNib }
    case 'search':
      return { glyph: icons.folderSearch }
    case 'task':
      return { glyph: icons.robot, color: isSubagent(item) ? C.accent : undefined }
    case 'web':
      return { glyph: icons.web }
    default:
      return { glyph: icons.wrench }
  }
}
