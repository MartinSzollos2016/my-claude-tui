// register()'s hooks under Vitest, against the fake engine in
// tests/coverage/engine.ts: the same paths tests/render.test.tsx drives in
// the real engine, here measured by coverage.
import type { SessionMessage } from 'claude-code'
import { beforeEach, describe, expect, test, vi } from 'vitest'

import { ICON_SETS } from '../hooks/icons'
import { BAR_EVENT, byKey, fakeEngine, hooksOf, PANE_EVENT, settle, text } from './coverage/engine'

// register.tsx keeps module-level state (pending turns, caches, the ticker):
// each test gets a fresh copy of the module so none of it leaks between tests.
let run: ReturnType<typeof hooksOf>
beforeEach(async () => {
  vi.resetModules()
  const { register } = await import('../hooks/register')
  run = hooksOf(register)
})

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

const command = (name: string, args = '') => ({
  command: name,
  args,
  origin: { kind: 'composer' },
  presentation: { isFullscreen: true, columns: 200 },
})

const say = async ($: Parameters<typeof run>[1], name: string, args = '') =>
  ((await run('command.run', $, command(name, args))) as { text: string }).text

const draw = ($: Parameters<typeof run>[1]) => run('ui.render', $, PANE_EVENT)

// Presses a button of the pane as drawn now, then lets its update land.
async function press($: Parameters<typeof run>[1], key: string) {
  const button = byKey(await draw($), key)
  if (!button) throw new Error(`no button ${key}`)
  ;(button.props['onPress'] as (e: unknown) => void)({ surface: 'terminal' })
  await settle()
}

describe('session start', () => {
  test('registers every command, opens the pane and reads the branch', async () => {
    const { $, world } = fakeEngine({ files: { '/r/.git/HEAD': 'ref: refs/heads/main\n' } })
    await run('session.start', $, { cwd: '/r' }, async e => e)
    await settle()
    expect(world.commands).toEqual([
      'tail',
      'tail-turns',
      'tail-width',
      'tail-compact',
      'tail-icons',
      'tail-bar',
      'tail-status',
      'tail-notify',
      'tail-help',
    ])
    // Opened once, before any width was known: no columns asked for.
    expect(world.opened).toEqual([undefined])
    expect(text(await run('ui.render', $, BAR_EVENT))).toContain('main')
  })

  test('follows a worktree .git file, and shows no branch outside a repository', async () => {
    const worktree = fakeEngine({
      isGitDir: false,
      files: { '/r/.git': 'gitdir: /g/wt\n', '/g/wt/HEAD': 'ref: refs/heads/feat/x\n' },
    })
    await run('session.start', worktree.$, { cwd: '/r' }, async e => e)
    await settle()
    expect(text(await run('ui.render', worktree.$, BAR_EVENT))).toContain('feat/x')

    const bare = fakeEngine({ hasRepo: false, files: { '/tmp/.git/HEAD': 'ref: refs/heads/develop\n' } })
    await run('session.start', bare.$, { cwd: '/tmp' }, async e => e)
    await settle()
    expect(text(await run('ui.render', bare.$, BAR_EVENT))).not.toContain('develop')
  })
})

describe('pane size', () => {
  const at = (columns: number, rows: number) => ({ columns, rows, isFullscreen: true })
  const bar = (viewport: ReturnType<typeof at>) => run('ui.render', $of, { ...BAR_EVENT, viewport })
  let $of: Parameters<typeof run>[1]

  // A drawing's viewport beside a docked pane is the transcript's column: the
  // terminal is that, the dock's body and its one-cell border.
  const docked = (viewport: ReturnType<typeof at>, bodyColumns: number) => ({
    ...PANE_EVENT,
    props: { ...PANE_EVENT.props, placement: 'dock', bodyColumns },
    viewport,
  })
  const inlineAt = (viewport: ReturnType<typeof at>) => ({
    ...PANE_EVENT,
    props: { ...PANE_EVENT.props, placement: 'inline', bodyColumns: viewport.columns - 4 },
    viewport,
  })

  test('the saved share is applied at session start once the pane is drawn, from the terminal width', async () => {
    const { $, world } = fakeEngine({ store: new Map([['paneWidth', 60]]) })
    $of = $
    await run('session.start', $, { cwd: '/r' }, async e => e)
    await settle()
    expect(world.opened).toEqual([undefined])
    // The info bar drawn before the pane is placed sizes nothing.
    await bar(at(200, 50))
    await settle()
    expect(world.opened).toEqual([undefined])
    // Docked at the engine's share: 120 transcript columns, 79 of body.
    await run('ui.render', $, docked(at(120, 50), 79))
    await settle()
    expect(world.opened.at(-1)).toBe(120)
    // Once only.
    await run('ui.render', $, docked(at(80, 50), 119))
    await settle()
    expect(world.opened).toHaveLength(2)
  })

  test('a terminal too narrow for a share is sized once all the same', async () => {
    const { $, world } = fakeEngine()
    await run('session.start', $, { cwd: '/r' }, async e => e)
    for (let i = 0; i < 3; i++) {
      await run('ui.render', $, inlineAt(at(70, 40)))
      await settle()
    }
    expect(world.openArgs.slice(1)).toEqual([{ id: 'tail', title: 'tail', rows: 20 }])
  })

  test('/tail asks for inline rows from the terminal height the drawings reported', async () => {
    const { $, world } = fakeEngine()
    $of = $
    await bar(at(90, 50))
    await settle()
    await run('command.run', $, { ...command('tail'), presentation: { isFullscreen: true, columns: 90 } })
    expect(world.openArgs.at(-1)).toMatchObject({ columns: 50, rows: 25 })
  })

  test('an inline pane draws the rows it asked for until the engine reports its window', async () => {
    const { $ } = fakeEngine({ messages: main })
    const inline = (bodyRows: number) =>
      run('ui.render', $, {
        ...PANE_EVENT,
        props: { ...PANE_EVENT.props, placement: 'inline', bodyColumns: 86, scroll: { offset: 0, bodyRows } },
        viewport: at(90, 50),
      }) as Promise<{ props: Record<string, unknown> }>
    expect((await inline(0)).props['height']).toBe(25)
    expect((await inline(14)).props['height']).toBe(14)
    const short = await inline(6)
    expect(short.props['height']).toBe(6)
    expect(byKey(short, 'pane-header')?.props['height']).toBe(1)
  })
})

describe('commands', () => {
  test('every command answers and the width sticks', async () => {
    const { $, world } = fakeEngine()
    expect(await say($, 'tail')).toContain('Detail view opened')
    expect(world.opened.at(-1)).toBe(160)
    expect(await say($, 'tail-width', '99')).toContain('between 30 and 80')
    expect(await say($, 'tail-width', '70')).toContain('70%')
    expect(world.opened.at(-1)).toBe(140)
    expect(await say($, 'tail-turns')).toContain('Turn list opened')
    expect(await say($, 'tail', 'bar')).toBe('Info bar hidden.')
    expect(await run('ui.render', $, BAR_EVENT, async () => 'engine bar')).toBe('engine bar')
    expect(await say($, 'tail-bar')).toBe('Info bar shown.')
    expect(await say($, 'tail-compact')).toContain('off')
    expect(await say($, 'tail-compact')).toContain('on')
    expect(await say($, 'tail-help')).toContain('/tail-turns')
  })

  test('/tail-help explains the header glyphs in the icon set the pane draws', async () => {
    const { $ } = fakeEngine()
    await say($, 'tail-icons', 'ascii')
    expect(await say($, 'tail-help')).toContain(`${ICON_SETS.ascii.thinking} thinking blocks`)
  })

  test('/tail-width alone names the stored share, the columns asked for and the width drawn', async () => {
    const { $, world } = fakeEngine({ messages: main })
    world.store.set('paneWidth', 50)
    await draw($)
    const answer = await say($, 'tail-width')
    expect(answer).toMatch(/50%/)
    expect(answer).toMatch(/\d+ columns/)
    expect(answer).toMatch(/drawn \d+/)
    expect(world.store.get('paneWidth')).toBe(50)
  })

  test('an inline pane makes no claim about a dragged dock', async () => {
    const { $ } = fakeEngine({ messages: main })
    await run('ui.render', $, { ...PANE_EVENT, props: { ...PANE_EVENT.props, placement: 'inline', bodyColumns: 88 } })
    const answer = await say($, 'tail-width')
    expect(answer).not.toMatch(/dragged/)
    expect(answer).not.toMatch(/drawn 88/)
  })

  test('after an inline drawing the width answer says the pane takes the whole width', async () => {
    const { $ } = fakeEngine({ messages: main })
    await run('ui.render', $, { ...PANE_EVENT, props: { ...PANE_EVENT.props, placement: 'inline', bodyColumns: 88 } })
    expect(await say($, 'tail-width')).toContain('inline: the pane takes the whole width')
  })

  test('before a drawing the width answer names no drawn width', async () => {
    const { $ } = fakeEngine()
    const answer = await say($, 'tail-width')
    expect(answer).toMatch(/80%/)
    expect(answer).not.toMatch(/drawn/)
  })

  test('/tail with an unknown subcommand names it, lists the valid ones and does not open the pane', async () => {
    const { $, world } = fakeEngine()
    const answer = await say($, 'tail', 'foo')
    expect(answer).toContain('"foo"')
    expect(answer).toContain('turns')
    expect(answer).not.toContain('Detail view opened')
    expect(world.opened).toEqual([])
  })

  test('/tail and /tail-turns ask for the keyboard again once the command is done, until the pane has it', async () => {
    // The engine grants the focus only over an empty composer, which still
    // holds the command while it runs.
    for (const name of ['tail', 'tail-turns']) {
      const unfocused = fakeEngine({ isPaneFocused: false })
      await say(unfocused.$, name)
      await settle()
      expect(unfocused.world.focusRequests, name).toBe(6)
      // Each retry asks for the width of the open it follows (a width the
      // person dragged still wins in the engine).
      const first = unfocused.world.opened[0]
      expect(unfocused.world.opened.slice(1), name).toEqual([first, first, first, first, first])

      const focused = fakeEngine()
      await say(focused.$, name)
      await settle()
      expect(focused.world.focusRequests, name).toBe(1)

      const waiting = fakeEngine({ isPaneFocused: false, isPanePlaced: false })
      await say(waiting.$, name)
      await settle()
      expect(waiting.world.focusRequests, name).toBe(1)
    }
  })

  test('/tail-icons stores the set, names it without an argument and the pane draws it', async () => {
    const { $, world } = fakeEngine({ messages: main })
    expect(await say($, 'tail-icons')).toContain('nerd')
    expect(await say($, 'tail-icons', 'bogus')).toContain('nerd|unicode|ascii')
    expect(world.store.get('tail-view.icons')).toBeUndefined()
    expect(await say($, 'tail-icons', ' ASCII ')).toContain('ascii')
    expect(world.store.get('tail-view.icons')).toBe('ascii')
    expect(await say($, 'tail', 'icons')).toContain('ascii')
    const drawn = text(await draw($))
    expect(drawn).not.toContain('\u{F167A}')
    expect(drawn).toContain('+ ')
    expect(text(await run('ui.render', $, BAR_EVENT))).not.toContain('\uF418')
  })

  test('answers /tail in text in VS Code', async () => {
    const { $, world } = fakeEngine({ surfaces: ['vscode'], messages: main })
    expect(await say($, 'tail')).toContain('Explore      Find callers')
    expect(await say($, 'tail-turns')).toContain('#1   Fix the bug')
    expect(world.opened).toEqual([])
  })

  test('answers /tail in text in a -p run with no turns', async () => {
    const { $, world } = fakeEngine({ surfaces: [], messages: [] })
    expect(await say($, 'tail')).toBe('No turns yet. Send a prompt and /tail lists its tool calls.')
    expect(await say($, 'tail-turns')).toBe('No turns yet.')
    expect(world.opened).toEqual([])
  })
})

