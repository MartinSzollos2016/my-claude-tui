// The glyphs the views draw, in three sets with the same keys: Nerd Font
// (the default), plain Unicode symbols and ASCII. Every glyph is one cell
// wide in the last two, so rows line up on any terminal font.

import type { IconSetName } from '../types'

export type Icons = {
  robot: string
  wrench: string
  folderSearch: string
  penNib: string
  book: string
  web: string
  output: string
  thinking: string
  clock: string
  token: string
  collapsed: string
  expanded: string
  drill: string
  selected: string
  system: string
  branch: string
  dot: string
  // Tool call states.
  done: string
  error: string
  idle: string
  interrupted: string
  spinner: readonly string[]
  // The compact transcript and small markers.
  bullet: string
  result: string
  prompt: string
  marker: string
  arrow: string
  dash: string
  // What a cut text ends in, the check marks of the task board and the
  // frame style the engine draws a Box border with.
  ellipsis: string
  taskDone: string
  taskActive: string
  taskTodo: string
  border: 'round' | 'classic'
  // The context meter's full and empty cells.
  meterFull: string
  meterEmpty: string
  // Tree guides of a subagent's trace, each three cells wide: an item that
  // has siblings after it, the last item, and a level that continues.
  treeBranch: string
  treeLast: string
  treeGuide: string
  // Between the groups of the navigation buttons.
  groupSep: string
  // The thin rule above the footer.
  rule: string
  // The duration bar's steps from one to eight eighths of a cell, and the
  // sign of a group's call count.
  bar: readonly string[]
  times: string
}

const BRAILLE = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

const nerd: Icons = {
  robot: '\u{F167A}',
  wrench: '\u{F0BE0}',
  folderSearch: '\u{F0968}',
  penNib: '',
  book: '',
  web: '\u{F059F}',
  output: '\u{F0182}',
  thinking: '\u{F09D1}',
  clock: '',
  token: '',
  collapsed: '',
  expanded: '',
  drill: '',
  selected: '│',
  system: '',
  branch: '',
  dot: '·',
  done: '✓',
  error: '✗',
  idle: '·',
  interrupted: '⏸',
  spinner: BRAILLE,
  bullet: '●',
  result: '⎿',
  prompt: '❯',
  marker: '›',
  arrow: '→',
  dash: '–',
  ellipsis: '…',
  taskDone: '☑',
  taskActive: '◐',
  taskTodo: '☐',
  border: 'round',
  meterFull: '▰',
  meterEmpty: '▱',
  treeBranch: '├─ ',
  treeLast: '└─ ',
  treeGuide: '│  ',
  groupSep: '·',
  rule: '─',
  bar: ['▏', '▎', '▍', '▌', '▋', '▊', '▉', '█'],
  times: '×',
}

const unicode: Icons = {
  ...nerd,
  robot: '◆',
  wrench: '◇',
  folderSearch: '⌕',
  penNib: '✎',
  book: '▤',
  web: '◎',
  output: '❯',
  thinking: '…',
  clock: '◷',
  token: 'Σ',
  collapsed: '⏵',
  expanded: '▾',
  drill: '→',
  system: '▪',
  branch: '⑂',
  // U+23F8 draws two cells wide on many terminals.
  interrupted: '‖',
}

const ascii: Icons = {
  robot: '@',
  wrench: '$',
  folderSearch: '?',
  penNib: '+',
  book: '#',
  web: '~',
  output: '*',
  thinking: '%',
  clock: 't',
  token: '=',
  collapsed: '>',
  expanded: 'v',
  drill: '>',
  selected: '|',
  system: '&',
  branch: '^',
  dot: '.',
  done: '+',
  error: 'x',
  idle: '.',
  interrupted: '!',
  spinner: ['|', '/', '-', '\\'],
  bullet: '*',
  result: '|',
  prompt: '>',
  marker: '>',
  arrow: '>',
  dash: '-',
  ellipsis: '...',
  taskDone: '[x]',
  taskActive: '[~]',
  taskTodo: '[ ]',
  border: 'classic',
  meterFull: '#',
  meterEmpty: '-',
  treeBranch: '|- ',
  treeLast: '`- ',
  treeGuide: '|  ',
  groupSep: '.',
  rule: '-',
  bar: ['-', '-', '-', '-', '-', '-', '-', '='],
  times: 'x',
}

export const ICON_SETS: Record<IconSetName, Icons> = { nerd, unicode, ascii }

export const ICON_SET_NAMES = Object.keys(ICON_SETS) as IconSetName[]

export const isIconSetName = (value: unknown): value is IconSetName =>
  typeof value === 'string' && Object.hasOwn(ICON_SETS, value)
