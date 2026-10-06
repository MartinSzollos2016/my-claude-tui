import type { AgentStatus } from 'claude-code'
import type { SectionKind } from './model/sections'

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
  'text',
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
  // The theme's own foreground: drawn explicitly on the painted pane, since
  // the terminal's default foreground can match the pane background.
  text: 'text',
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

// Model families keep tail-claude's hues (sonnet blue, haiku green, fable
// violet) through the theme's agent palette; opus is orange, as its red
// reads as an error here.
export function modelColor(model: string): ThemeKey | undefined {
  if (model.includes('fable') || model.includes('mythos')) return 'purple_FOR_SUBAGENTS_ONLY'
  if (model.includes('opus')) return 'orange_FOR_SUBAGENTS_ONLY'
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