describe('live data', () => {
  test('the bar shows a running Workflow and the agents it started', async () => {
    const { $ } = fakeEngine({
      messages: [
        { role: 'user', text: 'Run review', toolUses: [] },
        {
          role: 'assistant',
          text: '',
          toolUses: [{ tool_use_id: 'w1', tool: 'Workflow', input: { name: 'review' } }],
        },
      ],
    })
    await run('prompt.submit', $, { text: 'Run review' }, async e => e)
    let release = () => undefined as unknown
    const workflow = run(
      'tool.call',
      $,
      { tool_use_id: 'w1', tool: 'Workflow', input: { name: 'review' } },
      () => new Promise(resolve => (release = () => resolve({}))),
    )
    await settle()
    await run('tool.call', $, { tool_use_id: 'x1', tool: 'Read', input: {}, agentId: 'wf-agent-1' }, async () => ({}))
    await run(
      'turn.complete',
      $,
      { answer: '', isAborted: false, reason: 'answer', turnId: 't', agentId: 'wf-agent-2', durationMs: 1 },
      async () => ({ text: '' }),
    )
    await settle()
    expect(text(await run('ui.render', $, BAR_EVENT))).toContain('workflow running · 2 agents')
    release()
    await workflow
  })

  const done = { answer: '', isAborted: false, reason: 'answer' }
  const finish = (turnId: string, durationMs: number, $: Parameters<typeof run>[1]) =>
    run('turn.complete', $, { ...done, turnId, durationMs }, async () => ({ text: '' }))

  test('a hand-back turn keeps its own duration', async () => {
    const handBack = 'Another Claude session sent a message: <agent-message from="a">x</agent-message>'
    const { $, world } = fakeEngine()
    await run('prompt.submit', $, { text: 'go' }, async e => e)
    world.messages = [
      { role: 'user', text: 'go', toolUses: [] },
      { role: 'assistant', text: 'spawned', toolUses: [] },
    ]
    world.api = [
      { role: 'user', content: [{ type: 'text', text: 'go' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'spawned' }] },
    ]
    await run('turn.start', $, { text: 'go', turnId: 'g' }, async e => e)
    await settle()
    await finish('g', 2_000, $)
    await run('turn.start', $, { text: handBack, turnId: 'h' }, async e => e)
    await settle()
    world.messages = [...world.messages, { role: 'assistant', text: 'Both failed', toolUses: [] }]
    world.api = [
      ...world.api,
      { role: 'user', content: [{ type: 'text', text: handBack }] },
      { role: 'assistant', content: [{ type: 'text', text: 'Both failed' }] },
    ]
    await finish('h', 7_000, $)
    await press($, 'nav-turns')
    const list = await draw($)
    expect(text(byKey(list, 'turn-0'))).toContain('2.0s')
    expect(text(byKey(list, 'turn-1'))).toContain('Message from agent')
    expect(text(byKey(list, 'turn-1'))).toContain('7.0s')
  })

  test('two hand-backs in a row keep their own durations', async () => {
    const handBack = (from: string) =>
      `Another Claude session sent a message: <agent-message from="${from}">x</agent-message>`
    const { $, world } = fakeEngine()
    await run('prompt.submit', $, { text: 'go' }, async e => e)
    world.messages = [
      { role: 'user', text: 'go', toolUses: [] },
      { role: 'assistant', text: 'spawned', toolUses: [] },
    ]
    world.api = [
      { role: 'user', content: [{ type: 'text', text: 'go' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'spawned' }] },
    ]
    await run('turn.start', $, { text: 'go', turnId: 'g' }, async e => e)
    await settle()
    await finish('g', 2_000, $)
    for (const [from, reply, ms, id] of [
      ['a', 'First result', 3_000, 'h1'],
      ['b', 'Second result', 5_000, 'h2'],
    ] as const) {
      await run('turn.start', $, { text: handBack(from), turnId: id }, async e => e)
      await settle()
      world.messages = [...world.messages, { role: 'assistant', text: reply, toolUses: [] }]
      world.api = [
        ...world.api,
        { role: 'user', content: [{ type: 'text', text: handBack(from) }] },
        { role: 'assistant', content: [{ type: 'text', text: reply }] },
      ]
      await finish(id, ms, $)
    }
    await press($, 'nav-turns')
    const list = await draw($)
    expect(text(byKey(list, 'turn-0'))).toContain('2.0s')
    expect(text(byKey(list, 'turn-1'))).toContain('3.0s')
    expect(text(byKey(list, 'turn-2'))).toContain('5.0s')
  })

  test('a prompt with a carriage return or an escape still finds its stat', async () => {
    const { $, world } = fakeEngine()
    await run('prompt.submit', $, { text: 'fix\r\n\u001b[31mbug' }, async e => e)
    world.messages = [{ role: 'user', text: 'fix\r\n\u001b[31mbug', toolUses: [] }]
    await finish('x', 4_000, $)
    await press($, 'nav-turns')
    expect(text(byKey(await draw($), 'turn-0'))).toContain('4.0s')
  })

  test('two identical prompts keep their own time', async () => {
    const { $, world } = fakeEngine()
    const turn = async (turnId: string, durationMs: number, rows: SessionMessage[]) => {
      await run('prompt.submit', $, { text: 'ok' }, async e => e)
      world.messages = [...world.messages, ...rows]
      await run('turn.start', $, { text: 'ok', turnId }, async e => e)
      await settle()
      await finish(turnId, durationMs, $)
    }
    await turn('a', 1_000, [{ role: 'user', text: 'ok', toolUses: [] }])
    await turn('b', 9_000, [
      { role: 'assistant', text: 'Sure.', toolUses: [] },
      { role: 'user', text: 'ok', toolUses: [] },
    ])
    world.messages = [...world.messages, { role: 'assistant', text: 'Done.', toolUses: [] }]

    await press($, 'nav-turns')
    const list = await draw($)
    expect(text(byKey(list, 'turn-0'))).toContain('1.0s')
    expect(text(byKey(list, 'turn-1'))).toContain('9.0s')
  })

  test('identical prompts queued before their rows appear still pair in order', async () => {
    const { $, world } = fakeEngine()
    await run('prompt.submit', $, { text: 'pokračuj' }, async e => e)
    world.messages = [{ role: 'user', text: 'pokračuj', toolUses: [] }]
    await run('prompt.submit', $, { text: 'pokračuj' }, async e => e)
    await run('turn.start', $, { text: 'pokračuj', turnId: 'a' }, async e => e)
    await run('turn.start', $, { text: 'pokračuj', turnId: 'b' }, async e => e)
    await settle()
    world.messages = [
      { role: 'user', text: 'pokračuj', toolUses: [] },
      { role: 'assistant', text: 'x', toolUses: [] },
      { role: 'user', text: 'pokračuj', toolUses: [] },
    ]
    await finish('a', 2_000, $)
    await finish('b', 7_000, $)
    await press($, 'nav-turns')
    const list = await draw($)
    expect(text(byKey(list, 'turn-0'))).toContain('2.0s')
    expect(text(byKey(list, 'turn-1'))).toContain('7.0s')
  })

  test('a delivery queued into a running turn adds no pending index', async () => {
    const { $, world } = fakeEngine()
    await run('prompt.submit', $, { text: 'one' }, async e => e)
    world.messages = [{ role: 'user', text: 'one', toolUses: [] }]
    await run('prompt.submit', $, { text: 'extra', turnId: 'a' }, async e => e)
    await run('turn.start', $, { text: 'one', turnId: 'a' }, async e => e)
    await run('turn.start', $, { text: 'note', turnId: 'n' }, async e => e)
    await settle()
    await finish('n', 3_000, $)
    await finish('a', 4_000, $)
    await press($, 'nav-turns')
    const list = await draw($)
    expect(text(byKey(list, 'turn-0'))).toContain('4.0s')
  })

  test('a dropped prompt leaves no pending index behind', async () => {
    const { $, world } = fakeEngine()
    await run('prompt.submit', $, { text: 'ok' }, async () => ({ drop: 'blocked' }))
    const rounds: [string, number, SessionMessage[]][] = [
      ['a', 1_000, [{ role: 'user', text: 'ok', toolUses: [] }]],
      [
        'b',
        9_000,
        [
          { role: 'assistant', text: 'x', toolUses: [] },
          { role: 'user', text: 'ok', toolUses: [] },
        ],
      ],
    ]
    for (const [id, ms, rows] of rounds) {
      await run('prompt.submit', $, { text: 'ok' }, async e => e)
      world.messages = [...world.messages, ...rows]
      await run('turn.start', $, { text: 'ok', turnId: id }, async e => e)
      await finish(id, ms, $)
    }
    await press($, 'nav-turns')
    const list = await draw($)
    expect(text(byKey(list, 'turn-0'))).toContain('1.0s')
    expect(text(byKey(list, 'turn-1'))).toContain('9.0s')
  })

  test('a dropped or failed prompt leaves the pane and the Workflow badge idle', async () => {
    const { $ } = fakeEngine({
      messages: [
        { role: 'user', text: 'Run review', toolUses: [] },
        {
          role: 'assistant',
          text: '',
          toolUses: [{ tool_use_id: 'w1', tool: 'Workflow', input: { name: 'review' } }],
        },
      ],
    })
    await run('prompt.submit', $, { text: 'again' }, async () => ({ drop: 'blocked' }))
    expect(text(await run('ui.render', $, BAR_EVENT))).not.toContain('workflow running')
    await expect(
      run('prompt.submit', $, { text: 'again' }, async () => {
        throw new Error('hook failed')
      }),
    ).rejects.toThrow('hook failed')
    expect(text(await run('ui.render', $, BAR_EVENT))).not.toContain('workflow running')
    expect(text(await draw($))).not.toContain('running')

    const quiet = fakeEngine({ messages: [{ role: 'user', text: 'Plan', toolUses: [] }] })
    expect(text(await draw(quiet.$))).not.toContain('Working…')
    await run('prompt.submit', quiet.$, { text: 'Plan' }, async () => ({ drop: 'blocked' }))
    expect(text(await draw(quiet.$))).not.toContain('Working…')
  })

  test('a stale entry from a submit without turn.start is discarded', async () => {
    const { $, world } = fakeEngine()
    await run('prompt.submit', $, { text: 'ok' }, async e => e)
    world.messages = [{ role: 'user', text: 'ok', toolUses: [] }]
    await run('turn.start', $, { text: 'ok', turnId: 'a' }, async e => e)
    await finish('a', 1_000, $)
    await run('prompt.submit', $, { text: '/stale' }, async e => e)
    world.messages = [...world.messages, { role: 'assistant', text: 'x', toolUses: [] }]
    await run('prompt.submit', $, { text: 'ok' }, async e => e)
    world.messages = [...world.messages, { role: 'user', text: 'ok', toolUses: [] }]
    await run('turn.start', $, { text: 'ok', turnId: 'b' }, async e => e)
    await finish('b', 9_000, $)
    // The stale entry is still queued: the third turn must not take it.
    await run('prompt.submit', $, { text: 'ok' }, async e => e)
    world.messages = [
      ...world.messages,
      { role: 'assistant', text: 'y', toolUses: [] },
      { role: 'user', text: 'ok', toolUses: [] },
    ]
    await run('turn.start', $, { text: 'ok', turnId: 'c' }, async e => e)
    await finish('c', 5_000, $)
    await press($, 'nav-turns')
    const list = await draw($)
    expect(text(byKey(list, 'turn-0'))).toContain('1.0s')
    expect(text(byKey(list, 'turn-1'))).toContain('9.0s')
    expect(text(byKey(list, 'turn-2'))).toContain('5.0s')
  })

  test('a stat does not move to another turn when old rows leave the window', async () => {
    const { $, world } = fakeEngine()
    const rounds: [string, string, number][] = [
      ['a', 'Alpha', 1_000],
      ['b', 'Beta', 9_000],
    ]
    for (const [id, said, ms] of rounds) {
      await run('prompt.submit', $, { text: said }, async e => e)
      world.messages = [...world.messages, { role: 'user', text: said, toolUses: [] }]
      await run('turn.start', $, { text: said, turnId: id }, async e => e)
      world.messages = [...world.messages, { role: 'assistant', text: 'Done.', toolUses: [] }]
      await finish(id, ms, $)
    }
    // The newest rows only: Alpha's fell off the front, and Gamma runs.
    await run('prompt.submit', $, { text: 'Gamma' }, async e => e)
    world.messages = [...world.messages.slice(2), { role: 'user', text: 'Gamma', toolUses: [] }]
    await run('turn.start', $, { text: 'Gamma', turnId: 'c' }, async e => e)

    await press($, 'nav-turns')
    const list = await draw($)
    expect(text(byKey(list, 'turn-0'))).toContain('9.0s')
    expect(text(byKey(list, 'turn-1'))).not.toMatch(/\d\.\ds/)
    await press($, 'nav-detail')
    expect(text(await draw($))).not.toContain('9.0s')
  })

  test('turn.start passes the turn on before it reads the API form', async () => {
    const { $, world } = fakeEngine()
    world.messages = [{ role: 'user', text: 'ping', toolUses: [] }]
    let readsAtNext = -1
    await run('turn.start', $, { text: 'ping', turnId: 'q' }, async e => {
      readsAtNext = world.calls.filter(call => call === 'messages:api').length
      return e
    })
    expect(readsAtNext).toBe(0)
    await settle()
    await finish('q', 3_000, $)
    await press($, 'nav-turns')
    expect(text(byKey(await draw($), 'turn-0'))).toContain('3.0s')
  })

  test('a turn started by a notification falls back to the transcript', async () => {
    const { $, world } = fakeEngine()
    world.messages = [{ role: 'user', text: 'ping', toolUses: [] }]
    await run('turn.start', $, { text: 'ping', turnId: 'n' }, async e => e)
    await settle()
    await finish('n', 3_000, $)
    await press($, 'nav-turns')
    const list = await draw($)
    expect(text(byKey(list, 'turn-0'))).toContain('3.0s')
  })

  test('times tool calls and turns, and notes the permission mode', async () => {
    const { $, world } = fakeEngine({ messages: main })
    await run('classic.UserPromptSubmit', $, { permission_mode: 'plan' }, async () => ({}))
    await run('prompt.submit', $, { text: 'Fix the bug' }, async e => e)
    await run('tool.call', $, { tool_use_id: 'r1', tool: 'Read', input: {} }, async () => {
      world.now += 2_500
      return {}
    })
    const usage = {
      model: 'claude-opus-5-5',
      input_tokens: 600,
      cache_read_input_tokens: 300,
      cache_creation_input_tokens: 100,
      output_tokens: 500,
    }
    const done = { answer: '', isAborted: false, reason: 'answer' }
    await run('turn.complete', $, { ...done, turnId: 't1', durationMs: 65_000, usage }, async () => ({ text: '' }))
    await run(
      'turn.complete',
      $,
      { ...done, turnId: 't1', agentId: 'agent-1', durationMs: 4_200, usage: { ...usage, model: 'claude-haiku-4-5' } },
      async () => ({ text: '' }),
    )
    for (const fire of world.timers) fire()
    await settle()

    const all = text(await draw($))
    expect(all).toContain('1m 5s')
    expect(all).toContain('1.5k')
    expect(all).toContain('2.5s')
    expect(all).toContain('haiku4.5')
    expect(text(await run('ui.render', $, BAR_EVENT))).toContain('plan')
  })
})

