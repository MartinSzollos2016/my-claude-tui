import type { CommandRunInput, ConfigRow, RenderSurface, SessionMessage } from 'claude-code'
import { describe, expect, mock, test } from 'claude-code/testing'

import { THEME_KEYS } from '../hooks/theme'

const themeKeys = new Set<string>(THEME_KEYS)

// Every color in a drawn tree, so a raw color slipping past the types fails.
function colorsOf(node: unknown, found: string[] = []): string[] {
  if (Array.isArray(node)) {
    for (const child of node) colorsOf(child, found)
  } else if (node !== null && typeof node === 'object') {
    const { props, hover, children } = node as {
      props?: Record<string, unknown>
      hover?: Record<string, unknown>
      children?: unknown
    }
    for (const source of [props, hover]) {
      for (const key of ['color', 'backgroundColor', 'borderColor']) {
        if (typeof source?.[key] === 'string') found.push(source[key] as string)
      }
    }
    colorsOf(children, found)
  }
  return found
}

type Node = {
  type?: string
  key?: string
  props?: Record<string, unknown>
  hover?: { scope?: string }
  children?: unknown
}

// Every framed Box: its border color and the text drawn inside it.
function framesOf(node: unknown, found: { color: string; text: string }[] = []): { color: string; text: string }[] {
  if (Array.isArray(node)) {
    for (const child of node) framesOf(child, found)
  } else if (node !== null && typeof node === 'object') {
    const { type, props, children } = node as Node
    if (type === 'Box' && typeof props?.['borderStyle'] === 'string') {
      found.push({ color: String(props['borderColor']), text: textsOf(children).join('\n') })
    }
    framesOf(children, found)
  }
  return found
}

function findKey(node: unknown, key: string): Node | undefined {
  if (Array.isArray(node)) {
    for (const child of node) {
      const hit = findKey(child, key)
      if (hit) return hit
    }
  } else if (node !== null && typeof node === 'object') {
    const n = node as Node
    if (n.key === key || n.props?.['key'] === key) return n
    return findKey(n.children, key)
  }
  return undefined
}

// Every string a drawn tree carries: text children and text-like props.
function textsOf(node: unknown, found: string[] = []): string[] {
  if (typeof node === 'string') {
    found.push(node)
  } else if (Array.isArray(node)) {
    for (const child of node) textsOf(child, found)
  } else if (node !== null && typeof node === 'object') {
    const { props, children } = node as { props?: Record<string, unknown>; children?: unknown }
    for (const key of ['text', 'source', 'label']) {
      if (typeof props?.[key] === 'string') found.push(props[key] as string)
    }
    textsOf(children, found)
  }
  return found
}

const main: SessionMessage[] = [
  { role: 'user', text: 'Fix the bug', toolUses: [] },
  {
    role: 'assistant',
    text: 'Looking.',
    toolUses: [
      { tool_use_id: 'r1', tool: 'Read', input: { file_path: '/a/b/main.go' }, text: 'package main' },
      {
        tool_use_id: 'a1',
        tool: 'Agent',
        input: { subagent_type: 'Explore', description: 'Find callers' },
        agentId: 'agent-1',
        text: 'done',
        durationMs: 4200,
      },
    ],
  },
]

const child: SessionMessage[] = [
  { role: 'user', text: 'Find callers', toolUses: [] },
  {
    role: 'assistant',
    text: '',
    toolUses: [{ tool_use_id: 'g1', tool: 'Grep', input: { pattern: 'Run(' }, text: '3 matches' }],
  },
]

