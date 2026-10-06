// tail-view: event wiring and state. Live data comes from the engine
// ($.session.messages, $.agent.list, $.session.usage); timings are captured
// by the tool.call and turn.complete hooks. Commands are in commands.ts,
// rendering in view.tsx, transformations in model.ts.
import { atom, read, update } from 'claude-code'
import type {
  AgentInfo,
  AgentStatus,
  CommandRunInput,
  CommandRunResult,
  EngineInterface,
  Register,
  RenderSurface,
  Timer,
  UiScrollResult,
} from 'claude-code'

import type { AgentStat, IconSetName } from '../types'
import { COMMANDS, helpText, parseCommand, unknownText } from './commands'
import {
  discardStale,
  dropPending,
  enqueueTurn,
  isTextOnly,
  memo,
  nextSelectedTurn,
  noteNotified,
  noteWorkflowAgent,
  recordToolEnd,
  recordToolStart,
  remember,
  statFor,
  statOfDuration,
  takeTurnIndex,
  toggleId,
  turnIndexAtStart,
  turnOfStat,
  turnStatFrom,
  type Memo,
} from './session'
import { ICON_SET_NAMES, ICON_SETS, isIconSetName, type Icons } from './icons'
import { C } from './theme'
import {
  callInput,
  compactCall,
  finishedSince,
  finishedWorkflows,
  runningTool,
  spinnerMessage,
  statusText,
  workflowState,
  type RunningTool,
} from './model/activity'
import { cursorRows, rowText } from './model/cursor'
import { engineDuration } from './model/format'
import { gitDirFrom, parseGitHead } from './model/git'
import { groupRuns } from './model/groups'
import { turnListText, turnText } from './model/reports'
import { sanitizePrompt, sanitizeText } from './model/sanitize'
import { engineScroll, scrollToRow, stepCursor, type EngineScroll, type ScrollFrame } from './model/scroll'
import { searchTurns, type TurnMatch } from './model/search'
import { taskBoard, teamMembers, type TaskEntry } from './model/team'
import { thinkingByStart, thinkingOf, type ApiLike, type TurnThinking } from './model/thinking'
import { durationSuffix, inlineRows, paneColumns, paneRows, resultLine, terminalWidth } from './model/transcript'
import {
  apiTurnStarts,
  incrementalTurns,
  isAgentFinished,
  isAgentRunning,
  isSubagent,
  traceItems,
  turnsKey,
} from './model/turns'
import type { Item, Turn } from './model/types'
import { shortPath, truncate } from './model/width'
import { renderBar } from './view/bar'
import type { Trace } from './view/context'
import type { El } from './view/kit'
import { renderPane } from './view/pane'
import { searchFieldKey, turnRowId } from './view/turn-list'

const PANE = 'tail'
const MAX_STATS = 200
const MAX_EXPANDED = 300
const TICK_MS = 500

const tick = atom({ plugin: 'tail-view', key: 'tick' } as const, 0)
const selectedTurn = atom({ plugin: 'tail-view', key: 'turn' } as const, null)
const paneView = atom({ plugin: 'tail-view', key: 'view' } as const, 'detail')
const TOP = { detail: 0, turns: 0, team: 0 } as const
const paneScroll = atom({ plugin: 'tail-view', key: 'scroll' } as const, TOP)
const expanded = atom({ plugin: 'tail-view', key: 'expanded' } as const, [])
const fullBlocks = atom({ plugin: 'tail-view', key: 'full' } as const, [])
const searchQuery = atom({ plugin: 'tail-view', key: 'query' } as const, '')
const searchField = atom({ plugin: 'tail-view', key: 'searchField' } as const, { gen: 0, seed: '' })
const timings = atom({ plugin: 'tail-view', key: 'timings' } as const, {})
const turnStats = atom({ plugin: 'tail-view', key: 'turnStats' } as const, [])
const agentStats = atom({ plugin: 'tail-view', key: 'agentStats' } as const, {})
const cursor = atom({ plugin: 'tail-view', key: 'cursor' } as const, null)
const turnCursor = atom({ plugin: 'tail-view', key: 'turnCursor' } as const, null)
const git = atom({ plugin: 'tail-view', key: 'git' } as const, null)
const mode = atom({ plugin: 'tail-view', key: 'mode' } as const, null)
const isWorking = atom({ plugin: 'tail-view', key: 'isWorking' } as const, false)
const isBarHidden = atom({ plugin: 'tail-view', key: 'isBarHidden' } as const, false)
// Whether the pane's footer shows its full key map (h); for the session only.
const footerOpen = atom({ plugin: 'tail-view', key: 'footerOpen' } as const, false)
const spinner = atom({ plugin: 'tail-view', key: 'spinner' } as const, null)

const bump = ($: EngineInterface) => update($, tick, n => n + 1)

// The info bar's branch, read from the repository's .git/HEAD (through a
// worktree's .git file when there is one). The plugin starts no programs.
async function refreshGit($: EngineInterface): Promise<void> {
  const repo = await $.session.repo()
  if (!repo) {
    await update($, git, () => null)
    return
  }
  const dotGit = `${repo.root}/.git`
  const stat = await $.fs.stat(dotGit)
  const gitDir = stat.kind === 'dir' ? dotGit : gitDirFrom(repo.root, await $.fs.read(dotGit))
  const info = gitDir === null ? null : parseGitHead(await $.fs.read(`${gitDir}/HEAD`))
  await update($, git, () => info)
}

// Module-local caches: a reload starts them over, which costs one rebuild.
let turnsCache: Memo<Turn[]> | undefined
let searchCache: Memo<TurnMatch[]> | undefined
let thinkingCache: Memo<ReadonlyMap<string, readonly TurnThinking[]>> | undefined
let tasksCache: Memo<TaskEntry[]> | undefined

// The Messages API form, read once per transcript fingerprint: it holds the
// turn starts the rows lack and the thinking. An auxiliary read: a failure
// or a denial is not cached, and turns and thinking go without it.
let apiCache: Memo<readonly ApiLike[]> | undefined

async function apiForm($: EngineInterface, key: string): Promise<readonly ApiLike[] | undefined> {
  if (apiCache?.key === key) return apiCache.value
  const api: unknown = await $.session.messages({ as: 'api' }).catch(() => undefined)
  if (!Array.isArray(api)) return undefined
  apiCache = { key, value: api as ApiLike[] }
  return apiCache.value
}

// Thinking per turn from the Messages API form, read again only when the
// transcript's fingerprint moved.
async function turnThinking($: EngineInterface, key: string): Promise<ReadonlyMap<string, readonly TurnThinking[]>> {
  if (thinkingCache === undefined || thinkingCache.key !== key) {
    const api = await apiForm($, key)
    if (api === undefined) return new Map()
    thinkingCache = { key, value: thinkingByStart(api) }
  }
  return thinkingCache.value
}

