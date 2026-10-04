// tail-view: event wiring and state. Live data comes from the engine
// ($.session.messages, $.agent.list, $.session.usage); timings are captured
// by the tool.call and turn.complete hooks. Commands are in commands.ts,
// rendering in view.tsx, transformations in model.ts.
import { atom, read, update } from 'claude-code'
import type {
  AgentStatus,
  CommandRunInput,
  CommandRunResult,
  EngineInterface,
  Register,
  RenderSurface,
  Timer,
} from 'claude-code'

import type { AgentStat } from '../types'
import {
  alignFromEnd,
  buildTurns,
  compactCall,
  gitDirFrom,
  isAgentFinished,
  isAgentRunning,
  isSubagent,
  parseGitHead,
  paneColumns,
  resultLine,
  sanitizePrompt,
  sanitizeText,
  searchTurns,
  shortPath,
  taskBoard,
  teamMembers,
  thinkingCounts,
  traceItems,
  turnListText,
  turnsKey,
  turnText,
  workflowState,
  type Item,
  type TaskEntry,
  type Turn,
  type TurnMatch,
  type TurnThinking,
} from './model'
import { COMMANDS, helpText, parseCommand } from './commands'
import {
  discardStale,
  dropPending,
  enqueueTurn,
  isTextOnly,
  memo,
  nextSelectedTurn,
  noteWorkflowAgent,
  recordToolEnd,
  recordToolStart,
  remember,
  statFor,
  takeTurnIndex,
  toggleId,
  turnIndexAtStart,
  turnStatFrom,
  type Memo,
} from './session'
import { C, tailThemeAdvice } from './theme'
import { renderBar, renderPane, type El, type Trace } from './view'

const PANE = 'tail'
const MAX_STATS = 200
const MAX_EXPANDED = 300
const TICK_MS = 500

const tick = atom({ plugin: 'tail-view', key: 'tick' } as const, 0)
const selectedTurn = atom({ plugin: 'tail-view', key: 'turn' } as const, null)
const paneView = atom({ plugin: 'tail-view', key: 'view' } as const, 'detail')
const expanded = atom({ plugin: 'tail-view', key: 'expanded' } as const, [])
const fullBlocks = atom({ plugin: 'tail-view', key: 'full' } as const, [])
const searchQuery = atom({ plugin: 'tail-view', key: 'query' } as const, '')
const timings = atom({ plugin: 'tail-view', key: 'timings' } as const, {})
const turnStats = atom({ plugin: 'tail-view', key: 'turnStats' } as const, [])
const agentStats = atom({ plugin: 'tail-view', key: 'agentStats' } as const, {})
const git = atom({ plugin: 'tail-view', key: 'git' } as const, null)
const mode = atom({ plugin: 'tail-view', key: 'mode' } as const, null)
const isWorking = atom({ plugin: 'tail-view', key: 'isWorking' } as const, false)
const isBarHidden = atom({ plugin: 'tail-view', key: 'isBarHidden' } as const, false)

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
  for (const item of items) {
    ids.push(item.id)
    if (isSubagent(item)) {
      const trace = traces.get(item.agentId)
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
// turnId -> the index its turn got, from turn.start to its turn.complete;
// bounded in case a turn never completes.
const turnIndexes = new Map<string, number>()
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
    const queue = discardStale(pendingTurns, lastDoneIndex)
    const taken = takeTurnIndex(queue, turnIndexAtStart(turns, sanitizePrompt(sanitizeText(text).trim())))
    pendingTurns = taken.queue
    remember(turnIndexes, turnId, taken.index, MAX_OPEN_TURNS)
  } catch {
    // No index: the stat matches by prompt.
  }
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
    case 'theme':
      return { text: await themeAdvice($) }
    case 'compact':
      return { text: await toggleCompact($) }
    case 'width':
      return { text: await setWidth($, parsed.arg, e.presentation.columns) }
    case 'help':
      return { text: helpText() }
    case 'turns': {
      const surfaces = await $.session.surfaces()
      if (isTextOnly(surfaces)) return { text: await turnsReport($, true) }
      await update($, paneView, () => 'turns' as const)
      await openPane($, true, e.presentation.columns)
      return { text: 'Turn list opened: Enter or click a turn to see it in detail.' }
    }
    case 'open': {
      const surfaces = await $.session.surfaces()
      if (isTextOnly(surfaces)) return { text: await turnsReport($, false) }
      await openPane($, true, e.presentation.columns)
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
      turns.map(t => statFor(stats, t)),
    )
  const turn = turns.at(-1)
  return turnText(turn, statFor(stats, turn))
}

