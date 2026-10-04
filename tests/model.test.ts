import type { SessionMessage } from 'claude-code'
import { describe, expect, test } from 'claude-code/testing'

import { parseCommand } from '../hooks/commands'
import { ICON_SETS } from '../hooks/icons'
import {
  buildTurns,
  chunkMarkdown,
  chunkText,
  clampText,
  formatDuration,
  fitPath,
  formatTokens,
  gitDirFrom,
  parseGitHead,
  itemName,
  itemStatus,
  languageFor,
  paneColumns,
  resultLine,
  toolSections,
  type ToolItem,
  itemSummary,
  sanitizePrompt,
  sanitizeText,
  shortModel,
  toolSummary,
  traceItems,
  truncateMiddle,
} from '../hooks/model'

const prompt = (text: string): SessionMessage => ({ role: 'user', text, toolUses: [] })

const transcript: SessionMessage[] = [
  prompt('Fix the bug'),
  {
    role: 'assistant',
    text: 'Looking.',
    toolUses: [
      { tool_use_id: 'r1', tool: 'Read', input: { file_path: '/a/b/c/main.go' }, text: 'package main' },
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
  {
    role: 'user',
    text: '',
    toolUses: [],
    toolResults: [{ tool_use_id: 'r1', text: 'package main', isError: false, result: null } as never],
  },
  {
    role: 'assistant',
    text: 'Fixed.',
    toolUses: [{ tool_use_id: 'b1', tool: 'Bash', input: { command: 'go test ./...' } }],
  },
  prompt('Thanks'),
  { role: 'assistant', text: 'You are welcome.', toolUses: [] },
]

describe('buildTurns', () => {
  test('groups assistant rows under the prompt that opened them', () => {
    const turns = buildTurns(transcript)
    expect(turns.length).toBe(2)
    expect(turns[0]!.prompt).toBe('Fix the bug')
    expect(turns[0]!.items.map(i => i.id)).toEqual(['t0:o0', 'r1', 'a1', 't0:o1', 'b1'])
    expect(turns[0]!.toolCount).toBe(3)
    expect(turns[0]!.outputCount).toBe(2)
    expect(turns[0]!.subagentCount).toBe(1)
    expect(turns[1]!.items.length).toBe(1)
  })

  test('marks unanswered tool calls pending', () => {
    const bash = buildTurns(transcript)[0]!.items.at(-1)!
    expect(bash.kind === 'tool' && bash.isPending).toBe(true)
  })

  test('opens an anonymous turn when the transcript starts mid-turn', () => {
    const turns = buildTurns([{ role: 'assistant', text: 'hi', toolUses: [] }])
    expect(turns.length).toBe(1)
    expect(turns[0]!.prompt).toBe('')
  })

  test('prefixes trace ids with the agent id', () => {
    const items = traceItems(transcript, 'agent-1/')
    expect(items[1]!.id).toBe('agent-1/r1')
  })
})

describe('summaries', () => {
  test('per-tool one-liners match agent-ouija', () => {
    expect(toolSummary('Read', { file_path: '/x/y/z.go', offset: 10, limit: 5 })).toBe('y/z.go - lines 10-14')
    expect(toolSummary('Edit', { file_path: '/x/z.go', old_string: 'a', new_string: 'b\nc' })).toBe(
      'x/z.go - 1 -> 2 lines',
    )
    expect(toolSummary('Bash', { command: 'ls', description: 'List' })).toBe('List: ls')
    expect(toolSummary('Grep', { pattern: 'foo', path: '/src/pkg' })).toBe('"foo" in pkg')
    expect(toolSummary('WebFetch', { url: 'https://example.com/docs?q=1' })).toBe('example.com/docs')
    expect(toolSummary('TodoWrite', { todos: [1] })).toBe('1 item')
    expect(toolSummary('mcp__x__y', { query: 'abc' })).toBe('abc')
  })

  test('subagent rows show the type and description', () => {
    const agent = buildTurns(transcript)[0]!.items[2]!
    expect(itemName(agent)).toBe('Explore')
    expect(itemSummary(agent)).toBe('Find callers')
  })
})

const tool = (over: Partial<ToolItem>): ToolItem => ({
  kind: 'tool',
  id: 't',
  tool: 'Bash',
  input: {},
  summary: '',
  isError: false,
  isPending: false,
  ...over,
})

describe('toolSections', () => {
  test('Bash separates the command from its output', () => {
    const sections = toolSections(
      tool({ input: { command: 'go test ./...', description: 'Run tests' }, resultText: 'ok\nPASS' }),
    )
    expect(sections.map(s => s.kind)).toEqual(['command', 'output'])
    expect(sections[0]).toEqual({
      kind: 'command',
      title: '$ command',
      meta: 'Run tests',
      body: 'go test ./...',
      format: { kind: 'code', language: 'bash' },
    })
    expect(sections[1]?.meta).toBe('ok · 2 lines')
  })

  test('an errored result is an error section', () => {
    const sections = toolSections(tool({ input: { command: 'false' }, resultText: 'exit 1', isError: true }))
    expect(sections[1]?.kind).toBe('error')
    expect(sections[1]?.meta).toBe('error · 1 line')
  })

  test('a pending call has no output section yet', () => {
    expect(toolSections(tool({ input: { command: 'sleep 9' }, isPending: true })).map(s => s.kind)).toEqual(['command'])
  })

  test('Read shows the file and highlights its content by extension', () => {
    const [file, out] = toolSections(
      tool({
        tool: 'Read',
        input: { file_path: '/src/app/main.go', offset: 10, limit: 5 },
        resultText: 'package main',
      }),
    )
    expect(file?.kind).toBe('file')
    expect(file?.body).toBe('/src/app/main.go')
    expect(file?.meta).toBe('lines 10-14')
    expect(out?.format).toEqual({ kind: 'code', language: 'go' })
  })

  test('Edit is a diff of the file', () => {
    const [diff] = toolSections(
      tool({ tool: 'Edit', input: { file_path: '/a.ts', old_string: 'a', new_string: 'b' }, resultText: 'ok' }),
    )
    expect(diff).toEqual({
      kind: 'diff',
      title: 'diff',
      meta: '/a.ts',
      isPathMeta: true,
      body: '-a\n+b',
      format: { kind: 'code', language: 'diff' },
    })
  })

  test('Write shows the written content in its language', () => {
    const [file] = toolSections(tool({ tool: 'Write', input: { file_path: '/x/y.py', content: 'print(1)' } }))
    expect(file).toEqual({
      kind: 'file',
      title: 'write',
      meta: '/x/y.py',
      isPathMeta: true,
      body: 'print(1)',
      format: { kind: 'code', language: 'python' },
    })
  })

  test('Grep and WebSearch are queries; web results are markdown', () => {
    expect(toolSections(tool({ tool: 'Grep', input: { pattern: 'Run(', glob: '*.go' } }))[0]?.body).toBe(
      'Run(  in *.go',
    )
    const web = toolSections(tool({ tool: 'WebSearch', input: { query: 'bubbletea' }, resultText: '# hits' }))
    expect(web.map(s => s.kind)).toEqual(['query', 'output'])
    expect(web[1]?.format).toEqual({ kind: 'markdown' })
  })

  test('TodoWrite lists items with their status', () => {
    const [list] = toolSections(
      tool({
        tool: 'TodoWrite',
        input: {
          todos: [
            { content: 'a', status: 'completed' },
            { content: 'b', status: 'in_progress' },
            { content: 'c', status: 'pending' },
          ],
        },
      }),
    )
    expect(list?.body).toBe('☑ a\n◐ b\n☐ c')
  })

  test('other tools show their input as JSON', () => {
    const [input] = toolSections(tool({ tool: 'mcp__x__y', input: { q: 1 }, resultText: 'r' }))
    expect(input?.kind).toBe('input')
    expect(input?.format).toEqual({ kind: 'code', language: 'json' })
    expect(input?.body).toBe('{\n  "q": 1\n}')
  })

  test('languageFor maps common extensions', () => {
    expect(languageFor('a/b.tsx')).toBe('tsx')
    expect(languageFor('Makefile')).toBe(undefined)
    expect(languageFor('x.YAML')).toBe('yaml')
  })
})

describe('paneColumns', () => {
  test('asks for the share of the terminal, keeping room for the transcript', () => {
    expect(paneColumns(200, 60)).toBe(120)
    expect(paneColumns(200, 80)).toBe(160)
    expect(paneColumns(200, 95)).toBe(160)
    expect(paneColumns(120, 30)).toBe(40)
    expect(paneColumns(70, 60)).toBe(undefined)
  })
})

describe('resultLine', () => {
  test('summarizes a tool result as one line', () => {
    expect(resultLine({ stdout: 'a\nb\nc', stderr: '' }, false)).toBe('3 lines')
    expect(resultLine('one', false)).toBe('1 line')
    expect(resultLine({ file: { content: 'x\ny' } }, false)).toBe('2 lines')
    expect(resultLine({ filenames: ['a', 'b'] }, false)).toBe('2 items')
    expect(resultLine(undefined, false)).toBe('done')
    expect(resultLine({ stdout: '', stderr: '' }, false)).toBe('no output')
  })

  test('shows the first line of an error, sanitized and cut', () => {
    expect(resultLine('Error: boom\nstack', true)).toBe('error: Error: boom')
    expect(resultLine('x\u001b[31m'.repeat(50), true).length).toBeLessThanOrEqual(87)
    expect(resultLine('x\u001b[31m', true)).toBe('error: x')
  })
})

describe('formatters', () => {
  test('shortModel', () => {
    expect(shortModel('claude-opus-4-6')).toBe('opus4.6')
    expect(shortModel('claude-opus-5-5')).toBe('opus5.5')
    expect(shortModel('claude-sonnet-5-20260203')).toBe('sonnet5')
    expect(shortModel('claude-fable-5-1[1m]')).toBe('fable5.1')
  })

  test('formatTokens and formatDuration', () => {
    expect(formatTokens(999)).toBe('999')
    expect(formatTokens(46_900)).toBe('46.9k')
    expect(formatTokens(1_234_567)).toBe('1.2M')
    expect(formatDuration(3500)).toBe('3.5s')
    expect(formatDuration(59_700)).toBe('1m 0s')
    expect(formatDuration(201_000)).toBe('3m 21s')
  })

  test('sanitizePrompt unwraps commands and notifications', () => {
    expect(sanitizePrompt('<command-name>/tail</command-name><command-args>bar</command-args>')).toBe('/tail bar')
    expect(sanitizePrompt('<task-notification><summary>Agent done</summary></task-notification>')).toBe(
      'Task notification: Agent done',
    )
    expect(sanitizePrompt('hi<system-reminder>x</system-reminder>')).toBe('hi')
  })

  test('clampText caps by lines and by characters', () => {
    expect(clampText('a\nb', 5, 100)).toEqual({ text: 'a\nb' })
    expect(clampText('a\nb\nc', 2, 100)).toEqual({ text: 'a\nb', note: '… (1 line hidden)' })
    expect(clampText('a\nb\nc\nd', 2, 100).note).toBe('… (2 lines hidden)')
    expect(clampText('x'.repeat(10), 5, 4)).toEqual({ text: 'xxxx', note: '… (6 chars hidden)' })
    expect(clampText('🚀🚀🚀', 5, 2).text).toBe('🚀🚀')
  })

  test('chunkText splits under the size, at newlines when it can', () => {
    expect(chunkText('abc', 10)).toEqual(['abc'])
    expect(chunkText('aaaa\nbbbb\ncccc', 10)).toEqual(['aaaa\nbbbb', 'cccc'])
    expect(chunkText('x'.repeat(25), 10)).toEqual(['x'.repeat(10), 'x'.repeat(10), 'x'.repeat(5)])
    const big = Array.from({ length: 3000 }, (_, i) => `line ${i}`).join('\n')
    const chunks = chunkText(big, 8000)
    expect(chunks.every(c => c.length <= 8000)).toBe(true)
    expect(chunks.join('\n')).toBe(big)
  })

  test('chunkMarkdown closes and reopens a code fence cut by a chunk', () => {
    const md = ['intro', '```ts', 'a()', 'b()', 'c()', '```', 'outro'].join('\n')
    const chunks = chunkMarkdown(md, 16)
    expect(chunks.every(c => c.length <= 16 + 4)).toBe(true)
    for (const c of chunks) expect((c.match(/^```/gm) ?? []).length % 2).toBe(0)
    expect(chunks.join('\n').replace(/\n```\n```ts/g, '')).toContain('a()')
  })

  test('parseGitHead reads the branch, or a short hash when detached', () => {
    expect(parseGitHead('ref: refs/heads/main\n')).toEqual({ branch: 'main' })
    expect(parseGitHead('ref: refs/heads/feat/turn-list')).toEqual({ branch: 'feat/turn-list' })
    expect(parseGitHead('3d3c42e5aac5ba805825da76410c181273ba90b1\n')).toEqual({ branch: '3d3c42e' })
    expect(parseGitHead('garbage')).toBe(null)
    expect(parseGitHead('ref: refs/heads/\u001b[31mx')).toEqual({ branch: 'x' })
  })

  test('gitDirFrom follows a worktree .git file to its git directory', () => {
    expect(gitDirFrom('/r', 'gitdir: /r/.git/worktrees/wt\n')).toBe('/r/.git/worktrees/wt')
    expect(gitDirFrom('/r/wt', 'gitdir: ../.git/worktrees/wt')).toBe('/r/wt/../.git/worktrees/wt')
    expect(gitDirFrom('/r', 'nonsense')).toBe(null)
  })
})

describe('parseCommand', () => {
  test('routes subcommands and their /tail shorthand alike', () => {
    expect(parseCommand('tail', '')).toEqual({ sub: 'open', arg: '' })
    expect(parseCommand('tail', 'width 70')).toEqual({ sub: 'width', arg: '70' })
    expect(parseCommand('tail-width', ' 70 ')).toEqual({ sub: 'width', arg: '70' })
    expect(parseCommand('tail', 'help')).toEqual({ sub: 'help', arg: '' })
    expect(parseCommand('tail', 'nonsense')).toEqual({ sub: 'open', arg: 'nonsense' })
    expect(parseCommand('tail-turns', '')).toEqual({ sub: 'turns', arg: '' })
    expect(parseCommand('tail', 'turns')).toEqual({ sub: 'turns', arg: '' })
    expect(parseCommand('tail-icons', ' ascii ')).toEqual({ sub: 'icons', arg: 'ascii' })
    expect(parseCommand('tail', 'icons unicode')).toEqual({ sub: 'icons', arg: 'unicode' })
    expect(parseCommand('other', '')).toBe(undefined)
  })
})

describe('untrusted input stays linear', () => {
  const ws = ' '.repeat(50_000)
  const hostile = [
    `<command-name>${ws}x`,
    `<command-args>${ws}x`,
    `<task-notification><summary>${ws}x`,
    `<system-reminder>${'<system-reminder>'.repeat(5_000)}`,
    `x\u001b]${'a'.repeat(50_000)}`,
    `x\u001bP${'a'.repeat(50_000)}`,
    '<'.repeat(50_000),
    '<a'.repeat(25_000),
  ]

  test('sanitizePrompt and sanitizeText handle hostile input in linear time', () => {
    for (const text of hostile) {
      const started = performance.now()
      sanitizePrompt(text)
      sanitizeText(text)
      expect(performance.now() - started).toBeLessThan(200)
    }
  })

  test('sanitizePrompt still unwraps well-formed wrappers', () => {
    expect(sanitizePrompt('<command-name> /tail </command-name><command-args> bar </command-args>')).toBe('/tail bar')
    expect(sanitizePrompt('<command-name>/tail</command-name>')).toBe('/tail')
    expect(
      sanitizePrompt('<task-notification><status>done</status><summary> Agent done </summary></task-notification>'),
    ).toBe('Task notification: Agent done')
    expect(sanitizePrompt('a<system-reminder>x</system-reminder>b<system-reminder>y</system-reminder>c')).toBe('abc')
    expect(sanitizePrompt('<command-name>a<b</command-name>')).toBe('a')
  })
})

describe('itemStatus', () => {
  const tool = (over: Partial<ToolItem>): ToolItem => ({
    kind: 'tool',
    id: 'x',
    tool: 'Bash',
    input: {},
    summary: '',
    isError: false,
    isPending: false,
    ...over,
  })
  const live = { isLatest: true, isWorking: true }
  const quiet = { isLatest: true, isWorking: false }

  test('a finished call is done, a failed one error', () => {
    expect(itemStatus(tool({ resultText: 'ok' }), quiet)).toBe('done')
    expect(itemStatus(tool({ isError: true, resultText: 'boom' }), quiet)).toBe('error')
  })

  test('a pending call runs only on the latest turn while the session works (P6)', () => {
    const pending = tool({ isPending: true })
    expect(itemStatus(pending, live)).toBe('running')
    expect(itemStatus(pending, quiet)).toBe('idle')
    expect(itemStatus(pending, { isLatest: false, isWorking: true })).toBe('idle')
  })

  test('a running subagent runs whatever the turn', () => {
    expect(itemStatus(tool({ isPending: false }), { isLatest: false, isWorking: false, isAgentRunning: true })).toBe(
      'running',
    )
  })

  test('a call ended by the user is interrupted, not an error', () => {
    const stopped = tool({ isError: true, resultText: '[Request interrupted by user for tool use]' })
    expect(itemStatus(stopped, quiet)).toBe('interrupted')
  })
})

describe('icon sets', () => {
  test('every set has the same keys', () => {
    const keys = Object.keys(ICON_SETS.nerd).sort()
    expect(Object.keys(ICON_SETS.unicode).sort()).toEqual(keys)
    expect(Object.keys(ICON_SETS.ascii).sort()).toEqual(keys)
  })

  test('the ascii set is only ASCII, the unicode set has no Nerd Font private-use glyph', () => {
    const all = (set: (typeof ICON_SETS)['nerd']) => Object.values(set).flat().join('')
    expect(all(ICON_SETS.ascii)).toMatch(/^[\x20-\x7e]+$/)
    expect(all(ICON_SETS.unicode)).not.toMatch(/[\ue000-\uf8ff\u{f0000}-\u{ffffd}]/u)
    expect(all(ICON_SETS.nerd)).toMatch(/[\ue000-\uf8ff\u{f0000}-\u{ffffd}]/u)
  })

  test('each glyph is one cell wide in the unicode and ascii sets, the spinner has frames', () => {
    for (const set of [ICON_SETS.unicode, ICON_SETS.ascii])
      for (const [key, value] of Object.entries(set))
        for (const glyph of [value].flat()) expect([...glyph].length, key).toBe(1)
    expect(ICON_SETS.ascii.spinner).toEqual(['|', '/', '-', '\\'])
    expect(ICON_SETS.ascii.done).toBe('+')
    expect(ICON_SETS.ascii.error).toBe('x')
  })
})

describe('truncateMiddle', () => {
  test('keeps both ends and favours the end, the file name', () => {
    expect(truncateMiddle('src/a/b/auth/session.ts', 16)).toBe('src/a…session.ts')
    expect(truncateMiddle('src/session.ts', 20)).toBe('src/session.ts')
    expect(truncateMiddle('abcdefghij', 5)).toBe('a…hij')
    expect(truncateMiddle('abcdef', 1)).toBe('…')
    expect(truncateMiddle('abcdef', 0)).toBe('')
    expect(truncateMiddle('a\nb\ncdefgh', 6)).toBe('a…efgh')
  })

  test('counts code points and never splits a surrogate pair', () => {
    const out = truncateMiddle('😀'.repeat(10) + 'end', 7)
    expect([...out]).toHaveLength(7)
    expect(out).toBe('😀😀…😀end')
    expect(out).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/)
  })
})

describe('fitPath', () => {
  const item = (tool: string, input: Record<string, unknown>): ToolItem => ({
    kind: 'tool',
    id: 'x',
    tool,
    input,
    summary: toolSummary(tool, input),
    isError: false,
    isPending: false,
  })
  const file = '/home/dev/project/src/server/auth/session.ts'

  test('a path summary is cut in the middle and keeps the file name', () => {
    const read = item('Read', { file_path: file })
    const fitted = fitPath(read, read.summary, 28)
    expect([...fitted].length).toBeLessThanOrEqual(28)
    expect(fitted).toContain('…')
    expect(fitted.endsWith('auth/session.ts')).toBe(true)
  })

  test('room to spare shows more of the path, and the rest of the summary stays', () => {
    const read = item('Read', { file_path: file, offset: 3, limit: 7 })
    expect(fitPath(read, read.summary, 80)).toBe('dev/project/src/server/auth/session.ts - lines 3-9')
    const tight = fitPath(read, read.summary, 36)
    expect(tight.endsWith(' - lines 3-9')).toBe(true)
    expect([...tight].length).toBeLessThanOrEqual(36)
    expect(tight).toContain('…')
  })

  test('covers Write, Edit, NotebookEdit and Grep/Glob with a path', () => {
    for (const [tool, input] of [
      ['Write', { file_path: file, content: 'x' }],
      ['Edit', { file_path: file, old_string: 'a', new_string: 'b' }],
      ['NotebookEdit', { notebook_path: file, edit_mode: 'insert' }],
      ['Grep', { pattern: 'x', path: file }],
      ['Glob', { pattern: 'x', path: file }],
    ] as const) {
      const it = item(tool, input)
      const fitted = fitPath(it, it.summary, 30)
      expect(fitted, tool).toContain('…')
      expect([...fitted].length, tool).toBeLessThanOrEqual(30)
    }
  })

  test('other text is still cut at the end', () => {
    const bash = item('Bash', { command: 'x'.repeat(100) })
    expect(fitPath(bash, bash.summary, 10)).toBe('xxxxxxxxx…')
    const grep = item('Grep', { pattern: 'x' })
    expect(fitPath(grep, grep.summary, 30)).toBe('"x"')
  })
})