// How many transcript reads a drawing of the pane finished, and how many of
// them the ticker had seen at its last look.
let drawnReads = 0
let tickSeenReads = 0

// The session's turns, rebuilt only when the transcript's fingerprint moved;
// a rebuild sanitizes only the rows that are new or changed.
// `isDrawing`: the pane's drawing reads it, which spares the next tick a read.
const sessionTurns = incrementalTurns()

async function currentTurns($: EngineInterface, isDrawing = false): Promise<Memo<Turn[]>> {
  const messages = await $.session.messages()
  const key = turnsKey(messages)
  if (turnsCache?.key !== key) {
    const api = await apiForm($, key)
    turnsCache = { key, value: sessionTurns.build(messages, '', api === undefined ? undefined : apiTurnStarts(api)) }
  }
  if (isDrawing) drawnReads += 1
  return turnsCache
}

// The turns for a tick's look: the pane's drawing reads the transcript after
// each tick, so when one finished since the last look, its turns serve; else
// the tick reads them itself. A read in flight is never shared: each look
// that reads gets rows as fresh as its own call.
async function tickTurns($: EngineInterface): Promise<Memo<Turn[]>> {
  const isFresh = turnsCache !== undefined && drawnReads !== tickSeenReads
  tickSeenReads = drawnReads
  return isFresh && turnsCache !== undefined ? turnsCache : currentTurns($)
}

// Traces by agentId. A finished agent's trace is final and never read again;
// a running one is read on each drawing but rebuilt only when it changed.
type CachedTrace = { key: string; trace: Trace; isFinal: boolean }
const traceCache = new Map<string, CachedTrace>()
const MAX_TRACES = 200
// The first level's traces and room as large for the nested ones opened.
const TRACE_CACHE_SIZE = 2 * MAX_TRACES

async function loadTrace($: EngineInterface, agentId: string, status: AgentStatus | undefined): Promise<Trace> {
  const cached = traceCache.get(agentId)
  if (cached?.isFinal && isAgentFinished(status)) return cached.trace
  const found = await $.session.messages({ agentId })
  if ('deny' in found) {
    const denied = { denied: sanitizeText(String(found.deny)) }
    // A finished agent's denial is final too: it is not asked again.
    remember(traceCache, agentId, { key: '', trace: denied, isFinal: isAgentFinished(status) }, TRACE_CACHE_SIZE)
    return denied
  }
  const key = turnsKey(found)
  const trace =
    cached?.key === key && 'items' in cached.trace ? cached.trace : { items: traceItems(found, `${agentId}/`) }
  remember(traceCache, agentId, { key, trace, isFinal: isAgentFinished(status) }, TRACE_CACHE_SIZE)
  return trace
}

// Loads the trace of every expanded subagent, nested ones included.
async function loadTraces(
  $: EngineInterface,
  items: readonly Item[],
  open: ReadonlySet<string>,
  agents: ReadonlyMap<string, AgentStatus>,
): Promise<Map<string, Trace>> {
  const traces = new Map<string, Trace>()
  // Open subagents, and finished ones too: a finished trace is read once (it
  // is final), so a collapsed row can count its failed calls.
  const subagents = items.filter(isSubagent)
  // Opened subagents first: the cap never cuts one the person opened.
  let frontier: Item[] = [
    ...subagents.filter(item => open.has(item.id)),
    ...subagents.filter(item => !open.has(item.id) && isAgentFinished(agents.get(item.agentId))),
  ].slice(0, MAX_TRACES)

  // One level at a time, its traces read together.
  while (frontier.length > 0) {
    const ids = [
      ...new Set(frontier.flatMap(item => (isSubagent(item) && !traces.has(item.agentId) ? [item.agentId] : []))),
    ]
    const loaded = await Promise.all(ids.map(id => loadTrace($, id, agents.get(id))))
    const next: Item[] = []
    ids.forEach((id, i) => {
      const trace = loaded[i]!
      traces.set(id, trace)
      if ('items' in trace) next.push(...trace.items.filter(child => isSubagent(child) && open.has(child.id)))
    })
    frontier = next
  }
  return traces
}

function visibleIds(items: readonly Item[], traces: ReadonlyMap<string, Trace>): string[] {
  // Level by level, the deepest first: expand all keeps the last
  // MAX_EXPANDED ids, so the top rows and the subagents stay open first.
  const levels: string[][] = []
  // A trace that names an agent already walked is not walked again.
  const seen = new Set<string>()
  let lists: (readonly Item[])[] = [items]
  while (lists.length > 0) {
    const ids: string[] = []
    const next: (readonly Item[])[] = []
    for (const list of lists)
      // A folded run counts as its own row, so expand all opens it too.
      for (const row of groupRuns(list)) {
        ids.push(row.id)
        if (row.kind === 'group') ids.push(...row.items.map(item => item.id))
        else if (isSubagent(row) && !seen.has(row.agentId)) {
          seen.add(row.agentId)
          const trace = traces.get(row.agentId)
          if (trace && 'items' in trace) next.push(trace.items)
        }
      }
    levels.push(ids)
    lists = next
  }
  return levels.reverse().flat()
}

// Background work started from a hook ends in `.catch(ignore)`: its failure
// (the session ended, a pane could not open) must not surface as an
// unhandled rejection.
const ignore = (): undefined => undefined

// Module-local: a reload starts these over, which only costs a missed frame.
let ticker: Timer | undefined
let frame = 0
let lastPrompt = ''
// Indexes (in buildTurns) of prompts submitted idle and not yet started; the
// next main-loop turn.start takes the oldest.
let pendingTurns: number[] = []
// turnId -> the index and prompt its turn got, from turn.start to its
// turn.complete; bounded in case a turn never completes.
const turnIndexes = new Map<string, { index: number; prompt: string }>()
const MAX_OPEN_TURNS = 50

// Agents a running Workflow started, as far as the hooks see them.
let workflowAgents: readonly string[] = []

async function trackWorkflow($: EngineInterface, tool: string, agentId: string | undefined): Promise<void> {
  if (agentId === undefined) {
    if (tool === 'Workflow') workflowAgents = []
    return
  }
  const agents = await $.agent.list()
  workflowAgents = noteWorkflowAgent(workflowAgents, agentId, new Set(agents.map(a => a.id)))
}

// Main-loop tool calls that have started and not ended, for the status line.
let runningTools: readonly RunningTool[] = []
// The status line and the spinner text as last set, so an unchanged text is
// not set again.
let lastStatus: string | undefined
let lastSpinner: string | null = null

// The /tail-status switch: on unless stored false.
async function isStatusOn($: EngineInterface): Promise<boolean> {
  return (await $.store.get(STATUS_KEY)) !== false
}

// The status line under the prompt (the engine draws it with a warning mark
// and the plugin's name): off until /tail-status on. The spinner text and
// the turn counts follow isStatusOn: on unless switched off.
const isStatusLineOn = (stored: unknown) => stored === true

