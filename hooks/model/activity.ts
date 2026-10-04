// Activity while Claude works: a Workflow's state, agents and workflows that
// finished since the last look, and the status line and spinner of running tools.
import type { AgentStatus } from 'claude-code'
import type { Icons } from '../icons'
import { sanitizeText, sanitizeValue } from './sanitize'
import { itemName, itemSummary, toolCategory, toolSummary } from './summaries'
import { isAgentFinished } from './turns'
import type { ToolItem, Turn } from './types'
import { str } from './values'
import { fitPath, truncate, truncateMiddle } from './width'

export type WorkflowState = { isRunning: false } | { isRunning: true; agents: number }

// A Workflow call of the latest turn still waiting for its result runs only
// while the session works: an interrupted turn leaves it pending for good.
export function workflowState(turn: Turn | undefined, unknownAgents: number, isWorking: boolean): WorkflowState {
  const isPending =
    turn?.items.some(item => item.kind === 'tool' && item.tool === 'Workflow' && item.isPending) ?? false
  return isPending && isWorking ? { isRunning: true, agents: unknownAgents } : { isRunning: false }
}

// The one line a tool call gets in the compact transcript: its name and the
// shortest useful summary (a Bash call's description, else its first line).
export function compactCall(tool: string, rawInput: unknown, ellipsis = '…'): { name: string; summary: string } {
  const input = (rawInput !== null && typeof rawInput === 'object' ? sanitizeValue(rawInput) : {}) as Record<
    string,
    unknown
  >
  const name = sanitizeText(tool)
  const item: ToolItem = { kind: 'tool', id: '', tool: name, input, summary: '', isError: false, isPending: false }
  if (name === 'Bash') {
    const line = str(input, 'description') || (str(input, 'command').split('\n')[0] ?? '')
    return { name, summary: truncate(line, 80, ellipsis) }
  }
  const named: ToolItem = { ...item, summary: toolSummary(name, input) }
  return { name: itemName(item), summary: fitPath(named, itemSummary(named), 80, ellipsis) }
}

export type AgentSnapshot = { id: string; status: AgentStatus; description: string }

// The agents of `next` that finished since `prev` (their statuses at the last
// look): not finished then, finished now. An agent the last look did not see
// is not reported, so a list read for the first time announces nothing.
export function finishedSince(prev: ReadonlyMap<string, AgentStatus>, next: readonly AgentSnapshot[]): AgentSnapshot[] {
  return next.filter(a => {
    const before = prev.get(a.id)
    return before !== undefined && !isAgentFinished(before) && isAgentFinished(a.status)
  })
}

// Follows the Workflow calls of the latest turn by id. `tracked` holds those
// seen pending; a tracked call that now has its result is finished. One left
// pending when the session stops working (an interrupt), gone from the turn
// or ended interrupted is dropped without being reported.
export function finishedWorkflows(
  tracked: ReadonlySet<string>,
  turn: Turn | undefined,
  isWorking: boolean,
): { tracked: Set<string>; finished: string[] } {
  const calls = new Map<string, ToolItem>()
  for (const item of turn?.items ?? []) if (item.kind === 'tool' && item.tool === 'Workflow') calls.set(item.id, item)
  const next = new Set<string>()
  const finished: string[] = []
  for (const [id, item] of calls) {
    if (item.isPending) {
      if (isWorking) next.add(id)
    } else if (tracked.has(id) && item.isInterrupted !== true) finished.push(id)
  }
  return { tracked: next, finished }
}

// A main-loop tool call that has started and not yet ended.
export type RunningTool = { id: string; tool: string; input: unknown; startedAt: number }

export const runningTool = (id: string, tool: string, input: unknown, startedAt: number): RunningTool => ({
  id,
  tool,
  input,
  startedAt,
})

// The input of a tool.call event: the event less the fields that are not the
// tool's own.
export function callInput(event: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const { tool: _tool, tool_use_id: _id, agentId: _agent, ...input } = event
  return input
}

const STATUS_SUMMARY = 60

function statusIcon(tool: string, icons: Icons): string {
  switch (toolCategory(tool)) {
    case 'read':
      return icons.book
    case 'edit':
      return icons.penNib
    case 'search':
      return icons.folderSearch
    case 'task':
      return icons.robot
    case 'web':
      return icons.web
    default:
      return icons.wrench
  }
}

// The line pinned under the prompt while a tool runs: the category icon, the
// tool, its summary cut to 60 characters in the middle and the whole seconds
// it has run, e.g. "$ Bash go test ./... . 12s". The oldest running call is
// the one shown; undefined when nothing runs.
export function statusText(running: readonly RunningTool[], now: number, icons: Icons): string | undefined {
  const oldest = oldestRunning(running)
  if (oldest === undefined) return undefined
  return `${statusIcon(oldest.tool, icons)} ${runningLine(oldest, now, STATUS_SUMMARY, icons)}`
}

const SPINNER_SUMMARY = 40

// The transcript spinner's text while a main-loop tool runs: the tool, its
// summary cut to 40 characters in the middle and the elapsed time, e.g.
// "Bash go test ./... . 12s". Undefined when nothing runs.
export function spinnerMessage(running: readonly RunningTool[], now: number, icons: Icons): string | undefined {
  const oldest = oldestRunning(running)
  return oldest === undefined ? undefined : runningLine(oldest, now, SPINNER_SUMMARY, icons)
}

const oldestRunning = (running: readonly RunningTool[]) =>
  running.reduce<RunningTool | undefined>(
    (best, r) => (best === undefined || r.startedAt < best.startedAt ? r : best),
    undefined,
  )

// "Name summary . 12s": what the status line and the spinner both say.
function runningLine(call: RunningTool, now: number, summaryMax: number, icons: Icons): string {
  const secs = Math.max(0, Math.floor((now - call.startedAt) / 1000))
  const elapsed = secs >= 60 ? `${Math.floor(secs / 60)}m ${secs % 60}s` : `${secs}s`
  const { name, summary } = compactCall(call.tool, call.input, icons.ellipsis)
  const shown = summary === '' ? '' : ` ${truncateMiddle(summary, summaryMax, icons.ellipsis)}`
  return `${name}${shown} ${icons.dot} ${elapsed}`
}
