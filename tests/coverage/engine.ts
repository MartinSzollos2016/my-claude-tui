// A stand-in engine for Vitest: register() hands its hooks to a collecting
// `on`, and each runs against a `$` of plain answers, so the wiring in
// register.tsx is measured by coverage. tests/render.test.tsx runs the same
// hooks in the real engine.
import type {
  AgentInfo,
  ConfigRow,
  EngineInterface,
  Register,
  RenderSurface,
  SessionMessage,
  UiCopyResult,
} from 'claude-code'

type Node = { type: string; props: Record<string, unknown>; children: unknown }
type Hook = ($: EngineInterface, e: never, next: (e: unknown) => unknown) => unknown
type Entry = { name: string; matcher: Record<string, unknown>; hook: Hook }

const make =
  (type: string) =>
  (props: Record<string, unknown>): Node => ({ type, props, children: props['children'] })

const el = {
  Box: make('Box'),
  Text: make('Text'),
  Button: make('Button'),
  Markdown: make('Markdown'),
  Code: make('Code'),
  Input: make('Input'),
}

export const PANE_EVENT = {
  component: 'Pane',
  requestId: 'tail',
  surface: 'terminal',
  props: {
    title: 'tail',
    isFocused: true,
    bodyColumns: 100,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
  viewport: { columns: 160, rows: 48, isFullscreen: true },
}

export const BAR_EVENT = {
  component: 'AbovePrompt',
  surface: 'terminal',
  props: {
    hasSurvey: false,
    isWorking: false,
    maxRows: 10,
    bodyColumns: 120,
    scroll: { offset: 0, bodyRows: 10 },
    view: {},
  },
  viewport: { columns: 160, rows: 48, isFullscreen: true },
}

function nodes(tree: unknown, found: Node[] = []): Node[] {
  if (Array.isArray(tree)) for (const child of tree) nodes(child, found)
  else if (tree !== null && typeof tree === 'object' && 'type' in tree) {
    found.push(tree as Node)
    nodes((tree as Node).children, found)
  }
  return found
}

// Every string a tree carries, text children and text-like props, joined.
export function text(tree: unknown): string {
  const parts: string[] = []
  const walk = (t: unknown) => {
    if (typeof t === 'string' || typeof t === 'number') parts.push(String(t))
    else if (Array.isArray(t)) t.forEach(walk)
    else if (t !== null && typeof t === 'object' && 'type' in t) {
      const { props, children } = t as Node
      for (const key of ['label', 'text', 'source'])
        if (typeof props[key] === 'string') parts.push(props[key] as string)
      walk(children)
    }
  }
  walk(tree)
  return parts.join('')
}

export const byKey = (tree: unknown, key: string) => nodes(tree).find(n => n.props['key'] === key)

// Lets work a hook started in the background (`.catch(ignore)`) finish.
export async function settle(): Promise<void> {
  const timers = globalThis as unknown as { setTimeout: (run: () => void, ms: number) => void }
  for (let i = 0; i < 10; i++) await new Promise<void>(resolve => timers.setTimeout(resolve, 0))
}

type World = {
  messages: SessionMessage[]
  agentMessages: Record<string, SessionMessage[]>
  api: unknown[]
  // Ring keys $.ui.focus refuses, as for an element drawn as Text.
  focusDenied: string[]
  agents: AgentInfo[]
  surfaces: RenderSurface[]
  config: ConfigRow[]
  files: Record<string, string>
  isGitDir: boolean
  hasRepo: boolean
  now: number
  // While set, a read of the main transcript returns the rows it saw when it
  // started only once this settles: a slow read of an older transcript.
  hold?: Promise<void>
  copyResult: UiCopyResult
  // What $.ui.panes reports for the pane.
  isPaneFocused: boolean
  isPanePlaced: boolean
  // What the plugin did, for the tests to read.
  store: Map<string, unknown>
  opened: (number | undefined)[]
  // Everything each open asked for.
  openArgs: Record<string, unknown>[]
  // How many opens asked for the keyboard.
  focusRequests: number
  commands: string[]
  copies: string[]
  toasts: string[]
  statuses: (string | undefined)[]
  // What each $.ui.invalidate asked to redraw.
  invalidations: string[]
  focused: string[]
  timers: (() => void)[]
  calls: string[]
  // Every round trip to the engine, in order: its calls ('agent.list') and
  // the state reads and writes ('state.get:tick', 'state.set:timings').
  trips: string[]
  // How many of those started while no other was in flight: the rounds a
  // hook waits through, calls made together counting once.
  rounds: number
}

export function fakeEngine(given: Partial<World> = {}): { $: EngineInterface; world: World } {
  const world: World = {
    messages: [],
    agentMessages: {},
    api: [],
    agents: [],
    surfaces: ['terminal'],
    config: [],
    files: {},
    isGitDir: true,
    focusDenied: [],
    hasRepo: true,
    now: 1_700_000_000_000,
    copyResult: { isCopied: true },
    isPaneFocused: true,
    isPanePlaced: true,
    store: new Map(),
    opened: [],
    openArgs: [],
    focusRequests: 0,
    commands: [],
    copies: [],
    toasts: [],
    statuses: [],
    invalidations: [],
    focused: [],
    timers: [],
    calls: [],
    trips: [],
    rounds: 0,
    ...given,
  }
  let inFlight = 0
  // Logs a round trip and counts it as a new round when nothing else waits.
  const track = (name: string, result: unknown): unknown => {
    if (typeof (result as { then?: unknown } | null)?.then !== 'function') return result
    world.trips.push(name)
    if (inFlight === 0) world.rounds++
    inFlight++
    return (result as Promise<unknown>).finally(() => {
      inFlight--
    })
  }
  const $ = {
    session: {
      messages: async (args?: { agentId?: string; as?: 'api' }) => {
        world.calls.push(`messages:${args?.as ?? args?.agentId ?? 'main'}`)
        if (args?.as === 'api') return world.api
        if (args?.agentId !== undefined) return world.agentMessages[args.agentId] ?? { deny: `no ${args.agentId}` }
        const rows = world.messages
        if (world.hold !== undefined) await world.hold
        return rows
      },
      model: async () => 'claude-opus-5-5',
      usage: async () => ({
        startedAt: 0,
        context: { tokens: 46_900, window: 200_000, percent: 23 },
        rateLimits: [],
        cost: { usd: 1.5 },
      }),
      repo: async () => (world.hasRepo ? { root: '/r', remote: null, internal: false, name: null } : null),
      root: async () => '/r/project',
      surfaces: async () => world.surfaces,
    },
    agent: {
      list: async () => {
        world.calls.push('agent.list')
        return world.agents
      },
    },
    clock: {
      now: async () => world.now,
      sleep: async () => undefined,
      every: (_ms: number, fn: () => void) => {
        world.timers.push(fn)
        return { cancel: () => undefined }
      },
    },
    ui: {
      resolve: () => el,
      open: async (args: { columns?: number; focus?: true }) => {
        world.opened.push(args.columns)
        world.openArgs.push(args)
        if (args.focus === true) world.focusRequests++
        return { isPlaced: true }
      },
      panes: async () => [{ id: 'tail', isPlaced: world.isPanePlaced, isFocused: world.isPaneFocused }],
      invalidate: (event: string) => {
        world.invalidations.push(event)
      },
      copy: async (args: { text: string }) => {
        world.copies.push(args.text)
        return world.copyResult
      },
      toast: (message: string) => {
        world.toasts.push(message)
      },
      status: (message: string | undefined) => {
        world.statuses.push(message)
      },
      focus: async (args: { key: string }) => {
        if (world.focusDenied.includes(args.key)) return { deny: 'not drawn' }
        world.focused.push(args.key)
        return {}
      },
    },
    store: {
      get: async (key: string) => world.store.get(key),
      set: async (key: string, value: unknown) => {
        world.store.set(key, value)
      },
    },
    config: { list: async () => world.config },
    command: {
      register: async (spec: { name: string }) => {
        world.commands.push(spec.name)
        return { command: spec.name }
      },
    },
    fs: {
      stat: async () => ({ kind: world.isGitDir ? 'dir' : 'file', size: 0, mtimeMs: 0, isLink: false }),
      read: async (path: string) => world.files[path] ?? '',
    },
  }
  for (const [area, calls] of Object.entries($) as [string, Record<string, unknown>][])
    for (const [name, fn] of Object.entries(calls))
      if (typeof fn === 'function')
        calls[name] = (...args: unknown[]) => track(`${area}.${name}`, (fn as (...a: unknown[]) => unknown)(...args))
  // The state stand-in (tests/coverage/claude-code.ts) logs through this.
  Object.defineProperty($, '__track', { value: track })
  return { $: $ as unknown as EngineInterface, world }
}

// Collects register()'s hooks; the returned runner calls the first one
// registered for `name` whose matcher fits `e`, as the engine would.
export function hooksOf(register: Register) {
  const entries: Entry[] = []
  const on = (name: string, matcher: unknown, hook?: unknown) => {
    entries.push(
      typeof matcher === 'function'
        ? { name, matcher: {}, hook: matcher as Hook }
        : { name, matcher: matcher as Record<string, unknown>, hook: hook as Hook },
    )
  }
  register(on as never, {} as never)
  return async (
    name: string,
    $: EngineInterface,
    e: Record<string, unknown>,
    next: (e: unknown) => unknown = async () => ({}),
  ): Promise<unknown> => {
    const entry = entries.find(x => x.name === name && Object.entries(x.matcher).every(([k, v]) => e[k] === v))
    if (!entry) throw new Error(`no ${name} hook matches`)
    return entry.hook($, e as never, next)
  }
}