// The switches and the icon set, read once per tick and passed on.
type Prefs = { isStatusOn: boolean; isStatusLineOn: boolean; isNotifyOn: boolean; icons: Icons }

async function loadPrefs($: EngineInterface): Promise<Prefs> {
  const [status, notify, icons] = await Promise.all([$.store.get(STATUS_KEY), $.store.get(NOTIFY_KEY), currentIcons($)])
  return { isStatusOn: status !== false, isStatusLineOn: isStatusLineOn(status), isNotifyOn: notify === true, icons }
}

// Sets the status line and the spinner text to what the running tools say
// now, each when it differs from what is showing; off in /tail-status, both
// are cleared instead. The spinner text is state its hook reads, so only the
// spinner is drawn again, not every row of the transcript.
async function syncStatus($: EngineInterface, given?: Prefs): Promise<void> {
  const prefs = given ?? (await loadPrefs($))
  const now = await $.clock.now()
  // Read after the awaits: the latest state wins whichever sync ends last.
  const text = prefs.isStatusLineOn ? statusText(runningTools, now, prefs.icons) : undefined
  const message = prefs.isStatusOn ? (spinnerMessage(runningTools, now, prefs.icons) ?? null) : null
  if (text !== lastStatus) {
    lastStatus = text
    $.ui.status(text)
  }
  if (message !== lastSpinner) {
    lastSpinner = message
    await update($, spinner, () => message)
  }
}

// Removes the status line and the spinner text at once, whatever the tools say.
async function clearStatus($: EngineInterface): Promise<void> {
  lastStatus = undefined
  $.ui.status(undefined)
  lastSpinner = null
  await update($, spinner, () => null)
}

// Agents' statuses at the last look, the ids already announced and the
// Workflow calls seen pending, for the finish toasts.
let agentStatuses: ReadonlyMap<string, AgentStatus> = new Map()
let notifiedAgents: readonly string[] = []
// Workflow calls already announced: a slower look that read an older
// transcript may track one again after it finished.
let notifiedWorkflows: readonly string[] = []
let trackedWorkflows: ReadonlySet<string> = new Set()
const MAX_TOAST_TEXT = 60

// Toasts a subagent or a Workflow that finished since the last look, when
// /tail-notify is on. The look is kept either way, so turning it on later
// announces only what finishes from then on. A Workflow counts as finished
// only when its own call got a result: an interrupt is not a finish.
// `tick`: what the ticker already read; its look takes the turns the pane
// last read when that is newer than its own last look.
type TickLook = { agents: readonly AgentInfo[]; prefs: Prefs; isWorking: boolean }

async function notifyFinished($: EngineInterface, tick?: TickLook): Promise<void> {
  const [agents, turns, working, prefs] =
    tick === undefined
      ? await Promise.all([$.agent.list(), currentTurns($), read($, isWorking), loadPrefs($)])
      : [tick.agents, await tickTurns($), tick.isWorking, tick.prefs]
  const latestTurn = turns.value.at(-1)

  // Nothing is awaited from here: concurrent looks cannot both see a change.
  const snapshot = agents.map(a => ({ id: a.id, status: a.status, description: a.description }))
  const finished = finishedSince(agentStatuses, snapshot).filter(
    a => !notifiedAgents.includes(a.id) && !workflowAgents.includes(a.id),
  )
  agentStatuses = new Map(snapshot.map(a => [a.id, a.status]))
  const workflows = finishedWorkflows(trackedWorkflows, latestTurn, working)
  trackedWorkflows = workflows.tracked
  const doneWorkflows = workflows.finished.filter(id => !notifiedWorkflows.includes(id))
  for (const id of doneWorkflows) notifiedWorkflows = noteNotified(notifiedWorkflows, id)
  if (!prefs.isNotifyOn) return

  for (const agent of finished) {
    notifiedAgents = noteNotified(notifiedAgents, agent.id)
    const text = truncate(sanitizeText(agent.description).trim(), MAX_TOAST_TEXT, prefs.icons.ellipsis)
    $.ui.toast(`Subagent finished: ${text}`)
  }
  if (doneWorkflows.length > 0) $.ui.toast('Workflow finished')
}

// What each finished turn's "Baked for 3s" line gets appended, by its stat:
// a finished turn's counts do not change, so the transcript is read once per
// turn rather than once per line drawn.
const durationTails = new Map<string, string>()

async function durationTail($: EngineInterface, durationMs: number, dot: string): Promise<string> {
  const stats = await read($, turnStats)
  const stat = statOfDuration(stats, durationMs)
  if (stat === undefined) return ''
  const key = `${stat.endedAt}|${stat.turnIndex}|${durationMs}|${dot}`
  const cached = durationTails.get(key)
  if (cached !== undefined) return cached
  const turns = await currentTurns($)
  const turn = turnOfStat(stat, turns.value)
  if (turn === undefined) return ''
  const tail = durationSuffix(turn, dot)
  remember(durationTails, key, tail, MAX_STATS)
  return tail
}

// The index of the last main-loop turn that completed with a known index.
let lastDoneIndex = -1

// Queues the index the submitted prompt's turn will get; undefined when the
// transcript could not be read (the turn then falls back at turn.start).
async function notePrompt($: EngineInterface): Promise<number | undefined> {
  try {
    const index = (await currentTurns($)).value.length
    // A new prompt always lands after the last completed turn; if not, the
    // transcript restarted (a cleared or another session) and the old state is moot.
    if (index <= lastDoneIndex) {
      lastDoneIndex = -1
      pendingTurns = []
    }
    pendingTurns = enqueueTurn(pendingTurns, index)
    return index
  } catch {
    return undefined
  }
}

// The index notes of the turns that started, until their turn.complete.
const startNotes = new Map<string, Promise<void>>()

async function noteTurnStart($: EngineInterface, turnId: string, text: string): Promise<void> {
  try {
    const turns = (await currentTurns($)).value
    const prompt = sanitizePrompt(sanitizeText(text).trim())
    const queue = discardStale(pendingTurns, lastDoneIndex)
    const taken = takeTurnIndex(queue, turnIndexAtStart(turns, prompt))
    pendingTurns = taken.queue
    remember(turnIndexes, turnId, { index: taken.index, prompt }, MAX_OPEN_TURNS)
  } catch {
    // No index: the stat matches by prompt.
  }
}

// A dropped or failed submit: no turn.start (nor turn.complete) follows, so
// its index must not stay queued and the session is as busy as before.
async function undoSubmit($: EngineInterface, pushed: number | undefined, wasWorking: boolean): Promise<void> {
  if (pushed !== undefined) pendingTurns = dropPending(pendingTurns, pushed)
  await update($, isWorking, () => wasWorking)
  await clearStatus($)
}

function stopTicker() {
  ticker?.cancel()
  ticker = undefined
}

