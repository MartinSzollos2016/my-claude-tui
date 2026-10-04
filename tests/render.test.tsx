import type { SessionMessage } from 'claude-code'
import { describe, expect, mock, test } from 'claude-code/testing'

import { THEME_KEYS } from '../hooks/theme'

const themeKeys = new Set<string>(THEME_KEYS)

// Every color in a drawn tree, so a raw color slipping past the types fails.
function colorsOf(node: unknown, found: string[] = []): string[] {
  if (Array.isArray(node)) {
    for (const child of node) colorsOf(child, found)
  } else if (node !== null && typeof node === 'object') {
    const { props, children } = node as { props?: Record<string, unknown>; children?: unknown }
    for (const key of ['color', 'backgroundColor', 'borderColor']) {
      if (typeof props?.[key] === 'string') found.push(props[key] as string)
    }
    colorsOf(children, found)
  }
  return found
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
      { tool_use_id: 'a1', tool: 'Agent', input: { subagent_type: 'Explore', description: 'Find callers' }, agentId: 'agent-1', text: 'done', durationMs: 4200 },
    ],
  },
]

const child: SessionMessage[] = [
  { role: 'user', text: 'Find callers', toolUses: [] },
  { role: 'assistant', text: '', toolUses: [{ tool_use_id: 'g1', tool: 'Grep', input: { pattern: 'Run(' }, text: '3 matches' }] },
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
    on('session.messages', (_$, e) => ({ value: (e.agentId === 'agent-1' ? child : main) }))
    on('session.model', () => ({ value: 'claude-opus-5-5' }))
    on('agent.list', () => ({ value: [] }))
    on('session.usage', () => ({ value: ({ startedAt: 0, context: { tokens: 46_900, window: 200_000, percent: 23 }, rateLimits: [] }) }))

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
        toolUses: [{ tool_use_id: 'w1', tool: 'WebFetch', input: { url: 'https://x.test/a' }, text: 'page\u001b[2J\u001b[1;1H‮gnp.exe' }],
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
          { tool_use_id: 'g1', tool: 'Bash', input: { command: 'y'.repeat(20_000), blob: 'z'.repeat(20_000) }, text: 'q'.repeat(50_000) },
          { tool_use_id: 'e1', tool: 'Edit', input: { file_path: '/a', old_string: 'o'.repeat(15_000), new_string: 'n' }, text: 'ok' },
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

  test('shows an empty state before the first prompt', async ($, on) => {
    mock.clock(on, { now: 1_700_000_000_000 })
    on('session.messages', () => ({ value: [] }))
    on('session.model', () => ({ value: 'claude-opus-5-5' }))
    on('agent.list', () => ({ value: [] }))
    on('session.usage', () => ({ value: ({ startedAt: 0, context: { window: 200_000 }, rateLimits: [] }) }))

    const ui = await $.ui.mount({ plugin: 'tail-view', surface: 'terminal', ...PANE })
    expect(await ui.find({ text: /No turns yet/ })).toBeDefined()
    await ui.unmount()
  })
})

describe('info bar', () => {
  test('shows project, context and running agents', async ($, on) => {
    on('session.root', () => ({ value: '/Users/me/Sites/claude/my-claude-tui' }))
    on('agent.list', () => ({ value: [{ id: 'x', description: 'd', type: 'Explore', status: 'running' as const }] }))
    on('session.usage', () => ({ value: ({ startedAt: 0, context: { tokens: 52_700, window: 200_000, percent: 26 }, rateLimits: [], cost: { usd: 1.5 } }) }))

    const ui = await $.ui.mount({
      plugin: 'tail-view',
      surface: 'terminal',
      component: 'AbovePrompt',
      props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 120, scroll: { offset: 0, bodyRows: 10 }, view: {} },
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