const PANE = {
  component: 'Pane',
  requestId: 'tail',
  props: {
    title: 'tail',
    isFocused: true,
    bodyColumns: 100,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
  viewport: { columns: 160, rows: 48, isFullscreen: true },
} as const

describe('detail pane', () => {
  test('typing in the turn search narrows the list and Enter opens the match', async ($, on) => {
    const three: SessionMessage[] = [
      ...main,
      { role: 'user', text: 'Now add tests', toolUses: [] },
      { role: 'assistant', text: 'Added.', toolUses: [] },
      { role: 'user', text: 'Thanks', toolUses: [] },
      { role: 'assistant', text: 'You are welcome.', toolUses: [] },
    ]
    mock.clock(on, { now: 1_700_000_000_000 })
    on('session.messages', (_$, e) => ({ value: e.agentId ? child : three }))
    on('session.model', () => ({ value: 'claude-opus-5-5' }))
    on('agent.list', () => ({ value: [] }))
    on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200_000 }, rateLimits: [] } }))

    const ui = await $.ui.mount({ plugin: 'tail-view', surface: 'terminal', ...PANE })
    await ui.press({ key: 'nav-turns' })
    await ui.input({ key: 'turn-search', text: 'tests', kind: 'change' })
    const labels = (await ui.findAll({ type: 'Button' }))
      .filter(b => /^turn-\d+$/.test(String(b.key ?? '')))
      .map(b => String(b.props['label']))
    expect(labels.length).toBe(1)
    expect(labels[0]).toContain('Now add tests')

    await ui.input({ key: 'turn-search', text: 'fix' })
    expect(await ui.find({ text: /turn 1\/3/ })).toBeDefined()
    await ui.unmount()
  })

  test('copies a whole block and says so', async ($, on) => {
    const lines = Array.from({ length: 500 }, (_, i) => `line ${i}`).join('\n')
    const long: SessionMessage[] = [
      { role: 'user', text: 'run it', toolUses: [] },
      {
        role: 'assistant',
        text: '',
        toolUses: [{ tool_use_id: 'b1', tool: 'Bash', input: { command: 'seq 500' }, text: lines }],
      },
    ]
    const copies: string[] = []
    const toasts: string[] = []
    mock.clock(on, { now: 1_700_000_000_000 })
    on('session.messages', () => ({ value: long }))
    on('session.model', () => ({ value: 'claude-opus-5-5' }))
    on('agent.list', () => ({ value: [] }))
    on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200_000 }, rateLimits: [] } }))
    on('ui.copy', (_$, e) => {
      copies.push(e.text)
      return { value: { isCopied: true as const } }
    })
    on('ui.toast', (_$, e) => {
      toasts.push(e.text)
      return { value: undefined }
    })

    const ui = await $.ui.mount({ plugin: 'tail-view', surface: 'terminal', ...PANE })
    await ui.press({ key: 'b1' })
    await ui.press({ key: 'copy:b1:output' })
    expect(copies).toEqual([lines])
    expect(toasts).toEqual(['Copied'])
    await ui.press({ key: 'copy:b1:command' })
    expect(copies.at(-1)).toBe('seq 500')
    await ui.unmount()
  })

  test('reads a finished subagent trace once', async ($, on) => {
    const done: SessionMessage[] = [
      { role: 'user', text: 'Map it', toolUses: [] },
      {
        role: 'assistant',
        text: '',
        toolUses: [
          {
            tool_use_id: 'd1',
            tool: 'Agent',
            input: { subagent_type: 'Explore', description: 'Map callers' },
            agentId: 'agent-done',
            text: 'ok',
          },
        ],
      },
    ]
    let traceReads = 0
    mock.clock(on, { now: 1_700_000_000_000 })
    on('session.messages', (_$, e) => {
      if (e.agentId !== 'agent-done') return { value: done }
      traceReads += 1
      return { value: child }
    })
    on('session.model', () => ({ value: 'claude-opus-5-5' }))
    on('agent.list', () => ({
      value: [{ id: 'agent-done', description: 'Map callers', type: 'Explore', status: 'completed' as const }],
    }))
    on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200_000 }, rateLimits: [] } }))

    const ui = await $.ui.mount({ plugin: 'tail-view', surface: 'terminal', ...PANE })
    await ui.press({ key: 'd1' })
    expect(await ui.find({ text: /Execution Trace/ })).toBeDefined()
    await ui.press({ key: 'nav-expand' })
    expect(await ui.find({ text: /3 matches/ })).toBeDefined()
    expect(traceReads).toBe(1)
    await ui.unmount()
  })

  test('paints the body with the theme background, full height', async ($, on) => {
    mock.clock(on, { now: 1_700_000_000_000 })
    on('session.model', () => ({ value: 'claude-opus-5-5' }))
    on('agent.list', () => ({ value: [] }))
    on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200_000 }, rateLimits: [] } }))
    let messages: SessionMessage[] = main
    on('session.messages', () => ({ value: messages }))

    for (const shown of [main, []]) {
      messages = shown
      const ui = await $.ui.mount({ plugin: 'tail-view', surface: 'terminal', ...PANE })
      const root = (await ui.drawn()) as { type: string; props: Record<string, unknown> }
      expect(root.type).toBe('Box')
      expect(root.props['backgroundColor']).toBe('inverseText')
      expect(root.props['width']).toBe(PANE.props.bodyColumns)
      expect(root.props['minHeight']).toBe(PANE.props.scroll.bodyRows)
      await ui.unmount()
    }
  })

  test('lists the turn items and drills into a subagent trace', async ($, on) => {
    mock.clock(on, { now: 1_700_000_000_000 })
    on('session.messages', (_$, e) => ({ value: e.agentId === 'agent-1' ? child : main }))
    on('session.model', () => ({ value: 'claude-opus-5-5' }))
    on('agent.list', () => ({ value: [] }))
    on('session.usage', () => ({
      value: { startedAt: 0, context: { tokens: 46_900, window: 200_000, percent: 23 }, rateLimits: [] },
    }))

    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await $.ui.mount({ plugin: 'tail-view', surface, ...PANE })

      expect(await ui.find({ text: /turn 1\/1/ })).toBeDefined()
      expect(await ui.find({ text: /Explore/ })).toBeDefined()
      expect(await ui.find({ text: /Find callers/ })).toBeDefined()
      expect(await ui.find({ text: /Execution Trace/ })).toBeUndefined()

      await ui.press({ key: 'a1' })
      expect(await ui.find({ text: /Execution Trace/ })).toBeDefined()
      expect(await ui.find({ text: /Run\(/ })).toBeDefined()

      await ui.press({ key: 'r1' })
      expect(await ui.find({ text: /package main/ })).toBeDefined()

      const colors = colorsOf(await ui.drawn())
      expect(colors.length).toBeGreaterThan(5)
      expect(colors.filter(c => !themeKeys.has(c))).toEqual([])

      await ui.press({ key: 'nav-collapse' })
      expect(await ui.find({ text: /Execution Trace/ })).toBeUndefined()
      await ui.unmount()
    }
  })

  test('never draws terminal escapes from a hostile tool result', async ($, on) => {
    const hostile: SessionMessage[] = [
      { role: 'user', text: 'fetch it', toolUses: [] },
      {
        role: 'assistant',
        text: 'done\u001b]52;c;cm0gLXJmIH4=\u0007',
        toolUses: [
          {
            tool_use_id: 'w1',
            tool: 'WebFetch',
            input: { url: 'https://x.test/a' },
            text: 'page\u001b[2J\u001b[1;1H‮gnp.exe',
          },
        ],
      },
    ]
    mock.clock(on, { now: 1_700_000_000_000 })
    on('session.messages', () => ({ value: hostile }))
    on('session.model', () => ({ value: 'claude-opus-5-5' }))
    on('agent.list', () => ({ value: [] }))
    on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200_000 }, rateLimits: [] } }))

    const ui = await $.ui.mount({ plugin: 'tail-view', surface: 'terminal', ...PANE })
    await ui.press({ key: 'nav-expand' })
    const drawn = JSON.stringify(await ui.drawn())
    expect(drawn).toContain('pagegnp.exe')
    // JSON escapes C0 controls as \u00XX; bidi controls stay raw.
    expect(drawn).not.toMatch(/\\u00(1b|07|9b)/)
    expect(drawn).not.toMatch(/[\u202a-\u202e\u2066-\u2069]/)
    await ui.unmount()
  })

  test('expands huge single-line results and long outputs without exceeding the text limit', async ($, on) => {
    const huge: SessionMessage[] = [
      { role: 'user', text: 'x'.repeat(30_000), toolUses: [] },
      {
        role: 'assistant',
        text: 'word '.repeat(4_000),
        toolUses: [
          {
            tool_use_id: 'g1',
            tool: 'Bash',
            input: { command: 'y'.repeat(20_000), blob: 'z'.repeat(20_000) },
            text: 'q'.repeat(50_000),
          },
          {
            tool_use_id: 'e1',
            tool: 'Edit',
            input: { file_path: '/a', old_string: 'o'.repeat(15_000), new_string: 'n' },
            text: 'ok',
          },
          { tool_use_id: 'j1', tool: 'Custom', input: { data: 'd'.repeat(15_000) }, text: 'ok' },
        ],
      },
    ]
    mock.clock(on, { now: 1_700_000_000_000 })
    on('session.messages', () => ({ value: huge }))
    on('session.model', () => ({ value: 'claude-opus-5-5' }))
    on('agent.list', () => ({ value: [] }))
    on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200_000 }, rateLimits: [] } }))

    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await $.ui.mount({ plugin: 'tail-view', surface, ...PANE })
      await ui.press({ key: 'nav-expand' })
      expect(await ui.find({ text: /chars hidden|lines hidden/ })).toBeDefined()
      const longest = Math.max(...textsOf(await ui.drawn()).map(t => t.length))
      expect(longest).toBeLessThan(10_000)
      await ui.unmount()
    }
  })

  test('the whole row is one button that expands and collapses', async ($, on) => {
    mock.clock(on, { now: 1_700_000_000_000 })
    on('session.messages', () => ({ value: main }))
    on('session.model', () => ({ value: 'claude-opus-5-5' }))
    on('agent.list', () => ({ value: [] }))
    on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200_000 }, rateLimits: [] } }))

    const ui = await $.ui.mount({ plugin: 'tail-view', surface: 'terminal', ...PANE })
    const row = findKey(await ui.drawn(), 'r1')
    expect(row?.type).toBe('Button')
    expect(String(row?.props?.['label'])).toContain('Read')
    expect(String(row?.props?.['label'])).toContain('b/main.go')
    expect(row?.hover?.scope).toBe('row:r1')

    await ui.press({ key: 'r1' })
    expect(await ui.find({ text: /package main/ })).toBeDefined()
    await ui.press({ key: 'r1' })
    expect(await ui.find({ text: /package main/ })).toBeUndefined()
    await ui.unmount()
  })

  test('frames the command apart from its output, colored by outcome', async ($, on) => {
    const bash: SessionMessage[] = [
      { role: 'user', text: 'test it', toolUses: [] },
      {
        role: 'assistant',
        text: '',
        toolUses: [
          {
            tool_use_id: 'ok1',
            tool: 'Bash',
            input: { command: 'go test ./...', description: 'Run tests' },
            text: 'PASS',
          },
          { tool_use_id: 'bad1', tool: 'Bash', input: { command: 'false' }, text: 'exit status 1', isError: true },
        ],
      },
    ]
    mock.clock(on, { now: 1_700_000_000_000 })
    on('session.messages', () => ({ value: bash }))
    on('session.model', () => ({ value: 'claude-opus-5-5' }))
    on('agent.list', () => ({ value: [] }))
    on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200_000 }, rateLimits: [] } }))

    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await $.ui.mount({ plugin: 'tail-view', surface, ...PANE })
      await ui.press({ key: 'nav-expand' })
      const frames = framesOf(await ui.drawn())
      const command = frames.find(f => f.text.includes('go test ./...'))
      const output = frames.find(f => f.text.includes('PASS'))
      const error = frames.find(f => f.text.includes('exit status 1'))
      expect(command?.color).toBe('permission')
      expect(command?.text).toContain('$ command')
      expect(command?.text).toContain('Run tests')
      expect(output?.color).toBe('success')
      expect(output?.text).toContain('ok · 1 line')
      expect(error?.color).toBe('error')
      expect(command?.text.includes('PASS')).toBe(false)
      await ui.unmount()
    }
  })

  test('previews a long result and shows it in full on demand', async ($, on) => {
    const lines = Array.from({ length: 500 }, (_, i) => `line ${i}`).join('\n')
    const long: SessionMessage[] = [
      { role: 'user', text: 'run it', toolUses: [] },
      {
        role: 'assistant',
        text: '',
        toolUses: [{ tool_use_id: 'b1', tool: 'Bash', input: { command: 'seq 500' }, text: lines }],
      },
    ]
    mock.clock(on, { now: 1_700_000_000_000 })
    on('session.messages', () => ({ value: long }))
    on('session.model', () => ({ value: 'claude-opus-5-5' }))
    on('agent.list', () => ({ value: [] }))
    on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200_000 }, rateLimits: [] } }))

    const ui = await $.ui.mount({ plugin: 'tail-view', surface: 'terminal', ...PANE })
    await ui.press({ key: 'b1' })
    expect(await ui.find({ text: /line 99\b/ })).toBeDefined()
    expect(await ui.find({ text: /line 499/ })).toBeUndefined()
    expect(await ui.find({ key: 'full:b1:output' })).toBeDefined()

    await ui.press({ key: 'full:b1:output' })
    expect(await ui.find({ text: /line 499/ })).toBeDefined()

    await ui.press({ key: 'full:b1:output' })
    expect(await ui.find({ text: /line 499/ })).toBeUndefined()
    await ui.unmount()
  })

  test('keeps the whole pane under the engine text budget', async ($, on) => {
    const uses = Array.from({ length: 6 }, (_, i) => ({
      tool_use_id: `h${i}`,
      tool: 'Bash',
      input: { command: 'cat big' },
      text: `${i}`.repeat(40_000),
    }))
    const heavy: SessionMessage[] = [
      { role: 'user', text: 'big', toolUses: [] },
      { role: 'assistant', text: 'word '.repeat(5_000), toolUses: uses },
    ]
    mock.clock(on, { now: 1_700_000_000_000 })
    on('session.messages', () => ({ value: heavy }))
    on('session.model', () => ({ value: 'claude-opus-5-5' }))
    on('agent.list', () => ({ value: [] }))
    on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200_000 }, rateLimits: [] } }))

    const ui = await $.ui.mount({ plugin: 'tail-view', surface: 'terminal', ...PANE })
    await ui.press({ key: 'nav-expand' })
    let pressed = 0
    for (const use of uses) {
      const key = `full:${use.tool_use_id}:output`
      if (await ui.find({ key })) {
        await ui.press({ key })
        pressed += 1
      }
    }
    expect(pressed).toBeGreaterThan(0)

    const texts = textsOf(await ui.drawn())
    expect(Math.max(...texts.map(t => t.length))).toBeLessThan(10_000)
    expect(texts.reduce((n, t) => n + t.length, 0)).toBeLessThan(100_000)
    expect(await ui.find({ text: /text budget/ })).toBeDefined()
    await ui.unmount()
  })

  test('lists the turns, newest first, and switches to the one picked', async ($, on) => {
    const three: SessionMessage[] = [
      ...main,
      { role: 'user', text: 'Now add tests', toolUses: [] },
      {
        role: 'assistant',
        text: 'Added.',
        toolUses: [{ tool_use_id: 'w1', tool: 'Write', input: { file_path: '/t.go', content: 'x' }, text: 'ok' }],
      },
      { role: 'user', text: 'Thanks', toolUses: [] },
      { role: 'assistant', text: 'You are welcome.', toolUses: [] },
    ]
    mock.clock(on, { now: 1_700_000_000_000 })
    on('session.messages', (_$, e) => ({ value: e.agentId ? child : three }))
    on('session.model', () => ({ value: 'claude-opus-5-5' }))
    on('agent.list', () => ({ value: [] }))
    on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200_000 }, rateLimits: [] } }))

    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await $.ui.mount({ plugin: 'tail-view', surface, ...PANE })
      expect(await ui.find({ text: /turn 3\/3/ })).toBeDefined()

      await ui.press({ key: 'nav-turns' })
      expect(await ui.find({ text: /Turns \(3\)/ })).toBeDefined()
      const labels = (await ui.findAll({ type: 'Button' }))
        .filter(b => String(b.key ?? '').startsWith('turn-'))
        .map(b => String(b.props['label']))
      expect(labels.length).toBe(3)
      expect(labels[0]).toContain('#3')
      expect(labels[0]).toContain('Thanks')
      expect(labels[2]).toContain('#1')
      expect(labels[2]).toContain('Fix the bug')
      expect(labels[2]).toContain('1 tool · 1 agent')
      expect(labels[2]).toContain('1 agent')

      await ui.press({ key: 'turn-0' })
      expect(await ui.find({ text: /Turns \(3\)/ })).toBeUndefined()
      expect(await ui.find({ text: /turn 1\/3/ })).toBeDefined()
      expect(await ui.find({ text: /Fix the bug/ })).toBeDefined()

      await ui.press({ key: 'nav-turns' })
      await ui.press({ key: 'nav-detail' })
      expect(await ui.find({ text: /turn 1\/3/ })).toBeDefined()
      await ui.press({ key: 'nav-latest' })
      await ui.unmount()
    }
  })

  test('shows an empty state before the first prompt', async ($, on) => {
    mock.clock(on, { now: 1_700_000_000_000 })
    on('session.messages', () => ({ value: [] }))
    on('session.model', () => ({ value: 'claude-opus-5-5' }))
    on('agent.list', () => ({ value: [] }))
    on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200_000 }, rateLimits: [] } }))

    const ui = await $.ui.mount({ plugin: 'tail-view', surface: 'terminal', ...PANE })
    expect(await ui.find({ text: /No turns yet/ })).toBeDefined()
    await ui.unmount()
  })
})