async function onTick($: EngineInterface): Promise<void> {
  frame += 1
  const [working, agents, prefs] = await Promise.all([read($, isWorking), $.agent.list(), loadPrefs($)])
  if (!working && !agents.some(a => isAgentRunning(a.status))) stopTicker()
  await Promise.all([syncStatus($, prefs), notifyFinished($, { agents, prefs, isWorking: working })])
  await bump($)
}

// Redraws twice a second while anything runs: spinners and elapsed times.
function startTicker($: EngineInterface) {
  if (ticker) return
  ticker = $.clock.every(TICK_MS, () => onTick($).catch(ignore))
}

async function runCommand($: EngineInterface, e: CommandRunInput): Promise<CommandRunResult> {
  const parsed = parseCommand(e.command, e.args) ?? { sub: 'open', arg: '' }
  switch (parsed.sub) {
    case 'bar': {
      const hidden = await update($, isBarHidden, wasHidden => !wasHidden)
      return { text: hidden ? 'Info bar hidden.' : 'Info bar shown.' }
    }
    case 'compact':
      return { text: await toggleCompact($) }
    case 'icons':
      return { text: await setIcons($, parsed.arg) }
    case 'width':
      return { text: await setWidth($, parsed.arg, e.presentation.columns) }
    case 'status':
      return { text: await setStatus($, parsed.arg) }
    case 'notify':
      return {
        text: await setSwitch(
          $,
          { command: 'tail-notify', key: NOTIFY_KEY, label: 'Notifications', fallback: false },
          parsed.arg,
        ),
      }
    case 'help':
      return { text: helpText(await currentIcons($)) }
    case 'unknown':
      return { text: unknownText(parsed.arg) }
    case 'turns': {
      const surfaces = await $.session.surfaces()
      if (isTextOnly(surfaces)) return { text: await turnsReport($, true) }
      await showView($, 'turns')
      await openPane($, true, e.presentation.columns)
      claimFocus($).catch(ignore)
      return { text: 'Turn list opened: Enter or click a turn to see it in detail.' }
    }
    case 'open': {
      const surfaces = await $.session.surfaces()
      if (isTextOnly(surfaces)) return { text: await turnsReport($, false) }
      await seedSearch($)
      await openPane($, true, e.presentation.columns)
      claimFocus($).catch(ignore)
      return { text: 'Detail view opened. /tail-help lists the commands and keys.' }
    }
  }
}

// The pane's content as text, for VS Code and `claude -p`: the latest turn
// in detail, or the list of turns.
async function turnsReport($: EngineInterface, isList: boolean): Promise<string> {
  const turns = (await currentTurns($)).value
  const stats = await read($, turnStats)
  if (isList)
    return turnListText(
      turns,
      turns.map(t => statFor(stats, t, turns)),
    )
  const turn = turns.at(-1)
  return turnText(turn, statFor(stats, turn, turns))
}

// Copies a whole block (not its preview) and says how it went; called with
// `$` whole, as the directory's validator wants.
async function copyBlock($: EngineInterface, text: string, surface?: RenderSurface): Promise<void> {
  const copied = await $.ui.copy(surface === undefined ? { text } : { text, surface })
  $.ui.toast(copied.isCopied ? 'Copied' : `Not copied: ${copied.reason}`)
}

// The rows the detail view drew last, by the key the engine's focus ring
// names them: a Tab or a click that moves the ring onto one moves the row
// cursor there, and the cursor moves the ring, so Enter presses the row
// under the cursor.
let drawnRowIds: ReadonlySet<string> = new Set()

// Whether the ring is in the search field, and whether the pane held the
// keys at its last drawing. The engine's Esc in a field hands the whole
// pane's keyboard back to the prompt, which the plugin cannot catch: the
// drawing that sees the keys go while the field held them takes them back
// once, so Esc leaves the field and a second Esc leaves the pane.
let isRingOnSearch = false
let wasFocused = false

function keepKeysAfterSearchEsc($: EngineInterface, isFocused: boolean | undefined): void {
  if (wasFocused && isFocused === false && isRingOnSearch) {
    isRingOnSearch = false
    openPane($, true).catch(ignore)
  }
  wasFocused = isFocused === true
}

// Moves the engine's focus ring onto the element `key`; a row drawn as Text
// cannot take it, and the cursor stays its own mark.
async function ringTo($: EngineInterface, key: string | null): Promise<void> {
  if (key === null) return
  isRingOnSearch = false
  await $.ui.focus({ requestId: PANE, key }).catch(ignore)
}

// Moves the keyboard cursor one row along `ids`, and the focus ring with it.
// The detail view's content scrolls so the row the cursor lands on stays in
// the window (`at`: the window as drawn).
async function moveRowCursor(
  $: EngineInterface,
  ids: readonly string[],
  delta: number,
  at: ScrollFrame,
): Promise<void> {
  const landed = await update($, cursor, cur => stepCursor(ids, cur, delta, at))
  await update($, paneScroll, all => ({ ...all, detail: scrollToRow(at, landed) }))
  await ringTo($, landed)
}

// Moves the turn list's cursor one turn along the rows the list draws (newest
// first), as the detail cursor moves: it enters inside the window, stops at
// the ends, and the list scrolls to keep its row in view.
async function moveTurnCursor($: EngineInterface, delta: number, at: ScrollFrame): Promise<void> {
  const ids = Object.keys(at.starts).filter(id => id.startsWith('turn:'))
  const landed = await update($, turnCursor, cur => {
    const id = stepCursor(ids, cur === null ? null : turnRowId(cur), delta, at)
    return id === null ? null : Number(id.slice('turn:'.length))
  })
  await update($, paneScroll, all => ({ ...all, turns: scrollToRow(at, landed === null ? null : turnRowId(landed)) }))
  await ringTo($, landed === null ? null : `turn-${landed}`)
}

// Where each view's window stood at its last drawing; a reload starts over
// and the next drawing clamps whatever the wheel did meanwhile. Module-level
// and keyed by view only: the plugin draws one pane (PANE) per session.
const drawnFrames: Partial<Record<'detail' | 'turns' | 'team', ScrollFrame>> = {}

// The engine's wheel and page keys over the pane: the pane is as tall as its
// window, so the engine has nothing to move. The shown view's own scroll moves
// instead (engineScroll: a wheel step, a page, the top or the end), clamped
// like f and b, and the engine's window stays (no `next`); the state change
// draws the pane again.
async function scrollPane($: EngineInterface, move: EngineScroll): Promise<UiScrollResult> {
  const view = await read($, paneView)
  const frame = drawnFrames[view]
  await update($, paneScroll, all => ({
    ...all,
    [view]: frame === undefined ? Math.max(0, all[view] + move.by) : engineScroll(all[view], move, frame),
  }))
  return {}
}

// The turn the detail view's scroll belongs to, by its index and prompt, as
// last drawn: the scroll starts over when the shown turn changes for any
// reason, a new latest turn no prompt of this session started included.
let scrolledTurn: string | undefined

