// my-claude-tui: tail-claude's detail view and info bar inside Claude Code.
//
//   /tail       opens the detail pane (tool calls, outputs, subagent traces)
//   /tail bar   shows or hides the info bar above the prompt
//
// Live data comes from the engine ($.session.messages, $.agent.list,
// $.session.usage); timings are captured by the tool.call and turn.complete
// hooks. Rendering lives in view.tsx, transformations in model.ts.
import { atom, read, update } from 'claude-code'
import type { AgentStatus, EngineInterface, Register, Timer } from 'claude-code'

import type { AgentStat, GitInfo, ToolTiming, TurnStat } from '../types'
import { buildTurns, isSubagent, paneColumns, resultLine, sanitizePrompt, sanitizeText, shortPath, traceItems, type Item, type Turn } from './model'
import { C, tailThemeAdvice } from './theme'
import { renderBar, renderPane, type El, type Trace } from './view'

const PANE = 'tail'
const MAX_TIMINGS = 500
const MAX_STATS = 200
const MAX_EXPANDED = 300
const TICK_MS = 500

const tick = atom({ plugin: 'tail-view', key: 'tick' } as const, 0)
const selectedTurn = atom({ plugin: 'tail-view', key: 'turn' } as const, null)
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

// "## main...origin/main" + one line per changed path.
export function parseGitStatus(stdout: string): GitInfo | null {
  const [head, ...rest] = stdout.split('\n')
  if (!head?.startsWith('## ')) return null
  const branch = sanitizeText(head)
    .slice(3)
    .replace(/^No commits yet on /, '')
    .split('...')[0]!
    .trim()
  return { branch, isDirty: rest.some(line => line.trim() !== '') }
}

// The repo's own config is untrusted: `core.fsmonitor` (and its hook
// variant) names a program git runs on every status, which would execute
// code from a cloned repo just by opening it here. Override it on the
// command line, which beats every config file, and take no index lock so
// the status never races the person's own git commands.
export const GIT_STATUS_ARGV = [
  'git',
  '--no-optional-locks',
  '-c',
  'core.fsmonitor=false',
  '-c',
  'core.untrackedCache=false',
  'status',
  '--porcelain=v1',
  '--branch',
] as const

