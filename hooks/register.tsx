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
import { alignFromEnd, thinkingCounts, type TurnThinking } from './model/thinking'
import { durationSuffix, paneColumns, resultLine } from './model/transcript'
import { buildTurns, isAgentFinished, isAgentRunning, isSubagent, traceItems, turnsKey } from './model/turns'
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
let thinkingCache: Memo<TurnThinking[]> | undefined
let tasksCache: Memo<TaskEntry[]> | undefined

// Thinking per turn from the Messages API form, read again only when the
// transcript's fingerprint moved.
async function turnThinking($: EngineInterface, key: string): Promise<TurnThinking[]> {
  if (thinkingCache === undefined || thinkingCache.key !== key) {
    // An auxiliary read: a failure shows no counts and is not cached.
    const api = await $.session.messages({ as: 'api' }).catch(() => undefined)
    if (api === undefined) return []
    thinkingCache = { key, value: thinkingCounts(api) }
  }
  return thinkingCache.value
}

// The session's turns, rebuilt only when the transcript's fingerprint moved.
async function currentTurns($: EngineInterface): Promise<Memo<Turn[]>> {
  const messages = await $.session.messages()
  turnsCache = memo(turnsCache, turnsKey(messages), () => buildTurns(messages))
  return turnsCache
}

// Traces by agentId. A finished agent's trace is final and never read again;
// a running one is read on each drawing but rebuilt only when it changed.
type CachedTrace = { key: string; trace: { items: Item[] }; isFinal: boolean }
const traceCache = new Map<string, CachedTrace>()
const MAX_TRACES = 200

async function loadTrace($: EngineInterface, agentId: string, status: AgentStatus | undefined): Promise<Trace> {
  const cached = traceCache.get(agentId)
  if (cached?.isFinal && isAgentFinished(status)) return cached.trace
  const found = await $.session.messages({ agentId })
  if ('deny' in found) return { denied: sanitizeText(String(found.deny)) }
  const key = turnsKey(found)
  const trace = cached?.key === key ? cached.trace : { items: traceItems(found, `${agentId}/`) }
  remember(traceCache, agentId, { key, trace, isFinal: isAgentFinished(status) }, MAX_TRACES)
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
  let frontier = items.filter(item => isSubagent(item) && open.has(item.id))

  while (frontier.length > 0) {
    const next: Item[] = []
    for (const item of frontier) {
      if (!isSubagent(item) || traces.has(item.agentId)) continue
      const trace = await loadTrace($, item.agentId, agents.get(item.agentId))
      traces.set(item.agentId, trace)
      if ('items' in trace) next.push(...trace.items.filter(child => isSubagent(child) && open.has(child.id)))
    }
    frontier = next
  }
  return traces
}

