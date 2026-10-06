import { describe, expect, test } from 'claude-code/testing'
import { ICON_SETS } from '../hooks/icons'
import { buildTurns } from '../hooks/model/turns'
import { displayWidth } from '../hooks/model/width'
import { renderBar } from '../hooks/view/bar'
import { renderPane } from '../hooks/view/pane'
import { act, base, el, foldedOpen, foldedTimings, foldedTurn, nodes, text } from './fixtures/view'

describe('context meter', () => {
  test('the header of the latest turn and the info bar draw the meter in the context color', () => {
    const latest = renderPane(el, { ...base, selected: 1, isLatest: true }, act)
    expect(text(latest)).toContain('▰▰▰▰▰▰▱▱▱▱ 62%')
    expect(nodes(latest).some(n => n.props['color'] === 'warning' && text(n).includes('▰▰▰▰▰▰▱▱▱▱ 62%'))).toBe(true)
    expect(text(renderPane(el, base, act))).not.toContain('▰')
    expect(text(renderPane(el, { ...base, selected: 1, isLatest: true, icons: ICON_SETS.ascii }, act))).toContain(
      '######---- 62%',
    )

    const bar = (columns: number, icons = ICON_SETS.nerd) =>
      renderBar(el, {
        project: 'tail',
        git: null,
        mode: null,
        runningAgents: 0,
        contextTokens: 5000,
        contextPercent: 85,
        columns,
        icons,
      })
    expect(text(bar(100))).toContain('5.0k ctx ▰▰▰▰▰▰▰▰▰▱ 85%')
    expect(text(bar(99))).not.toContain('▰')
    expect(text(bar(99))).toContain('85%')
    expect(nodes(bar(100)).some(n => n.props['color'] === 'error' && text(n).includes('▰▰▰▰▰▰▰▰▰▱ 85%'))).toBe(true)
    expect(text(bar(120, ICON_SETS.ascii))).toContain('#########- 85%')
  })
})

describe('renderBar', () => {
  test('a running Workflow shows as a badge', () => {
    const bar = (workflow: { isRunning: true; agents: number } | { isRunning: false }) =>
      renderBar(el, { project: 'tail', git: null, mode: null, runningAgents: 0, columns: 80, workflow })
    const running = bar({ isRunning: true, agents: 2 })
    expect(text(running)).toBe('tail · workflow running · 2 agents')
    expect(nodes(running).some(n => n.props['color'] === 'success' && text(n).includes('workflow running'))).toBe(true)
    expect(text(bar({ isRunning: true, agents: 1 }))).toBe('tail · workflow running · 1 agent')
    expect(text(bar({ isRunning: true, agents: 0 }))).toBe('tail · workflow running')
    expect(text(bar({ isRunning: false }))).toBe('tail')
  })

  test('project, branch, mode, agents, context and cost', () => {
    const tree = renderBar(el, {
      project: 'tail',
      git: { branch: 'main' },
      mode: 'plan',
      runningAgents: 2,
      contextTokens: 52_700,
      contextPercent: 85,
      costUsd: 1.5,
      columns: 100,
    })
    const all = text(tree)
    for (const part of ['tail', 'main', 'plan', 'agents running · 2', '52.7k ctx', '85%', '$1.50']) {
      expect(all).toContain(part)
    }
    expect(nodes(tree).some(n => n.props['color'] === 'error' && text(n).includes('85%'))).toBe(true)
  })

  test('omits what it does not know', () => {
    const all = text(renderBar(el, { project: 'tail', git: null, mode: null, runningAgents: 0, columns: 80 }))
    expect(all).toBe('tail')
  })
})

describe('group and bar regressions', () => {
  test('hover scopes stay unique and within 64 characters with groups open', () => {
    const tree = renderPane(el, { ...base, turns: foldedTurn, timings: foldedTimings, expanded: foldedOpen }, act)
    const scopes = nodes(tree)
      .map(n => (n.props['hover'] as { scope?: string } | undefined)?.scope)
      .filter((scope): scope is string => scope !== undefined)
    for (const scope of new Set(scopes)) {
      expect(scope.length).toBeGreaterThanOrEqual(1)
      expect(scope.length).toBeLessThanOrEqual(64)
    }
    expect(scopes).toContain('row:group:fr1')
    expect(scopes).toContain('row:fr1')
  })

  test('the pane text stays within the engine limit with a thousand folded calls', () => {
    const many = buildTurns([
      { role: 'user', text: 'go', toolUses: [] },
      {
        role: 'assistant',
        text: '',
        toolUses: Array.from({ length: 1000 }, (_, n) => ({
          tool_use_id: `m${n}`,
          tool: 'Read',
          input: { file_path: `/s/${n}.ts` },
          text: 'x'.repeat(50),
        })),
      },
    ])
    const tree = renderPane(el, { ...base, turns: many, expanded: new Set(['group:m0']) }, act)
    expect(text(tree).length).toBeLessThan(100_000)
  })
})

describe('one line', () => {
  const data = (columns: number) => ({
    project: 'my-claude-tui',
    git: { branch: 'feat/footer-collapsed' } as never,
    mode: 'plan',
    runningAgents: 2,
    contextTokens: 46_900,
    contextPercent: 34,
    costUsd: 1.5,
    columns,
  })

  for (const columns of [34, 60, 120]) {
    test(`at ${columns} cells the bar fits one line`, () => {
      expect(displayWidth(text(renderBar(el, data(columns))))).toBeLessThanOrEqual(columns)
    })
  }

  test('parts drop from the lowest priority: cost, tokens, meter, agents, mode, branch', () => {
    const at34 = text(renderBar(el, data(34)))
    expect(at34).toContain('34%')
    expect(at34).toContain('my-claude-tui')
    expect(at34).not.toContain('$1.50')
    const at60 = text(renderBar(el, data(60)))
    expect(at60).toContain('feat/footer-collapsed')
  })

  test('a bar of 8 cells keeps the percent only', () => {
    expect(text(renderBar(el, data(8))).trim()).toBe('34%')
  })

  test('a project too long for its room is cut, never wrapped', () => {
    const long = {
      ...data(30),
      project: 'a-very-long-project-name-that-goes-on',
      git: null,
      mode: null,
      runningAgents: 0,
    }
    const all = text(renderBar(el, long))
    expect(displayWidth(all)).toBeLessThanOrEqual(30)
    expect(all).toContain('34%')
  })
})
