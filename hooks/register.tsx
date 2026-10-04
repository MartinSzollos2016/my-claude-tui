// tail-view: event wiring and state. Live data comes from the engine
// ($.session.messages, $.agent.list, $.session.usage); timings are captured
// by the tool.call and turn.complete hooks. Commands are in commands.ts,
// rendering in view.tsx, transformations in model.ts.
import { atom, read, update } from 'claude-code'
import type { AgentStatus, CommandRunInput, CommandRunResult, EngineInterface, Register, Timer } from 'claude-code'

import type { AgentStat } from '../types'
import {
  buildTurns,
  compactCall,
  gitDirFrom,
  parseGitHead,
  isSubagent,
  paneColumns,
  resultLine,
  sanitizePrompt,
  sanitizeText,
  shortPath,
  traceItems,
  type Item,
} from './model'
import { COMMANDS, helpText, parseCommand } from './commands'
import { nextSelectedTurn, recordToolEnd, recordToolStart, statFor, toggleId, turnStatFrom } from './session'
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
const timings = atom({ plugin: 'tail-view', key: 'timings' } as const, {})
const turnStats = atom({ plugin: 'tail-view', key: 'turnStats' } as const, [])
const agentStats = atom({ plugin: 'tail-view', key: 'agentStats' } as const, {})
const git = atom({ plugin: 'tail-view', key: 'git' } as const, null)
const mode = atom({ plugin: 'tail-view', key: 'mode' } as const, null)
const isWorking = atom({ plugin: 'tail-view', key: 'isWorking' } as const, false)
const isBarHidden = atom({ plugin: 'tail-view', key: 'isBarHidden' } as const, false)

const isRunning = (status: AgentStatus) => status === 'running' || status === 'pending' || status === 'waiting'

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

// Loads the trace of every expanded subagent, nested ones included.
async function loadTraces(
  $: EngineInterface,
  items: readonly Item[],
  open: ReadonlySet<string>,
): Promise<Map<string, Trace>> {
  const traces = new Map<string, Trace>()
  let frontier = items.filter(item => isSubagent(item) && open.has(item.id))

  while (frontier.length > 0) {
    const next: Item[] = []
    for (const item of frontier) {
      if (!isSubagent(item) || traces.has(item.agentId)) continue
      const found = await $.session.messages({ agentId: item.agentId })
      if ('deny' in found) {
        traces.set(item.agentId, { denied: sanitizeText(String(found.deny)) })
        continue
      }
      const children = traceItems(found, `${item.agentId}/`)
      traces.set(item.agentId, { items: children })
      next.push(...children.filter(child => isSubagent(child) && open.has(child.id)))
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

function stopTicker() {
  ticker?.cancel()
  ticker = undefined
}

async function onTick($: EngineInterface): Promise<void> {
  frame += 1
  const working = await read($, isWorking)
  const agents = await $.agent.list()
  if (!working && !agents.some(a => isRunning(a.status))) stopTicker()
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
    case 'turns':
      await update($, paneView, () => 'turns' as const)
      await openPane($, true, e.presentation.columns)
      return { text: 'Turn list opened: Enter or click a turn to see it in detail.' }
    case 'open':
      await openPane($, true, e.presentation.columns)
      return { text: 'Detail view opened. /tail-help lists the commands and keys.' }
  }
}

// Shows one turn in the detail view; the latest one follows new turns.
async function pickTurn($: EngineInterface, index: number, latest: number) {
  await update($, selectedTurn, () => (index >= latest ? null : index))
  await update($, paneView, () => 'detail' as const)
}

// Names the tail-view theme matching the current one; picking it is the
// person's, in /theme (the config API only accepts built-in themes).
async function themeAdvice($: EngineInterface): Promise<string> {
  const row = (await $.config.list()).find(r => r.key === 'theme')
  return tailThemeAdvice(sanitizeText(typeof row?.value === 'string' ? row.value : ''))
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
    await update($, isWorking, () => true)
    await update($, selectedTurn, () => null)
    startTicker($)
    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    const id = e.tool_use_id
    const start = await $.clock.now()
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
    } else {
      const stat = turnStatFrom(e, lastPrompt, endedAt)
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

    const turns = buildTurns(await $.session.messages())
    const latest = turns.length - 1
    const chosen = await read($, selectedTurn)
    const selected = chosen === null || chosen > latest ? latest : chosen
    const turn = turns[selected]
    const open = new Set(await read($, expanded))
    const traces = await loadTraces($, turn?.items ?? [], open)
    const agents = new Map((await $.agent.list()).map(a => [a.id, a.status] as const))
    const usage = await $.session.usage()
    const allStats = await read($, turnStats)

    const step = (delta: number | null) => update($, selectedTurn, cur => nextSelectedTurn(cur, latest, delta))

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
        isWorking: await read($, isWorking),
        now: await $.clock.now(),
        frame,
        agents,
        agentStats: await read($, agentStats),
        traces,
        columns: e.props.bodyColumns,
        rows: e.props.scroll.bodyRows,
        full: new Set(await read($, fullBlocks)),
        view: await read($, paneView),
        stats: turns.map(t => statFor(allStats, t)),
      },
      {
        toggle: id => update($, expanded, ids => toggleId(ids, id, MAX_EXPANDED)).catch(ignore),
        prev: () => step(-1).catch(ignore),
        next: () => step(1).catch(ignore),
        latest: () => step(null).catch(ignore),
        expandAll: () =>
          update($, expanded, ids =>
            [...new Set([...ids, ...visibleIds(turn?.items ?? [], traces)])].slice(-MAX_EXPANDED),
          ).catch(ignore),
        collapseAll: () => {
          update($, expanded, () => []).catch(ignore)
          update($, fullBlocks, () => []).catch(ignore)
        },
        showTurns: () => update($, paneView, () => 'turns' as const).catch(ignore),
        showDetail: () => update($, paneView, () => 'detail' as const).catch(ignore),
        pickTurn: index => pickTurn($, index, latest).catch(ignore),
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

    return renderBar(el, {
      project: sanitizeText(shortPath(await $.session.root(), 1)),
      git: await read($, git),
      mode: await read($, mode),
      runningAgents: agents.filter(a => isRunning(a.status)).length,
      contextTokens: usage.context.tokens,
      contextPercent: usage.context.percent,
      costUsd: usage.cost?.usd,
      columns: e.props.bodyColumns,
    })
  })
}
