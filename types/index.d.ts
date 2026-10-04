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

// The icon sets /tail-icons offers; the choice is kept in $.store under
// 'tail-view.icons' and read by every view.
export type IconSetName = 'nerd' | 'unicode' | 'ascii'

// The other preferences kept in $.store: 'tail-view.status' (boolean, the status
// line under the prompt while a tool runs; on unless false) and
// 'tail-view.notify' (boolean, toasts when a subagent or workflow finishes;
// off unless true). Set by /tail-status and /tail-notify. The Spinner and
// TurnDuration rewrites follow 'tail-view.status' too.
export type GitInfo = { branch: string }

declare module 'claude-code' {
  interface PluginState {
    'tail-view': {
      // Bumped on every live change; drawings read it to redraw.
      tick: number
      // Selected turn index; null follows the latest.
      turn: number | null
      // What the pane shows: one turn in detail, the list of turns, or the team board.
      view: 'detail' | 'turns' | 'team'
      // How many rows each view's content is scrolled up in the pane's own window;
      // all back to 0 when the shown turn or the view changes.
      scroll: Record<'detail' | 'turns' | 'team', number>
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
      // The row the keyboard cursor stands on (an item or folded run id); null for none.
      cursor: string | null
      // The transcript spinner's text while a main-loop tool runs; null leaves the engine's.
      spinner: string | null
    }
  }
}
