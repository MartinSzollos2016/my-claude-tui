// The shapes the transcript becomes: a turn holds the items its reply produced.

type OutputItem = { kind: 'output'; id: string; text: string }

export type ToolItem = {
  kind: 'tool'
  id: string
  tool: string
  input: Record<string, unknown>
  summary: string
  resultText?: string
  isError: boolean
  isPending: boolean
  // The tool's own record says an abort ended it (Bash: result.interrupted).
  isInterrupted?: boolean
  agentId?: string
  durationMs?: number
}

export type Item = OutputItem | ToolItem

export type Turn = {
  index: number
  prompt: string
  items: Item[]
  toolCount: number
  outputCount: number
  subagentCount: number
}

export const SUBAGENT_TOOLS = new Set(['Agent', 'Task'])