describe('info bar', () => {
  test('shows project, context and running agents', async ($, on) => {
    on('session.root', () => ({ value: '/Users/me/Sites/claude/my-claude-tui' }))
    on('agent.list', () => ({ value: [{ id: 'x', description: 'd', type: 'Explore', status: 'running' as const }] }))
    on('session.usage', () => ({
      value: {
        startedAt: 0,
        context: { tokens: 52_700, window: 200_000, percent: 26 },
        rateLimits: [],
        cost: { usd: 1.5 },
      },
    }))

    const ui = await $.ui.mount({
      plugin: 'tail-view',
      surface: 'terminal',
      component: 'AbovePrompt',
      props: {
        hasSurvey: false,
        isWorking: false,
        maxRows: 10,
        bodyColumns: 120,
        scroll: { offset: 0, bodyRows: 10 },
        view: {},
      },
    })
    expect(await ui.find({ text: /my-claude-tui/ })).toBeDefined()
    expect(await ui.find({ text: /52\.7k ctx/ })).toBeDefined()
    expect(await ui.find({ text: /26%/ })).toBeDefined()
    expect(await ui.find({ text: /agents running · 1/ })).toBeDefined()
    expect(await ui.find({ text: /\$1\.50/ })).toBeDefined()
    expect(colorsOf(await ui.drawn()).filter(c => !themeKeys.has(c))).toEqual([])
    await ui.unmount()
  })
})

