import { describe, expect, test } from 'claude-code/testing'
import { ICON_SETS } from '../hooks/icons'
import { C, modelColor } from '../hooks/theme'
import { buildTurns } from '../hooks/model/turns'
import { displayWidth } from '../hooks/model/width'
import { renderBar } from '../hooks/view/bar'
import { renderPane } from '../hooks/view/pane'
import {
  act,
  acts,
  base,
  byKey,
  calls,
  el,
  foldedOpen,
  foldedTimings,
  foldedTurn,
  measured,
  nodes,
  text,
  type Node,
} from './fixtures/view'

describe('renderPane', () => {
  test('Workflow row says running, done or no result', () => {
    const wf = (text?: string) =>
      buildTurns([
        { role: 'user', text: 'go', toolUses: [] },
        {
          role: 'assistant',
          text: '',
          toolUses: [{ tool_use_id: 'w1', tool: 'Workflow', input: { name: 'review' }, ...(text ? { text } : {}) }],
        },
      ])
    const label = (turns: ReturnType<typeof wf>, isWorking: boolean) =>
      String(byKey(renderPane(el, { ...base, turns, isLatest: true, isWorking }, act), 'w1')?.props['label'])
    expect(label(wf(), true)).toContain('review · running')
    expect(label(wf(), false)).toContain('review · no result')
    expect(label(wf('ok'), false)).toContain('review · done')
  })

  test('the header counts thinking blocks and the Thinking row opens its text', () => {
    const quiet = renderPane(el, { ...base, thinking: { count: 3, text: '' } }, act)
    expect(text(quiet)).toContain('\u{F09D1} 3')
    expect(byKey(quiet, 't0:thinking')).toBeUndefined()

    const thinking = { count: 1, text: 'Plan the fix' }
    const tree = renderPane(el, { ...base, thinking }, act)
    expect(String(byKey(tree, 't0:thinking')?.props['label'])).toContain('Thinking')
    ;(byKey(tree, 't0:thinking')?.props['onPress'] as () => void)()
    expect(calls).toContain('toggle:t0:thinking')

    const open = renderPane(el, { ...base, thinking, expanded: new Set(['t0:thinking']) }, act)
    // Markdown is drawn in the terminal's own foreground, unreadable on the
    // pane's theme background; prose goes through Code's markdown highlighting.
    expect(
      nodes(open).some(
        n => n.type === 'Code' && n.props['language'] === 'markdown' && n.props['source'] === 'Plan the fix',
      ),
    ).toBe(true)
    expect(nodes(open).some(n => n.type === 'Markdown')).toBe(false)
    expect(byKey(open, 'copy:t0:thinking')).toBeDefined()
  })

  test('header, prompt, navigation and one row per item', () => {
    const tree = renderPane(el, base, act)
    const all = text(tree)
    expect(all).not.toContain('ctx')
    expect(text(renderPane(el, { ...base, selected: 1, isLatest: true }, act))).toContain('62%')
    expect(all).toContain('opus5.5')
    expect(all).toContain('1.5k')
    expect(all).toContain('1m 5s')
    expect(all).toContain('❯ Fix the bug')
    expect(all).toContain('1/2')
    expect(byKey(tree, 'b1')?.props['label']).toContain('Run tests')
    expect(all).toContain('2.5s')
    expect(all).toContain('haiku4.5')
    expect(acts(tree, 'nav-prev')).toBe(false)
    expect(acts(tree, 'nav-latest')).toBe(true)
    const mid = renderPane(el, { ...base, selected: 1 }, act)
    expect(acts(mid, 'nav-prev')).toBe(true)
    expect(acts(mid, 'nav-next')).toBe(false)
    const last = renderPane(el, { ...base, selected: 1, isLatest: true }, act)
    expect(acts(last, 'nav-prev')).toBe(true)
    expect(acts(last, 'nav-next')).toBe(false)
    expect(acts(last, 'nav-latest')).toBe(false)
  })

  test('every tool row starts with a status glyph, outputs and thinking keep the column blank', () => {
    const glyph = (tree: unknown, id: string) => text(byKey(tree, `status-${id}`))
    const color = (tree: unknown, id: string) => byKey(tree, `status-${id}`)?.props['color']
    const quiet = renderPane(el, base, act)
    expect(glyph(quiet, 'b1')).toBe('✓ ')
    expect(color(quiet, 'b1')).toBe('success')
    expect(glyph(quiet, 'e1')).toBe('✗ ')
    expect(color(quiet, 'e1')).toBe('error')
    expect(glyph(quiet, 'p1')).toBe('· ')
    expect(color(quiet, 'p1')).toBe('inactive')
    expect(glyph(quiet, 'a1')).toBe('⠋ ')

    const live = renderPane(el, { ...base, isLatest: true, isWorking: true, frame: 1 }, act)
    expect(glyph(live, 'p1')).toBe('⠙ ')
    expect(color(live, 'p1')).toBe('success')

    const stopped = buildTurns([
      { role: 'user', text: 'go', toolUses: [] },
      {
        role: 'assistant',
        text: 'o',
        toolUses: [
          {
            tool_use_id: 's1',
            tool: 'Bash',
            input: {},
            text: '[Request interrupted by user for tool use]',
            isError: true,
          },
        ],
      },
    ])
    const paused = renderPane(el, { ...base, turns: stopped, agents: new Map() }, act)
    expect(glyph(paused, 's1')).toBe('⏸ ')
    expect(color(paused, 's1')).toBe('warning')

    // Output rows draw a blank of the same width, so the columns line up.
    expect(glyph(quiet, 't0:o0')).toBe('  ')
  })

  test('the icon set in the data replaces every glyph, the default is Nerd Font', () => {
    const nerd = text(renderPane(el, base, act))
    expect(nerd).toContain(ICON_SETS.nerd.robot)
    const ascii = text(renderPane(el, { ...base, icons: ICON_SETS.ascii, frame: 2 }, act))
    expect(ascii).not.toContain(ICON_SETS.nerd.robot)
    expect(ascii).not.toContain(ICON_SETS.nerd.wrench)
    expect(ascii).toContain(ICON_SETS.ascii.robot)
    expect(text(byKey(renderPane(el, { ...base, icons: ICON_SETS.ascii }, act), 'status-b1'))).toBe('+ ')
    expect(text(byKey(renderPane(el, { ...base, icons: ICON_SETS.ascii, frame: 2 }, act), 'status-a1'))).toBe('- ')
    expect(text(byKey(renderPane(el, { ...base, icons: ICON_SETS.unicode }, act), 'status-b1'))).toBe('✓ ')
    expect(text(byKey(renderPane(el, { ...base, icons: ICON_SETS.ascii }, act), 'status-e1'))).toBe('x ')
  })

  test('the info bar draws its glyphs from the chosen set', () => {
    const bar = (icons?: (typeof ICON_SETS)['nerd']) =>
      text(
        renderBar(el, {
          project: 'tail',
          git: { branch: 'main' },
          mode: null,
          runningAgents: 0,
          columns: 80,
          ...(icons ? { icons } : {}),
        }),
      )
    expect(bar()).toContain(ICON_SETS.nerd.branch)
    expect(bar(ICON_SETS.ascii)).toBe('tail . ^ main')
  })

  test('a path in a row is cut in the middle, file name last; path-only headers truncate in the middle', () => {
    const path = '/home/dev/project/src/server/auth/session.ts'
    const long = buildTurns([
      { role: 'user', text: 'go', toolUses: [] },
      {
        role: 'assistant',
        text: '',
        toolUses: [
          { tool_use_id: 'r9', tool: 'Read', input: { file_path: path }, text: 'x' },
          { tool_use_id: 'w9', tool: 'Write', input: { file_path: path, content: 'x' }, text: 'ok' },
        ],
      },
    ])
    const tree = renderPane(el, { ...base, turns: long, columns: 50, expanded: new Set(['w9']) }, act)
    const label = String(byKey(tree, 'r9')?.props['label'])
    expect(label).toContain('…')
    expect(label.endsWith('session.ts')).toBe(true)
    const wide = renderPane(el, { ...base, turns: long, columns: 120 }, act)
    expect(String(byKey(wide, 'r9')?.props['label'])).toContain('dev/project/src/server/auth/session.ts')
    const meta = nodes(tree).find(n => n.type === 'Text' && text(n).trim() === path)
    expect(meta?.props['wrap']).toBe('truncate-middle')
  })

  test('an error frame is titled with a red bold cross and shows the first error line above the preview', () => {
    const failed = buildTurns([
      { role: 'user', text: 'go', toolUses: [] },
      {
        role: 'assistant',
        text: '',
        toolUses: [
          {
            tool_use_id: 'f1',
            tool: 'Bash',
            input: { command: 'tsc' },
            text: 'compiling\nsrc/a.ts:3: error TS2304: nope\nmore output',
            isError: true,
          },
        ],
      },
    ])
    const tree = renderPane(el, { ...base, turns: failed, expanded: new Set(['f1']) }, act)
    const frame = nodes(tree).find(n => n.type === 'Box' && n.props['borderColor'] === 'error')
    const title = nodes(frame).find(n => n.type === 'Text' && n.props['bold'] === true)
    expect(text(title)).toBe('✗ error')
    expect(title?.props['color']).toBe(C.error)
    const lines = nodes(frame).filter(n => n.type === 'Text' && n.props['color'] === C.error)
    expect(lines.map(n => text(n))).toEqual([
      '✗ error',
      'src/a.ts:3: error TS2304: nope',
      expect.stringContaining('compiling'),
    ])
    expect(lines[1]?.props['wrap']).toBe('truncate-end')
    const ascii = renderPane(el, { ...base, turns: failed, expanded: new Set(['f1']), icons: ICON_SETS.ascii }, act)
    expect(text(ascii)).toContain('x error')
    // A succeeded call gets neither.
    const ok = renderPane(el, { ...base, expanded: new Set(['b1']) }, act)
    expect(text(ok)).not.toContain('✗ error')
  })

  test('the ascii set draws only ASCII: every string, every border, every truncation', () => {
    const path = '/home/dev/project/src/server/auth/session.ts'
    const many = buildTurns([
      { role: 'user', text: `go ${'long prompt '.repeat(40)}`, toolUses: [] },
      {
        role: 'assistant',
        text: 'Done.',
        toolUses: [
          { tool_use_id: 'x1', tool: 'Read', input: { file_path: path }, text: 'x' },
          { tool_use_id: 'x2', tool: 'Write', input: { file_path: path, content: 'x' }, text: 'ok' },
          {
            tool_use_id: 'x3',
            tool: 'Edit',
            input: { file_path: path, old_string: 'a', new_string: 'b' },
            text: 'bad: error',
            isError: true,
          },
          {
            tool_use_id: 'x4',
            tool: 'Bash',
            input: { command: 'seq 300', description: 'd'.repeat(200) },
            text: Array.from({ length: 300 }, (_, n) => `line ${n}`).join('\n'),
          },
          {
            tool_use_id: 'x5',
            tool: 'TodoWrite',
            input: {
              todos: [
                { content: 'a', status: 'completed' },
                { content: 'b', status: 'in_progress' },
                { content: 'c', status: 'pending' },
              ],
            },
            text: 'ok',
          },
          { tool_use_id: 'x6', tool: 'Workflow', input: { name: 'review' } },
          {
            tool_use_id: 'x7',
            tool: 'Agent',
            input: { subagent_type: 'Explore', description: 'Find' },
            agentId: 'ag',
            text: 'r',
          },
        ],
      },
    ])
    const trace = buildTurns(
      [
        {
          role: 'assistant',
          text: 'ok',
          toolUses: [{ tool_use_id: 'g', tool: 'Grep', input: { pattern: 'x', path }, text: 'm' }],
        },
      ],
      'ag/',
    )
    const members = [{ name: 'alice', type: 'teammate', status: 'running' as const }]
    const tasks = [
      { id: '1', subject: 'Write tests', status: 'in_progress', owner: 'alice' },
      { id: '2', subject: 'Ship', status: 'completed' },
      { id: '3', subject: 'Later', status: 'pending' },
    ]
    const open = new Set(['x1', 'x2', 'x3', 'x4', 'x5', 'x7', 't0:o0', 't0:thinking'])
    const numbered = Array.from({ length: 90 }, (_, n) => `${n + 1}→const v${n} = ${n}`).join('\n')
    const rich = buildTurns([
      { role: 'user', text: 'go', toolUses: [] },
      {
        role: 'assistant',
        text: '',
        toolUses: [
          {
            tool_use_id: 'r1',
            tool: 'Read',
            input: { file_path: '/src/a.ts' },
            text: numbered,
          },
          {
            tool_use_id: 'r2',
            tool: 'Edit',
            input: {
              file_path: '/src/a.ts',
              old_string: 'a\nb',
              new_string: Array.from({ length: 150 }, (_, n) => `n${n}`).join('\n'),
            },
            text: 'ok',
          },
          {
            tool_use_id: 'r3',
            tool: 'MultiEdit',
            input: {
              file_path: '/src/a.ts',
              edits: [
                { old_string: 'x', new_string: 'y' },
                { old_string: 'p', new_string: 'q' },
              ],
            },
            text: 'ok',
          },
        ],
      },
    ])
    const richOpen = new Set(['r1', 'r2', 'r3'])

    const ascii = { ...base, turns: many, icons: ICON_SETS.ascii, columns: 70, agents: new Map() }
    const trees = [
      renderPane(
        el,
        {
          ...ascii,
          expanded: open,
          thinking: { count: 1, text: 'Plan' },
          traces: new Map([['ag', { items: trace[0]!.items }]]),
          isLatest: true,
          isWorking: true,
          members,
          tasks,
        },
        act,
      ),
      renderPane(el, { ...ascii, expanded: open, traces: new Map([['ag', { denied: 'gone' }]]) }, act),
      renderPane(el, { ...ascii, expanded: new Set(['x7']) }, act),
      renderPane(
        el,
        { ...ascii, turns: buildTurns([{ role: 'user', text: 'hi', toolUses: [] }]), isLatest: true, isWorking: true },
        act,
      ),
      renderPane(el, { ...ascii, expanded: open, full: new Set(['x4:output']) }, act),
      renderPane(
        el,
        {
          ...ascii,
          view: 'turns',
          stats: [base.turnStat],
          query: 'long',
          matches: [{ index: 0, snippet: '...a long prompt ...' }],
        },
        act,
      ),
      renderPane(el, { ...ascii, view: 'turns', query: 'zzz', matches: [] }, act),
      renderPane(el, { ...ascii, view: 'team', members, tasks }, act),
      renderPane(el, { ...ascii, turns: [] }, act),
      renderPane(el, { ...ascii, view: 'team' }, act),
      renderPane(el, { ...ascii, selected: 1, isLatest: true }, act),
      renderPane(el, { ...ascii, isFocused: true }, act),
      renderPane(el, { ...ascii, isFocused: false }, act),
      renderBar(el, {
        project: 'tail',
        git: null,
        mode: null,
        runningAgents: 0,
        contextTokens: 5000,
        contextPercent: 70,
        columns: 120,
        icons: ICON_SETS.ascii,
      }),
      renderBar(el, {
        project: 'tail',
        git: { branch: 'main' },
        mode: 'plan',
        runningAgents: 1,
        contextTokens: 5000,
        contextPercent: 5,
        costUsd: 1,
        columns: 80,
        icons: ICON_SETS.ascii,
        workflow: { isRunning: true, agents: 2 },
      }),
    ]
    trees.push(
      renderPane(el, { ...ascii, turns: rich, expanded: richOpen }, act),
      renderPane(el, { ...ascii, turns: rich, expanded: richOpen, full: new Set(['r2:diff', 'r1:output']) }, act),
    )
    const folded = { ...ascii, turns: foldedTurn.map(t => ({ ...t, prompt: 'fold' })), timings: foldedTimings }
    trees.push(
      renderPane(el, folded, act),
      renderPane(el, { ...folded, expanded: foldedOpen }, act),
      renderPane(el, { ...folded, expanded: foldedOpen, columns: 60 }, act),
      renderPane(
        el,
        {
          ...folded,
          view: 'turns',
          stats: [{ ...foldedStats[0]!, prompt: 'fold' }],
          query: 'fold',
          matches: [{ index: 0, snippet: 'a fold' }],
        },
        act,
      ),
      renderPane(el, { ...folded, view: 'turns', stats: [{ ...foldedStats[0]!, prompt: 'fold' }], columns: 54 }, act),
      renderPane(el, { ...folded, expanded: foldedOpen, cursor: 'fe' }, act),
      renderPane(el, { ...ascii, cursor: 'b1', expanded: open }, act),
    )
    for (const tree of trees) {
      expect(text(tree)).toMatch(/^[\x20-\x7e\n]*$/)
      for (const n of nodes(tree))
        if (n.props['borderStyle'] !== undefined) expect(n.props['borderStyle']).toBe('classic')
    }
    expect(text(trees[0])).toContain('...')
    expect(text(trees[0])).toMatch(/[|`]- /)
    expect(text(trees[3])).toContain('Working...')
    for (const n of nodes(renderPane(el, base, act)))
      if (n.props['borderStyle'] !== undefined) expect(n.props['borderStyle']).toBe('round')
  })

  test('the first error line is not drawn twice when the output starts with it', () => {
    const failed = buildTurns([
      { role: 'user', text: 'go', toolUses: [] },
      {
        role: 'assistant',
        text: '',
        toolUses: [{ tool_use_id: 'f2', tool: 'Bash', input: {}, text: 'Error: boom\nmore', isError: true }],
      },
    ])
    const tree = renderPane(el, { ...base, turns: failed, expanded: new Set(['f2']) }, act)
    expect(text(tree).split('Error: boom')).toHaveLength(2)
  })

  test('the trace of a subagent carries status glyphs too', () => {
    const trace = buildTurns(
      [
        {
          role: 'assistant',
          text: '',
          toolUses: [{ tool_use_id: 'g', tool: 'Grep', input: { pattern: 'x' }, text: 'm' }],
        },
      ],
      'ag/',
    )
    const tree = renderPane(
      el,
      { ...base, expanded: new Set(['a1']), traces: new Map([['ag', { items: trace[0]!.items }]]) },
      act,
    )
    expect(text(byKey(tree, 'status-ag/g'))).toBe('✓ ')
  })

  test('hover scopes stay within 64 characters and are not shared between buttons', () => {
    const id = 'toolu_vrtx_0123456789abcdefghijklmnopqr'
    const agentId = 'a0123456789abcdef'
    const items = buildTurns(
      [
        { role: 'user', text: 'go', toolUses: [] },
        {
          role: 'assistant',
          text: '',
          toolUses: [{ tool_use_id: id, tool: 'Agent', input: { description: 'd' }, agentId, text: 'r' }],
        },
      ],
      '',
    )
    const inner = buildTurns(
      [
        {
          role: 'assistant',
          text: '',
          toolUses: [{ tool_use_id: id, tool: 'Bash', input: { command: 'ls' }, text: 'o' }],
        },
      ],
      `${agentId}/`,
    )
    const child = inner[0]!.items[0]!.id
    const tree = renderPane(
      el,
      {
        ...base,
        turns: items,
        expanded: new Set([items[0]!.items[0]!.id, child]),
        agents: new Map(),
        agentStats: {},
        traces: new Map([[agentId, { items: inner[0]!.items }]]),
      },
      act,
    )
    const scopes: { key: string; scope: string }[] = []
    for (const n of nodes(tree)) {
      const scope = (n.props['hover'] as { scope?: string } | undefined)?.scope
      if (scope !== undefined && n.type === 'Button') scopes.push({ key: String(n.props['key']), scope })
    }
    expect(scopes.some(s => s.key.startsWith('copy:'))).toBe(true)
    for (const { scope } of scopes) {
      expect(scope.length).toBeGreaterThanOrEqual(1)
      expect(scope.length).toBeLessThanOrEqual(64)
    }
    expect(new Set(scopes.map(s => s.scope)).size).toBe(scopes.length)
  })

  test('the selected turn is a full-contrast button the focus ring can take', () => {
    const list = renderPane(el, { ...base, view: 'turns', selected: 1 }, act)
    const row = byKey(list, 'turn-1')
    expect(row?.type).toBe('Button')
    expect(row?.props['dimColor']).toBe(false)
    expect(text(row)).toContain('Thanks')
    expect(byKey(list, 'turn-0')?.type).toBe('Button')
  })

  test('every Text carries a theme color and every Button the theme grey with a full-contrast hover', () => {
    const thinking = { count: 1, text: 'Plan the fix' }
    const trace = buildTurns(
      [{ role: 'assistant', text: 'ok', toolUses: [{ tool_use_id: 'g', tool: 'Grep', input: { pattern: 'x' } }] }],
      'ag/',
    )
    const members = [{ name: 'alice', type: 'teammate', status: 'running' as const }]
    const tasks = [
      { id: '1', subject: 'Write tests', status: 'in_progress', owner: 'alice' },
      { id: '2', subject: 'Ship', status: 'completed' },
    ]
    const long = buildTurns([
      { role: 'user', text: 'go', toolUses: [] },
      {
        role: 'assistant',
        text: '',
        toolUses: [
          {
            tool_use_id: 'x1',
            tool: 'Bash',
            input: { command: 'cat' },
            text: Array.from({ length: 300 }, (_, n) => `line ${n}`).join('\n'),
          },
        ],
      },
    ])
    const open = new Set(['b1', 'e1', 'a1', 't0:o0', 't0:thinking'])
    const numbered = Array.from({ length: 90 }, (_, n) => `${n + 1}→const v${n} = ${n}`).join('\n')
    const rich = buildTurns([
      { role: 'user', text: 'go', toolUses: [] },
      {
        role: 'assistant',
        text: '',
        toolUses: [
          {
            tool_use_id: 'r1',
            tool: 'Read',
            input: { file_path: '/src/a.ts' },
            text: numbered,
          },
          {
            tool_use_id: 'r2',
            tool: 'Edit',
            input: {
              file_path: '/src/a.ts',
              old_string: 'a\nb',
              new_string: Array.from({ length: 150 }, (_, n) => `n${n}`).join('\n'),
            },
            text: 'ok',
          },
          {
            tool_use_id: 'r3',
            tool: 'MultiEdit',
            input: {
              file_path: '/src/a.ts',
              edits: [
                { old_string: 'x', new_string: 'y' },
                { old_string: 'p', new_string: 'q' },
              ],
            },
            text: 'ok',
          },
        ],
      },
    ])
    const richOpen = new Set(['r1', 'r2', 'r3'])
    const trees = [
      renderPane(el, { ...base, turns: rich, expanded: richOpen }, act),
      renderPane(el, { ...base, turns: rich, expanded: richOpen, full: new Set(['r2:diff']) }, act),
      renderPane(
        el,
        { ...base, thinking, expanded: open, traces: new Map([['ag', { items: trace[0]!.items }]]), members, tasks },
        act,
      ),
      renderPane(el, { ...base, selected: 1, isLatest: true, members, tasks }, act),
      renderPane(el, { ...base, expanded: open }, act),
      renderPane(el, { ...base, expanded: open, traces: new Map([['ag', { denied: 'gone' }]]) }, act),
      renderPane(el, { ...base, turns: long, expanded: new Set(['x1']) }, act),
      renderPane(el, { ...base, turns: long, expanded: new Set(['x1']), full: new Set(['x1:output']) }, act),
      renderPane(el, { ...base, turns: [] }, act),
      renderPane(el, { ...base, turns: buildTurns([{ role: 'user', text: 'hi', toolUses: [] }]) }, act),
      renderPane(el, { ...base, view: 'turns', stats: [base.turnStat, undefined] }, act),
      renderPane(el, { ...base, view: 'turns', query: 'callers', matches: [{ index: 0, snippet: 'a' }] }, act),
      renderPane(el, { ...base, view: 'turns', query: 'zzz', matches: [] }, act),
      renderPane(
        el,
        { ...base, view: 'turns', query: 'callers', matches: [{ index: 0, snippet: 'Find callers' }] },
        act,
      ),
      renderPane(el, { ...base, view: 'team', members, tasks }, act),
      renderPane(el, { ...base, view: 'team', turns: [] }, act),
      renderPane(el, { ...base, icons: ICON_SETS.ascii, expanded: open, thinking }, act),
      renderPane(el, { ...base, icons: ICON_SETS.unicode, view: 'turns', stats: [base.turnStat, undefined] }, act),
      renderPane(el, { ...base, icons: ICON_SETS.ascii, view: 'team', members, tasks }, act),
      renderPane(el, { ...base, selected: 1, isLatest: true, icons: ICON_SETS.ascii }, act),
      renderPane(el, { ...base, isFocused: true }, act),
      renderPane(el, { ...base, isFocused: false }, act),
      renderPane(el, { ...base, view: 'team' }, act),
      renderPane(el, { ...base, turns: [], icons: ICON_SETS.unicode }, act),
      renderPane(el, { ...base, turns: foldedTurn, timings: foldedTimings }, act),
      renderPane(el, { ...base, turns: foldedTurn, timings: foldedTimings, expanded: foldedOpen }, act),
      renderPane(el, { ...base, turns: foldedTurn, timings: foldedTimings, expanded: foldedOpen, columns: 60 }, act),
      renderPane(el, { ...base, turns: foldedTurn, view: 'turns', stats: foldedStats, selected: 0 }, act),
      renderPane(el, { ...base, turns: foldedTurn, view: 'turns', stats: foldedStats, selected: 1, columns: 54 }, act),
      renderPane(el, { ...base, turns: foldedTurn, view: 'turns', stats: foldedStats, columns: 69 }, act),
      renderPane(el, { ...base, cursor: 'e1', expanded: open }, act),
      renderPane(el, { ...base, turns: foldedTurn, cursor: 'group:fr1', expanded: foldedOpen }, act),
    ]
    const allowed: unknown[] = [...Object.values(C), ...['fable', 'opus', 'sonnet', 'haiku'].map(m => modelColor(m))]
    let texts = 0
    let buttons = 0
    for (const tree of trees)
      for (const n of nodes(tree)) {
        if (n.type === 'Text') {
          texts++
          expect(allowed, text(n)).toContain(n.props['color'])
        }
        if (n.type === 'Button') {
          buttons++
          // The selected turn of the turn list is the one full-contrast button.
          const isSelectedTurn = String(n.props['key']) === `turn-${base.selected}` && n.props['dimColor'] === false
          if (!isSelectedTurn) expect(n.props['dimColor'], String(n.props['key'])).toBe(true)
          expect((n.props['hover'] as { color?: string } | undefined)?.color, String(n.props['key'])).toBe('text')
        }
      }
    expect(texts).toBeGreaterThan(50)
    expect(buttons).toBeGreaterThan(20)
  })

  test('expanded rows draw input and output frames, errors in red', () => {
    const tree = renderPane(el, { ...base, expanded: new Set(['b1', 'e1', 't0:o0']) }, act)
    const frames = nodes(tree).filter(
      n => n.type === 'Box' && n.props['borderStyle'] === 'round' && !String(n.props['key']).startsWith('card-'),
    )
    expect(frames.map(f => f.props['borderColor'])).toEqual([
      'suggestion',
      'permission',
      'success',
      'autoAccept',
      'error',
    ])
    expect(text(frames[1])).toContain('$ command')
    expect(text(frames[4])).toContain('done')
  })

  test('a subagent row shows its trace, loading state or why it is unavailable', () => {
    const open = { ...base, expanded: new Set(['a1']) }
    expect(text(renderPane(el, open, act))).toContain('Loading trace')
    expect(text(renderPane(el, { ...open, traces: new Map([['ag', { denied: 'gone' }]]) }, act))).toContain(
      'Trace unavailable: gone',
    )
    const trace = buildTurns(
      [{ role: 'assistant', text: '', toolUses: [{ tool_use_id: 'g', tool: 'Grep', input: { pattern: 'x' } }] }],
      'ag/',
    )
    const tree = renderPane(el, { ...open, traces: new Map([['ag', { items: trace[0]!.items }]]) }, act)
    expect(text(tree)).toContain('Execution Trace')
    expect(text(tree)).toContain('1 tool calls, 0 messages')
    expect(text(tree)).toContain('haiku4.5')
  })

  test('long blocks preview with show all, and the budget stops runaway text', () => {
    const long = buildTurns([
      { role: 'user', text: 'go', toolUses: [] },
      {
        role: 'assistant',
        text: '',
        toolUses: Array.from({ length: 12 }, (_, i) => ({
          tool_use_id: `l${i}`,
          tool: 'Bash',
          input: { command: 'cat' },
          text: Array.from({ length: 300 }, (_, n) => `line ${n} ${'x'.repeat(30)}`).join('\n'),
        })),
      },
    ])
    const ids = long[0]!.items.map(i => i.id)
    const preview = renderPane(
      el,
      { ...base, turns: long, expanded: new Set(ids), full: new Set([`${ids[0]}:output`]) },
      act,
    )
    expect(byKey(preview, `full:${ids[0]}:output`)?.props['label']).toBe('show less')
    expect(byKey(preview, `full:${ids[1]}:output`)?.props['label']).toContain('show all')

    const everything = renderPane(
      el,
      { ...base, turns: long, expanded: new Set(ids), full: new Set(ids.map(id => `${id}:output`)) },
      act,
    )
    expect(text(everything)).toContain('pane text budget reached')
    expect(text(everything).length).toBeLessThan(100_000)
  })

  test('every frame has a copy button that copies the whole block', () => {
    const lines = Array.from({ length: 300 }, (_, n) => `line ${n}`).join('\n')
    const long = buildTurns([
      { role: 'user', text: 'go', toolUses: [] },
      {
        role: 'assistant',
        text: 'Done.',
        toolUses: [{ tool_use_id: 'x1', tool: 'Bash', input: { command: 'seq 300' }, text: lines }],
      },
    ])
    const tree = renderPane(el, { ...base, turns: long, expanded: new Set(['x1', 't0:o0']) }, act)
    for (const key of ['copy:x1:command', 'copy:x1:output', 'copy:t0:o0']) expect(byKey(tree, key)?.type).toBe('Button')
    ;(byKey(tree, 'copy:x1:output')?.props['onPress'] as (e: { surface: string }) => void)({ surface: 'terminal' })
    ;(byKey(tree, 'copy:x1:command')?.props['onPress'] as (e: { surface: string }) => void)({ surface: 'desktop' })
    expect(calls).toContain(`copy:terminal:${lines}`)
    expect(calls).toContain('copy:desktop:seq 300')
  })

  test('turn list and empty state', () => {
    const list = renderPane(el, { ...base, view: 'turns', stats: [base.turnStat, undefined] }, act)
    expect(text(list)).toContain('Turns (2)')
    expect(text(byKey(list, 'turn-0'))).toContain('1m 5s')
    expect(text(byKey(list, 'turn-1'))).toContain('Thanks')
    ;(byKey(list, 'turn-1')?.props['onPress'] as () => void)()
    expect(calls).toContain('pick:1')
    expect(text(renderPane(el, { ...base, turns: [] }, act))).toContain('No turns yet')
    expect(
      text(
        renderPane(
          el,
          { ...base, turns: buildTurns([{ role: 'user', text: 'hi', toolUses: [] }]), isLatest: true, isWorking: true },
          act,
        ),
      ),
    ).toContain('Working…')
  })

  test('the turn search filters the list and shows each match', () => {
    const tree = renderPane(
      el,
      { ...base, view: 'turns', query: 'callers', matches: [{ index: 0, snippet: 'Explore - Find callers' }] },
      act,
    )
    expect(text(tree)).toContain('Turns (1 of 2)')
    expect(byKey(tree, 'turn-0')).toBeDefined()
    expect(byKey(tree, 'turn-1')).toBeUndefined()
    expect(text(tree)).toContain('Explore - Find callers')
    const input = byKey(tree, 'turn-search')
    expect(input?.type).toBe('Input')
    expect(input?.props['placeholder']).toBe('Search turns')
    expect(input?.props['value']).toBe('callers')
    ;(input?.props['onInput'] as (value: string) => void)('x')
    ;(input?.props['onSubmit'] as (value: string) => void)('y')
    ;(byKey(tree, 'search-clear')?.props['onPress'] as () => void)()
    expect(calls).toEqual(expect.arrayContaining(['search:x', 'submit:y', 'clearSearch']))

    expect(text(renderPane(el, { ...base, view: 'turns', query: 'zzz', matches: [] }, act))).toContain(
      'No turn matches "zzz".',
    )
    const all = renderPane(el, { ...base, view: 'turns', query: '' }, act)
    expect(byKey(all, 'turn-0')).toBeDefined()
    expect(byKey(all, 'turn-1')).toBeDefined()
    expect(byKey(all, 'search-clear')).toBeUndefined()
  })

  test('the matched part of a snippet is underlined bold in the accent, the rest muted', () => {
    const tree = renderPane(
      el,
      { ...base, view: 'turns', query: 'CALLERS', matches: [{ index: 0, snippet: 'Explore - Find callers now' }] },
      act,
    )
    const hit = nodes(tree).find(n => n.type === 'Text' && n.props['underline'] === true)
    expect(text(hit)).toBe('callers')
    expect(hit?.props['bold']).toBe(true)
    expect(hit?.props['color']).toBe(C.accent)
    const row = nodes(tree).find(n => n.type === 'Text' && text(n).includes('Explore - Find '))
    expect(row?.props['color']).toBe(C.muted)
    expect(text(row)).toBe('      Explore - Find callers now')
    // A snippet with no match stays one muted line.
    const plain = renderPane(
      el,
      { ...base, view: 'turns', query: 'zzz', matches: [{ index: 0, snippet: 'no hit here' }] },
      act,
    )
    expect(nodes(plain).some(n => n.props['underline'] === true)).toBe(false)
  })

  test('a filtered row keeps the real tail, and the echoed query is sanitized and cut', () => {
    const query = `a\u001b[31m${'q'.repeat(100)}`
    const empty = text(renderPane(el, { ...base, view: 'turns', query, matches: [] }, act))
    expect(empty).not.toContain('\u001b')
    expect(empty).toContain('No turn matches "aqqq')
    expect(empty).toContain('…"')
    const tree = renderPane(
      el,
      { ...base, view: 'turns', stats: [base.turnStat, undefined], query: 'c', matches: [{ index: 0, snippet: 's' }] },
      act,
    )
    expect(text(byKey(tree, 'turn-0'))).toContain('1m 5s')
  })

  test('a long turn list stays within the pane text budget', () => {
    const many = buildTurns(
      Array.from({ length: 1500 }, (_, i) => ({
        role: 'user' as const,
        text: `prompt ${i} ${'x'.repeat(60)}`,
        toolUses: [],
      })),
    )
    const matches = many.map(t => ({ index: t.index, snippet: `…${'s'.repeat(70)}…` }))
    const all = renderPane(el, { ...base, turns: many, stats: [], view: 'turns' }, act)
    const filtered = renderPane(el, { ...base, turns: many, stats: [], view: 'turns', query: 'x', matches }, act)
    for (const tree of [all, filtered]) {
      expect(text(tree).length).toBeLessThan(100_000)
      expect(text(tree)).toMatch(/\d+ more turns/)
    }
    expect(text(filtered)).toContain('refine the search')
    expect(text(all)).not.toContain('refine the search')
  })

  test('the team board stays within the pane text budget', () => {
    const tasks = Array.from({ length: 2000 }, (_, i) => ({
      id: String(i + 1),
      subject: 'y'.repeat(150),
      status: 'pending',
    }))
    const huge = [{ id: '0', subject: 'z'.repeat(20_000), status: 'pending', owner: 'o'.repeat(20_000) }]
    const members = Array.from({ length: 3 }, () => ({ name: 'alice', type: 'teammate', status: 'idle' as const }))
    const tree = renderPane(el, { ...base, view: 'team', members, tasks }, act)
    expect(text(tree).length).toBeLessThan(100_000)
    expect(text(tree)).toMatch(/\d+ more tasks/)
    const one = renderPane(el, { ...base, view: 'team', tasks: huge }, act)
    expect(nodes(one).every(n => typeof n.children !== 'string' || n.children.length < 10_000)).toBe(true)
    expect(text(one).length).toBeLessThan(1000)
    const keys = nodes(tree).map(n => n.props['key'])
    expect(new Set(keys.filter(k => String(k).startsWith('member-'))).size).toBe(3)
  })

  test('row buttons call their actions', () => {
    const tree = renderPane(el, base, act)
    ;(byKey(renderPane(el, { ...base, selected: 1 }, act), 'nav-prev')?.props['onPress'] as () => void)()
    for (const key of ['b1', 'nav-next', 'nav-latest', 'nav-turns', 'nav-search', 'nav-expand', 'nav-collapse']) {
      ;(byKey(tree, key)?.props['onPress'] as () => void)()
    }
    expect(calls).toEqual(
      expect.arrayContaining([
        'toggle:b1',
        'prev',
        'next',
        'latest',
        'showTurns',
        'focusSearch',
        'expandAll',
        'collapseAll',
      ]),
    )
  })

  test('the team view lists teammates and tasks; its nav key acts only with a team', () => {
    expect(acts(renderPane(el, base, act), 'nav-team')).toBe(false)
    const members = [{ name: 'alice', type: 'teammate', status: 'running' as const }]
    const tasks = [
      { id: '1', subject: 'Write tests', status: 'in_progress', owner: 'alice' },
      { id: '2', subject: 'Ship', status: 'completed' },
    ]
    const detail = renderPane(el, { ...base, members, tasks }, act)
    ;(byKey(detail, 'nav-team')?.props['onPress'] as () => void)()
    expect(calls).toContain('showTeam')

    const team = renderPane(el, { ...base, view: 'team', members, tasks }, act)
    const all = text(team)
    expect(all).toContain('Team (1)')
    expect(all).toContain('alice')
    expect(all).toContain('◐ #1 Write tests  → alice')
    expect(all).toContain('☑ #2 Ship')
    expect(nodes(team).some(n => n.props['color'] === 'success' && text(n) === 'running')).toBe(true)
    expect(text(renderPane(el, { ...base, view: 'team', turns: [] }, act))).toContain('No teammates in this session.')
  })
})

describe('own scroll', () => {
  const kids = (n: Node | undefined) => (n?.children as Node[]).filter(Boolean)
  const pane = (extra: Record<string, unknown> = {}) => renderPane(el, { ...base, ...extra }, act) as Node
  const press = (n: Node | undefined) => (n?.props['onPress'] as (e: unknown) => void)({})
  const members = [{ name: 'alice', type: 'teammate', status: 'running' as const }]

  test('the body is exactly as tall as the window: the header, the window and the footer in flow', () => {
    const tree = pane()
    expect(tree.props['height']).toBe(30)
    expect(tree.props['minHeight']).toBeUndefined()
    expect(tree.props['paddingBottom']).toBeUndefined()
    expect(kids(tree).map(n => n.props['key'])).toEqual(['pane-header', 'pane-window', 'footer'])
    expect(kids(pane({ turns: [] })).map(n => n.props['key'])).toEqual(['pane-window', 'footer'])
  })

  test('the header holds the metrics and the prompt and does not scroll', () => {
    const tree = pane({ rows: 10, scrollTop: 2 })
    const header = byKey(tree, 'pane-header')!
    expect(header.props['height']).toBe(2)
    expect(header.props['overflow']).toBe('hidden')
    expect(byKey(header, 'brand-mark')).toBeDefined()
    expect(text(header)).toContain('Fix the bug')
    expect(byKey(byKey(tree, 'pane-window'), 'brand-mark')).toBeUndefined()
  })

  test('the header is laid out row by row with explicit heights, at 64 and 40 columns', () => {
    const busy = new Map([...Array.from({ length: 12 }, (_, i) => [`x${i}`, 'running' as const] as const)])
    for (const columns of [64, 40])
      for (const extra of [{}, { view: 'turns' as const }, { view: 'team' as const, members }]) {
        const tree = pane({ columns, agents: busy, ...extra })
        const header = byKey(tree, 'pane-header')!
        const parts = kids(header)
        for (const part of parts) {
          expect(typeof part.props['height'], JSON.stringify(extra)).toBe('number')
          expect(part.props['overflow']).toBe('hidden')
          expect(part.props['flexShrink']).toBe(0)
        }
        const rows = parts.reduce((sum, part) => sum + Number(part.props['height']), 0)
        expect(header.props['height']).toBe(rows)
        // Every drawn child of the footer is one row; the hidden keys take none.
        const footerRows = kids(byKey(tree, 'footer')).filter(n => n.props['key'] !== 'footer-hidden').length
        expect(footerRows, JSON.stringify(extra)).toBe(
          extra.view === undefined
            ? columns >= 64
              ? 4
              : 6
            : extra.view === 'team'
              ? columns >= 64
                ? 3
                : 4
              : columns >= 64
                ? 4
                : 5,
        )
        expect(byKey(tree, 'pane-window')?.props['height']).toBe(30 - rows - footerRows)
      }
    // A long prompt is cut to the one row it is given.
    const long = buildTurns([{ role: 'user', text: `go ${'very long prompt '.repeat(20)}`, toolUses: [] }])
    for (const icons of [ICON_SETS.nerd, ICON_SETS.ascii]) {
      const prompt = byKey(pane({ turns: long, stats: [undefined], columns: 40, icons }), 'prompt')!
      expect(displayWidth(text(prompt))).toBeLessThanOrEqual(38)
    }
  })

  test('the window clips the rows between the header and the footer in every view', () => {
    const cases: [Record<string, unknown>, number, number][] = [
      [{}, 2, 4],
      [{ columns: 50 }, 2, 6],
      [{ view: 'turns' }, 2, 4],
      // The team board draws one row of keys: the footer is a row shorter.
      [{ view: 'team', members }, 1, 3],
      [{ turns: [] }, 0, 4],
    ]
    for (const [extra, headerRows, footerRows] of cases) {
      const tree = pane(extra)
      const win = byKey(tree, 'pane-window')!
      expect(win.props['overflow'], JSON.stringify(extra)).toBe('hidden')
      expect(win.props['height'], JSON.stringify(extra)).toBe(30 - headerRows - footerRows)
      expect(byKey(tree, 'pane-header')?.props['height'] ?? 0).toBe(headerRows)
    }
  })

  // The engine clamps an absolute box at the top of the tree (measured: the
  // content moved 3 rows for a top of -33), so the content stays in flow in
  // the clipped window and a negative top margin moves it up.
  test('the content is in flow in the window and moved up by a negative top margin, clamped to the content', () => {
    const content = byKey(pane({ rows: 10, scrollTop: 2 }), 'pane-content')!
    expect(content.props).toMatchObject({ marginTop: -2, flexShrink: 0, width: 100 })
    expect(content.props['position']).toBeUndefined()
    expect(content.props['top']).toBeUndefined()
    expect(byKey(pane({ rows: 10 }), 'pane-window')?.props['flexDirection']).toBe('column')
    expect(byKey(pane(), 'pane-content')?.props['marginTop']).toBe(0)
    expect(byKey(pane({ scrollTop: 5 }), 'pane-content')?.props['marginTop']).toBe(0)
    expect(byKey(pane({ rows: 10, scrollTop: 99 }), 'pane-content')?.props['marginTop']).toBe(-4)
  })

  test('more above and more below show only while the content overflows, muted, inside the window', () => {
    const fits = pane()
    expect(byKey(fits, 'more-above')).toBeUndefined()
    expect(byKey(fits, 'more-below')).toBeUndefined()
    const top = pane({ rows: 10 })
    expect(byKey(top, 'more-above')).toBeUndefined()
    const below = byKey(top, 'more-below')!
    expect(text(below)).toBe('▼ 3 more below')
    expect(below.props).toMatchObject({ position: 'absolute', top: 3, left: 0, backgroundColor: C.paneBackground })
    expect(nodes(below).find(n => n.type === 'Text')?.props['color']).toBe(C.muted)
    const mid = pane({ rows: 10, scrollTop: 2 })
    const win = byKey(mid, 'pane-window')
    expect(text(byKey(win, 'more-above'))).toBe('▲ 3 more above')
    expect(byKey(win, 'more-above')?.props['top']).toBe(0)
    expect(text(byKey(win, 'more-below'))).toBe('▼ 1 more below')
    const ascii = pane({ rows: 10, scrollTop: 2, icons: ICON_SETS.ascii })
    expect(text(byKey(ascii, 'more-above'))).toBe('^ 3 more above')
    expect(text(byKey(ascii, 'more-below'))).toBe('v 1 more below')
  })

  test('f and b page the window, and do nothing at the end and at the top', () => {
    const top = pane({ rows: 10 })
    expect(byKey(top, 'nav-pageup')?.props['hotkey']).toBe('b')
    expect(acts(top, 'nav-pageup')).toBe(false)
    const f = byKey(top, 'nav-pagedown')!
    expect(f.props).toMatchObject({ hotkey: 'f', plain: true, dimColor: true })
    expect(String(f.props['label']).trimEnd()).toBe('▼ page')
    expect((f.props['hover'] as { scope?: string }).scope).toBe('btn:nav-pagedown')
    calls.length = 0
    press(f)
    expect(calls).toEqual(['scroll:2'])
    const end = pane({ rows: 10, scrollTop: 4 })
    expect(byKey(end, 'nav-pagedown')?.props['hotkey']).toBe('f')
    expect(acts(end, 'nav-pagedown')).toBe(false)
    expect(byKey(end, 'nav-pageup')?.props['hotkey']).toBe('b')
    press(byKey(end, 'nav-pageup'))
    expect(calls.at(-1)).toBe('scroll:2')
    for (const view of [{}, { view: 'turns' as const }, { view: 'team' as const, members }]) {
      const fits = pane(view)
      expect(acts(fits, 'nav-pageup')).toBe(false)
      expect(acts(fits, 'nav-pagedown')).toBe(false)
    }
    expect(String(byKey(pane({ rows: 10, icons: ICON_SETS.ascii }), 'nav-pagedown')?.props['label']).trimEnd()).toBe(
      'v page',
    )
  })

  test('long prose and one-line JSON count the rows they wrap to, at 80 and 40 columns', () => {
    const prose = Array.from({ length: 20 }, () => 'x'.repeat(300)).join('\n\n')
    const json = JSON.stringify({ data: 'y'.repeat(7989) })
    const wrapped = buildTurns([
      { role: 'user', text: 'go', toolUses: [] },
      {
        role: 'assistant',
        text: prose,
        toolUses: [{ tool_use_id: 'j1', tool: 'Bash', input: { command: 'cat x.json' }, text: json }],
      },
    ])
    const totalAt = (columns: number) => {
      measured.length = 0
      pane({ turns: wrapped, stats: [undefined], columns, expanded: new Set(['t0:o0', 'j1']) })
      return measured[0]!.total
    }
    // Measured in the engine: a frame's body is the pane less 4 (indent) and 4
    // (border and padding), and Markdown draws no empty line. Blank, message
    // row, its frame and blank, the call row, the command frame, the output
    // frame and blank.
    const least = (inner: number) =>
      1 + 1 + 3 + 20 * Math.ceil(300 / inner) + 1 + 1 + 4 + 3 + Math.ceil(8000 / inner) + 1
    expect(totalAt(80)).toBe(least(72))
    expect(totalAt(40)).toBe(least(32))
  })

  test('numbered code gets a gutter of its widest line number and 2 cells, a diff its own', () => {
    const read = buildTurns([
      { role: 'user', text: 'go', toolUses: [] },
      {
        role: 'assistant',
        text: '',
        toolUses: [
          {
            tool_use_id: 'r1',
            tool: 'Read',
            input: { file_path: '/a/w.txt' },
            text: Array.from({ length: 30 }, (_, i) => `${String(i + 1).padStart(6)}→line${i} ${'y'.repeat(240)}`).join(
              '\n',
            ),
          },
        ],
      },
    ])
    measured.length = 0
    pane({ turns: read, stats: [undefined], columns: 108, expanded: new Set(['r1']) })
    // 30 lines of 247 cells beside a 4-cell gutter in a 100-cell body: 3 rows each.
    const frames = measured[0]!.total - (1 + 1 + 1)
    expect(frames).toBe(4 + 3 + 30 * 3)
  })

  // First measured at a 49-column pane with a long Bash description, which
  // the frame now leaves to the row; a Read's long `lines` meta at 24 columns
  // wraps the same way.
  test('a frame title never shrinks; the ascii set counts the rows its uncut meta wraps to', () => {
    const bash = buildTurns([
      { role: 'user', text: 'go', toolUses: [] },
      {
        role: 'assistant',
        text: '',
        toolUses: [
          {
            tool_use_id: 'c1',
            tool: 'Read',
            input: { file_path: '/p.ts', offset: 1_000_000_000, limit: 1_000_000_000 },
            text: 'ok',
          },
        ],
      },
    ])
    const tree = pane({ turns: bash, stats: [undefined], columns: 24, expanded: new Set(['c1']) })
    const titles = nodes(tree).filter(
      n => n.type === 'Box' && n.props['flexShrink'] === 0 && nodes(n.children).some(t => t.props['bold'] === true),
    )
    expect(titles.length).toBeGreaterThanOrEqual(2)
    measured.length = 0
    pane({ turns: bash, stats: [undefined], columns: 24, expanded: new Set(['c1']) })
    const unicode = measured[0]!.total
    measured.length = 0
    pane({ turns: bash, stats: [undefined], columns: 24, expanded: new Set(['c1']), icons: ICON_SETS.ascii })
    expect(measured[0]!.total).toBeGreaterThan(unicode)
  })

  test('a narrow pane counts the wrapped notes, the empty-pane hint and the trace line', () => {
    measured.length = 0
    pane({ turns: [], columns: 30 })
    // The keys hint (about 70 characters) wraps to three rows of 28.
    expect(measured[0]!.total).toBeGreaterThanOrEqual(1 + 2 + 3)
  })

  test('a very short pane drops the header before the window, and a window of two rows its indicators', () => {
    const short = pane({ rows: 5 })
    expect(byKey(short, 'pane-header')).toBeUndefined()
    expect(byKey(short, 'pane-window')?.props['height']).toBe(1)
    expect(byKey(short, 'more-below')).toBeUndefined()
    const two = pane({ rows: 8 })
    expect(byKey(two, 'pane-window')?.props['height']).toBe(2)
    expect(byKey(two, 'more-below')).toBeUndefined()
    expect(byKey(pane({ rows: 9 }), 'more-below')).toBeDefined()
  })

  test('the turn search field stays in a compact or short pane, so s and clear keep working', () => {
    // A field that leaves and comes back would lose the query the person typed.
    for (const extra of [
      { placement: 'inline' as const, rows: 9 },
      { placement: 'inline' as const, rows: 6 },
      { rows: 5 },
    ]) {
      const tree = pane({ view: 'turns', query: 'abc', ...extra })
      expect(byKey(tree, 'turn-search'), JSON.stringify(extra)).toBeDefined()
    }
  })

  test('a short inline pane keeps the header line, a window of rows and a one-row footer', () => {
    const footerRows = (tree: Node) =>
      kids(byKey(tree, 'footer')).filter(n => n.props['key'] !== 'footer-hidden').length
    // Inline above the prompt the engine spares few rows: the full footer and
    // header would leave the window two rows, so the pane goes compact.
    for (const rows of [6, 8, 9]) {
      const short = pane({ placement: 'inline', rows, isFocused: true })
      expect(short.props['height'], `${rows}`).toBe(rows)
      expect(byKey(short, 'pane-header')?.props['height']).toBe(1)
      expect(byKey(byKey(short, 'pane-header'), 'brand-mark')).toBeDefined()
      expect(byKey(short, 'prompt')).toBeUndefined()
      expect(footerRows(short)).toBe(1)
      expect(byKey(short, 'footer-rule')).toBeUndefined()
      expect(text(byKey(short, 'footer-status'))).toContain('keys on')
      // Every key keeps its hotkey, drawn or not.
      expect(byKey(short, 'nav-turns')?.props['hotkey']).toBe('t')
      expect(byKey(short, 'pane-window')?.props['height']).toBe(rows - 2)
    }
    // With room for the full layout an inline pane draws as a docked one.
    const tall = pane({ placement: 'inline', rows: 14 })
    expect(byKey(tall, 'pane-header')?.props['height']).toBe(2)
    expect(footerRows(tall)).toBe(4)
    expect(byKey(tall, 'pane-window')?.props['height']).toBe(8)
    // A docked pane as short keeps its layout.
    const docked = pane({ placement: 'dock', rows: 8 })
    expect(byKey(docked, 'pane-header')?.props['height']).toBe(2)
    expect(footerRows(docked)).toBe(4)
  })

  test('each drawing reports where its window stands, for the scroll of the engine', () => {
    measured.length = 0
    pane({ rows: 10, scrollTop: 99 })
    expect(measured).toEqual([expect.objectContaining({ scrollTop: 4, windowRows: 4, total: 6 })])
  })

  test('the status row says top or end while the content overflows', () => {
    const status = (extra: Record<string, unknown>) => text(byKey(pane({ isFocused: true, ...extra }), 'footer-status'))
    expect(status({ rows: 10 })).toBe('1/2 · top · keys on')
    expect(status({ rows: 10, scrollTop: 2 })).toBe('1/2 · keys on')
    expect(status({ rows: 10, scrollTop: 4 })).toBe('1/2 · end · keys on')
    expect(status({})).toBe('1/2 · keys on')
    expect(text(byKey(pane({ rows: 10, isFocused: true, icons: ICON_SETS.ascii }), 'footer-status'))).toBe(
      '1/2 . top . keys on',
    )
    const place = byKey(pane({ rows: 10 }), 'scroll-place')
    expect(place?.props['color']).toBe(C.muted)
  })

  test('the page keys move to the status row where the views row has no room for them', () => {
    const tree = pane({ columns: 70, rows: 10, isFocused: true })
    const footer = byKey(tree, 'footer')!
    expect(text(byKey(footer, 'footer-row-2'))).not.toContain('page')
    const last = byKey(footer, 'footer-last')!
    expect(byKey(last, 'nav-pagedown')).toBeDefined()
    const status = byKey(last, 'footer-status')!
    expect(status.props['width']).toBe(70 - 2 - 20 - 2)
    expect(text(status)).toBe('1/2 · top · keys on')
    expect(byKey(pane({ columns: 44 }), 'footer-last')).toBeDefined()
    expect(byKey(pane({ columns: 100 }), 'footer-last')).toBeUndefined()
  })

  test('j hands over where the rows are, an open row pushes the rows under it down by its frames', () => {
    calls.length = 0
    press(byKey(pane({ rows: 10, scrollTop: 1, cursor: 'b1' }), 'nav-down'))
    expect(calls).toEqual(['down:1/4/6/2/3'])
    calls.length = 0
    press(byKey(pane({ expanded: new Set(['b1']), cursor: 'b1' }), 'nav-down'))
    expect(calls).toEqual(['down:0/24/15/2/12'])
  })
})

describe('empty states', () => {
  const lines = (tree: unknown) =>
    nodes(tree)
      .filter(n => n.type === 'Text' && String(n.props['key']).startsWith('empty-'))
      .map(n => ({ text: text(n), color: n.props['color'] }))

  test('no turns: a three line block with the keys', () => {
    expect(lines(renderPane(el, { ...base, turns: [] }, act))).toEqual([
      { text: 'No turns yet.', color: 'text' },
      { text: 'Send a prompt; tool calls and subagents appear here.', color: 'inactive' },
      { text: 'Keys: t turns · s search · e expand · click or ctrl+x tab for keys', color: 'inactive' },
    ])
    expect(lines(renderPane(el, { ...base, turns: [], view: 'turns' }, act))).toHaveLength(3)
    expect(lines(renderPane(el, { ...base, turns: [], isBarShown: true }, act)).at(-1)?.text).toBe(
      'Keys: t turns · s search · e expand · click or ctrl+x tab ×2 for keys',
    )
    expect(text(renderPane(el, { ...base, turns: [], icons: ICON_SETS.ascii }, act))).toContain(
      'Keys: t turns . s search . e expand . click or ctrl+x tab for keys',
    )
  })

  test('no turn matches the search: one line on what to do', () => {
    const tree = renderPane(el, { ...base, view: 'turns', query: 'zzz', matches: [] }, act)
    expect(lines(tree)).toEqual([{ text: 'Clear the search or try fewer words.', color: 'inactive' }])
    expect(text(tree)).toContain('No turn matches "zzz".')
  })

  test('no teammates and no tasks: one hint line each', () => {
    const tree = renderPane(el, { ...base, view: 'team' }, act)
    expect(lines(tree).map(l => l.text)).toEqual([
      'Teammates show up once Claude starts a team.',
      'Tasks show up when Claude plans with TodoWrite or TaskCreate.',
    ])
    for (const l of lines(tree)) expect(l.color).toBe('inactive')
    const members = [{ name: 'alice', type: 'teammate', status: 'running' as const }]
    expect(lines(renderPane(el, { ...base, view: 'team', members }, act))).toHaveLength(1)
  })
})

describe('header spacing', () => {
  const header = (columns: number, extra = {}) => {
    const tree = renderPane(el, { ...base, selected: 1, isLatest: true, isWorking: true, columns, ...extra }, act)
    // The metrics row, in the header's first part.
    return nodes(byKey(tree, 'pane-header-0')?.children)[0]!
  }
  const texts = (tree: unknown) => nodes(tree).filter(n => n.type === 'Text')

  test('counters are separated by Box gaps, not by padding inside the text', () => {
    for (const columns of [40, 70, 100]) {
      const tree = header(columns, { thinking: { count: 2, text: 'x' } })
      for (const t of texts(tree)) {
        const s = text(t)
        expect(s, `${columns}`).toBe(s.trim())
      }
      for (const row of nodes(tree).filter(n => n.type === 'Box' && n.props['flexShrink'] !== undefined))
        expect(row.props['gap'] ?? row.props['columnGap'], `${columns}`).toBeGreaterThan(0)
    }
  })

  test('below 80 columns the header shows only the context percent', () => {
    expect(text(header(79))).toContain('62%')
    expect(text(header(79))).not.toContain('▰')
    expect(text(header(80))).toContain('▰▰▰▰▰▰▱▱▱▱ 62%')
    expect(text(header(100))).not.toContain('ctx')
  })
})

describe('pane budget with everything on', () => {
  // Every text a node carries: its own string children, joined, and the
  // text-like props.
  const own = (children: unknown): string =>
    typeof children === 'string' || typeof children === 'number'
      ? String(children)
      : Array.isArray(children)
        ? children.map(own).join('')
        : ''
  const pieces = (tree: unknown) =>
    nodes(tree).flatMap(n => [
      own(n.children),
      ...['label', 'text', 'source'].flatMap(key => (typeof n.props[key] === 'string' ? [n.props[key] as string] : [])),
    ])

  const everything = (outputs: number) => {
    const output = Array.from({ length: 300 }, (_, n) => `line ${n} ${'x'.repeat(30)}`).join('\n')
    const table = ['| a | b |', '|---|---|', ...Array.from({ length: 200 }, (_, n) => `| ${n} | ${'t'.repeat(40)} |`)]
    const turn = buildTurns([
      { role: 'user', text: 'go', toolUses: [] },
      {
        role: 'assistant',
        text: table.join('\n'),
        toolUses: [
          ...Array.from({ length: outputs }, (_, n) => ({
            tool_use_id: `o${n}`,
            tool: 'Bash',
            input: { command: `cat big${n}` },
            text: output,
          })),
          ...Array.from({ length: 1500 }, (_, n) => ({
            tool_use_id: `k${n}`,
            tool: n % 2 === 0 ? 'Bash' : 'Edit',
            input:
              n % 2 === 0
                ? { command: `echo ${n} ${'q'.repeat(300)}` }
                : { file_path: `/src/f${n}.go`, old_string: 'a\nb\nc', new_string: 'd\ne\nf' },
            text: 'ok',
          })),
        ],
      },
    ])
    const open = turn[0]!.items.filter(item => item.kind === 'output' || item.id.startsWith('o')).map(item => item.id)
    return renderPane(
      el,
      {
        ...base,
        turns: turn,
        expanded: new Set(open),
        full: new Set(open.flatMap(id => [`${id}:output`, `${id}:command`, id])),
        cursor: 'k3',
        columns: 100,
      },
      act,
    )
  }

  test('rows, show-all outputs, cards, a table and the cursor stay under the engine limits', () => {
    for (const outputs of [3, 9]) {
      const tree = everything(outputs)
      const all = pieces(tree)
      expect(all.join('').length).toBeLessThan(100_000)
      for (const piece of all) expect(piece.length).toBeLessThan(10_000)
      expect(nodes(tree).length).toBeLessThan(20_000)
      expect(text(tree)).toMatch(/\d+ more rows/)
    }
    expect(byKey(everything(3), 'card-k0')).toBeDefined()
  })

  test('the frames of 300 open rows are charged too: titles, paths and notes', () => {
    const turn = buildTurns([
      { role: 'user', text: 'go', toolUses: [] },
      {
        role: 'assistant',
        text: '',
        toolUses: Array.from({ length: 300 }, (_, n) => ({
          tool_use_id: `w${n}`,
          tool: 'Write',
          input: { file_path: `/${'p'.repeat(400)}/f${n}.go`, content: 'x' },
          text: 'y',
        })),
      },
    ])
    const ids = turn[0]!.items.map(item => item.id)
    for (const icons of [ICON_SETS.nerd, ICON_SETS.unicode, ICON_SETS.ascii]) {
      const tree = renderPane(el, { ...base, turns: turn, expanded: new Set(ids), columns: 40, icons }, act)
      expect(pieces(tree).join('').length).toBeLessThan(100_000)
    }
  })

  test('a row that does not fit is counted, not drawn, and the cards draw from what is left', () => {
    const turn = buildTurns([
      { role: 'user', text: 'go', toolUses: [] },
      {
        role: 'assistant',
        text: '',
        toolUses: Array.from({ length: 2000 }, (_, n) => ({
          tool_use_id: `r${n}`,
          tool: 'Bash',
          input: { command: `echo ${n} ${'q'.repeat(590)}` },
          text: 'ok',
        })),
      },
    ])
    const tree = renderPane(el, { ...base, turns: turn, columns: 300 }, act)
    expect(text(tree).length).toBeLessThan(100_000)
    expect(byKey(tree, 'item-r0')).toBeDefined()
    expect(byKey(tree, 'item-r1999')).toBeUndefined()
    const shown = nodes(tree).filter(n => String(n.props['key']).startsWith('item-r')).length
    expect(text(tree)).toContain(`${2000 - shown} more rows`)
  })
})

const foldedStats = [{ prompt: '日本語 fold', durationMs: 9_000, endedAt: 0, inputTokens: 3, outputTokens: 4 }]
