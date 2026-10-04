// Start and end of one tool call, in $.clock.now() milliseconds, keyed by
// tool_use_id. Captured live by the tool.call hook (main loop and subagents).
export type ToolTiming = { start: number; end?: number }

// One finished main-loop turn, matched back to its prompt by text.
export type TurnStat = {
  prompt: string
  durationMs: number
  endedAt: number
  model?: string
  inputTokens?: number
  outputTokens?: number
}

// What a subagent's own turn.complete reported.
export type AgentStat = { model?: string; durationMs?: number }

export type GitInfo = { branch: string; isDirty: boolean }

declare module 'claude-code' {
  interface PluginState {
    'tail-view': {
      // Bumped on every live change; drawings read it to redraw.
      tick: number
      // Selected turn index; null follows the latest.
      turn: number | null
      // Expanded row ids (tool_use_id, output id, agentId/child id).
      expanded: string[]
      // Blocks shown whole instead of previewed (output, input, result ids).
      full: string[]
      timings: Record<string, ToolTiming>
      turnStats: TurnStat[]
      agentStats: Record<string, AgentStat>
      git: GitInfo | null
      mode: string | null
      isWorking: boolean
      isBarHidden: boolean
    }
  }
}