describe('/tail theme', () => {
  const themeRow = (value: string): ConfigRow => ({
    key: 'theme',
    label: 'Theme',
    kind: 'choice',
    value,
    provider: { plugin: 'engine', tier: 'core' },
    isLocked: false,
  })
  const RUN_THEME = {
    command: 'tail',
    args: 'theme',
    origin: { kind: 'composer' },
    presentation: { isFullscreen: true, columns: 160 },
  } as CommandRunInput

  test('advises the matching tail-view theme without writing config', async ($, on) => {
    let writes = 0
    on('config.list', () => ({ value: [themeRow('dark-daltonized')] }))
    on('config.set', (_$, e) => {
      writes += 1
      return { value: e.value }
    })

    const ran = await $.command.run(RUN_THEME)
    expect(writes).toBe(0)
    expect(ran.text).toContain('"Tail Dark (colorblind-friendly)"')
  })

  test('says the variants are missing when /theme does not offer them', async ($, on) => {
    on('config.list', () => ({ value: [{ ...themeRow('dark'), options: ['dark', 'light', 'auto'] }] }))
    const ran = await $.command.run(RUN_THEME)
    expect(ran.text).toContain('not loaded')
  })

  test('leaves auto to /theme without writing', async ($, on) => {
    let writes = 0
    on('config.list', () => ({ value: [themeRow('auto')] }))
    on('config.set', (_$, e) => {
      writes += 1
      return { value: e.value }
    })

    const ran = await $.command.run(RUN_THEME)
    expect(writes).toBe(0)
    expect(ran.text).toContain('/theme')
  })
})