describe('detail pane', () => {
  test('passes the pane focus the engine reports into the footer', async () => {
    const { $ } = fakeEngine({ messages: main })
    const focus = async (isFocused?: boolean) => {
      const props = { ...PANE_EVENT.props, ...(isFocused === undefined ? {} : { isFocused }) }
      if (isFocused === undefined) delete (props as { isFocused?: boolean }).isFocused
      return text(await run('ui.render', $, { ...PANE_EVENT, props }))
    }
    expect(await focus(true)).toContain('keys on')
    // The info bar shows by default and takes the first ctrl+x tab.
    expect(await focus(false)).toContain('click or ctrl+x tab ×2')
    await say($, 'tail-bar')
    expect(await focus(false)).toContain('click or ctrl+x tab')
    expect(await focus(false)).not.toContain('×2')
    const unknown = await focus(undefined)
    expect(unknown).not.toContain('keys on')
    expect(unknown).not.toContain('click or')
  })

  test('draws the pane exactly as tall as the engine window, whatever its offset, the footer in flow', async () => {
    const { $ } = fakeEngine({ messages: main })
    for (const scroll of [
      { offset: 0, bodyRows: 40 },
      { offset: 14, bodyRows: 40 },
      { offset: 0, bodyRows: 12 },
    ]) {
      const tree = (await run('ui.render', $, { ...PANE_EVENT, props: { ...PANE_EVENT.props, scroll } })) as {
        props: Record<string, unknown>
      }
      expect(tree.props['height']).toBe(scroll.bodyRows)
      // The header's two rows and the collapsed footer's two (rule, keys and status).
      expect(byKey(tree, 'pane-window')?.props['height']).toBe(scroll.bodyRows - 2 - 2)
      expect(byKey(tree, 'footer')?.props['top']).toBeUndefined()
    }
  })

  test('a failing API read leaves the pane drawn without a thinking count', async () => {
    const { $ } = fakeEngine({
      messages: [
        { role: 'user', text: 'Failing read one', toolUses: [] },
        { role: 'assistant', text: 'ok', toolUses: [] },
      ],
    })
    const original = $.session.messages
    ;($.session as { messages: unknown }).messages = async (args?: { as?: 'api' }) => {
      if (args?.as === 'api') throw new Error('boom')
      return original(args as never)
    }
    const drawn = text(await draw($))
    expect(drawn).toContain('Failing read one')
    expect(drawn).not.toContain('\u{F09D1}')
  })

  test('finds thinking by its reply when the API form is shorter, refetches on a new fingerprint, expand all opens it', async () => {
    const api = [
      { role: 'user', content: [{ type: 'text', text: 'Second misaligned' }] },
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'Only late thought', signature: 's' },
          { type: 'text', text: 'two' },
        ],
      },
    ]
    const { $, world } = fakeEngine({
      messages: [
        { role: 'user', text: 'First misaligned', toolUses: [] },
        { role: 'assistant', text: 'one', toolUses: [] },
        { role: 'user', text: 'Second misaligned', toolUses: [] },
        { role: 'assistant', text: 'two', toolUses: [] },
      ],
      api,
    })
    expect(text(await draw($))).toContain('\u{F09D1} 1')
    await press($, 'nav-expand')
    expect(text(await draw($))).toContain('Only late thought')
    world.messages.push({ role: 'user', text: 'Third misaligned', toolUses: [] })
    api.push({ role: 'user', content: [{ type: 'text', text: 'Third misaligned' }] })
    expect(text(await draw($))).not.toContain('\u{F09D1} 1')
    expect(world.calls.filter(call => call === 'messages:api').length).toBe(2)
  })

  test('the API form is read once per transcript change, for the turns as well', async () => {
    const { $, world } = fakeEngine({ messages: [...main] })
    await draw($)
    await draw($)
    await press($, 'nav-turns')
    await draw($)
    expect(world.calls.filter(call => call === 'messages:api').length).toBe(1)
    world.messages.push({ role: 'user', text: 'more', toolUses: [] })
    await draw($)
    expect(world.calls.filter(call => call === 'messages:api').length).toBe(2)
  })

  test('a reply to an agent hand-back is its own turn, with its own thinking', async () => {
    const late = '<task-notification><task-id>t9</task-id><summary>Agent done</summary></task-notification>'
    const { $ } = fakeEngine({
      messages: [
        { role: 'user', text: 'go', toolUses: [] },
        { role: 'assistant', text: 'spawned', toolUses: [] },
        { role: 'assistant', text: 'Both failed', toolUses: [] },
        { role: 'user', text: late, toolUses: [] },
      ],
      api: [
        { role: 'user', content: [{ type: 'text', text: 'go' }] },
        {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'plan it', signature: 's' },
            { type: 'text', text: 'spawned' },
          ],
        },
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Another Claude session sent a message: <agent-message from="a">x</agent-message>' },
          ],
        },
        {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'read the report', signature: 's' },
            { type: 'thinking', thinking: 'two fails', signature: 's' },
            { type: 'text', text: 'Both failed' },
          ],
        },
        { role: 'user', content: [{ type: 'text', text: `<system-reminder>${late}</system-reminder>` }] },
      ],
    })
    const latest = text(await draw($))
    expect(latest).toContain('Message from agent')
    expect(latest).toContain('Both failed')
    expect(latest).toContain('\u{F09D1} 2')
    expect(latest).not.toContain('No tool calls or output in this turn')
    await press($, 'nav-prev')
    const first = text(await draw($))
    expect(first).toContain('\u{F09D1} 1')
    expect(first).not.toContain('Both failed')
  })

  test('counts the shown turn thinking from the API form, read once per transcript', async () => {
    // The thinking cache is keyed by the transcript's fingerprint, so a
    // second draw of the same transcript reads the API form only once.
    const { $, world } = fakeEngine({
      messages: [
        { role: 'user', text: 'Think about main.go', toolUses: [] },
        { role: 'assistant', text: 'Thought it through.', toolUses: [] },
      ],
      api: [
        { role: 'user', content: [{ type: 'text', text: 'Think about main.go' }] },
        {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'Look at main.go', signature: 's' },
            { type: 'text', text: 'Thought it through.' },
          ],
        },
      ],
    })
    expect(text(await draw($))).toContain('\u{F09D1} 1')
    await draw($)
    expect(world.calls.filter(call => call === 'messages:api').length).toBe(1)
    await press($, 't0:thinking')
    expect(text(await draw($))).toContain('Look at main.go')
  })

  test('searches the turn list and focuses the field on s', async () => {
    const { $, world } = fakeEngine({ messages: three })
    await press($, 'nav-search')
    expect(world.focused).toEqual(['turn-search'])
    const field = byKey(await draw($), 'turn-search')
    ;(field?.props['onInput'] as (value: string) => void)('tests')
    await settle()
    expect(text(await draw($))).toContain('Turns (1 of 3)')
    ;(byKey(await draw($), 'turn-search')?.props['onSubmit'] as (value: string) => void)('fix')
    await settle()
    expect(text(await draw($))).toContain('1/3')
  })

  test('typing is never overwritten: the field keeps its seed until clear resets it under a new key', async () => {
    const { $, world } = fakeEngine({ messages: three })
    await say($, 'tail-turns')
    const typeInto = async (value: string) => {
      ;(byKey(await draw($), 'turn-search')?.props['onInput'] as (value: string) => void)(value)
    }
    // Drawings arrive late while the person types: none sends the query back.
    await typeInto('t')
    await typeInto('te')
    await settle()
    expect(byKey(await draw($), 'turn-search')?.props['value']).toBe('')
    expect(text(await draw($))).toContain('Turns (1 of 3)')
    // Clear resets the field: a new key, an empty value, every turn listed.
    await press($, 'search-clear')
    const field = byKey(await draw($), 'turn-search-1')
    expect(field?.props['value']).toBe('')
    expect(byKey(await draw($), 'turn-search')).toBeUndefined()
    expect(text(await draw($))).toContain('Turns (3)')
    // The search key focuses the field drawn now.
    await press($, 'nav-search')
    expect(world.focused).toEqual(['turn-search-1'])
    // Back from another view, the field shows the query it left with.
    ;(field?.props['onInput'] as (value: string) => void)('fix')
    await settle()
    await press($, 'nav-detail')
    await press($, 'nav-turns')
    expect(byKey(await draw($), 'turn-search-1')?.props['value']).toBe('fix')
  })

  test('copies a block, or says why it could not', async () => {
    const bash: SessionMessage[] = [
      { role: 'user', text: 'test it', toolUses: [] },
      {
        role: 'assistant',
        text: '',
        toolUses: [{ tool_use_id: 'b1', tool: 'Bash', input: { command: 'go test' }, text: 'PASS' }],
      },
    ]
    const ok = fakeEngine({ messages: bash })
    await press(ok.$, 'b1')
    await press(ok.$, 'copy:b1:output')
    expect(ok.world.copies).toEqual(['PASS'])
    expect(ok.world.toasts).toEqual(['Copied'])

    const refused = fakeEngine({ messages: bash, copyResult: { isCopied: false, reason: 'no-clipboard' } })
    await press(refused.$, 'b1')
    await press(refused.$, 'copy:b1:command')
    expect(refused.world.copies).toEqual(['go test'])
    expect(refused.world.toasts).toEqual(['Not copied: no-clipboard'])
  })

  test('navigates turns, drills into a subagent and expands everything', async () => {
    const { $ } = fakeEngine({ messages: three, agentMessages: { 'agent-1': child } })
    expect(text(await draw($))).toContain('3/3 live')
    await press($, 'nav-prev')
    expect(text(await draw($))).toContain('2/3')
    await press($, 'nav-prev')
    expect(text(await draw($))).toContain('1/3')
    // p on the first turn is still the pane's key and changes nothing.
    expect(byKey(await draw($), 'nav-prev')?.props['hotkey']).toBe('p')
    await press($, 'nav-prev')
    expect(text(await draw($))).toContain('1/3')
    await press($, 'nav-next')
    expect(text(await draw($))).toContain('2/3')
    await press($, 'nav-latest')
    expect(text(await draw($))).toContain('3/3 live')

    await press($, 'nav-turns')
    expect(text(await draw($))).toContain('Turns (3)')
    await press($, 'nav-detail')
    await press($, 'nav-turns')
    await press($, 'turn-0')
    expect(text(await draw($))).toContain('1/3')

    await press($, 'a1')
    expect(text(await draw($))).toContain('Execution Trace')
    await press($, 'a1')
    expect(text(await draw($))).not.toContain('Execution Trace')
    await press($, 'nav-expand')
    const open = text(await draw($))
    expect(open).toContain('package main')
    expect(open).toContain('Run(')
    await press($, 'nav-collapse')
    expect(text(await draw($))).not.toContain('package main')
  })

  test('folds a run of reads into a group row that opens on press and with expand all', async () => {
    const reads: SessionMessage[] = [
      { role: 'user', text: 'Read it all', toolUses: [] },
      {
        role: 'assistant',
        text: '',
        toolUses: [1, 2, 3, 4].map(n => ({
          tool_use_id: `rd${n}`,
          tool: 'Read',
          input: { file_path: `/src/f${n}.go` },
          text: 'package main',
        })),
      },
    ]
    const { $ } = fakeEngine({ messages: reads })
    const folded = await draw($)
    expect(String(byKey(folded, 'group:rd1')?.props['label']).trimEnd()).toBe('Read ×4 · 4 files')
    expect(byKey(folded, 'rd1')).toBeUndefined()
    await press($, 'group:rd1')
    expect(byKey(await draw($), 'rd1')).toBeDefined()
    await press($, 'group:rd1')
    expect(byKey(await draw($), 'rd1')).toBeUndefined()
    await press($, 'nav-expand')
    const open = await draw($)
    expect(byKey(open, 'rd4')).toBeDefined()
    expect(text(open)).toContain('package main')
    await press($, 'nav-collapse')
    expect(byKey(await draw($), 'rd1')).toBeUndefined()
  })

  test('builds the turns once while the transcript stays the same', async () => {
    let reads = 0
    const middle: SessionMessage = {
      role: 'assistant',
      toolUses: [],
      get text() {
        reads += 1
        return 'Counting.'
      },
    }
    const { $ } = fakeEngine({
      messages: [
        { role: 'user', text: 'Count me', toolUses: [] },
        middle,
        { role: 'user', text: 'Again', toolUses: [] },
      ],
    })
    await draw($)
    await draw($)
    expect(reads).toBe(1)
  })

  test('reads a finished subagent trace once', async () => {
    const { $, world } = fakeEngine({
      messages: [
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
      ],
      agentMessages: { 'agent-done': child },
      agents: [{ id: 'agent-done', description: 'Map callers', type: 'Explore', status: 'completed' }],
    })
    await press($, 'd1')
    await draw($)
    await draw($)
    expect(world.calls.filter(call => call === 'messages:agent-done').length).toBe(1)
  })

  describe('subagent trace cache', () => {
    const spawn = (agentId: string): SessionMessage[] => [
      { role: 'user', text: `Run ${agentId}`, toolUses: [] },
      {
        role: 'assistant',
        text: '',
        toolUses: [
          {
            tool_use_id: `t-${agentId}`,
            tool: 'Agent',
            input: { subagent_type: 'Explore', description: `Job ${agentId}` },
            agentId,
            text: 'ok',
          },
        ],
      },
    ]
    const reply = (more: string): SessionMessage[] => [
      { role: 'user', text: 'Go', toolUses: [] },
      { role: 'assistant', text: more, toolUses: [] },
    ]

    test('re-reads a finished agent once it resumes', async () => {
      const { $, world } = fakeEngine({
        messages: spawn('agent-resume'),
        agentMessages: { 'agent-resume': reply('First answer') },
        agents: [{ id: 'agent-resume', description: 'Job', type: 'Explore', status: 'completed' }],
      })
      await press($, 't-agent-resume')
      expect(text(await draw($))).toContain('First answer')
      world.agents = [{ id: 'agent-resume', description: 'Job', type: 'Explore', status: 'running' }]
      world.agentMessages['agent-resume'] = reply('Resumed answer')
      expect(text(await draw($))).toContain('Resumed answer')
    })

    test('a collapsed finished agent is read once for its failures, a running one not at all', async () => {
      const { $, world } = fakeEngine({
        messages: spawn('agent-done'),
        agentMessages: { 'agent-done': reply('Answer') },
        agents: [{ id: 'agent-done', description: 'Job', type: 'Explore', status: 'completed' }],
      })
      await draw($)
      await draw($)
      expect(world.calls.filter(c => c === 'messages:agent-done')).toHaveLength(1)
      const live = fakeEngine({
        messages: spawn('agent-run'),
        agentMessages: { 'agent-run': reply('Working') },
        agents: [{ id: 'agent-run', description: 'Job', type: 'Explore', status: 'running' }],
      })
      await draw(live.$)
      expect(live.world.calls).not.toContain('messages:agent-run')
    })

    test('a finished agent whose trace is denied is asked once, not on every drawing', async () => {
      const { $, world } = fakeEngine({
        messages: spawn('agent-denied'),
        agents: [{ id: 'agent-denied', description: 'Job', type: 'Explore', status: 'completed' }],
      })
      await draw($)
      await draw($)
      await draw($)
      expect(world.calls.filter(c => c === 'messages:agent-denied')).toHaveLength(1)
    })

    test('a collapsed subagent the engine does not list is not read', async () => {
      const { $, world } = fakeEngine({ messages: spawn('agent-old'), agentMessages: { 'agent-old': reply('Old') } })
      await draw($)
      expect(world.calls).not.toContain('messages:agent-old')
    })

    test('e on a turn with more rows than it keeps opens every subagent first, then their rows', async () => {
      const ids = Array.from({ length: 15 }, (_, i) => `agent-${i}`)
      const calls = (id: string) => [
        { role: 'user' as const, text: 'Go', toolUses: [] },
        {
          role: 'assistant' as const,
          text: '',
          toolUses: Array.from({ length: 25 }, (_, n) => ({
            tool_use_id: `${id}-c${n}`,
            tool: n % 2 === 0 ? 'Bash' : 'Grep',
            input: n % 2 === 0 ? { command: `echo ${n}` } : { pattern: `p${n}` },
            text: 'ok',
          })),
        },
      ]
      const { $ } = fakeEngine({
        messages: [
          { role: 'user', text: 'Run them', toolUses: [] },
          {
            role: 'assistant',
            text: '',
            toolUses: ids.map(id => ({
              tool_use_id: `t-${id}`,
              tool: 'Agent',
              input: { subagent_type: 'Explore', description: `Job ${id}` },
              agentId: id,
              text: 'ok',
            })),
          },
        ],
        agentMessages: Object.fromEntries(ids.map(id => [id, calls(id)])),
        agents: ids.map(id => ({ id, description: 'Job', type: 'Explore', status: 'completed' as const })),
      })
      await draw($)
      await press($, 'nav-expand')
      const all = text(await draw($))
      expect(all.split('Execution Trace').length - 1).toBe(15)
    })

    test("e opens a finished subagent's trace rows too, the cursor walks only open rows", async () => {
      const { $ } = fakeEngine({
        messages: spawn('agent-x'),
        agentMessages: {
          'agent-x': [
            { role: 'user', text: 'Go', toolUses: [] },
            {
              role: 'assistant',
              text: '',
              toolUses: [{ tool_use_id: 'c1', tool: 'Bash', input: { command: 'ls' }, text: 'listing' }],
            },
          ],
        },
        agents: [{ id: 'agent-x', description: 'Job', type: 'Explore', status: 'completed' }],
      })
      await press($, 'nav-expand')
      const all = text(await draw($))
      expect(all).toContain('Execution Trace')
      expect(all).toContain('listing')
    })

    test('an opened subagent past the cap still loads', async () => {
      const ids = Array.from({ length: 230 }, (_, i) => `ag-${i}`)
      const { $, world } = fakeEngine({
        messages: [
          { role: 'user', text: 'Run', toolUses: [] },
          {
            role: 'assistant',
            text: '',
            toolUses: ids.map(id => ({
              tool_use_id: `t-${id}`,
              tool: 'Agent',
              input: { description: id },
              agentId: id,
              text: 'ok',
            })),
          },
        ],
        agentMessages: Object.fromEntries(ids.map(id => [id, reply(`answer ${id}`)])),
        agents: ids.map(id => ({ id, description: 'Job', type: 'Explore', status: 'completed' as const })),
      })
      await press($, 't-ag-225')
      const drawn = text(await draw($))
      expect(world.calls).toContain('messages:ag-225')
      expect(drawn).toContain('answer ag-225')
    })

    test('reuses a running agent trace until it changes', async () => {
      let reads = 0
      const steady: SessionMessage = {
        role: 'assistant',
        toolUses: [],
        get text() {
          reads += 1
          return 'Working.'
        },
      }
      const tail: SessionMessage = { role: 'user', text: 'Next', toolUses: [] }
      const { $, world } = fakeEngine({
        messages: spawn('agent-live'),
        agentMessages: { 'agent-live': [{ role: 'user', text: 'Go', toolUses: [] }, steady, tail] },
        agents: [{ id: 'agent-live', description: 'Job', type: 'Explore', status: 'running' }],
      })
      await press($, 't-agent-live')
      await draw($)
      await draw($)
      expect(reads).toBe(1)
      world.agentMessages['agent-live'] = [{ role: 'user', text: 'Go', toolUses: [] }, steady, tail, ...reply('More')]
      await draw($)
      expect(reads).toBe(2)
    })
  })

  test('says why a trace is unavailable', async () => {
    const { $ } = fakeEngine({ messages: main })
    await press($, 'a1')
    expect(text(await draw($))).toContain('Trace unavailable: no agent-1')
  })

  test('shows a long result whole on demand', async () => {
    const lines = Array.from({ length: 500 }, (_, i) => `line ${i}`).join('\n')
    const { $ } = fakeEngine({
      messages: [
        { role: 'user', text: 'run it', toolUses: [] },
        {
          role: 'assistant',
          text: '',
          toolUses: [{ tool_use_id: 'b1', tool: 'Bash', input: { command: 'seq 500' }, text: lines }],
        },
      ],
    })
    await press($, 'b1')
    expect(text(await draw($))).not.toContain('line 499')
    await press($, 'full:b1:output')
    expect(text(await draw($))).toContain('line 499')
  })

  test('opens the team board with teammates and tasks', async () => {
    const plain = fakeEngine({ messages: main })
    await press(plain.$, 'nav-team')
    expect(text(await draw(plain.$))).not.toContain('Team (')

    const { $ } = fakeEngine({
      messages: [
        { role: 'user', text: 'Plan', toolUses: [] },
        {
          role: 'assistant',
          text: '',
          toolUses: [
            {
              tool_use_id: 'c1',
              tool: 'TaskCreate',
              input: { subject: 'Write tests' },
              text: 'Task #1 created successfully: Write tests',
            },
          ],
        },
      ],
      agents: [{ id: 'tm1', teammateId: 'alice@crew', description: 'help', type: 'teammate', status: 'running' }],
    })
    await press($, 'nav-team')
    const all = text(await draw($))
    expect(all).toContain('Team (1)')
    expect(all).toContain('alice')
    expect(all).toContain('☐ #1 Write tests')
  })
})