// Copies a whole block (not its preview) and says how it went; called with
// `$` whole, as the directory's validator wants.
async function copyBlock($: EngineInterface, text: string, surface?: RenderSurface): Promise<void> {
  const copied = await $.ui.copy(surface === undefined ? { text } : { text, surface })
  $.ui.toast(copied.isCopied ? 'Copied' : `Not copied: ${copied.reason}`)
}

// Shows one turn in the detail view; the latest one follows new turns.
async function pickTurn($: EngineInterface, index: number, latest: number) {
  await update($, selectedTurn, () => (index >= latest ? null : index))
  await update($, paneView, () => 'detail' as const)
}

// The search key: opens the turn list and puts the cursor in its field.
async function focusSearch($: EngineInterface): Promise<void> {
  await update($, paneView, () => 'turns' as const)
  await $.ui.focus({ requestId: PANE, key: 'turn-search' })
}

// Enter in the search field: keeps the query and opens the newest match,
// the first one the list shows.
async function openMatch($: EngineInterface, value: string, turns: readonly Turn[]): Promise<void> {
  await update($, searchQuery, () => value)
  const newest = searchTurns(turns, value).at(-1)
  if (newest) await pickTurn($, newest.index, turns.length - 1)
}

// Names the tail-view theme matching the current one; picking it is the
// person's, in /theme (the config API only accepts built-in themes).
async function themeAdvice($: EngineInterface): Promise<string> {
  const row = (await $.config.list()).find(r => r.key === 'theme')
  return tailThemeAdvice(sanitizeText(typeof row?.value === 'string' ? row.value : ''), row?.options)
}

// Persisted preferences ($.store, across sessions).
const WIDTH_KEY = 'paneWidth'
const COMPACT_KEY = 'isCompact'
const DEFAULT_WIDTH = 80
const MIN_WIDTH = 30
const MAX_WIDTH = 80

async function widthShare($: EngineInterface): Promise<number> {
  const stored = await $.store.get(WIDTH_KEY)
  return typeof stored === 'number' && stored >= MIN_WIDTH && stored <= MAX_WIDTH ? stored : DEFAULT_WIDTH
}

async function isCompact($: EngineInterface): Promise<boolean> {
  return (await $.store.get(COMPACT_KEY)) !== false
}