// The detail scroll for drawing `turnKey`: kept for the same turn, back to
// the top (and stored so) for another one. `stored`: the detail scroll as
// the drawing read it.
async function detailScroll($: EngineInterface, turnKey: string, stored: number): Promise<number> {
  const isOtherTurn = scrolledTurn !== undefined && scrolledTurn !== turnKey
  scrolledTurn = turnKey
  if (!isOtherTurn || stored === 0) return stored
  await update($, paneScroll, all => ({ ...all, detail: 0 }))
  return 0
}

// Every view's content back to the top: the shown turn or the view changed.
async function scrollToTop($: EngineInterface): Promise<void> {
  await update($, paneScroll, () => TOP)
}

// Switches what the pane shows, from the top of its content.
async function showView($: EngineInterface, view: 'detail' | 'turns' | 'team'): Promise<void> {
  // A view change leaves the search field (focusSearch marks it again).
  isRingOnSearch = false
  await update($, turnCursor, () => null)
  await seedSearch($)
  await update($, paneView, () => view)
  await scrollToTop($)
}

// Shows one turn in the detail view; the latest one follows new turns.
async function pickTurn($: EngineInterface, index: number, latest: number) {
  await update($, cursor, () => null)
  await update($, selectedTurn, () => (index >= latest ? null : index))
  await showView($, 'detail')
}

// The search key: opens the turn list and puts the cursor in its field.
async function focusSearch($: EngineInterface): Promise<void> {
  await showView($, 'turns')
  const { gen } = await read($, searchField)
  await $.ui.focus({ requestId: PANE, key: searchFieldKey(gen) })
  // The plugin's own $.ui.focus raises no ui.focus hook here: mark it.
  isRingOnSearch = true
}

// A search field drawn anew (another view, the pane opened) starts from the
// query; while it is drawn only typing changes it (searchField).
async function seedSearch($: EngineInterface): Promise<void> {
  const query = await read($, searchQuery)
  await update($, searchField, field => (field.seed === query ? field : { ...field, seed: query }))
}

// The clear button: no query, and a new, empty field under a new key.
async function clearSearch($: EngineInterface): Promise<void> {
  await update($, turnCursor, () => null)
  await update($, searchQuery, () => '')
  await update($, searchField, field => ({ gen: field.gen + 1, seed: '' }))
}

// Enter in the search field: keeps the query and opens the newest match,
// the first one the list shows. searchTurns reuses the lowercased turns the
// list's search left behind.
async function openMatch($: EngineInterface, value: string, turns: readonly Turn[]): Promise<void> {
  await update($, searchQuery, () => value)
  const newest = searchTurns(turns, value).at(-1)
  if (newest) await pickTurn($, newest.index, turns.length - 1)
}

// Persisted preferences ($.store, across sessions).
const WIDTH_KEY = 'paneWidth'
const COMPACT_KEY = 'isCompact'
const ICONS_KEY = 'tail-view.icons'
const STATUS_KEY = 'tail-view.status'
const NOTIFY_KEY = 'tail-view.notify'
const DEFAULT_ICONS: IconSetName = 'nerd'
const DEFAULT_WIDTH = 80
const MIN_WIDTH = 30
const MAX_WIDTH = 80

async function widthShare($: EngineInterface): Promise<number> {
  const stored = await $.store.get(WIDTH_KEY)
  return typeof stored === 'number' && stored >= MIN_WIDTH && stored <= MAX_WIDTH ? stored : DEFAULT_WIDTH
}

async function iconSetName($: EngineInterface): Promise<IconSetName> {
  const stored = await $.store.get(ICONS_KEY)
  return isIconSetName(stored) ? stored : DEFAULT_ICONS
}

async function currentIcons($: EngineInterface): Promise<Icons> {
  return ICON_SETS[await iconSetName($)]
}

async function isCompact($: EngineInterface): Promise<boolean> {
  return (await $.store.get(COMPACT_KEY)) !== false
}

// The terminal's height as the last drawing reported it: a command knows
// only the width.
let terminalRows: number | undefined

function noteViewport(viewport: { rows: number } | undefined) {
  if (viewport !== undefined && viewport.rows > 0) terminalRows = viewport.rows
}

// Whether the pane has been asked for its share of a known terminal width.
let isAutoSized = false

// Opens (or re-opens) the pane, asking for its share of `terminalColumns`
// when known (docked), and for rows by the terminal's height (inline, below
// 110 columns or on the main screen: left out, the engine gives a third);
// a size the person dragged the pane to still wins.
// No `closeOnEscape`: Esc (in the search field too) only hands the keys back
// to the prompt and the pane stays open.
async function openPane($: EngineInterface, focus: boolean, terminalColumns?: number) {
  const share = await widthShare($)
  const columns = terminalColumns === undefined ? undefined : paneColumns(terminalColumns, share)
  if (columns !== undefined) isAutoSized = true
  return $.ui.open({
    id: PANE,
    title: 'tail',
    ...(focus ? { focus: true as const } : {}),
    ...(columns === undefined ? {} : { columns }),
    ...(terminalRows === undefined ? {} : { rows: paneRows(terminalRows) }),
  })
}

// The engine grants a pane the keyboard only over an empty composer, and
// while a command runs the composer still holds it: once the command is
// done, ask again a few times until the pane has the keys. Text the person
// types meanwhile makes the engine refuse, so nothing is taken from them.
const FOCUS_TRIES = 5
const FOCUS_RETRY_MS = 100

async function claimFocus($: EngineInterface): Promise<void> {
  for (let i = 0; i < FOCUS_TRIES; i++) {
    await $.clock.sleep(FOCUS_RETRY_MS)
    const pane = (await $.ui.panes()).find(p => p.id === PANE)
    if (pane === undefined || !pane.isPlaced || pane.isFocused) return
    await openPane($, true)
  }
}

// The pane opened at session start before any width was known: size it
// once to the saved share from its first drawing, which comes once the
// surface places it (unasked, it may wait for a wider terminal).
async function autoSize($: EngineInterface, terminalColumns: number) {
  if (isAutoSized) return
  isAutoSized = true
  await openPane($, false, terminalColumns)
}

// The pane's width as the engine drew it last (the Pane render's bodyColumns).
let drawnColumns: number | undefined