describe('footer keys', () => {
  test('h expands and collapses the footer for the session', async () => {
    const { $ } = fakeEngine({ messages: main })
    expect(byKey(await draw($), 'footer-rule')).toBeDefined()
    expect(byKey(await draw($), 'footer-row-keys')).toBeDefined()
    await press($, 'nav-keys')
    expect(byKey(await draw($), 'footer-row-keys')).toBeUndefined()
    await press($, 'nav-keys')
    expect(byKey(await draw($), 'footer-row-keys')).toBeDefined()
  })

  test('t on the team board opens the turn list', async () => {
    const { $ } = fakeEngine({
      messages: main,
      agents: [{ id: 'tm1', teammateId: 'alice@crew', description: 'help', type: 'teammate', status: 'running' }],
    })
    await press($, 'nav-team')
    expect(text(await draw($))).toContain('Team (1)')
    await press($, 'nav-turns')
    expect(text(await draw($))).toContain('Turns (')
  })
})

describe('keyboard cursor', () => {
  const markOf = (tree: unknown) => {
    const found: string[] = []
    const walk = (t: unknown) => {
      if (Array.isArray(t)) t.forEach(walk)
      else if (t !== null && typeof t === 'object' && 'props' in t) {
        const n = t as { props: Record<string, unknown>; children: unknown }
        if (String(n.props['key']).startsWith('cursor-') && text(n) !== ' ') found.push(String(n.props['key']).slice(7))
        walk(n.children)
      }
    }
    walk(tree)
    return found
  }

  test('j and k move the cursor, mark the row and take the engine focus ring with them', async () => {
    const { $, world } = fakeEngine({ messages: main, agentMessages: { 'agent-1': child } })
    expect(markOf(await draw($))).toEqual([])
    await press($, 'nav-down')
    expect(markOf(await draw($))).toEqual(['t0:o0'])
    await press($, 'nav-down')
    await press($, 'nav-down')
    await press($, 'nav-down')
    expect(markOf(await draw($))).toEqual(['a1'])
    await press($, 'nav-up')
    expect(markOf(await draw($))).toEqual(['r1'])
    // The ring follows the cursor, so Enter presses the row under it.
    expect(world.focused.at(-1)).toBe('r1')
    expect(world.focused).toContain('t0:o0')
  })

  test('the focus retries after /tail keep the pane at its width', async () => {
    const { $, world } = fakeEngine({ messages: main })
    world.isPaneFocused = false
    await say($, 'tail')
    await settle()
    for (let i = 0; i < 10; i++) await settle()
    const opens = world.openArgs as { columns?: number; focus?: true }[]
    expect(opens.length).toBeGreaterThan(1)
    for (const open of opens) expect(typeof open.columns, JSON.stringify(open)).toBe('number')
  })

  test('taking the keys back after Esc keeps the pane at its width', async () => {
    const { $, world } = fakeEngine({ messages: main })
    const focused = (isFocused: boolean) => ({ ...PANE_EVENT, props: { ...PANE_EVENT.props, isFocused } })
    await run('ui.render', $, focused(true))
    await press($, 'nav-search')
    await run('ui.render', $, focused(true))
    await run('ui.render', $, focused(false))
    await settle()
    const last = world.openArgs.at(-1) as { columns?: number; focus?: true }
    expect(last.focus).toBe(true)
    expect(typeof last.columns).toBe('number')
  })

  test("after leaving the search for another view, a later focus loss is the person's", async () => {
    const { $, world } = fakeEngine({ messages: main })
    const focused = (isFocused: boolean) => ({ ...PANE_EVENT, props: { ...PANE_EVENT.props, isFocused } })
    await run('ui.render', $, focused(true))
    await press($, 'nav-search')
    await press($, 'nav-detail')
    await run('ui.render', $, focused(true))
    const before = world.focusRequests
    await run('ui.render', $, focused(false))
    await settle()
    expect(world.focusRequests).toBe(before)
  })

  test('Esc in the search field leaves the field, not the pane', async () => {
    const { $, world } = fakeEngine({ messages: main })
    const focused = (isFocused: boolean) => ({ ...PANE_EVENT, props: { ...PANE_EVENT.props, isFocused } })
    await run('ui.render', $, focused(true))
    // The plugin's own $.ui.focus raises no ui.focus hook of its own (seen
    // live), so `s` alone must mark the field.
    await press($, 'nav-search')
    await run('ui.render', $, focused(true))
    const before = world.focusRequests
    await run('ui.render', $, focused(false))
    await settle()
    expect(world.focusRequests).toBe(before + 1)
    // Once back, a second Esc (outside the field) returns the keys for good.
    await run('ui.render', $, focused(true))
    await run('ui.render', $, focused(false))
    await settle()
    expect(world.focusRequests).toBe(before + 1)
  })

  test('a Tab or a click that moves the ring onto a row moves the cursor there', async () => {
    const { $ } = fakeEngine({ messages: main, agentMessages: { 'agent-1': child } })
    await draw($)
    await run(
      'ui.focus',
      $,
      { component: 'Pane', requestId: 'tail', element: 'r1', origin: { kind: 'person' } },
      async () => ({}),
    )
    expect(markOf(await draw($))).toEqual(['r1'])
    await run(
      'ui.focus',
      $,
      { component: 'Pane', requestId: 'tail', element: 'nav-down', origin: { kind: 'person' } },
      async () => ({}),
    )
    expect(markOf(await draw($))).toEqual(['r1'])
  })

  test('the cursor moves on a row the ring cannot take', async () => {
    const { $, world } = fakeEngine({ messages: main, agentMessages: { 'agent-1': child } })
    world.focusDenied = ['t0:o0']
    await draw($)
    await press($, 'nav-down')
    expect(markOf(await draw($))).toEqual(['t0:o0'])
    expect(world.focused).toEqual([])
  })

  test('in the turn list j moves the ring onto the turn row, the selected turn a button too', async () => {
    const { $, world } = fakeEngine({
      messages: [
        ...main,
        { role: 'user', text: 'Second', toolUses: [] },
        { role: 'assistant', text: 'two', toolUses: [] },
      ],
    })
    await press($, 'nav-turns')
    await draw($)
    await press($, 'nav-down')
    await press($, 'nav-down')
    const key = world.focused.at(-1)
    expect(key).toMatch(/^turn-\d+$/)
    const tree = await draw($)
    for (const row of ['turn-0', 'turn-1']) expect(byKey(tree, row)?.type, row).toBe('Button')
  })

  test('o opens and closes the row under the cursor, a subagent adds its trace rows', async () => {
    const { $ } = fakeEngine({ messages: main, agentMessages: { 'agent-1': child } })
    await press($, 'nav-up')
    expect(markOf(await draw($))).toEqual(['a1'])
    await press($, 'nav-open')
    expect(text(await draw($))).toContain('Execution Trace')
    await press($, 'nav-down')
    expect(markOf(await draw($))).toEqual(['agent-1/g1'])
    await press($, 'nav-up')
    await press($, 'nav-open')
    expect(text(await draw($))).not.toContain('Execution Trace')
  })

  test('o on a row with nothing to open changes nothing', async () => {
    const { $, world } = fakeEngine({ messages: main })
    world.messages = [
      { role: 'user', text: 'x', toolUses: [] },
      { role: 'assistant', text: '', toolUses: [{ tool_use_id: 'q1', tool: 'Bash', input: {} }] },
    ]
    await press($, 'nav-down')
    const before = text(await draw($))
    await press($, 'nav-open')
    expect(text(await draw($))).toBe(before)
  })

  test('y copies the whole text of the row under the cursor, with the surface of the press', async () => {
    const { $, world } = fakeEngine({ messages: main })
    await press($, 'nav-down')
    await press($, 'nav-down')
    await press($, 'nav-copy')
    expect(world.copies).toHaveLength(1)
    expect(world.copies[0]).toContain('/a/b/main.go')
    expect(world.copies[0]).toContain('package main')
    expect(world.toasts).toEqual(['Copied'])
  })

  test('the cursor is dropped when the turn changes, and y has nothing to copy without one', async () => {
    const { $, world } = fakeEngine({ messages: three })
    await press($, 'nav-down')
    expect(markOf(await draw($))).toHaveLength(1)
    await press($, 'nav-prev')
    expect(markOf(await draw($))).toEqual([])
    await press($, 'nav-copy')
    expect(world.copies).toEqual([])
    expect(world.toasts).toEqual([])
  })
})