async function refreshGit($: EngineInterface): Promise<void> {
  try {
    const root = await $.session.cwd()
    const ran = await $.process.run(GIT_STATUS_ARGV, {
      cwd: root,
      timeoutMs: 5000,
      env: { GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' },
    })
    const info = ran.exitCode === 0 ? parseGitStatus(ran.stdout) : null
    await update($, git, () => info)
  } catch {
    await update($, git, () => null)
  }
}

// Prefer the stat recorded for this turn's prompt; the latest turn of a
// fresh session may have none yet.
export function statFor(stats: readonly TurnStat[], turn: Turn | undefined): TurnStat | undefined {
  if (!turn) return undefined
  for (let i = stats.length - 1; i >= 0; i--) {
    if (stats[i]!.prompt === turn.prompt) return stats[i]
  }
  return undefined
}

// Loads the trace of every expanded subagent, nested ones included.
async function loadTraces($: EngineInterface, items: readonly Item[], open: ReadonlySet<string>): Promise<Map<string, Trace>> {
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
  ticker = $.clock.every(TICK_MS, () => void onTick($))
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
const DEFAULT_WIDTH = 60
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
  return next ? 'Compact transcript on: tool results are one line, details in /tail.' : 'Compact transcript off: tool results are drawn in full.'
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await $.command.register({
      name: 'tail',
      description:
        'Open the tail-claude detail view; bar: info bar, compact: one-line tool results, width N: pane share %, theme: pane theme',
      argumentHint: '[bar|compact|width N|theme]',
    })
    void refreshGit($)
    void openPane($, false)
    return started
  })

  on('command.run', { command: 'tail' }, async ($, e) => {
    const arg = e.args.trim()
    if (arg === 'bar') {
      const hidden = await update($, isBarHidden, h => !h)
      return { text: hidden ? 'Info bar hidden.' : 'Info bar shown.' }
    }
    if (arg === 'theme') return { text: await themeAdvice($) }
    if (arg === 'compact') return { text: await toggleCompact($) }
    if (arg === 'width' || arg.startsWith('width ')) return { text: await setWidth($, arg.slice(5).trim(), e.presentation.columns) }
    await openPane($, true, e.presentation.columns)
    return { text: 'Detail view opened: Tab walks rows, Enter expands, p/n/l turns, e/c expand/collapse all.' }
  })

  // Theme keys resolve at paint; redraw once the new theme is stored so
  // nothing cached keeps the old palette.
  on('config.set', { key: 'theme' }, async ($, e, next) => {
    const set = await next(e)
    await bump($)
    return set
  })

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
    await update($, timings, all => {
      const keys = Object.keys(all)
      const kept = keys.length >= MAX_TIMINGS ? Object.fromEntries(keys.slice(-MAX_TIMINGS / 2).map(k => [k, all[k]!])) : all
      return { ...kept, [id]: { start } satisfies ToolTiming }
    })
    await bump($)
    startTicker($)

    const ran = await next(e)

    const end = await $.clock.now()
    await update($, timings, all => ({ ...all, [id]: { start: all[id]?.start ?? start, end } }))
    await bump($)
    return ran
  })

  on('turn.complete', async ($, e, next) => {
    const endedAt = await $.clock.now()
    const usage = e.usage

    if (e.agentId !== undefined) {
      const agentId = e.agentId
      const stat: AgentStat = { model: usage?.model, durationMs: e.durationMs }
      await update($, agentStats, all => ({ ...all, [agentId]: stat }))
    } else {
      const stat: TurnStat = {
        prompt: lastPrompt,
        durationMs: e.durationMs,
        endedAt,
        model: usage?.model,
        inputTokens: usage ? usage.input_tokens + usage.cache_read_input_tokens + usage.cache_creation_input_tokens : undefined,
        outputTokens: usage?.output_tokens,
      }
      await update($, turnStats, all => [...all, stat].slice(-MAX_STATS))
      await update($, isWorking, () => false)
      void refreshGit($)
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

    const setTurn = (fn: (cur: number) => number | null) =>
      update($, selectedTurn, cur => {
        const n = fn(cur === null || cur > latest ? latest : cur)
        return n === null || n >= latest ? null : Math.max(0, n)
      })

    return renderPane(
      el,
      {
        turns,
        selected: Math.max(0, selected),
        expanded: open,
        timings: await read($, timings),
        turnStat: statFor(await read($, turnStats), turn),
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
      },
      {
        toggle: id =>
          void update($, expanded, ids => (ids.includes(id) ? ids.filter(x => x !== id) : [...ids, id].slice(-MAX_EXPANDED))),
        prev: () => void setTurn(cur => cur - 1),
        next: () => void setTurn(cur => cur + 1),
        latest: () => void setTurn(() => null),
        expandAll: () =>
          void update($, expanded, ids => [...new Set([...ids, ...visibleIds(turn?.items ?? [], traces)])].slice(-MAX_EXPANDED)),
        collapseAll: () => {
          void update($, expanded, () => [])
          void update($, fullBlocks, () => [])
        },
        toggleFull: id =>
          void update($, fullBlocks, ids => (ids.includes(id) ? ids.filter(x => x !== id) : [...ids, id].slice(-MAX_EXPANDED))),
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

  on('ui.render', { component: 'ToolGroup' }, async ($, e, next) => {
    if (!e.props.isExpanded || !(await isCompact($))) return next(e)
    return next({ ...e, props: { ...e.props, isExpanded: false } })
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    void autoSize($, e.viewport?.columns)
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