describe('compact transcript', () => {
  const RESULT = {
    component: 'ToolResult',
    requestId: 'b1',
    props: {
      tool_use_id: 'b1',
      tool: 'Bash',
      output: { stdout: 'a\nb\nc', stderr: '', interrupted: false },
      isErrored: false,
    },
  } as const
  const RUN = (args: string) =>
    ({
      command: 'tail',
      args,
      origin: { kind: 'composer' },
      presentation: { isFullscreen: true, columns: 200 },
    }) as CommandRunInput

  test('draws a tool result as one line and restores it on /tail compact', async ($, on) => {
    mock.store(on)
    on('ui.render', { component: 'ToolResult' }, ($, e) => {
      const { Text } = $.ui.resolve(e)
      return <Text>engine result</Text>
    })

    const ui = await $.ui.mount({ plugin: 'tail-view', surface: 'terminal', ...RESULT })
    expect(await ui.find({ text: /⎿ 3 lines/ })).toBeDefined()
    expect(await ui.find({ text: /engine result/ })).toBeUndefined()
    await ui.unmount()

    expect((await $.command.run(RUN('compact'))).text).toContain('off')
    const full = await $.ui.mount({ plugin: 'tail-view', surface: 'terminal', ...RESULT })
    expect(await full.find({ text: /engine result/ })).toBeDefined()
    await full.unmount()
  })

  test('keeps an error visible in red', async ($, on) => {
    mock.store(on)
    const ui = await $.ui.mount({
      plugin: 'tail-view',
      surface: 'terminal',
      ...RESULT,
      props: { ...RESULT.props, output: 'Error: boom\nstack', isErrored: true },
    })
    const line = await ui.find({ text: /error: Error: boom/ })
    expect(line?.props['color']).toBe('error')
    await ui.unmount()
  })

  test('/tail opens the pane at the stored width share', async ($, on) => {
    mock.store(on)
    on('session.surfaces', () => ({ value: ['terminal' as const] }))
    const opened: (number | undefined)[] = []
    on('ui.panes', () => ({ value: [] }))
    on('ui.open', (_$, e) => {
      opened.push(e.columns)
      return { value: { isPlaced: true as const } }
    })

    await $.command.run(RUN(''))
    // Default share: 80 % of 200 columns, the transcript keeping its 40.
    expect(opened.at(-1)).toBe(160)

    expect((await $.command.run(RUN('width 70'))).text).toContain('70%')
    await $.command.run(RUN(''))
    expect(opened.at(-1)).toBe(140)

    expect((await $.command.run(RUN('width 99'))).text).toContain('between 30 and 80')
    await $.command.run(RUN(''))
    expect(opened.at(-1)).toBe(140)
  })
})

