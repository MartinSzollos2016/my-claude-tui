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
  dirty: 'warning',
  modePlan: 'planMode',
  modeAcceptEdits: 'autoAccept',
  modeBypass: 'error',
  modeAuto: 'permission',
} as const satisfies Record<string, ThemeKey>

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

// -- Plugin themes ------------------------------------------------------------
//
// The engine paints the docked pane's column (frame included) with the
// composerSidebarBackground theme key, out of a plugin's reach. themes/*.json
// ship one variant of each built-in theme that only overrides that key: black
// on the dark themes, white on the light ones. The engine loads them as
// `custom:tail-view:<base>`.

export const BUILTIN_THEMES = ['dark', 'light', 'dark-daltonized', 'light-daltonized', 'dark-ansi', 'light-ansi'] as const

const TAIL_THEME_PREFIX = 'custom:tail-view:'

const isBuiltinTheme = (theme: string): theme is (typeof BUILTIN_THEMES)[number] =>
  (BUILTIN_THEMES as readonly string[]).includes(theme)

// The theme /tail theme switches to: the tail-view variant of a built-in
// theme, or back to the built-in one. Undefined for `auto` and for custom
// themes, which only the person can map.
export function toggleTailTheme(current: string): string | undefined {
  if (current.startsWith(TAIL_THEME_PREFIX)) {
    const base = current.slice(TAIL_THEME_PREFIX.length)
    return isBuiltinTheme(base) ? base : undefined
  }
  return isBuiltinTheme(current) ? TAIL_THEME_PREFIX + current : undefined
}