// Opens (or re-opens) the pane, asking for its share of `terminalColumns`
// when known; a width the person dragged the dock to still wins.
async function openPane($: EngineInterface, focus: boolean, terminalColumns?: number) {
  const columns = terminalColumns === undefined ? undefined : paneColumns(terminalColumns, await widthShare($))
  return $.ui.open({
    id: PANE,
    title: 'tail',
    ...(focus ? { focus: true as const } : {}),
    ...(columns === undefined ? {} : { columns }),
  })
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
    for (const spec of COMMANDS) {
      await $.command.register({
        name: spec.name,
        description: spec.description,
        ...(spec.argumentHint ? { argumentHint: spec.argumentHint } : {}),
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
  on('command.run', { command: 'tail-theme' }, ($, e) => runCommand($, e))
  on('command.run', { command: 'tail-compact' }, ($, e) => runCommand($, e))
  on('command.run', { command: 'tail-bar' }, ($, e) => runCommand($, e))
  on('command.run', { command: 'tail-help' }, ($, e) => runCommand($, e))

  on('classic.UserPromptSubmit', async ($, e, next) => {
    if (e.permission_mode) await update($, mode, () => e.permission_mode ?? null)
    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    lastPrompt = sanitizePrompt(e.text.trim())
    const pushed = e.turnId === undefined ? await notePrompt($) : undefined
    await update($, isWorking, () => true)
    await update($, selectedTurn, () => null)
    startTicker($)
    const result = await next(e)
    // Dropped: no turn.start will follow, so its index must not stay queued.
    if (pushed !== undefined && 'drop' in result) pendingTurns = dropPending(pendingTurns, pushed)
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

    const ran = await next(e)

    const end = await $.clock.now()
    await update($, timings, all => recordToolEnd(all, id, end, start))
    await bump($)
    return ran
  })

  on('turn.complete', async ($, e, next) => {
    const endedAt = await $.clock.now()

    if (e.agentId !== undefined) {
      const agentId = e.agentId
      const stat: AgentStat = { model: e.usage?.model, durationMs: e.durationMs }
      await update($, agentStats, all => ({ ...all, [agentId]: stat }))
      trackWorkflow($, '', agentId).catch(ignore)
    } else {
      const index = turnIndexes.get(e.turnId)
      turnIndexes.delete(e.turnId)
      if (index !== undefined) lastDoneIndex = Math.max(lastDoneIndex, index)
      const stat = turnStatFrom(e, lastPrompt, endedAt, index)
      await update($, turnStats, all => [...all, stat].slice(-MAX_STATS))
      await update($, isWorking, () => false)
      refreshGit($).catch(ignore)
    }
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
    const open = new Set(await read($, expanded))
    const agentList = await $.agent.list()
    const agents = new Map(agentList.map(a => [a.id, a.status] as const))
    const traces = await loadTraces($, turn?.items ?? [], open, agents)
    const usage = await $.session.usage()
    const allStats = await read($, turnStats)

    const step = (delta: number | null) => update($, selectedTurn, cur => nextSelectedTurn(cur, latest, delta))
    const view = await read($, paneView)
    const query = await read($, searchQuery)
    const isSearching = view === 'turns' && query.trim() !== ''
    if (isSearching) searchCache = memo(searchCache, `${turnsMemo.key}\n${query}`, () => searchTurns(turns, query))

    const thinkingByTurn = view === 'detail' && turn ? await turnThinking($, turnsMemo.key) : []
    const thinking = alignFromEnd(thinkingByTurn, turns.length, selected)
    tasksCache = memo(tasksCache, turnsMemo.key, () => taskBoard(turns))
    const tasks = tasksCache.value

    const thinkingIds = turn && thinking && thinking.text !== '' ? [`t${turn.index}:thinking`] : []

    return renderPane(
      el,
      {
        turns,
        selected: Math.max(0, selected),
        expanded: open,
        timings: await read($, timings),
        turnStat: statFor(allStats, turn),
        sessionModel: await $.session.model(),
        contextPercent: usage.context.percent,
        isLatest: selected === latest,
        thinking,
        isWorking: await read($, isWorking),
        now: await $.clock.now(),
        frame,
        agents,
        agentStats: await read($, agentStats),
        traces,
        columns: e.props.bodyColumns,
        rows: e.props.scroll.bodyRows,
        full: new Set(await read($, fullBlocks)),
        view,
        query,
        matches: isSearching ? searchCache?.value : undefined,
        stats: turns.map(t => statFor(allStats, t)),
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
        showTurns: () => update($, paneView, () => 'turns' as const).catch(ignore),
        showDetail: () => update($, paneView, () => 'detail' as const).catch(ignore),
        showTeam: () => update($, paneView, () => 'team' as const).catch(ignore),
        pickTurn: index => pickTurn($, index, latest).catch(ignore),
        search: value => update($, searchQuery, () => value).catch(ignore),
        submitSearch: value => openMatch($, value, turns).catch(ignore),
        focusSearch: () => focusSearch($).catch(ignore),
        copy: (text, surface) => copyBlock($, text, surface).catch(ignore),
        toggleFull: id => update($, fullBlocks, ids => toggleId(ids, id, MAX_EXPANDED)).catch(ignore),
      },
    )
  })

  // The transcript stays a conversation; tool detail lives in the pane.
  on('ui.render', { component: 'ToolResult' }, async ($, e, next) => {
    if (!(await isCompact($))) return next(e)
    const { Text } = $.ui.resolve(e) as unknown as El
    const line = resultLine(e.props.output, e.props.isErrored)
    return (
      <Text color={e.props.isErrored ? C.error : undefined} dimColor={!e.props.isErrored}>
        {`⎿ ${line}`}
      </Text>
    )
  })

  on('ui.render', { component: 'ToolUse' }, async ($, e, next) => {
    if (!(await isCompact($))) return next(e)
    const { Box, Text } = $.ui.resolve(e) as unknown as El
    const { name, summary } = compactCall(e.props.tool, e.props.input)
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
          {'● '}
        </Text>
        <Text bold>{name}</Text>
        <Text dimColor wrap="truncate-end">
          {summary ? `  ${summary}` : ''}
        </Text>
        {e.props.isInterrupted && <Text color={C.interrupted}> · interrupted</Text>}
      </Box>
    )
  })

  on('ui.render', { component: 'ToolGroup' }, async ($, e, next) => {
    if (!e.props.isExpanded || !(await isCompact($))) return next(e)
    return next({ ...e, props: { ...e.props, isExpanded: false } })
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

    return renderBar(el, {
      project: sanitizeText(shortPath(await $.session.root(), 1)),
      git: await read($, git),
      mode: await read($, mode),
      runningAgents: agents.filter(a => isAgentRunning(a.status)).length,
      contextTokens: usage.context.tokens,
      contextPercent: usage.context.percent,
      costUsd: usage.cost?.usd,
      columns: e.props.bodyColumns,
      workflow: workflowState(latestTurn, workflowAgents.length, working),
    })
  })
}
