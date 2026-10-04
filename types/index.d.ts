// Start and end of one tool call, in $.clock.now() milliseconds, keyed by
// tool_use_id. Captured live by the tool.call hook (main loop and subagents).
export type ToolTiming = { start: number; end?: number }

// One finished main-loop turn. turnIndex is the turn's index in buildTurns,
// noted when the turn was submitted or started; a stat recorded before it
// existed matches by prompt.
export type TurnStat = {
  prompt: string
  turnIndex?: number
  durationMs: number
  endedAt: number
  model?: string
  inputTokens?: number
  outputTokens?: number
}

// What a subagent's own turn.complete reported.
export type AgentStat = { model?: string; durationMs?: number }

export type GitInfo = { branch: string }

declare module 'claude-code' {
  interface PluginState {
    'tail-view': {
      // Bumped on every live change; drawings read it to redraw.
      tick: number
      // Selected turn index; null follows the latest.
      turn: number | null
      // What the pane shows: one turn in detail, or the list of turns.
      view: 'detail' | 'turns'
      // Expanded row ids (tool_use_id, output id, agentId/child id).
      expanded: string[]
      // Blocks shown whole instead of previewed (output, input, result ids).
      full: string[]
      // The turn search's query; '' lists every turn.
      query: string
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