describe('commands', () => {
  const run = (command: string, args = '') =>
    ({
      command,
      args,
      origin: { kind: 'composer' },
      presentation: { isFullscreen: true, columns: 200 },
    }) as CommandRunInput

  test('registers every subcommand as its own slash command', async ($, on) => {
    const names: string[] = []
    on('command.register', (_$, e) => {
      names.push(e.name)
      return { value: { command: e.name } }
    })
    on('process.run', () => ({
      value: { exitCode: 1, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
    }))
    on('session.cwd', () => ({ value: '/tmp' }))
    on('ui.open', () => ({ value: { isPlaced: false as const, reason: 'test' } }))
    on('session.start', (_$, e) => ({ cwd: e.cwd }))
    await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true } as never)
    expect(names.sort()).toEqual([
      'tail',
      'tail-bar',
      'tail-compact',
      'tail-help',
      'tail-theme',
      'tail-turns',
      'tail-width',
    ])
  })

  test('/tail and /tail-turns answer in text where no pane is drawn', async ($, on) => {
    mock.store(on)
    let surfaces: RenderSurface[] = ['vscode']
    let opened = 0
    on('session.surfaces', () => ({ value: surfaces }))
    on('session.messages', () => ({ value: main }))
    on('ui.open', () => {
      opened += 1
      return { value: { isPlaced: true as const } }
    })

    for (const shown of [['vscode'], []] as RenderSurface[][]) {
      surfaces = shown
      const detail = await $.command.run(run('tail'))
      expect(detail.text).toContain('❯ Fix the bug')
      expect(detail.text).toContain('Explore')
      expect((await $.command.run(run('tail-turns'))).text).toContain('#1')
    }
    expect(opened).toBe(0)
  })

  test('/tail-help and /tail help list every command', async ($, on) => {
    mock.store(on)
    for (const ran of [await $.command.run(run('tail-help')), await $.command.run(run('tail', 'help'))]) {
      for (const name of ['/tail-turns', '/tail-theme', '/tail-width', '/tail-compact', '/tail-bar', '/tail-help'])
        expect(ran.text).toContain(name)
    }
  })

  test('/tail-width and /tail-theme work like their /tail forms', async ($, on) => {
    mock.store(on)
    on('session.surfaces', () => ({ value: ['terminal' as const] }))
    const opened: (number | undefined)[] = []
    on('ui.panes', () => ({ value: [] }))
    on('ui.open', (_$, e) => {
      opened.push(e.columns)
      return { value: { isPlaced: true as const } }
    })
    on('config.list', () => ({
      value: [
        {
          key: 'theme',
          label: 'Theme',
          kind: 'choice',
          value: 'light',
          provider: { plugin: 'engine', tier: 'core' },
          isLocked: false,
        },
      ],
    }))

    expect((await $.command.run(run('tail-width', '75'))).text).toContain('75%')
    await $.command.run(run('tail'))
    expect(opened.at(-1)).toBe(150)
    expect((await $.command.run(run('tail-theme'))).text).toContain('"Tail Light"')
  })
})