async function setWidth($: EngineInterface, arg: string, terminalColumns: number): Promise<string> {
  // Alone: what is stored, what that asks for, and what was drawn.
  if (arg.trim() === '') {
    const stored = await widthShare($)
    const asked = paneColumns(terminalColumns, stored)
    const drawn = drawnColumns === undefined ? '' : `, drawn ${drawnColumns}`
    // A terminal too narrow to dock a pane asks for no columns.
    if (asked === undefined) return `Pane width ${stored}% of the terminal (too narrow to dock it now${drawn}).`
    const override =
      drawnColumns !== undefined && Math.abs(drawnColumns - asked) > 2
        ? ' A width you dragged the dock to wins over it; /tail width N asks again.'
        : ''
    return `Pane width ${stored}% of the terminal: ${asked} columns${drawn}.${override}`
  }
  const share = Number(arg)
  if (!Number.isInteger(share) || share < MIN_WIDTH || share > MAX_WIDTH) {
    return `Give the pane width as a share of the terminal between ${MIN_WIDTH} and ${MAX_WIDTH} (percent), e.g. /tail width 60.`
  }
  await $.store.set(WIDTH_KEY, share)
  const pane = (await $.ui.panes()).find(p => p.id === PANE)
  if (pane?.isPlaced) await openPane($, false, terminalColumns)
  return `Pane width set to ${share}% of the terminal (a width you drag the dock to still wins).`
}

// /tail-icons: names the current set, or stores another and redraws.
async function setIcons($: EngineInterface, rawArg: string): Promise<string> {
  const arg = rawArg.toLowerCase()
  const options = ICON_SET_NAMES.join('|')
  if (arg === '') return `Icon set: ${await iconSetName($)}. Change it with /tail-icons ${options}.`
  if (!isIconSetName(arg)) return `Unknown icon set. Use /tail-icons ${options}.`
  await $.store.set(ICONS_KEY, arg)
  $.ui.invalidate('ui.render')
  await syncStatus($)
  await bump($)
  return `Icon set: ${arg}.`
}

// /tail-status and /tail-notify: names the setting, or stores on/off.
// `fallback` is the state until one is stored.
async function setSwitch(
  $: EngineInterface,
  setting: { command: string; key: string; label: string; fallback: boolean },
  rawArg: string,
): Promise<string> {
  const arg = rawArg.toLowerCase()
  const stored = await $.store.get(setting.key)
  const isOn = typeof stored === 'boolean' ? stored : setting.fallback
  if (arg === '') return `${setting.label}: ${isOn ? 'on' : 'off'}. Change it with /${setting.command} on|off.`
  if (arg !== 'on' && arg !== 'off') return `Unknown value. Use /${setting.command} on|off.`
  await $.store.set(setting.key, arg === 'on')
  return `${setting.label}: ${arg}.`
}

// /tail-status: also redraws the transcript once when the switch moved, so
// the turn duration lines already drawn take or drop their counts.
async function setStatus($: EngineInterface, arg: string): Promise<string> {
  const wasOn = await isStatusOn($)
  const stored = await $.store.get(STATUS_KEY)
  // Nothing stored: the line is off, the spinner text and counts are on.
  if (arg.trim() === '' && typeof stored !== 'boolean')
    return 'Status line: off, spinner text and turn counts: on. /tail-status on shows the line too, off hides all three.'
  const text = await setSwitch(
    $,
    { command: 'tail-status', key: STATUS_KEY, label: 'Status line, spinner text and turn counts', fallback: true },
    arg,
  )
  if ((await isStatusOn($)) !== wasOn) $.ui.invalidate('ui.render')
  await syncStatus($)
  return text
}

