// register()'s hooks under Vitest, against the fake engine in
// tests/coverage/engine.ts: the same paths tests/render.test.tsx drives in
// the real engine, here measured by coverage.
import type { ConfigRow, SessionMessage } from 'claude-code'
import { describe, expect, test } from 'vitest'

import { register } from '../hooks/register'
import { BAR_EVENT, byKey, fakeEngine, hooksOf, PANE_EVENT, settle, text } from './coverage/engine'

const run = hooksOf(register)

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

const themeRow = (value: string): ConfigRow => ({
  key: 'theme',
  label: 'Theme',
  kind: 'choice',
  value,
  provider: { plugin: 'engine', tier: 'core' },
  isLocked: false,
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
      'tail-theme',
      'tail-compact',
      'tail-bar',
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
    const { $, world } = fakeEngine({ config: [themeRow('light')] })
    expect(await say($, 'tail')).toContain('Detail view opened')
    expect(world.opened.at(-1)).toBe(160)
    expect(await say($, 'tail-width', '99')).toContain('between 30 and 80')
    expect(await say($, 'tail-width', '70')).toContain('70%')
    expect(world.opened.at(-1)).toBe(140)
    expect(await say($, 'tail-turns')).toContain('Turn list opened')
    expect(await say($, 'tail', 'bar')).toBe('Info bar hidden.')
    expect(await run('ui.render', $, BAR_EVENT, async () => 'engine bar')).toBe('engine bar')
    expect(await say($, 'tail-bar')).toBe('Info bar shown.')
    expect(await say($, 'tail-theme')).toContain('"Tail Light"')
    expect(await say($, 'tail-compact')).toContain('off')
    expect(await say($, 'tail-compact')).toContain('on')
    expect(await say($, 'tail-help')).toContain('/tail-turns')
  })
})

describe('live data', () => {
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
  test('navigates turns, drills into a subagent and expands everything', async () => {
    const { $ } = fakeEngine({ messages: three, agentMessages: { 'agent-1': child } })
    expect(text(await draw($))).toContain('turn 3/3 (live)')
    await press($, 'nav-prev')
    expect(text(await draw($))).toContain('turn 2/3')
    await press($, 'nav-prev')
    await press($, 'nav-prev')
    expect(text(await draw($))).toContain('turn 1/3')
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