describe('own scroll', () => {
  // Twenty calls under one prompt: 22 rows of content in a window of six.
  const long: SessionMessage[] = [
    { role: 'user', text: 'Run many', toolUses: [] },
    {
      role: 'assistant',
      text: 'Ran.',
      toolUses: Array.from({ length: 20 }, (_, i) => ({
        tool_use_id: `b${i}`,
        tool: 'Bash',
        input: { command: `echo ${i}` },
        text: `${i}`,
      })),
    },
  ]
  // A window of six rows: the body less the header's two and the collapsed footer's two.
  const SMALL = { ...PANE_EVENT, props: { ...PANE_EVENT.props, scroll: { offset: 0, bodyRows: 10 } } }
  const drawSmall = ($: Parameters<typeof run>[1]) => run('ui.render', $, SMALL)
  const topOf = async ($: Parameters<typeof run>[1]) => byKey(await drawSmall($), 'pane-content')?.props['marginTop']
  async function pressSmall($: Parameters<typeof run>[1], key: string) {
    const button = byKey(await drawSmall($), key)
    if (!button) throw new Error(`no button ${key}`)
    ;(button.props['onPress'] as (e: unknown) => void)({ surface: 'terminal' })
    await settle()
  }

  test('f pages the content down and b back up, a no-op at the ends', async () => {
    const { $ } = fakeEngine({ messages: long })
    expect(await topOf($)).toBe(0)
    await pressSmall($, 'nav-pageup')
    expect(await topOf($)).toBe(0)
    await pressSmall($, 'nav-pagedown')
    expect(await topOf($)).toBe(-4)
    await pressSmall($, 'nav-pagedown')
    expect(await topOf($)).toBe(-8)
    await pressSmall($, 'nav-pageup')
    expect(await topOf($)).toBe(-4)
    for (let i = 0; i < 5; i++) await pressSmall($, 'nav-pagedown')
    expect(await topOf($)).toBe(-18)
    expect(text(byKey(await drawSmall($), 'footer-status'))).toContain('end')
  })

  test('j past the bottom of the window scrolls the cursor row into view, k past the top back', async () => {
    const { $ } = fakeEngine({ messages: long })
    for (let i = 0; i < 4; i++) await pressSmall($, 'nav-down')
    expect(await topOf($)).toBe(0)
    await pressSmall($, 'nav-down')
    expect(await topOf($)).toBe(-1)
    await pressSmall($, 'nav-down')
    expect(await topOf($)).toBe(-2)
    for (let i = 0; i < 3; i++) await pressSmall($, 'nav-up')
    expect(await topOf($)).toBe(-2)
    await pressSmall($, 'nav-up')
    expect(await topOf($)).toBe(-1)
  })

  test('every key out of reach is still the pane key: pressing it keeps the state', async () => {
    const { $, world } = fakeEngine({ messages: long })
    const before = text(await drawSmall($))
    for (const key of ['nav-prev', 'nav-next', 'nav-latest', 'nav-open', 'nav-copy', 'nav-team', 'nav-pageup']) {
      expect(byKey(await drawSmall($), key)?.type, key).toBe('Button')
      expect(typeof byKey(await drawSmall($), key)?.props['hotkey'], key).toBe('string')
      await pressSmall($, key)
    }
    expect(text(await drawSmall($))).toBe(before)
    expect(world.copies).toEqual([])
    expect(world.focused).toEqual([])
  })

  test('the wheel and the page keys of the engine move the own scroll by a step or a page, never the engine window', async () => {
    const { $ } = fakeEngine({ messages: long })
    await drawSmall($)
    const nexts: unknown[] = []
    const wheel = (by: number) =>
      run(
        'ui.scroll',
        $,
        {
          component: 'Pane',
          requestId: 'tail',
          offset: 0,
          by,
          bodyRows: 10,
          contentRows: 10,
          origin: { kind: 'person' },
        },
        async e => (nexts.push(e), {}),
      )
    expect(await wheel(3)).toEqual({})
    expect(await topOf($)).toBe(-3)
    expect(await wheel(-1)).toEqual({})
    expect(await topOf($)).toBe(-2)
    // A page key arrives as the whole pane body: one page of the own window (6 - 2).
    await wheel(10)
    expect(await topOf($)).toBe(-6)
    await wheel(-10)
    expect(await topOf($)).toBe(-2)
    await wheel(10)
    expect(await topOf($)).toBe(-6)
    // Home and End, beyond the body: the top and the end.
    await wheel(100)
    expect(await topOf($)).toBe(-18)
    await wheel(-100)
    expect(await topOf($)).toBe(0)
    expect(nexts).toEqual([])
    // The turn list keeps its own: it fits, so a tick there moves nothing.
    await pressSmall($, 'nav-turns')
    await wheel(5)
    expect(await topOf($)).toBe(0)
  })

  test('after paging down, the first j or k lands inside the window and the view stays', async () => {
    const { $ } = fakeEngine({ messages: long })
    await pressSmall($, 'nav-pagedown')
    await pressSmall($, 'nav-pagedown')
    expect(await topOf($)).toBe(-8)
    await pressSmall($, 'nav-down')
    expect(await topOf($)).toBe(-8)
  })

  test('a new latest turn that no prompt of this session started opens at the top, and keeps its scroll as it grows', async () => {
    const { $, world } = fakeEngine({ messages: long })
    await pressSmall($, 'nav-pagedown')
    expect(await topOf($)).toBe(-4)
    world.messages = [...long, ...long]
    expect(await topOf($)).toBe(0)
    await pressSmall($, 'nav-pagedown')
    expect(await topOf($)).toBe(-4)
    const grown = structuredClone(long)
    grown[1]!.toolUses.push({ tool_use_id: 'b99', tool: 'Bash', input: { command: 'echo more' }, text: 'more' })
    world.messages = [...long, ...grown]
    expect(await topOf($)).toBe(-4)
  })

  test('a change of view, of turn or a new prompt scrolls back to the top', async () => {
    const { $ } = fakeEngine({ messages: [...long, ...long] })
    await pressSmall($, 'nav-pagedown')
    expect(await topOf($)).toBe(-4)
    await pressSmall($, 'nav-turns')
    await pressSmall($, 'nav-detail')
    expect(await topOf($)).toBe(0)
    await pressSmall($, 'nav-pagedown')
    await pressSmall($, 'nav-prev')
    expect(await topOf($)).toBe(0)
    await pressSmall($, 'nav-pagedown')
    await pressSmall($, 'nav-latest')
    expect(await topOf($)).toBe(0)
    await pressSmall($, 'nav-pagedown')
    await run('prompt.submit', $, { text: 'more' }, async e => e)
    expect(await topOf($)).toBe(0)
  })
})