async function toggleCompact($: EngineInterface): Promise<string> {
  const next = !(await isCompact($))
  await $.store.set(COMPACT_KEY, next)
  $.ui.invalidate('ui.render')
  return next
    ? 'Compact transcript on: tool results are one line, details in /tail.'
    : 'Compact transcript off: tool results are drawn in full.'
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    // The commands only steer the pane, never the turn: they run at once,
    // even while Claude is answering, instead of queueing like a prompt.
    for (const spec of COMMANDS) {
      await $.command.register({
        name: spec.name,
        description: spec.description,
        ...(spec.argumentHint ? { argumentHint: spec.argumentHint } : {}),
        immediate: true,
      })
    }
    refreshGit($).catch(ignore)
    openPane($, false).catch(ignore)
    return started
  })

  // One registration per command, so the hook never sees anyone else's.
  on('command.run', { command: 'tail' }, ($, e) => runCommand($, e))
  on('command.run', { command: 'tail-turns' }, ($, e) => runCommand($, e))
  on('command.run', { command: 'tail-width' }, ($, e) => runCommand($, e))
  on('command.run', { command: 'tail-compact' }, ($, e) => runCommand($, e))
  on('command.run', { command: 'tail-icons' }, ($, e) => runCommand($, e))
  on('command.run', { command: 'tail-status' }, ($, e) => runCommand($, e))
  on('command.run', { command: 'tail-notify' }, ($, e) => runCommand($, e))
  on('command.run', { command: 'tail-bar' }, ($, e) => runCommand($, e))
  on('command.run', { command: 'tail-help' }, ($, e) => runCommand($, e))

  on('classic.UserPromptSubmit', async ($, e, next) => {
    if (e.permission_mode) await update($, mode, () => e.permission_mode ?? null)
    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    // In the form a turn's prompt takes, so the fallback stat finds its turn.
    lastPrompt = sanitizePrompt(sanitizeText(e.text).trim())
    const pushed = e.turnId === undefined ? await notePrompt($) : undefined
    const wasWorking = await read($, isWorking)
    await update($, isWorking, () => true)
    await update($, selectedTurn, () => null)
    await update($, cursor, () => null)
    await scrollToTop($)
    startTicker($)
    let result
    try {
      result = await next(e)
    } catch (err) {
      await undoSubmit($, pushed, wasWorking)
      throw err
    }
    if (result.drop !== undefined) await undoSubmit($, pushed, wasWorking)
    return result
  })

  // Observe only: the turn's index is noted before it starts unchanged.
  // The turn's index is noted in the background: reading the transcript (and
  // its API form) must not hold the turn up; turn.complete waits for it.
  on('turn.start', async ($, e, next) => {
    remember(startNotes, e.turnId, noteTurnStart($, e.turnId, e.text), MAX_OPEN_TURNS)
    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    const id = e.tool_use_id
    const start = await $.clock.now()
    trackWorkflow($, e.tool, e.agentId).catch(ignore)
    // The pane reads the timings: their change alone draws it again. The
    // info bar draws no timing; the ticker started here redraws it.
    await update($, timings, all => recordToolStart(all, id, start))
    startTicker($)
    const isMain = e.agentId === undefined
    if (isMain) {
      runningTools = [...runningTools, runningTool(id, e.tool, callInput(e), start)]
      syncStatus($).catch(ignore)
    }

    try {
      return await next(e)
    } finally {
      const end = await $.clock.now()
      await update($, timings, all => recordToolEnd(all, id, end, start))
      if (isMain) {
        runningTools = runningTools.filter(r => r.id !== id)
        syncStatus($).catch(ignore)
      }
    }
  })

  on('turn.complete', async ($, e, next) => {
    const endedAt = await $.clock.now()

    if (e.agentId !== undefined) {
      const agentId = e.agentId
      const stat: AgentStat = { model: e.usage?.model, durationMs: e.durationMs }
      await update($, agentStats, all => ({ ...all, [agentId]: stat }))
      trackWorkflow($, '', agentId).catch(ignore)
    } else {
      await startNotes.get(e.turnId)
      startNotes.delete(e.turnId)
      const opened = turnIndexes.get(e.turnId)
      turnIndexes.delete(e.turnId)
      if (opened !== undefined) lastDoneIndex = Math.max(lastDoneIndex, opened.index)
      // The prompt its turn.start carried; a continuation's is empty.
      const prompt = opened?.prompt || lastPrompt
      const stat = turnStatFrom(e, prompt, endedAt, opened?.index)
      await update($, turnStats, all => [...all, stat].slice(-MAX_STATS))
      await update($, isWorking, () => false)
      runningTools = []
      await clearStatus($)
      refreshGit($).catch(ignore)
    }
    notifyFinished($).catch(ignore)
    await bump($)
    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    keepKeysAfterSearchEsc($, e.props.isFocused)
    // Only a docked pane's width answers to /tail-width; inline it is the screen's.
    drawnColumns = e.props.placement === 'dock' ? e.props.bodyColumns : undefined
    noteViewport(e.viewport)
    const viewport = e.viewport
    if (viewport !== undefined)
      autoSize($, terminalWidth(viewport.columns, e.props.placement, e.props.bodyColumns)).catch(ignore)
    const el = $.ui.resolve(e) as unknown as El

    // Each read is a round trip to the engine: the independent ones go
    // together, then those that need the turn, the view or the agents.
    const [
      ,
      turnsMemo,
      chosen,
      openIds,
      agentList,
      usage,
      allStats,
      view,
      scrolled,
      query,
      icons,
      stored,
      timed,
      sessionModel,
      working,
      now,
      agentStatsNow,
      fullIds,
      isBarOff,
      field,
      isFooterOpen,
    ] = await Promise.all([
      read($, tick),
      currentTurns($, true),
      read($, selectedTurn),
      read($, expanded),
      $.agent.list(),
      $.session.usage(),
      read($, turnStats),
      read($, paneView),
      read($, paneScroll),
      read($, searchQuery),
      currentIcons($),
      read($, cursor),
      read($, timings),
      $.session.model(),
      read($, isWorking),
      $.clock.now(),
      read($, agentStats),
      read($, fullBlocks),
      read($, isBarHidden),
      read($, searchField),
      read($, footerOpen),
    ])
    const turns = turnsMemo.value
    const latest = turns.length - 1
    const selected = chosen === null || chosen > latest ? latest : chosen
    const turn = turns[selected]
    const open = new Set(openIds)
    const agents = new Map(agentList.map(a => [a.id, a.status] as const))
    const turnKey = turn === undefined ? '' : `${turn.index}\u0000${turn.prompt}`
    // The turn list's cursor is read only where it is drawn: a read
    // subscribes the drawing, and the detail view need not follow it.
    const [traces, detailTop, thinkingByTurn, turnCursorAt] = await Promise.all([
      loadTraces($, turn?.items ?? [], open, agents),
      detailScroll($, turnKey, scrolled.detail),
      view === 'detail' && turn ? turnThinking($, turnsMemo.key) : new Map<string, readonly TurnThinking[]>(),
      view === 'turns' ? read($, turnCursor) : null,
    ])

    const step = async (delta: number | null) => {
      await update($, cursor, () => null)
      await update($, selectedTurn, cur => nextSelectedTurn(cur, latest, delta))
      await scrollToTop($)
    }
    const isSearching = view === 'turns' && query.trim() !== ''
    if (isSearching)
      searchCache = memo(searchCache, `${turnsMemo.key}\n${icons.ellipsis}\n${query}`, () =>
        searchTurns(turns, query, icons.ellipsis),
      )

    // Keyed to the turn that holds the reply, not paired by place.
    const thinking = thinkingOf(turns, turn, thinkingByTurn)
    tasksCache = memo(tasksCache, turnsMemo.key, () => taskBoard(turns))
    const tasks = tasksCache.value

    const childrenOf = (agentId: string) => {
      const trace = traces.get(agentId)
      return trace && 'items' in trace ? trace.items : undefined
    }
    const rowIds = cursorRows(turn?.items ?? [], open, childrenOf)
    if (view === 'detail') drawnRowIds = new Set(rowIds)
    const cursorId = stored !== null && rowIds.includes(stored) ? stored : null
    const cursorText = cursorId === null ? undefined : rowText(turn?.items ?? [], cursorId, childrenOf, icons)

    const thinkingIds = turn && thinking && thinking.text !== '' ? [`t${turn.index}:thinking`] : []
    // Whether e has nothing left to open: every row it would expand already is.
    const openable = [...visibleIds(turn?.items ?? [], traces), ...thinkingIds]
    const isAllExpanded = openable.length > 0 && openable.slice(-MAX_EXPANDED).every(id => open.has(id))

    return renderPane(
      el,
      {
        turns,
        selected: Math.max(0, selected),
        expanded: open,
        timings: timed,
        turnStat: statFor(allStats, turn, turns),
        sessionModel,
        contextPercent: usage.context.percent,
        isLatest: selected === latest,
        thinking,
        isWorking: working,
        icons,
        now,
        frame,
        agents,
        agentStats: agentStatsNow,
        traces,
        cursor: cursorId,
        isFocused: e.props.isFocused,
        isBarShown: !isBarOff,
        isFooterOpen,
        isAllExpanded,
        turnCursor: turnCursorAt,
        columns: e.props.bodyColumns,
        rows:
          e.props.placement === 'inline'
            ? inlineRows(e.props.scroll.bodyRows, paneRows(terminalRows ?? 0))
            : e.props.scroll.bodyRows,
        placement: e.props.placement,
        scrollTop: view === 'detail' ? detailTop : scrolled[view],
        full: new Set(fullIds),
        view,
        query,
        searchField: field,
        matches: isSearching ? searchCache?.value : undefined,
        stats: turns.map(t => statFor(allStats, t, turns)),
        members: teamMembers(agentList),
        tasks,
      },
      {
        toggle: id => update($, expanded, ids => toggleId(ids, id, MAX_EXPANDED)).catch(ignore),
        toggleKeys: () => update($, footerOpen, open => !open).catch(ignore),
        prev: () => step(-1).catch(ignore),
        next: () => step(1).catch(ignore),
        latest: () => step(null).catch(ignore),
        expandAll: () =>
          // This turn's rows go last, so the trim drops earlier expansions
          // first, never a row this turn opens.
          update($, expanded, ids => {
            const fresh = new Set(openable)
            return [...ids.filter(id => !fresh.has(id)), ...openable].slice(-MAX_EXPANDED)
          }).catch(ignore),
        collapseAll: () => {
          update($, expanded, () => []).catch(ignore)
          update($, fullBlocks, () => []).catch(ignore)
        },
        showTurns: () => showView($, 'turns').catch(ignore),
        showDetail: () => showView($, 'detail').catch(ignore),
        showTeam: () => showView($, 'team').catch(ignore),
        pickTurn: index => pickTurn($, index, latest).catch(ignore),
        search: value => {
          update($, turnCursor, () => null).catch(ignore)
          update($, searchQuery, () => value).catch(ignore)
        },
        clearSearch: () => clearSearch($).catch(ignore),
        submitSearch: value => openMatch($, value, turns).catch(ignore),
        focusSearch: () => focusSearch($).catch(ignore),
        copy: (text, surface) => copyBlock($, text, surface).catch(ignore),
        cursorDown: at => (view === 'turns' ? moveTurnCursor($, 1, at) : moveRowCursor($, rowIds, 1, at)).catch(ignore),
        cursorUp: at => (view === 'turns' ? moveTurnCursor($, -1, at) : moveRowCursor($, rowIds, -1, at)).catch(ignore),
        scroll: top => update($, paneScroll, all => ({ ...all, [view]: top })).catch(ignore),
        measure: at => {
          drawnFrames[view] = at
        },
        cursorOpen: () =>
          view === 'turns'
            ? read($, turnCursor)
                .then(index => (index === null ? undefined : pickTurn($, index, latest)))
                .catch(ignore)
            : cursorId === null || cursorText === undefined || cursorText === ''
              ? undefined
              : update($, expanded, ids => toggleId(ids, cursorId, MAX_EXPANDED)).catch(ignore),
        copyCursor: surface => (cursorText === undefined ? undefined : copyBlock($, cursorText, surface).catch(ignore)),
        toggleFull: id => update($, fullBlocks, ids => toggleId(ids, id, MAX_EXPANDED)).catch(ignore),
      },
    )
  })

  // The ring moved by a Tab or a click onto a row takes the row cursor along.
  on('ui.focus', { requestId: PANE }, async ($, e, next) => {
    const element = e.element
    isRingOnSearch = element !== undefined && element.startsWith('turn-search')
    if (element !== undefined && drawnRowIds.has(element))
      await update($, cursor, cur => (cur === element ? cur : element)).catch(ignore)
    else if (element !== undefined && /^turn-\d+$/.test(element))
      await update($, turnCursor, () => Number(element.slice('turn-'.length))).catch(ignore)
    return next(e)
  })

  on('ui.scroll', { requestId: PANE }, ($, e) => scrollPane($, e))

  // The transcript stays a conversation; tool detail lives in the pane.
  on('ui.render', { component: 'ToolResult' }, async ($, e, next) => {
    if (!(await isCompact($))) return next(e)
    const { Text } = $.ui.resolve(e) as unknown as El
    const line = resultLine(e.props.output, e.props.isErrored)
    const icons = await currentIcons($)
    return (
      <Text color={e.props.isErrored ? C.error : undefined} dimColor={!e.props.isErrored}>
        {`${icons.result} ${line}`}
      </Text>
    )
  })

  on('ui.render', { component: 'ToolUse' }, async ($, e, next) => {
    if (!(await isCompact($))) return next(e)
    const { Box, Text } = $.ui.resolve(e) as unknown as El
    const icons = await currentIcons($)
    const { name, summary } = compactCall(e.props.tool, e.props.input, icons.ellipsis)
    const mark = e.props.isInterrupted
      ? C.interrupted
      : e.props.isErrored
        ? C.error
        : e.props.isRunning
          ? C.ongoing
          : undefined
    return (
      // The bullet, the name and the note never shrink; the summary gives way,
      // cut at the edge (the ascii set without its Unicode ellipsis).
      <Box flexDirection="row">
        <Box flexShrink={0}>
          <Text color={mark} dimColor={mark === undefined}>
            {`${icons.bullet} `}
          </Text>
        </Box>
        <Box flexShrink={0}>
          <Text bold>{name}</Text>
        </Box>
        <Box flexShrink={1}>
          <Text dimColor wrap={icons === ICON_SETS.ascii ? 'truncate' : 'truncate-end'}>
            {summary ? `  ${summary}` : ''}
          </Text>
        </Box>
        {e.props.isInterrupted && (
          <Box flexShrink={0}>
            <Text color={C.interrupted}>{` ${icons.dot} interrupted`}</Text>
          </Box>
        )}
      </Box>
    )
  })

  on('ui.render', { component: 'ToolGroup' }, async ($, e, next) => {
    if (!e.props.isExpanded || !(await isCompact($))) return next(e)
    return next({ ...e, props: { ...e.props, isExpanded: false } })
  })

  // While a main-loop tool runs the spinner names it, as the status line
  // does; /tail-status off leaves the engine's own text. syncStatus keeps the
  // text in state, so a change redraws the spinner alone.
  on('ui.render', { component: 'Spinner' }, async ($, e, next) => {
    const message = await read($, spinner)
    if (message === null) return next(e)
    // An empty suffix: the engine's own would add a Unicode ellipsis to the text.
    return next({ ...e, props: { ...e.props, message, suffix: '' } })
  })

  // The engine's "Baked for 3s" line plus the counts of the turn it closes,
  // found by its duration. The line has no text prop to append to, so it is
  // drawn whole in its place; a line whose turn is not known stays the engine's.
  on('ui.render', { component: 'TurnDuration' }, async ($, e, next) => {
    if (!(await isStatusOn($))) return next(e)
    const icons = await currentIcons($)
    const tail = await durationTail($, e.props.durationMs, icons.dot)
    if (tail === '') return next(e)
    const { Text } = $.ui.resolve(e) as unknown as El
    return (
      <Text color={C.muted}>{`${sanitizeText(e.props.word)} for ${engineDuration(e.props.durationMs)}${tail}`}</Text>
    )
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    noteViewport(e.viewport)
    if (e.props.hasSurvey || (await read($, isBarHidden))) return next(e)

    const el = $.ui.resolve(e) as unknown as El
    const [, usage, agents, working, root, branch, permissionMode, icons] = await Promise.all([
      read($, tick),
      $.session.usage(),
      $.agent.list(),
      read($, isWorking),
      $.session.root(),
      read($, git),
      read($, mode),
      currentIcons($),
    ])
    // Only a running Workflow needs the latest turn, so only while working;
    // the turns the pane or the ticker read last are at most a tick old, so
    // the bar does not read the transcript again.
    const latestTurn = working ? (turnsCache ?? (await currentTurns($))).value.at(-1) : undefined

    return renderBar(el, {
      project: sanitizeText(shortPath(root, 1)),
      git: branch,
      mode: permissionMode,
      runningAgents: agents.filter(a => isAgentRunning(a.status)).length,
      contextTokens: usage.context.tokens,
      contextPercent: usage.context.percent,
      costUsd: usage.cost?.usd,
      columns: e.props.bodyColumns,
      icons,
      workflow: workflowState(latestTurn, workflowAgents.length, working),
    })
  })
}
