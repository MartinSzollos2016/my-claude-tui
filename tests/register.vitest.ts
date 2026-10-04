// register()'s hooks under Vitest, against the fake engine in
// tests/coverage/engine.ts: the same paths tests/render.test.tsx drives in
// the real engine, here measured by coverage.
import type { SessionMessage } from 'claude-code'
import { beforeEach, describe, expect, test, vi } from 'vitest'

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
    expect(await focus(true)).toContain('keys active')
    expect(await focus(false)).toContain('ctrl+x tab to use keys')
    const unknown = await focus(undefined)
    expect(unknown).not.toContain('keys active')
    expect(unknown).not.toContain('to use keys')
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

  test('pairs thinking from the end when the API form is shorter, refetches on a new fingerprint, expand all opens it', async () => {
    const api = [
      { role: 'user', content: [{ type: 'text', text: 'Second misaligned' }] },
      { role: 'assistant', content: [{ type: 'thinking', thinking: 'Only late thought', signature: 's' }] },
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
        { role: 'assistant', content: [{ type: 'thinking', thinking: 'Look at main.go', signature: 's' }] },
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
    expect(text(await draw($))).toContain('turn 1/3')
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
    expect(text(await draw($))).toContain('turn 3/3 (live)')
    await press($, 'nav-prev')
    expect(text(await draw($))).toContain('turn 2/3')
    await press($, 'nav-prev')
    expect(text(await draw($))).toContain('turn 1/3')
    expect(byKey(await draw($), 'nav-prev')).toBeUndefined()
    await press($, 'nav-next')
    expect(text(await draw($))).toContain('turn 2/3')
    await press($, 'nav-latest')
    expect(text(await draw($))).toContain('turn 3/3 (live)')

    await press($, 'nav-turns')
    expect(text(await draw($))).toContain('Turns (3)')
    await press($, 'nav-detail')
    await press($, 'nav-turns')
    await press($, 'turn-0')
    expect(text(await draw($))).toContain('turn 1/3')

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
    expect(String(byKey(folded, 'group:rd1')?.props['label'])).toBe('Read ×4 · 4 files')
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
    expect(byKey(await draw(plain.$), 'nav-team')).toBeUndefined()

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

  test('j and k move the cursor and mark the row, without taking the keyboard focus', async () => {
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
    expect(world.focused).toEqual([])
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
    expect(byKey(await draw($), 'nav-copy')).toBeUndefined()
    expect(world.copies).toEqual([])
  })
})

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

  test('a main-loop tool sets the status while it runs and clears it after', async () => {
    const { $, world } = fakeEngine()
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
    expect(await props($, spinner)).toMatchObject({ message: 'Bash go test ./... · 12s', suffix: '', word: 'Sauteing' })
    gate.release()
    await running
    await settle()
    expect(await props($, spinner)).toMatchObject({ message: null, suffix: '…' })
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

  test('the turn duration line gets the tool and agent counts of the last turn', async () => {
    const { $ } = fakeEngine({ messages: main })
    const drawn = await run('ui.render', $, duration, async x => x)
    expect(text(drawn)).toBe('Baked for 3s · 1 tool · 1 agent')
    expect((drawn as { props: Record<string, unknown> }).props['color']).toBe('inactive')
  })

  test("the turn duration line is the engine's own with the switch off or nothing to count", async () => {
    const { $, world } = fakeEngine({ messages: main })
    await say($, 'tail-status', 'off')
    expect(await props($, duration)).toMatchObject({ word: 'Baked', durationMs: 3_000 })
    await say($, 'tail-status', 'on')
    world.messages = [
      { role: 'user', text: 'hi', toolUses: [] },
      { role: 'assistant', text: 'Hello', toolUses: [] },
    ]
    expect(await props($, duration)).toMatchObject({ word: 'Baked', durationMs: 3_000 })
    world.messages = []
    expect(await props($, duration)).toMatchObject({ word: 'Baked' })
  })

  test('the ascii set gives an ASCII duration line', async () => {
    const { $ } = fakeEngine({ messages: main })
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