// Every node of a tree, keyed or not.
const byKeyless = (tree: unknown): { type: string; props: Record<string, unknown> }[] => {
  const out: { type: string; props: Record<string, unknown> }[] = []
  const walk = (t: unknown) => {
    if (Array.isArray(t)) t.forEach(walk)
    else if (t !== null && typeof t === 'object' && 'props' in t) {
      out.push(t as { type: string; props: Record<string, unknown> })
      walk((t as { children?: unknown }).children)
    }
  }
  walk(tree)
  return out
}

describe('compact transcript', () => {
  const RESULT = {
    component: 'ToolResult',
    surface: 'terminal',
    props: { tool_use_id: 'b1', tool: 'Bash', output: { stdout: 'a\nb\nc', stderr: '' }, isErrored: false },
  }
  const USE = {
    component: 'ToolUse',
    surface: 'terminal',
    props: {
      tool_use_id: 'b9',
      tool: 'Bash',
      input: { command: 'ls', description: 'List' },
      isRunning: true,
      isErrored: false,
      isInterrupted: false,
    },
  }

  test('a compact tool row never shrinks the tool name', async () => {
    const { $ } = fakeEngine()
    const long = {
      ...USE,
      props: { ...USE.props, input: { command: 'echo '.repeat(40), description: 'x'.repeat(80) } },
    }
    const tree = (await run('ui.render', $, long, async () => 'engine')) as Parameters<typeof text>[0]
    const fixed = byKeyless(tree).filter(n => n.type === 'Box' && n.props['flexShrink'] === 0)
    expect(fixed.some(n => text(n) === 'Bash')).toBe(true)
  })

  test('draws one-line rows until /tail-compact turns it off', async () => {
    const { $ } = fakeEngine()
    expect(text(await run('ui.render', $, RESULT, async () => 'engine'))).toContain('⎿ 3 lines')
    expect(text(await run('ui.render', $, USE, async () => 'engine'))).toContain('List')
    let seen: unknown
    await run('ui.render', $, { component: 'ToolGroup', surface: 'terminal', props: { isExpanded: true } }, async e => {
      seen = e
      return 'group'
    })
    expect((seen as { props: { isExpanded: boolean } }).props.isExpanded).toBe(false)

    await say($, 'tail-compact')
    expect(await run('ui.render', $, RESULT, async () => 'engine')).toBe('engine')
    expect(await run('ui.render', $, USE, async () => 'engine')).toBe('engine')
  })
})

describe('status line', () => {
  const call = { tool_use_id: 'b1', tool: 'Bash', command: 'go test ./...' }
  const hold = () => {
    let release = () => undefined as unknown
    const next = () => new Promise(resolve => (release = () => resolve({})))
    return { next, release: () => release() }
  }
  const last = (world: { statuses: (string | undefined)[] }) => world.statuses.at(-1)

  const spinnerOf = async ($: Parameters<typeof run>[1]) =>
    (
      (await run(
        'ui.render',
        $,
        {
          component: 'Spinner',
          surface: 'terminal',
          props: { word: 'Sauteing', message: null, suffix: '…', mode: 'tool-use' },
        },
        async x => x,
      )) as { props: Record<string, unknown> }
    ).props['message']

  test('the status line is off until /tail-status on, the spinner text is on', async () => {
    const { $, world } = fakeEngine()
    const gate = hold()
    const running = run('tool.call', $, call, gate.next)
    await settle()
    expect(world.statuses.filter(s => s !== undefined)).toEqual([])
    expect(String(await spinnerOf($))).toContain('Bash')
    gate.release()
    await running
  })

  test('/tail-status alone says the line is off by default and what stays on', async () => {
    const { $ } = fakeEngine()
    const answer = await say($, 'tail-status')
    expect(answer).toContain('Status line: off')
    expect(answer).toContain('spinner text and turn counts: on')
    expect(await say($, 'tail-status', 'on')).toBe('Status line, spinner text and turn counts: on.')
  })

  test('a stored on keeps the status line', async () => {
    const { $, world } = fakeEngine()
    world.store.set('tail-view.status', true)
    const gate = hold()
    const running = run('tool.call', $, call, gate.next)
    await settle()
    expect(world.statuses.filter(s => s !== undefined).length).toBeGreaterThan(0)
    gate.release()
    await running
  })

  test('off still turns the line and the spinner text off', async () => {
    const { $, world } = fakeEngine()
    world.store.set('tail-view.status', false)
    const gate = hold()
    const running = run('tool.call', $, call, gate.next)
    await settle()
    expect(world.statuses.filter(s => s !== undefined)).toEqual([])
    expect(await spinnerOf($)).toBeNull()
    gate.release()
    await running
  })

  test('a main-loop tool sets the status while it runs and clears it after', async () => {
    const { $, world } = fakeEngine()
    world.store.set('tail-view.status', true)
    const gate = hold()
    const running = run('tool.call', $, call, gate.next)
    await settle()
    expect(last(world)).toBe('\u{F0BE0} Bash go test ./... · 0s')
    gate.release()
    await running
    await settle()
    expect(last(world)).toBeUndefined()
    expect(world.statuses).toHaveLength(2)
  })

  test('the ticker refreshes the elapsed time and sets nothing when the text is unchanged', async () => {
    const { $, world } = fakeEngine()
    world.store.set('tail-view.status', true)
    const gate = hold()
    const running = run('tool.call', $, call, gate.next)
    await settle()
    const tick = world.timers[0]!
    world.now += 400
    tick()
    await settle()
    expect(world.statuses).toHaveLength(1)
    world.now += 12_000
    tick()
    await settle()
    expect(last(world)).toBe('\u{F0BE0} Bash go test ./... · 12s')
    expect(world.statuses).toHaveLength(2)
    gate.release()
    await running
  })

  test('a subagent tool call leaves the status alone', async () => {
    const { $, world } = fakeEngine()
    const gate = hold()
    const running = run('tool.call', $, { ...call, agentId: 'ag' }, gate.next)
    await settle()
    expect(world.statuses).toEqual([])
    gate.release()
    await running
  })

  test('turn.complete and a dropped prompt clear it', async () => {
    const { $, world } = fakeEngine()
    world.store.set('tail-view.status', true)
    const gate = hold()
    const running = run('tool.call', $, call, gate.next)
    await settle()
    await run(
      'turn.complete',
      $,
      { answer: '', isAborted: true, reason: 'aborted', turnId: 't', durationMs: 1 },
      async () => ({ text: '' }),
    )
    expect(last(world)).toBeUndefined()
    gate.release()
    await running
    const again = hold()
    const next = run('tool.call', $, call, again.next)
    await settle()
    expect(last(world)).toContain('Bash')
    await run('prompt.submit', $, { text: 'again' }, async () => ({ drop: 'blocked' }))
    expect(last(world)).toBeUndefined()
    again.release()
    await next
  })

  test('/tail-status keeps the choice in the store, names it, and off sets nothing', async () => {
    const { $, world } = fakeEngine()
    expect(await say($, 'tail-status')).toContain('on')
    expect(await say($, 'tail-status', 'bogus')).toContain('on|off')
    expect(world.store.get('tail-view.status')).toBeUndefined()
    expect(await say($, 'tail', 'status off')).toContain('off')
    expect(world.store.get('tail-view.status')).toBe(false)
    const gate = hold()
    const running = run('tool.call', $, call, gate.next)
    await settle()
    expect(world.statuses.filter(s => s !== undefined)).toEqual([])
    gate.release()
    await running
    expect(await say($, 'tail-status', 'on')).toContain('on')
    expect(world.store.get('tail-view.status')).toBe(true)
  })

  test('turning it off clears a status that is showing, and the ascii set gives ASCII', async () => {
    const { $, world } = fakeEngine()
    world.store.set('tail-view.status', true)
    await say($, 'tail-icons', 'ascii')
    const gate = hold()
    const running = run('tool.call', $, call, gate.next)
    await settle()
    expect(last(world)).toBe('$ Bash go test ./... . 0s')
    await say($, 'tail-status', 'off')
    expect(last(world)).toBeUndefined()
    gate.release()
    await running
  })
})