describe('compact tool calls', () => {
  const USE = {
    component: 'ToolUse',
    requestId: 'b9',
    props: {
      tool_use_id: 'b9',
      tool: 'Bash',
      input: { command: "python3 - <<'EOF'\nprint(1)\nprint(2)\nEOF", description: 'Run the script' },
      isRunning: false,
      isErrored: false,
      isInterrupted: false,
    },
  } as const

  test('draws a tool call as one line with its summary', async ($, on) => {
    mock.store(on)
    on('ui.render', { component: 'ToolUse' }, ($, e) => {
      const { Text } = $.ui.resolve(e)
      return <Text>engine row</Text>
    })

    const ui = await $.ui.mount({ plugin: 'tail-view', surface: 'terminal', ...USE })
    const texts = textsOf(await ui.drawn()).join('')
    expect(texts).toContain('Bash')
    expect(texts).toContain('Run the script')
    expect(texts).not.toContain('print(2)')
    expect(texts).not.toContain('\n')
    expect(await ui.find({ text: /engine row/ })).toBeUndefined()
    await ui.unmount()
  })

  test('marks running, failed and interrupted calls', async ($, on) => {
    mock.store(on)
    for (const [state, color] of [
      [{ isRunning: true }, 'success'],
      [{ isErrored: true }, 'error'],
      [{ isInterrupted: true }, 'warning'],
    ] as const) {
      const ui = await $.ui.mount({
        plugin: 'tail-view',
        surface: 'terminal',
        ...USE,
        props: { ...USE.props, ...state },
      })
      expect(colorsOf(await ui.drawn())).toContain(color)
      await ui.unmount()
    }
  })
})