function visibleIds(items: readonly Item[], traces: ReadonlyMap<string, Trace>): string[] {
  const ids: string[] = []
  // A folded run counts as its own row, so expand all opens it too.
  for (const row of groupRuns(items)) {
    ids.push(row.id)
    if (row.kind === 'group') ids.push(...row.items.map(item => item.id))
    else if (isSubagent(row)) {
      const trace = traces.get(row.agentId)
      if (trace && 'items' in trace) ids.push(...visibleIds(trace.items, traces))
    }
  }
  return ids
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

// The switches and the icon set, read once per tick and passed on.
type Prefs = { isStatusOn: boolean; isNotifyOn: boolean; icons: Icons }

async function loadPrefs($: EngineInterface): Promise<Prefs> {
  return {
    isStatusOn: await isStatusOn($),
    isNotifyOn: (await $.store.get(NOTIFY_KEY)) === true,
    icons: await currentIcons($),
  }
}

// Sets the status line and the spinner text to what the running tools say
// now, each when it differs from what is showing; off in /tail-status, both
// are cleared instead. The spinner text is state its hook reads, so only the
// spinner is drawn again, not every row of the transcript.
async function syncStatus($: EngineInterface, given?: Prefs): Promise<void> {
  const prefs = given ?? (await loadPrefs($))
  const now = await $.clock.now()
  // Read after the awaits: the latest state wins whichever sync ends last.
  const text = prefs.isStatusOn ? statusText(runningTools, now, prefs.icons) : undefined
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
async function notifyFinished($: EngineInterface, list?: readonly AgentInfo[], given?: Prefs): Promise<void> {
  const agents = list ?? (await $.agent.list())
  const latestTurn = (await currentTurns($)).value.at(-1)
  const working = await read($, isWorking)
  const prefs = given ?? (await loadPrefs($))

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
  const working = await read($, isWorking)
  const agents = await $.agent.list()
  if (!working && !agents.some(a => isAgentRunning(a.status))) stopTicker()
  const prefs = await loadPrefs($)
  await syncStatus($, prefs)
  await notifyFinished($, agents, prefs)
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
      return { text: helpText() }
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

// Moves the keyboard cursor one row along `ids`. The engine's focus ring is
// not used: it draws the focused button in reverse video of the terminal's
// own colors, which can be unreadable under the other theme.
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
// the top (and stored so) for another one.
async function detailScroll($: EngineInterface, turnKey: string): Promise<number> {
  const stored = (await read($, paneScroll)).detail
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
// the first one the list shows.
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

// Opens (or re-opens) the pane, asking for its share of `terminalColumns`
// when known; a width the person dragged the dock to still wins.
// No `closeOnEscape`: Esc (in the search field too) only hands the keys back
// to the prompt and the pane stays open.
async function openPane($: EngineInterface, focus: boolean, terminalColumns?: number) {
  const share = await widthShare($)
  const columns = terminalColumns === undefined ? undefined : paneColumns(terminalColumns, share)
  return $.ui.open({
    id: PANE,
    title: 'tail',
    ...(focus ? { focus: true as const } : {}),
    ...(columns === undefined ? {} : { columns }),
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
// once, from the first drawing that reports the terminal width, if it is
// still docked.
let isAutoSized = false

async function autoSize($: EngineInterface, terminalColumns: number | undefined) {
  if (isAutoSized || terminalColumns === undefined) return
  isAutoSized = true
  const pane = (await $.ui.panes()).find(p => p.id === PANE)
  if (pane?.isPlaced) await openPane($, false, terminalColumns)
}

async function setWidth($: EngineInterface, arg: string, terminalColumns: number): Promise<string> {
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
  const text = await setSwitch(
    $,
    { command: 'tail-status', key: STATUS_KEY, label: 'Status line', fallback: true },
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
    lastPrompt = sanitizePrompt(e.text.trim())
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
  on('turn.start', async ($, e, next) => {
    await noteTurnStart($, e.turnId, e.text)
    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    const id = e.tool_use_id
    const start = await $.clock.now()
    trackWorkflow($, e.tool, e.agentId).catch(ignore)
    await update($, timings, all => recordToolStart(all, id, start))
    await bump($)
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
      await bump($)
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
    const el = $.ui.resolve(e) as unknown as El
    await read($, tick)

    const turnsMemo = await currentTurns($)
    const turns = turnsMemo.value
    const latest = turns.length - 1
    const chosen = await read($, selectedTurn)
    const selected = chosen === null || chosen > latest ? latest : chosen
    const turn = turns[selected]
    const openIds = await read($, expanded)
    const open = new Set(openIds)
    const agentList = await $.agent.list()
    const agents = new Map(agentList.map(a => [a.id, a.status] as const))
    const traces = await loadTraces($, turn?.items ?? [], open, agents)
    const usage = await $.session.usage()
    const allStats = await read($, turnStats)

    const step = async (delta: number | null) => {
      await update($, cursor, () => null)
      await update($, selectedTurn, cur => nextSelectedTurn(cur, latest, delta))
      await scrollToTop($)
    }
    const view = await read($, paneView)
    const turnKey = turn === undefined ? '' : `${turn.index}\u0000${turn.prompt}`
    const detailTop = await detailScroll($, turnKey)
    const scrolled = await read($, paneScroll)
    const query = await read($, searchQuery)
    const isSearching = view === 'turns' && query.trim() !== ''
    const icons = await currentIcons($)
    if (isSearching)
      searchCache = memo(searchCache, `${turnsMemo.key}\n${icons.ellipsis}\n${query}`, () =>
        searchTurns(turns, query, icons.ellipsis),
      )

    const thinkingByTurn = view === 'detail' && turn ? await turnThinking($, turnsMemo.key) : []
    const thinking = alignFromEnd(thinkingByTurn, turns.length, selected)
    tasksCache = memo(tasksCache, turnsMemo.key, () => taskBoard(turns))
    const tasks = tasksCache.value

    const childrenOf = (agentId: string) => {
      const trace = traces.get(agentId)
      return trace && 'items' in trace ? trace.items : undefined
    }
    const rowIds = cursorRows(turn?.items ?? [], open, childrenOf)
    const stored = await read($, cursor)
    const cursorId = stored !== null && rowIds.includes(stored) ? stored : null
    const cursorText = cursorId === null ? undefined : rowText(turn?.items ?? [], cursorId, childrenOf, icons)

    const thinkingIds = turn && thinking && thinking.text !== '' ? [`t${turn.index}:thinking`] : []

    const timed = await read($, timings)
    const sessionModel = await $.session.model()
    const working = await read($, isWorking)
    const now = await $.clock.now()
    const agentStatsNow = await read($, agentStats)
    const fullIds = await read($, fullBlocks)

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
        isBarShown: !(await read($, isBarHidden)),
        turnCursor: view === 'turns' ? await read($, turnCursor) : null,
        columns: e.props.bodyColumns,
        rows: e.props.scroll.bodyRows,
        scrollTop: view === 'detail' ? detailTop : scrolled[view],
        full: new Set(fullIds),
        view,
        query,
        searchField: await read($, searchField),
        matches: isSearching ? searchCache?.value : undefined,
        stats: turns.map(t => statFor(allStats, t, turns)),
        members: teamMembers(agentList),
        tasks,
      },
      {
        toggle: id => update($, expanded, ids => toggleId(ids, id, MAX_EXPANDED)).catch(ignore),
        prev: () => step(-1).catch(ignore),
        next: () => step(1).catch(ignore),
        latest: () => step(null).catch(ignore),
        expandAll: () =>
          update($, expanded, ids =>
            [...new Set([...ids, ...thinkingIds, ...visibleIds(turn?.items ?? [], traces)])].slice(-MAX_EXPANDED),
          ).catch(ignore),
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
      <Box flexDirection="row">
        <Text color={mark} dimColor={mark === undefined}>
          {`${icons.bullet} `}
        </Text>
        <Text bold>{name}</Text>
        <Text dimColor wrap={icons.ellipsis === ICON_SETS.nerd.ellipsis ? 'truncate-end' : 'wrap'}>
          {summary ? `  ${summary}` : ''}
        </Text>
        {e.props.isInterrupted && <Text color={C.interrupted}>{` ${icons.dot} interrupted`}</Text>}
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
    autoSize($, e.viewport?.columns).catch(ignore)
    if (e.props.hasSurvey || (await read($, isBarHidden))) return next(e)
    await read($, tick)

    const el = $.ui.resolve(e) as unknown as El
    const usage = await $.session.usage()
    const agents = await $.agent.list()
    const latestTurn = (await currentTurns($)).value.at(-1)
    const working = await read($, isWorking)
    const root = await $.session.root()
    const branch = await read($, git)
    const permissionMode = await read($, mode)
    const icons = await currentIcons($)

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