describe('transcript spinner and turn duration', () => {
  const call = { tool_use_id: 'b1', tool: 'Bash', command: 'go test ./...' }
  const hold = () => {
    let release = () => undefined as unknown
    const next = () => new Promise(resolve => (release = () => resolve({})))
    return { next, release: () => release() }
  }
  const spinner = {
    component: 'Spinner',
    surface: 'terminal',
    props: { word: 'Sauteing', message: null, suffix: '…', mode: 'tool-use' },
  }
  const duration = { component: 'TurnDuration', surface: 'terminal', props: { word: 'Baked', durationMs: 3_000 } }
  const props = async ($: Parameters<typeof run>[1], e: Record<string, unknown>) =>
    ((await run('ui.render', $, e, async x => x)) as { props: Record<string, unknown> }).props

  test('the spinner names the running tool, its summary and the elapsed time', async () => {
    const { $, world } = fakeEngine()
    const gate = hold()
    const running = run('tool.call', $, call, gate.next)
    await settle()
    world.now += 12_400
    // The spinner says what the last sync set: the ticker moves it on.
    expect((await props($, spinner))['message']).toBe('Bash go test ./... · 0s')
    world.timers[0]!()
    await settle()
    expect(await props($, spinner)).toMatchObject({ message: 'Bash go test ./... · 12s', suffix: '', word: 'Sauteing' })
    gate.release()
    await running
    await settle()
    expect(await props($, spinner)).toMatchObject({ message: null, suffix: '…' })
  })

  test('a status change redraws through state, never the whole transcript', async () => {
    const { $, world } = fakeEngine()
    world.store.set('tail-view.status', true)
    const gate = hold()
    const running = run('tool.call', $, call, gate.next)
    await settle()
    for (let i = 0; i < 3; i++) {
      world.now += 1_000
      world.timers[0]!()
      await settle()
    }
    gate.release()
    await running
    await settle()
    expect(world.statuses.length).toBeGreaterThan(2)
    expect(world.invalidations).toEqual([])
  })

  test('the spinner is left alone for a subagent tool, with the switch off, and draws ASCII in the ascii set', async () => {
    const { $, world } = fakeEngine()
    const sub = hold()
    const inner = run('tool.call', $, { ...call, agentId: 'ag' }, sub.next)
    await settle()
    expect((await props($, spinner))['message']).toBeNull()
    sub.release()
    await inner

    const gate = hold()
    const running = run('tool.call', $, { ...call, tool_use_id: 'b2' }, gate.next)
    await settle()
    await say($, 'tail-icons', 'ascii')
    expect((await props($, spinner))['message']).toBe('Bash go test ./... . 0s')
    await say($, 'tail-status', 'off')
    expect(await props($, spinner)).toMatchObject({ message: null, suffix: '…' })
    expect(world.store.get('tail-view.status')).toBe(false)
    gate.release()
    await running
  })

  // Runs one main-loop turn through submit, start and complete, the
  // transcript holding `rows` once it started.
  const turn = async (
    $: Parameters<typeof run>[1],
    world: { messages: SessionMessage[] },
    rows: SessionMessage[],
    turnId: string,
    durationMs: number,
  ) => {
    const prompt = rows.filter(r => r.role === 'user').at(-1)!.text
    await run('prompt.submit', $, { text: prompt }, async e => e)
    world.messages = rows
    await run('turn.start', $, { turnId, text: prompt }, async e => e)
    await run('turn.complete', $, { answer: '', isAborted: false, reason: 'answer', turnId, durationMs }, async () => ({
      text: '',
    }))
  }
  const at = (durationMs: number) => ({ ...duration, props: { ...duration.props, durationMs } })

  test('the turn duration line gets the tool and agent counts of its turn', async () => {
    const { $, world } = fakeEngine()
    await turn($, world, main, 't1', 3_000)
    const drawn = await run('ui.render', $, duration, async x => x)
    expect(text(drawn)).toBe('Baked for 3s · 1 tool · 1 agent')
    expect((drawn as { props: Record<string, unknown> }).props['color']).toBe('inactive')
  })

  test('each turn duration line keeps the counts of its own turn as later turns run', async () => {
    const { $, world } = fakeEngine()
    await turn($, world, main, 't1', 3_000)
    await turn($, world, three.slice(0, 4), 't2', 5_000)
    expect(text(await run('ui.render', $, at(3_000), async x => x))).toBe('Baked for 3s · 1 tool · 1 agent')
    expect(text(await run('ui.render', $, at(5_000), async x => x))).toBe('Baked for 5s · 1 tool')
    // A third turn that is still running changes neither line.
    await run('prompt.submit', $, { text: 'Thanks' }, async e => e)
    world.messages = [...three.slice(0, 4), { role: 'user', text: 'Thanks', toolUses: [] }]
    expect(text(await run('ui.render', $, at(3_000), async x => x))).toBe('Baked for 3s · 1 tool · 1 agent')
    expect(text(await run('ui.render', $, at(5_000), async x => x))).toBe('Baked for 5s · 1 tool')
  })

  test('a line whose turn has no stat is the engine own, and the transcript is read once per turn', async () => {
    const { $, world } = fakeEngine()
    await turn($, world, main, 't1', 3_000)
    expect(await props($, at(7_000))).toMatchObject({ word: 'Baked', durationMs: 7_000 })
    await run('ui.render', $, duration, async x => x)
    world.calls.length = 0
    await run('ui.render', $, duration, async x => x)
    await run('ui.render', $, duration, async x => x)
    expect(world.calls.filter(c => c === 'messages:main')).toEqual([])
  })

  test("the turn duration line is the engine's own with the switch off or nothing to count", async () => {
    const { $, world } = fakeEngine()
    await turn($, world, main, 't1', 3_000)
    await say($, 'tail-status', 'off')
    expect(await props($, duration)).toMatchObject({ word: 'Baked', durationMs: 3_000 })
    await say($, 'tail-status', 'on')
    await turn(
      $,
      world,
      [...main, { role: 'user', text: 'hi', toolUses: [] }, { role: 'assistant', text: 'Hello', toolUses: [] }],
      't2',
      4_000,
    )
    expect(await props($, at(4_000))).toMatchObject({ word: 'Baked', durationMs: 4_000 })
  })

  test('/tail-status redraws the transcript once when the switch changes', async () => {
    const { $, world } = fakeEngine()
    await say($, 'tail-status', 'off')
    expect(world.invalidations).toEqual(['ui.render'])
    await say($, 'tail-status', 'off')
    await say($, 'tail-status')
    expect(world.invalidations).toEqual(['ui.render'])
    await say($, 'tail-status', 'on')
    expect(world.invalidations).toEqual(['ui.render', 'ui.render'])
  })

  test('the ascii set gives an ASCII duration line', async () => {
    const { $, world } = fakeEngine()
    await turn($, world, main, 't1', 3_000)
    await say($, 'tail-icons', 'ascii')
    expect(text(await run('ui.render', $, duration, async x => x))).toBe('Baked for 3s . 1 tool . 1 agent')
  })
})

describe('finish toasts', () => {
  const info = (status: 'running' | 'completed', id = 'ag-1') => ({
    id,
    description: 'Find callers',
    type: 'Explore',
    status,
  })
  const tick = async (world: { timers: (() => void)[] }) => {
    world.timers[0]!()
    await settle()
  }
  const start = async ($: Parameters<typeof run>[1]) => {
    await run('prompt.submit', $, { text: 'go' }, async e => e)
  }

  test('toasts are off until /tail-notify on, and the choice is kept', async () => {
    const { $, world } = fakeEngine({ agents: [info('running')] as never })
    expect(await say($, 'tail-notify')).toContain('off')
    expect(await say($, 'tail-notify', 'bogus')).toContain('on|off')
    expect(world.store.get('tail-view.notify')).toBeUndefined()
    await start($)
    await tick(world)
    world.agents = [info('completed')] as never
    await tick(world)
    expect(world.toasts).toEqual([])
    expect(await say($, 'tail', 'notify on')).toContain('on')
    expect(world.store.get('tail-view.notify')).toBe(true)
    expect(await say($, 'tail-notify', 'off')).toBe('Notifications: off.')
    expect(world.store.get('tail-view.notify')).toBe(false)
  })

  test('a subagent that finishes toasts once, with its description', async () => {
    const { $, world } = fakeEngine({ agents: [info('running')] as never })
    await say($, 'tail-notify', 'on')
    await start($)
    await tick(world)
    expect(world.toasts).toEqual([])
    world.agents = [info('completed')] as never
    await tick(world)
    await tick(world)
    expect(world.toasts).toEqual(['Subagent finished: Find callers'])
    // Running again and finishing again is the same agent: no second toast.
    world.agents = [info('running')] as never
    await tick(world)
    world.agents = [info('completed')] as never
    await tick(world)
    expect(world.toasts).toHaveLength(1)
  })

  test('agents already finished when seen first, or never listed running, do not toast', async () => {
    const { $, world } = fakeEngine({ agents: [info('completed', 'old')] as never })
    await say($, 'tail-notify', 'on')
    await start($)
    await tick(world)
    expect(world.toasts).toEqual([])
  })

  test('the description is cleaned and cut, in ASCII under the ascii set', async () => {
    const description = `Find \u001b[31mcallers\u202e ${'x'.repeat(100)}`
    const { $, world } = fakeEngine({ agents: [{ ...info('running'), description }] as never })
    await say($, 'tail-notify', 'on')
    await say($, 'tail-icons', 'ascii')
    await start($)
    await tick(world)
    world.agents = [{ ...info('completed'), description }] as never
    await tick(world)
    const toast = world.toasts[0]!
    expect(toast).toMatch(/^[\x20-\x7e]+$/)
    expect(toast.startsWith('Subagent finished: Find callers xxx')).toBe(true)
    expect(toast.endsWith('...')).toBe(true)
  })

  const workflowRows: SessionMessage[] = [
    { role: 'user', text: 'Run review', toolUses: [] },
    { role: 'assistant', text: '', toolUses: [{ tool_use_id: 'w1', tool: 'Workflow', input: { name: 'review' } }] },
  ]

  test('a Workflow that stops running toasts once', async () => {
    const { $, world } = fakeEngine({ messages: workflowRows })
    await say($, 'tail-notify', 'on')
    await start($)
    await tick(world)
    expect(world.toasts).toEqual([])
    world.messages = [
      workflowRows[0]!,
      {
        role: 'assistant',
        text: '',
        toolUses: [{ tool_use_id: 'w1', tool: 'Workflow', input: { name: 'review' }, text: 'done' }],
      },
    ]
    await tick(world)
    await tick(world)
    expect(world.toasts).toEqual(['Workflow finished'])
  })

  const endTurn = ($: Parameters<typeof run>[1]) =>
    run(
      'turn.complete',
      $,
      { answer: '', isAborted: false, reason: 'answer', turnId: 't', durationMs: 1 },
      async () => ({ text: '' }),
    )

  const doneRows: SessionMessage[] = [
    workflowRows[0]!,
    {
      role: 'assistant',
      text: '',
      toolUses: [{ tool_use_id: 'w1', tool: 'Workflow', input: { name: 'review' }, text: 'done' }],
    },
  ]

  test('a slow look at an older transcript does not toast a finished Workflow again', async () => {
    const { $, world } = fakeEngine({ messages: workflowRows })
    await say($, 'tail-notify', 'on')
    await start($)
    await tick(world)
    let release = () => undefined as unknown
    world.hold = new Promise<void>(resolve => (release = () => resolve()))
    world.timers[0]!()
    await settle()
    world.hold = undefined
    world.messages = doneRows
    await tick(world)
    expect(world.toasts).toEqual(['Workflow finished'])
    release()
    await settle()
    await tick(world)
    expect(world.toasts).toEqual(['Workflow finished'])
  })

  test('a Workflow whose result arrives with its turn ending toasts once', async () => {
    const { $, world } = fakeEngine({ messages: workflowRows })
    await say($, 'tail-notify', 'on')
    await start($)
    await tick(world)
    world.messages = doneRows
    await endTurn($)
    await settle()
    expect(world.toasts).toEqual(['Workflow finished'])
  })

  test('an interrupted turn leaves a pending Workflow without a toast', async () => {
    const { $, world } = fakeEngine({ messages: workflowRows })
    await say($, 'tail-notify', 'on')
    await start($)
    await tick(world)
    await endTurn($)
    await settle()
    await tick(world)
    expect(world.toasts).toEqual([])
    // Its result turning up later is not an announcement either.
    world.messages = doneRows
    await tick(world)
    expect(world.toasts).toEqual([])
  })

  test('a dropped prompt does not announce a pending Workflow', async () => {
    const { $, world } = fakeEngine({ messages: workflowRows })
    await say($, 'tail-notify', 'on')
    await start($)
    await tick(world)
    await run('prompt.submit', $, { text: 'again' }, async () => ({ drop: 'blocked' }))
    await tick(world)
    expect(world.toasts).toEqual([])
  })

  test('an agent the Workflow started does not toast on its own', async () => {
    const { $, world } = fakeEngine({ messages: workflowRows })
    await say($, 'tail-notify', 'on')
    await start($)
    await run('tool.call', $, { tool_use_id: 'x', tool: 'Read', agentId: 'wf-1' }, async () => ({}))
    await settle()
    world.agents = [info('running', 'wf-1')] as never
    await tick(world)
    world.agents = [info('completed', 'wf-1')] as never
    await tick(world)
    expect(world.toasts).toEqual([])
  })

  test('a tick reads the agent list once', async () => {
    const { $, world } = fakeEngine()
    await start($)
    world.calls.length = 0
    await tick(world)
    expect(world.calls.filter(c => c === 'agent.list')).toHaveLength(1)
  })

  test('no Workflow toast while notifications are off', async () => {
    const { $, world } = fakeEngine({ messages: workflowRows })
    await start($)
    await tick(world)
    await endTurn($)
    await settle()
    expect(world.toasts).toEqual([])
  })
})

