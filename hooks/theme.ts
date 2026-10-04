import type { AgentStatus } from 'claude-code'

import type { SectionKind } from './model'

// Colors as Claude Code theme keys. The engine resolves a key against the
// theme the person picked in /theme (dark, light, their daltonized and ANSI
// variants, or a custom one) at paint time, so every color here follows the
// theme, including a switch mid-session, with no theme detection of our own.
//
// The engine does not validate keys: an unknown one silently draws uncolored.
// THEME_KEYS is therefore the closed set this mod may use, checked by
// tests/theme.test.ts; every key in it is present in all six built-in themes
// of Claude Code 2.1.289.

export const THEME_KEYS = [
  'inverseText',
  'userMessageBackground',
  'claude',
  'suggestion',
  'permission',
  'success',
  'warning',
  'error',
  'inactive',
  'subtle',
  'merged',
  'planMode',
  'autoAccept',
  'red_FOR_SUBAGENTS_ONLY',
  'blue_FOR_SUBAGENTS_ONLY',
  'green_FOR_SUBAGENTS_ONLY',
  'purple_FOR_SUBAGENTS_ONLY',
  'orange_FOR_SUBAGENTS_ONLY',
] as const

export type ThemeKey = (typeof THEME_KEYS)[number]

// Semantic roles, mapped from tail-claude's theme.go onto the nearest
// Claude Code role so the mod reads as part of the host UI.
export const C = {
  // The pane body: black on dark themes, white on light ones (the inverse
  // of the text color), replacing the engine's grey sidebar fill so the
  // text reads at full contrast.
  paneBackground: 'inverseText',
  // A hovered row: the subtle fill Claude Code gives the person's messages.
  rowHover: 'userMessageBackground',
  brand: 'claude',
  accent: 'suggestion',
  error: 'error',
  ongoing: 'success',
  contextOk: 'success',
  contextWarn: 'warning',
  contextCrit: 'error',
  muted: 'inactive',
  subtle: 'subtle',
  branch: 'merged',
  interrupted: 'warning',
  modePlan: 'planMode',
  modeAcceptEdits: 'autoAccept',
  modeBypass: 'error',
  modeAuto: 'permission',
} as const satisfies Record<string, ThemeKey>

// Frame colors of the expanded sections: what went in in the permission /
// suggestion hues, a diff in the edit hue, the outcome green or red.
export const TONE = {
  command: 'permission',
  query: 'permission',
  input: 'suggestion',
  file: 'suggestion',
  diff: 'autoAccept',
  output: 'success',
  error: 'error',
} as const satisfies Record<SectionKind, ThemeKey>

// Model families keep tail-claude's hues (opus red, sonnet blue, haiku
// green, fable violet) through the theme's agent palette.
export function modelColor(model: string): ThemeKey | undefined {
  if (model.includes('fable') || model.includes('mythos')) return 'purple_FOR_SUBAGENTS_ONLY'
  if (model.includes('opus')) return 'red_FOR_SUBAGENTS_ONLY'
  if (model.includes('sonnet')) return 'blue_FOR_SUBAGENTS_ONLY'
  if (model.includes('haiku')) return 'green_FOR_SUBAGENTS_ONLY'
  return undefined
}

// Context-window pressure: thresholds 50/80 as in tail-claude.
export function contextColor(pct: number): ThemeKey {
  if (pct >= 80) return C.contextCrit
  if (pct >= 50) return C.contextWarn
  return C.contextOk
}

export function modeColor(mode: string | null): ThemeKey | undefined {
  switch (mode) {
    case 'plan':
      return C.modePlan
    case 'acceptEdits':
      return C.modeAcceptEdits
    case 'bypassPermissions':
      return C.modeBypass
    case 'auto':
      return C.modeAuto
    default:
      return undefined
  }
}

// An agent's status on the team board: running green, failed red, finished
// in the accent, idle muted.
export function agentStatusColor(status: AgentStatus): ThemeKey {
  switch (status) {
    case 'running':
    case 'pending':
    case 'waiting':
      return C.ongoing
    case 'failed':
    case 'killed':
      return C.error
    case 'completed':
      return C.accent
    default:
      return C.muted
  }
}

// -- Plugin themes ------------------------------------------------------------
//
// The engine paints the docked pane's column (frame included) with the
// composerSidebarBackground theme key, out of a plugin's reach. themes/*.json
// ship one variant of each built-in theme that only overrides that key: black
// on the dark themes, white on the light ones. The engine loads them as
// `custom:tail-view:<base>`.

// Base theme -> the name its themes/<base>.json variant shows in /theme.
export const TAIL_THEMES = {
  dark: 'Tail Dark',
  'dark-daltonized': 'Tail Dark (colorblind-friendly)',
  'dark-ansi': 'Tail Dark (ANSI colors only)',
  light: 'Tail Light',
  'light-daltonized': 'Tail Light (colorblind-friendly)',
  'light-ansi': 'Tail Light (ANSI colors only)',
} as const

type BuiltinTheme = keyof typeof TAIL_THEMES

const TAIL_THEME_PREFIX = 'custom:tail-view:'

const isBuiltinTheme = (theme: string): theme is BuiltinTheme => Object.hasOwn(TAIL_THEMES, theme)

const NOT_LOADED = 'Tail themes are not loaded in this session; run /reload-plugins or reinstall tail-view.'

// What /tail theme says. Claude Code's config API only takes the built-in
// themes, so the mod cannot switch to a custom one itself: it names the
// variant matching the current theme for the person to pick in /theme.
// `options` are the theme setting's choices (config.list); when they are
// known and hold no tail-view variant, the themes did not load and naming
// one would send the person looking for nothing.
export function tailThemeAdvice(current: string, options?: readonly string[]): string {
  if (current.startsWith(TAIL_THEME_PREFIX)) {
    const base = current.slice(TAIL_THEME_PREFIX.length)
    if (isBuiltinTheme(base)) return `Already using "${TAIL_THEMES[base]}".`
  }
  if (options !== undefined && !options.some(option => option.startsWith(TAIL_THEME_PREFIX))) return NOT_LOADED
  if (isBuiltinTheme(current)) {
    return `Pick "${TAIL_THEMES[current]}" in /theme: ${current} with a ${current.startsWith('dark') ? 'black' : 'white'} pane column and frame.`
  }
  const names = Object.values(TAIL_THEMES)
    .map(n => `"${n}"`)
    .join(', ')
  return `Pick one of ${names} in /theme for a black or white pane column and frame.`
}