describe('what the plugin runs and touches', () => {
  test('reads the branch from .git/HEAD and starts no program', async ($, on) => {
    mock.store(on)
    const reads: string[] = []
    let ranProgram = false
    on('process.run', () => {
      ranProgram = true
      return { value: { exitCode: 1, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    })
    on('session.repo', () => ({ value: { root: '/r', remote: null, internal: false, name: null } }))
    on('fs.stat', (_$, e) => ({
      value: { kind: e.path === '/r/.git' ? ('dir' as const) : ('file' as const), size: 0, mtimeMs: 0, isLink: false },
    }))
    on('fs.read', (_$, e) => {
      reads.push(e.path)
      return { value: 'ref: refs/heads/feat/turns\n' }
    })
    on('session.root', () => ({ value: '/r' }))
    on('agent.list', () => ({ value: [] }))
    on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200_000 }, rateLimits: [] } }))
    on('command.register', (_$, e) => ({ value: { command: e.name } }))
    on('ui.open', () => ({ value: { isPlaced: false as const, reason: 'test' } }))
    on('session.start', (_$, e) => ({ cwd: e.cwd }))

    await $.session.start({ cwd: '/r', surface: 'terminal', isInteractive: true } as never)
    // The branch is read detached from session.start; wait for it.
    const timers = globalThis as unknown as { setTimeout: (run: () => void, ms: number) => void }
    for (let i = 0; i < 100 && reads.length === 0; i++)
      await new Promise<void>(resolve => timers.setTimeout(resolve, 5))
    await new Promise<void>(resolve => timers.setTimeout(resolve, 20))

    expect(reads).toEqual(['/r/.git/HEAD'])
    expect(ranProgram).toBe(false)
    const ui = await $.ui.mount({
      plugin: 'tail-view',
      surface: 'terminal',
      component: 'AbovePrompt',
      props: {
        hasSurvey: false,
        isWorking: false,
        maxRows: 10,
        bodyColumns: 120,
        scroll: { offset: 0, bodyRows: 10 },
        view: {},
      },
    })
    expect(await ui.find({ text: /feat\/turns/ })).toBeDefined()
    await ui.unmount()
  })

  test('commands that are not tail-view pass by untouched', async ($, on) => {
    mock.store(on)
    on('command.run', (_$, e) => ({ text: `engine ran /${e.command}` }))
    const ran = await $.command.run({
      command: 'compact',
      args: 'tail',
      origin: { kind: 'composer' },
      presentation: { isFullscreen: true, columns: 200 },
    } as CommandRunInput)
    expect(ran.text).toBe('engine ran /compact')
  })
})