describe('turn list cursor', () => {
  const three: SessionMessage[] = ['one', 'two', 'three'].flatMap(prompt => [
    { role: 'user' as const, text: prompt, toolUses: [] },
    { role: 'assistant' as const, text: `re ${prompt}`, toolUses: [] },
  ])
  const marks = (tree: unknown) => {
    const found: string[] = []
    const walk = (t: unknown) => {
      if (Array.isArray(t)) t.forEach(walk)
      else if (t !== null && typeof t === 'object' && 'props' in t) {
        const n = t as { props: Record<string, unknown>; children?: unknown }
        if (String(n.props['key']).startsWith('turn-cursor-')) found.push(String(n.props['key']))
        walk(n.children)
      }
    }
    walk(tree)
    return found
  }

  test('j and k move a cursor over the turns, newest first, and stop at the ends; o opens the turn', async () => {
    const { $ } = fakeEngine({ messages: three })
    await say($, 'tail-turns')
    expect(marks(await draw($))).toEqual([])
    await press($, 'nav-down')
    expect(marks(await draw($))).toEqual(['turn-cursor-2'])
    await press($, 'nav-down')
    expect(marks(await draw($))).toEqual(['turn-cursor-1'])
    await press($, 'nav-up')
    await press($, 'nav-up')
    expect(marks(await draw($))).toEqual(['turn-cursor-2'])
    await press($, 'nav-down')
    await press($, 'nav-open')
    const detail = await draw($)
    expect(text(detail)).toContain('re two')
    expect(byKey(detail, 'nav-turns')).toBeDefined()
    await press($, 'nav-turns')
    expect(marks(await draw($))).toEqual([])
  })

  test('a new search query and another view drop the cursor', async () => {
    const { $ } = fakeEngine({ messages: three })
    await say($, 'tail-turns')
    await press($, 'nav-down')
    const input = byKey(await draw($), 'turn-search')!
    ;(input.props['onInput'] as (value: string) => void)('t')
    await settle()
    expect(marks(await draw($))).toEqual([])
    await press($, 'nav-down')
    await press($, 'nav-detail')
    await press($, 'nav-turns')
    expect(marks(await draw($))).toEqual([])
  })
})

// Round trips to the engine (tests/coverage/engine.ts counts them): a call
// the hook awaits before it can make the next one costs a whole round.
describe('engine round trips', () => {
  const agentUse = (n: number) => ({
    tool_use_id: `p${n}`,
    tool: 'Agent',
    input: { subagent_type: 'Explore', description: `Job ${n}` },
    agentId: `agent-p${n}`,
    text: 'ok',
  })
  const twoAgents: SessionMessage[] = [
    { role: 'user', text: 'Fan out', toolUses: [] },
    { role: 'assistant', text: '', toolUses: [agentUse(1), agentUse(2)] },
  ]
  const running = (id: string) => ({ id, description: id, type: 'Explore', status: 'running' as const })
  const reset = (world: { trips: string[]; rounds: number; calls: string[] }) => {
    world.trips.length = 0
    world.calls.length = 0
    world.rounds = 0
  }
  const writes = (world: { trips: string[] }, key: string) => world.trips.filter(t => t === `state.set:${key}`).length

  test('a pane drawing reads everything it needs in one round', async () => {
    const { $, world } = fakeEngine({ messages: main })
    await draw($)
    await settle()
    reset(world)
    await draw($)
    expect(world.rounds).toBe(1)
    expect(world.trips.filter(t => t === 'state.get:scroll')).toHaveLength(1)
    // The detail view does not read the turn list's cursor, so moving it does
    // not draw the detail view again.
    expect(world.trips).not.toContain('state.get:turnCursor')
  })

  test('the expanded subagents of one level load their traces together', async () => {
    const { $, world } = fakeEngine({
      messages: twoAgents,
      agentMessages: { 'agent-p1': child, 'agent-p2': child },
      agents: [running('agent-p1'), running('agent-p2')],
    })
    await press($, 'p1')
    await press($, 'p2')
    reset(world)
    await draw($)
    expect(world.calls.filter(c => c.startsWith('messages:agent-p')).sort()).toEqual([
      'messages:agent-p1',
      'messages:agent-p2',
    ])
    expect(world.rounds).toBe(2)
  })

  test('the turn list reads its cursor', async () => {
    const { $, world } = fakeEngine({ messages: main })
    await say($, 'tail-turns')
    await settle()
    reset(world)
    await draw($)
    expect(world.trips).toContain('state.get:turnCursor')
  })

  test('the info bar reads in one round after its switch, and idle it reads no transcript', async () => {
    const { $, world } = fakeEngine({ messages: main })
    await run('ui.render', $, BAR_EVENT)
    reset(world)
    await run('ui.render', $, BAR_EVENT)
    expect(world.rounds).toBe(2)
    expect(world.calls).not.toContain('messages:main')
  })

  test('a tick reuses the transcript the pane read since the last tick', async () => {
    const { $, world } = fakeEngine({ messages: main, agents: [running('a')] })
    await run('prompt.submit', $, { text: 'go' }, async e => e)
    world.timers[0]!()
    await settle()
    await draw($)
    reset(world)
    world.timers[0]!()
    await settle()
    expect(world.calls).not.toContain('messages:main')
    expect(world.trips.filter(t => t === 'state.get:isWorking')).toHaveLength(1)
    // With nothing read since, the next tick reads it itself.
    reset(world)
    world.timers[0]!()
    await settle()
    expect(world.calls.filter(c => c === 'messages:main')).toHaveLength(1)
  })

  test('a tool call changes what the pane draws once at its start and once at its end', async () => {
    const { $, world } = fakeEngine()
    await run('prompt.submit', $, { text: 'go' }, async e => e)
    await settle()
    reset(world)
    await run('tool.call', $, { tool_use_id: 'r1', tool: 'Read', input: {} }, async () => ({}))
    await settle()
    expect(writes(world, 'tick') + writes(world, 'timings')).toBe(2)
  })
})

describe('wave 1 correctness', () => {
  test('expand all on a trace that names its own agent, or a cycle of two, draws and collapses', async () => {
    for (const loop of [{ A: 'A' }, { A: 'B', B: 'A' }] as Record<string, string>[]) {
      const agentMessages = Object.fromEntries(
        Object.entries(loop).map(([id, child]) => [
          id,
          [
            { role: 'user' as const, text: 'Go', toolUses: [] },
            {
              role: 'assistant' as const,
              text: '',
              toolUses: [
                { tool_use_id: `${id}-x`, tool: 'Agent', input: { description: 'again' }, agentId: child, text: 'ok' },
              ],
            },
          ],
        ]),
      )
      const { $ } = fakeEngine({
        messages: [
          { role: 'user', text: 'Go', toolUses: [] },
          {
            role: 'assistant',
            text: '',
            toolUses: [{ tool_use_id: 't-A', tool: 'Agent', input: { description: 'Job' }, agentId: 'A', text: 'ok' }],
          },
        ],
        agentMessages,
        agents: Object.keys(loop).map(id => ({
          id,
          description: 'Job',
          type: 'Explore',
          status: 'completed' as const,
        })),
      })
      await draw($)
      await press($, 'nav-expand')
      await expect(draw($)).resolves.toBeDefined()
      await press($, 'nav-down')
      await press($, 'nav-collapse')
      await expect(draw($)).resolves.toBeDefined()
    }
  })

  test('expand all never closes a row this turn opens that an earlier expansion holds', async () => {
    const bash = (id: string, out: string) => ({
      tool_use_id: id,
      tool: 'Bash',
      input: { command: `echo ${id}` },
      text: out,
    })
    const { $ } = fakeEngine({
      messages: [
        { role: 'user', text: 'first', toolUses: [] },
        { role: 'assistant', text: '', toolUses: [bash('r0', 'zero-output'), bash('r1', 'one-output')] },
        { role: 'user', text: 'second', toolUses: [] },
        { role: 'assistant', text: '', toolUses: Array.from({ length: 299 }, (_, n) => bash(`s${n}`, `out ${n}`)) },
      ],
    })
    await draw($)
    await press($, 'nav-prev')
    await press($, 'r0')
    await press($, 'nav-next')
    await press($, 'nav-expand')
    await press($, 'nav-prev')
    await press($, 'nav-expand')
    expect(text(await draw($))).toContain('zero-output')
  })
})
