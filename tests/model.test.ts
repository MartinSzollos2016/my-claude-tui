import type { AgentStatus, SessionMessage } from 'claude-code'
import { describe, expect, test } from 'claude-code/testing'

import { parseCommand } from '../hooks/commands'
import { ICON_SETS } from '../hooks/icons'
import {
  buildTurns,
  cachedSections,
  callInput,
  chunkText,
  clampDiff,
  clampScroll,
  clampText,
  compactCall,
  contentRows,
  cursorRows,
  displayWidth,
  durationBar,
  durationSuffix,
  engineScroll,
  finishedSince,
  finishedWorkflows,
  firstErrorLine,
  fitPath,
  followCursor,
  footerLayout,
  footerPads,
  groupLabel,
  groupRuns,
  hoverCard,
  itemName,
  itemStatus,
  itemSummary,
  languageFor,
  moveCursor,
  overflowRows,
  padEndDisplay,
  pageScroll,
  paneColumns,
  parseNumbered,
  pieceStarts,
  resetSectionCache,
  resultLine,
  rowText,
  runningTool,
  sanitizePrompt,
  sanitizeText,
  scrollToRow,
  searchTurns,
  sectionCacheSize,
  spinnerMessage,
  splitDiff,
  splitMatch,
  statusText,
  stepCursor,
  taskMark,
  toolSections,
  toolSummary,
  traceItems,
  truncate,
  truncateDisplay,
  truncateMiddle,
  turnTable,
  turnTail,
  unifiedDiff,
} from '../hooks/model'
import type { Item, ToolItem, Turn } from '../hooks/model/types'

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
    expect(out?.format).toEqual({ kind: 'code', path: '/src/app/main.go' })
  })

  test('Edit is a unified diff of the file', () => {
    const [diff] = toolSections(
      tool({ tool: 'Edit', input: { file_path: '/a.ts', old_string: 'a', new_string: 'b' }, resultText: 'ok' }),
    )
    expect(diff).toEqual({
      kind: 'diff',
      title: 'diff',
      meta: '/a.ts',
      isPathMeta: true,
      body: '@@ -1,1 +1,1 @@\n-a\n+b',
      format: { kind: 'diff' },
    })
  })

  test('Edit numbers the hunk from the cat -n snippet its result carries', () => {
    const [diff] = toolSections(
      tool({
        tool: 'Edit',
        input: { file_path: '/a.ts', old_string: 'foo()', new_string: 'bar()\nbaz()' },
        resultText:
          "The file /a.ts has been updated. Here's the result of running `cat -n` on a snippet:\n    41\tlet x\n    42\tbar()\n    43\tbaz()",
      }),
    )
    expect(diff?.body).toBe('@@ -42,1 +42,2 @@\n-foo()\n+bar()\n+baz()')
  })

  test('MultiEdit has one hunk per edit', () => {
    const [diff] = toolSections(
      tool({
        tool: 'MultiEdit',
        input: {
          file_path: '/a.ts',
          edits: [
            { old_string: 'a', new_string: 'b' },
            { old_string: 'c', new_string: 'd' },
          ],
        },
      }),
    )
    expect(diff?.format).toEqual({ kind: 'diff' })
    expect(diff?.body).toBe('@@ -1,1 +1,1 @@\n-a\n+b\n@@ -1,1 +1,1 @@\n-c\n+d')
  })

  test('an edit that cannot be diffed keeps the plain - and + lines', () => {
    const big = Array.from({ length: 2001 }, (_, i) => `l${i}`).join('\n')
    const [diff] = toolSections(tool({ tool: 'Edit', input: { file_path: '/a.ts', old_string: big, new_string: 'x' } }))
    expect(diff?.format).toEqual({ kind: 'code', language: 'diff' })
    expect(diff?.body.startsWith('-l0\n-l1')).toBe(true)
    expect(diff?.body.endsWith('\n+x')).toBe(true)
    const [same] = toolSections(tool({ tool: 'Edit', input: { file_path: '/a.ts', old_string: 'q', new_string: 'q' } }))
    expect(same?.body).toBe('-q\n+q')
    const [multi] = toolSections(
      tool({ tool: 'MultiEdit', input: { file_path: '/a.ts', edits: [{ old_string: big, new_string: 'x' }, 'junk'] } }),
    )
    expect(multi?.format).toEqual({ kind: 'code', language: 'diff' })
  })

  test('the diff text is sanitized', () => {
    const [diff] = toolSections(
      tool({ tool: 'Edit', input: { file_path: '/a.ts', old_string: 'a\u001b[31m', new_string: 'b\u202e' } }),
    )
    expect(diff?.body).toBe('@@ -1,1 +1,1 @@\n-a\n+b')
  })

  test('Write shows the written content in its language', () => {
    const [file] = toolSections(tool({ tool: 'Write', input: { file_path: '/x/y.py', content: 'print(1)' } }))
    expect(file).toEqual({
      kind: 'file',
      title: 'write',
      meta: '/x/y.py',
      isPathMeta: true,
      body: 'print(1)',
      format: { kind: 'code', path: '/x/y.py' },
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
    expect(parseCommand('tail-status', ' off ')).toEqual({ sub: 'status', arg: 'off' })
    expect(parseCommand('tail', 'status on')).toEqual({ sub: 'status', arg: 'on' })
    expect(parseCommand('tail-notify', 'on')).toEqual({ sub: 'notify', arg: 'on' })
    expect(parseCommand('tail', 'notify off')).toEqual({ sub: 'notify', arg: 'off' })
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

describe('itemStatus from the structured interrupt flag', () => {
  const built = (use: Record<string, unknown>) =>
    buildTurns([
      { role: 'user', text: 'go', toolUses: [] },
      { role: 'assistant', text: '', toolUses: [{ tool_use_id: 'k', tool: 'Bash', input: {}, ...use }] },
    ])[0]!.items[0] as ToolItem
  const quiet = { isLatest: true, isWorking: false }

  test('a Bash result with interrupted: true is interrupted, even when it was not an error', () => {
    expect(itemStatus(built({ text: 'partial', result: { stdout: 'x', interrupted: true } }), quiet)).toBe(
      'interrupted',
    )
    expect(itemStatus(built({ text: 'ok', result: { stdout: 'x', interrupted: false } }), quiet)).toBe('done')
  })

  test('the stored text only counts at its start, so output that mentions it stays an error', () => {
    const quote = built({ text: 'script said: interrupted by user, retrying', isError: true })
    expect(itemStatus(quote, quiet)).toBe('error')
    const stored = built({ text: '[Request interrupted by user for tool use]', isError: true })
    expect(itemStatus(stored, quiet)).toBe('interrupted')
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

const MULTI = [
  'ellipsis',
  'border',
  'taskDone',
  'taskActive',
  'taskTodo',
  'treeBranch',
  'treeLast',
  'treeGuide',
  'keyLatest',
]

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

  test('no set draws the paused mark as a spinner frame, and the unicode set avoids the wide U+23F8', () => {
    for (const set of Object.values(ICON_SETS)) expect(set.spinner).not.toContain(set.idle)
    expect(ICON_SETS.unicode.interrupted).not.toBe('\u23f8')
    expect(ICON_SETS.nerd.interrupted).toBe('\u23f8')
  })

  test('each glyph is one cell wide in the unicode and ascii sets, the spinner has frames', () => {
    for (const set of [ICON_SETS.unicode, ICON_SETS.ascii])
      for (const [key, value] of Object.entries(set).filter(([k]) => !MULTI.includes(k)))
        for (const glyph of [value].flat()) expect([...glyph].length, key).toBe(1)
    for (const set of Object.values(ICON_SETS))
      for (const key of ['treeBranch', 'treeLast', 'treeGuide'] as const) expect([...set[key]].length, key).toBe(3)
    expect(ICON_SETS.ascii.spinner).toEqual(['|', '/', '-', '\\'])
    expect(ICON_SETS.ascii.done).toBe('+')
    expect(ICON_SETS.ascii.error).toBe('x')
    expect(ICON_SETS.ascii.ellipsis).toBe('...')
    expect(ICON_SETS.ascii.border).toBe('classic')
    expect(ICON_SETS.nerd.border).toBe('round')
    expect(ICON_SETS.unicode.ellipsis).toBe('…')
  })

  test('the page keys and the more above / below rows have triangles, ^ and v in ascii', () => {
    for (const set of [ICON_SETS.nerd, ICON_SETS.unicode]) {
      expect([set.pageUp, set.pageDown, set.moreAbove, set.moreBelow]).toEqual(['▲', '▼', '▲', '▼'])
      for (const glyph of [set.pageUp, set.pageDown, set.moreAbove, set.moreBelow]) expect(displayWidth(glyph)).toBe(1)
    }
    expect([ICON_SETS.ascii.pageUp, ICON_SETS.ascii.pageDown]).toEqual(['^', 'v'])
    expect([ICON_SETS.ascii.moreAbove, ICON_SETS.ascii.moreBelow]).toEqual(['^', 'v'])
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

  test('counts cells and never splits a surrogate pair', () => {
    const out = truncateMiddle('😀'.repeat(10) + 'end', 11)
    expect(displayWidth(out)).toBeLessThanOrEqual(11)
    expect(out).toBe('😀…😀😀end')
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

describe('splitMatch', () => {
  test('splits a snippet around the query, whatever the case', () => {
    expect(splitMatch('foo Bar baz', 'bar')).toEqual({ before: 'foo ', match: 'Bar', after: ' baz' })
    expect(splitMatch('foo Bar baz', '  BAR ')).toEqual({ before: 'foo ', match: 'Bar', after: ' baz' })
    expect(splitMatch('…tail Bar', 'bar')).toEqual({ before: '…tail ', match: 'Bar', after: '' })
  })

  test('no match, or no query, leaves the snippet whole', () => {
    expect(splitMatch('foo', 'zzz')).toEqual({ before: 'foo', match: '', after: '' })
    expect(splitMatch('foo', '  ')).toEqual({ before: 'foo', match: '', after: '' })
  })

  test('maps offsets like snippetAt: lowercase length changes and surrogate pairs', () => {
    // "İ" lowercases to two UTF-16 units, so offsets in the lowercased text drift.
    expect(splitMatch('İx', 'x')).toEqual({ before: 'İ', match: 'x', after: '' })
    expect(splitMatch('😀 Bar 😀', 'bar')).toEqual({ before: '😀 ', match: 'Bar', after: ' 😀' })
    expect(splitMatch('😀😀', '😀')).toEqual({ before: '', match: '😀', after: '😀' })
  })

  test('agrees with searchTurns: the snippet it made holds the match it finds', () => {
    const long = `${'a'.repeat(60)} needle ${'b'.repeat(60)}`
    const turns = buildTurns([
      { role: 'user', text: long, toolUses: [] },
      { role: 'assistant', text: 'ok', toolUses: [] },
    ])
    const [hit] = searchTurns(turns, 'NEEDLE')
    const split = splitMatch(hit!.snippet, 'NEEDLE')
    expect(split.match).toBe('needle')
    expect(split.before.startsWith('…')).toBe(true)
    expect(split.after.endsWith('…')).toBe(true)
  })
})

describe('firstErrorLine', () => {
  test('is the first line that names an error, trimmed', () => {
    expect(firstErrorLine('compiling\n\n   src/a.ts:3: error TS2304: nope  \nError: later')).toBe(
      'src/a.ts:3: error TS2304: nope',
    )
    expect(firstErrorLine('ok\n--- FAIL: TestX (0.00s)\nmore')).toBe('--- FAIL: TestX (0.00s)')
    expect(firstErrorLine('running\npanic: nil pointer\n')).toBe('panic: nil pointer')
    expect(firstErrorLine('trace\njava.lang.NullPointerException at x')).toBe('java.lang.NullPointerException at x')
  })

  test('without a match it is the first non-empty line, and empty text gives nothing', () => {
    expect(firstErrorLine('\n \n  command not found \nsecond')).toBe('command not found')
    expect(firstErrorLine('')).toBe('')
    expect(firstErrorLine(' \n\t\n')).toBe('')
  })

  test('stays linear on one huge line', () => {
    const started = performance.now()
    expect(firstErrorLine('x'.repeat(2_000_000)).length).toBe(2_000_000)
    expect(performance.now() - started).toBeLessThan(200)
  })
})

describe('a custom ellipsis (the ascii set)', () => {
  test('truncate and truncateMiddle count the width of the ellipsis', () => {
    expect(truncate('abcdefghij', 6, '...')).toBe('abc...')
    expect(truncate('abcdef', 6, '...')).toBe('abcdef')
    expect(truncate('abcdefghij', 2, '...')).toBe('ab')
    expect(truncateMiddle('abcdefghij', 7, '...')).toBe('a...hij')
    expect(truncateMiddle('abcdefghij', 2, '...')).toBe('..')
    expect(displayWidth(truncateMiddle('😀'.repeat(20), 9, '...'))).toBeLessThanOrEqual(9)
  })

  test('clampText, searchTurns and splitMatch use it', () => {
    expect(clampText('a\nb\nc', 2, 100, '...').note).toBe('... (1 line hidden)')
    expect(clampText('x'.repeat(10), 5, 4, '...').note).toBe('... (6 chars hidden)')
    const long = `${'a'.repeat(60)} needle ${'b'.repeat(60)}`
    const turns = buildTurns([
      { role: 'user', text: long, toolUses: [] },
      { role: 'assistant', text: 'ok', toolUses: [] },
    ])
    const [hit] = searchTurns(turns, 'needle', '...')
    expect(hit!.snippet.startsWith('...')).toBe(true)
    expect(hit!.snippet.endsWith('...')).toBe(true)
    expect(hit!.snippet).not.toContain('…')
    expect(splitMatch(hit!.snippet, 'needle', '...').match).toBe('needle')
    // A query of dots finds no hit in the ellipsis itself.
    expect(splitMatch('...abc', '.', '...')).toEqual({ before: '...abc', match: '', after: '' })
  })

  test('task marks follow the set', () => {
    const marks = { taskDone: '[x]', taskActive: '[~]', taskTodo: '[ ]' }
    expect(taskMark('completed', marks)).toBe('[x]')
    expect(taskMark('in_progress', marks)).toBe('[~]')
    expect(taskMark('pending', marks)).toBe('[ ]')
  })

  test('compactCall, turnTail and toolSections take their glyphs from the set', () => {
    const glyphs = { ellipsis: '...', dot: '.', taskDone: '[x]', taskActive: '[~]', taskTodo: '[ ]' }
    expect(compactCall('Bash', { command: 'x'.repeat(100) }, '...').summary).toBe(`${'x'.repeat(77)}...`)
    expect(turnTail(buildTurns(transcript)[0]!, { durationMs: 2000 }, '.')).toContain(' . ')
    const todo: ToolItem = {
      kind: 'tool',
      id: 't',
      tool: 'TodoWrite',
      input: {
        todos: [
          { content: 'a', status: 'completed' },
          { content: 'b', status: 'pending' },
        ],
      },
      summary: '',
      resultText: 'ok',
      isError: false,
      isPending: false,
    }
    const sections = toolSections(todo, glyphs)
    expect(sections[0]!.body).toBe('[x] a\n[ ] b')
    expect(sections[1]!.meta).toBe('ok . 1 line')
  })
})

describe('compactCall paths', () => {
  test('a long path is cut in the middle and keeps the file name', () => {
    const { summary } = compactCall('Read', { file_path: `/home/dev/${`${'d'.repeat(20)}/`.repeat(6)}session.ts` })
    expect([...summary].length).toBeLessThanOrEqual(80)
    expect(summary).toContain('…')
    expect(summary.endsWith('session.ts')).toBe(true)
  })
})

describe('unifiedDiff', () => {
  const lines = (n: number, from = 1) => Array.from({ length: n }, (_, i) => `l${i + from}`).join('\n')

  test('a replacement is one hunk with its header', () => {
    expect(unifiedDiff('a', 'b')).toBe('@@ -1,1 +1,1 @@\n-a\n+b')
  })

  test('an insertion and a deletion keep their context', () => {
    expect(unifiedDiff('a\nc', 'a\nb\nc')).toBe('@@ -1,2 +1,3 @@\n a\n+b\n c')
    expect(unifiedDiff('a\nb\nc', 'a\nc')).toBe('@@ -1,3 +1,2 @@\n a\n-b\n c')
  })

  test('context is at most three lines around a change, and far changes get their own hunks', () => {
    const before = lines(20)
    const after = before.replace('l2\n', 'L2\n').replace('l19', 'L19')
    const diff = unifiedDiff(before, after, { context: 3 })
    expect(diff).toBe(
      [
        '@@ -1,5 +1,5 @@',
        ' l1',
        '-l2',
        '+L2',
        ' l3',
        ' l4',
        ' l5',
        '@@ -16,5 +16,5 @@',
        ' l16',
        ' l17',
        ' l18',
        '-l19',
        '+L19',
        ' l20',
      ].join('\n'),
    )
  })

  test('changes closer than twice the context share a hunk', () => {
    const before = lines(10)
    const after = before.replace('l2\n', 'L2\n').replace('l8', 'L8')
    expect(unifiedDiff(before, after)?.match(/^@@/gm)).toHaveLength(1)
  })

  test('numbers start at startLine, and a pure insertion counts from the line before', () => {
    expect(unifiedDiff('a', 'b', { startLine: 40 })).toBe('@@ -40,1 +40,1 @@\n-a\n+b')
    expect(unifiedDiff('', 'x\ny')).toBe('@@ -0,0 +1,2 @@\n+x\n+y')
    expect(unifiedDiff('x', '')).toBe('@@ -1,1 +0,0 @@\n-x')
  })

  test('equal texts have no diff, and a side over 2000 lines is not diffed', () => {
    expect(unifiedDiff('a\nb', 'a\nb')).toBe('')
    expect(unifiedDiff(lines(2001), 'x')).toBeNull()
    expect(unifiedDiff('x', lines(2001))).toBeNull()
    expect(unifiedDiff(lines(1999), `${lines(1999)}\nmore`)).toBe(
      '@@ -1997,3 +1997,4 @@\n l1997\n l1998\n l1999\n+more',
    )
  })

  test('the result parses back to the new text', () => {
    const before = 'one\ntwo\nthree\nfour\nfive\nsix'
    const after = 'one\n2\nthree\nfour\nfive\nsix\nseven'
    const diff = unifiedDiff(before, after)!
    const rebuilt = diff
      .split('\n')
      .filter(l => l[0] === ' ' || l[0] === '+')
      .map(l => l.slice(1))
      .join('\n')
    expect(rebuilt).toBe(after)
  })
})

describe('splitDiff and clampDiff', () => {
  const body = Array.from({ length: 10 }, (_, i) => `+n${i}`).join('\n')
  const diff = `@@ -0,0 +1,10 @@\n${body}`

  test('a diff that fits comes back whole', () => {
    expect(splitDiff(diff, 100, 1000)).toEqual([diff])
  })

  test('a cut hunk continues under a header that counts its own lines', () => {
    const pieces = splitDiff(diff, 6, 1000)
    expect(pieces).toEqual(['@@ -0,0 +1,5 @@\n+n0\n+n1\n+n2\n+n3\n+n4', '@@ -0,0 +6,5 @@\n+n5\n+n6\n+n7\n+n8\n+n9'])
  })

  test('context lines advance both numbers when a hunk is cut', () => {
    const pieces = splitDiff('@@ -5,4 +5,4 @@\n a\n-b\n+B\n c\n d', 4, 1000)
    expect(pieces).toEqual(['@@ -5,2 +5,2 @@\n a\n-b\n+B', '@@ -7,2 +7,2 @@\n c\n d'])
  })

  test('pieces stay under the character size', () => {
    const pieces = splitDiff(diff, Infinity, 40)
    expect(pieces.length).toBeGreaterThan(1)
    for (const piece of pieces) expect(piece.length).toBeLessThanOrEqual(40)
    expect(pieces.flatMap(p => p.split('\n').filter(l => l[0] === '+'))).toHaveLength(10)
  })

  test('a text that is no diff is returned as one piece', () => {
    expect(splitDiff('not a diff', 2, 5)).toEqual(['not a diff'])
  })

  test('clampDiff keeps the first piece and says how many lines are hidden', () => {
    const clamped = clampDiff(diff, 6, 1000)
    expect(clamped.text).toBe('@@ -0,0 +1,5 @@\n+n0\n+n1\n+n2\n+n3\n+n4')
    expect(clamped.note).toBe('… (5 lines hidden)')
    expect(clampDiff(diff, 100, 1000)).toEqual({ text: diff })
    expect(clampDiff(diff, 100, 3, '...')).toEqual({ text: '', note: '... (10 lines hidden)' })
  })
})

describe('parseNumbered', () => {
  test('reads the arrow form and returns the first number with the bare lines', () => {
    expect(parseNumbered('     3→const a = 1\n     4→\n     5→  return a')).toEqual({
      startLine: 3,
      body: 'const a = 1\n\n  return a',
    })
  })

  test('reads the tab form and keeps tabs inside a line', () => {
    expect(parseNumbered('12\tone\n13\ttwo\tcols')).toEqual({ startLine: 12, body: 'one\ntwo\tcols' })
  })

  test('numbers that skip, repeat or run backwards leave the text alone', () => {
    expect(parseNumbered('1→a\n3→b')).toBeNull()
    expect(parseNumbered('1→a\n1→b')).toBeNull()
    expect(parseNumbered('2→a\n1→b')).toBeNull()
  })

  test('plain text, a partly numbered text and nothing are not numbered', () => {
    expect(parseNumbered('package main\nfunc main() {}')).toBeNull()
    expect(parseNumbered('1→a\nnote')).toBeNull()
    expect(parseNumbered('1→a\n\n2→b')).toBeNull()
    expect(parseNumbered('')).toBeNull()
  })
})

describe('pieceStarts', () => {
  test('gives the line each chunkText piece starts at', () => {
    const text = ['aaaa', 'bbbb', 'cccc', 'dddd'].join('\n')
    const pieces = chunkText(text, 9)
    expect(pieces).toEqual(['aaaa\nbbbb', 'cccc\ndddd'])
    expect(pieceStarts(text, pieces)).toEqual([0, 2])
  })

  test('a hard cut inside a line continues on that line', () => {
    const text = 'abcdefghij\nxyz'
    const pieces = chunkText(text, 4)
    expect(pieceStarts(text, pieces)[1]).toBe(0)
  })
})

describe('Read sections', () => {
  test('numbered output loses its numbers, gains startLine and the path', () => {
    const [, out] = toolSections(
      tool({
        tool: 'Read',
        input: { file_path: '/src/a.rs' },
        resultText: '    10→fn main() {\n    11→}',
      }),
    )
    expect(out).toMatchObject({
      body: 'fn main() {\n}',
      meta: 'ok · 2 lines',
      format: { kind: 'code', path: '/src/a.rs', startLine: 10 },
    })
  })

  test('numbers that do not run on stay in the text, with no startLine', () => {
    const [, out] = toolSections(tool({ tool: 'Read', input: { file_path: '/src/a.go' }, resultText: '1→a\n5→b' }))
    expect(out?.body).toBe('1→a\n5→b')
    expect(out?.format).toEqual({ kind: 'code', path: '/src/a.go' })
  })

  test('an unknown extension without numbers stays text, an error stays text', () => {
    expect(
      toolSections(tool({ tool: 'Read', input: { file_path: '/x/LICENSE' }, resultText: 'MIT' }))[1]?.format,
    ).toEqual({ kind: 'text' })
    expect(
      toolSections(tool({ tool: 'Read', input: { file_path: '/a.go' }, resultText: '1→x', isError: true }))[1]?.format,
    ).toEqual({ kind: 'text' })
  })
})

describe('callInput', () => {
  test("is the event without the fields that are not the tool's own", () => {
    expect(callInput({ tool: 'Bash', tool_use_id: 'x', agentId: 'a', command: 'ls', timeout: 5 })).toEqual({
      command: 'ls',
      timeout: 5,
    })
  })
})

describe('statusText', () => {
  const started = (tool: string, input: Record<string, unknown>, at: number, id = tool) =>
    runningTool(id, tool, input, at)

  test('the category icon, the tool, its summary and the elapsed seconds', () => {
    const bash = started('Bash', { command: 'go test ./...' }, 0)
    expect(statusText([bash], 12_400, ICON_SETS.nerd)).toBe(`${ICON_SETS.nerd.wrench} Bash go test ./... · 12s`)
    expect(statusText([bash], 72_000, ICON_SETS.unicode)).toBe(
      `${ICON_SETS.unicode.wrench} Bash go test ./... · 1m 12s`,
    )
    const read = started('Read', { file_path: '/a/b/main.go' }, 5_000)
    expect(statusText([read], 6_900, ICON_SETS.nerd)).toBe(`${ICON_SETS.nerd.book} Read a/b/main.go · 1s`)
  })

  test('the oldest running call is the one shown, and nothing running has no status', () => {
    const first = started('Grep', { pattern: 'x' }, 1_000)
    const second = started('Bash', { command: 'ls' }, 4_000)
    expect(statusText([first, second], 6_000, ICON_SETS.nerd)).toContain('Grep')
    expect(statusText([], 6_000, ICON_SETS.nerd)).toBeUndefined()
  })

  test('the summary is cut to 60 characters in the middle', () => {
    const long = started('Bash', { command: `echo ${'x'.repeat(30)}${'y'.repeat(30)}` }, 0)
    const line = statusText([long], 0, ICON_SETS.nerd)!
    const summary = line.slice(line.indexOf('Bash ') + 5, line.lastIndexOf(' · '))
    expect([...summary]).toHaveLength(60)
    expect(summary).toContain('…')
    expect(summary.startsWith('echo x')).toBe(true)
    expect(summary.endsWith('y')).toBe(true)
  })

  test('the ascii set gives an ASCII line, untrusted text is cleaned', () => {
    const bash = started('Bash', { command: `echo \u001b[31mhi\u202e ${'z'.repeat(80)}` }, 0)
    const line = statusText([bash], 3_000, ICON_SETS.ascii)!
    expect(line).toMatch(/^[\x20-\x7e]+$/)
    expect(line).toContain('Bash echo hi')
    expect(line.endsWith(' . 3s')).toBe(true)
  })
})

describe('finishedSince', () => {
  const agent = (id: string, status: AgentStatus) => ({ id, status, description: `job ${id}` })

  test('an agent that was not finished and now is, whichever way it ended', () => {
    const prev = new Map<string, AgentStatus>([
      ['a', 'running'],
      ['b', 'waiting'],
      ['c', 'pending'],
      ['d', 'idle'],
    ])
    const next = [agent('a', 'completed'), agent('b', 'failed'), agent('c', 'killed'), agent('d', 'completed')]
    expect(finishedSince(prev, next).map(a => a.id)).toEqual(['a', 'b', 'c', 'd'])
  })

  test('still running, already finished and never seen agents are not reported', () => {
    const prev = new Map<string, AgentStatus>([
      ['run', 'running'],
      ['old', 'completed'],
    ])
    const next = [agent('run', 'running'), agent('old', 'completed'), agent('new', 'completed')]
    expect(finishedSince(prev, next)).toEqual([])
    expect(finishedSince(new Map(), next)).toEqual([])
  })

  test('carries the description with the id', () => {
    const found = finishedSince(new Map([['a', 'running' as const]]), [agent('a', 'completed')])
    expect(found).toEqual([{ id: 'a', status: 'completed', description: 'job a' }])
  })
})

describe('fix round 1: model', () => {
  const many = (n: number, tag: string) => Array.from({ length: n }, (_, i) => `${tag}${i}`).join('\n')

  test('a changed middle over the cell cap is not diffed, one under it is', () => {
    expect(unifiedDiff(many(600, 'a'), many(600, 'b'))).toBeNull()
    expect(unifiedDiff(many(400, 'a'), many(400, 'b'))).not.toBeNull()
    // The common head and tail do not count against the cap.
    const shared = many(1500, 's')
    expect(unifiedDiff(`${shared}\nold`, `${shared}\nnew`)).not.toBeNull()
  })

  test('a big edit falls back to the plain - and + lines', () => {
    const [diff] = toolSections(
      tool({ tool: 'Edit', input: { file_path: '/a.ts', old_string: many(600, 'a'), new_string: many(600, 'b') } }),
    )
    expect(diff?.format).toEqual({ kind: 'code', language: 'diff' })
    expect(diff?.body.startsWith('-a0\n-a1')).toBe(true)
  })

  test('splitDiff of a very long hunk is linear', () => {
    const diff = `@@ -0,0 +1,20000 @@\n${Array.from({ length: 20000 }, (_, i) => `+line ${i}`).join('\n')}`
    const started = Date.now()
    const pieces = splitDiff(diff, Infinity, 8000)
    expect(Date.now() - started).toBeLessThan(400)
    expect(pieces.length).toBeGreaterThan(20)
    for (const piece of pieces) expect(piece.length).toBeLessThanOrEqual(8000)
  })

  test('editStartLine matches the whole new block, not a first line seen earlier', () => {
    const [diff] = toolSections(
      tool({
        tool: 'Edit',
        input: { file_path: '/a.ts', old_string: '}\nold', new_string: '}\nnew' },
        resultText: 'Updated:\n     3\t}\n     4\tx\n    10\t}\n    11\tnew\n    12\ty',
      }),
    )
    expect(diff?.body.startsWith('@@ -10,2 +10,2 @@')).toBe(true)
  })

  test('parseNumbered survives CRLF lines and a trailing blank tab line', () => {
    expect(parseNumbered('1\ta\r\n2\tb\r')).toEqual({ startLine: 1, body: 'a\nb' })
    expect(parseNumbered('1\ta\n2\tb\n3')).toEqual({ startLine: 1, body: 'a\nb\n' })
    expect(parseNumbered('1\ta\u2028b\n2\tc')).toEqual({ startLine: 1, body: 'a\u2028b\nc' })
    expect(parseNumbered('5')).toBeNull()
    expect(parseNumbered('1\n2\n3')).toBeNull()
  })

  test('cachedSections returns the same sections until the item changes', () => {
    const item = tool({ id: 'cache-1', tool: 'Edit', input: { file_path: '/a.ts', old_string: 'a', new_string: 'b' } })
    const first = cachedSections(item, ICON_SETS.nerd)
    expect(cachedSections({ ...item }, ICON_SETS.nerd)).toBe(first)
    const changed = { ...item, input: { file_path: '/a.ts', old_string: 'a', new_string: 'c' } }
    expect(cachedSections(changed, ICON_SETS.nerd)).not.toBe(first)
    expect(cachedSections(changed, ICON_SETS.ascii)).not.toBe(cachedSections(changed, ICON_SETS.nerd))
    expect(cachedSections({ ...item, resultText: 'ok' }, ICON_SETS.nerd)).not.toBe(first)
  })

  test('cachedSections keeps at most 200 items', () => {
    const first = cachedSections(tool({ id: 'cap-0', input: { command: 'ls' } }), ICON_SETS.nerd)
    for (let i = 1; i <= 200; i++) cachedSections(tool({ id: `cap-${i}`, input: { command: 'ls' } }), ICON_SETS.nerd)
    expect(cachedSections(tool({ id: 'cap-0', input: { command: 'ls' } }), ICON_SETS.nerd)).not.toBe(first)
  })
})

describe('finishedWorkflows', () => {
  const wf = (id: string, over: Partial<ToolItem> = {}): ToolItem =>
    tool({ id, tool: 'Workflow', isPending: true, ...over })
  const turn = (...items: ToolItem[]) => ({
    index: 0,
    prompt: '',
    items,
    toolCount: items.length,
    outputCount: 0,
    subagentCount: 0,
  })

  test('tracks pending Workflow calls while the session works', () => {
    expect(finishedWorkflows(new Set(), turn(wf('w1')), true)).toEqual({ tracked: new Set(['w1']), finished: [] })
  })

  test('a tracked call that got its result is finished, once', () => {
    const done = finishedWorkflows(new Set(['w1']), turn(wf('w1', { isPending: false, resultText: 'ok' })), true)
    expect(done).toEqual({ tracked: new Set(), finished: ['w1'] })
  })

  test('a call left pending when the session stops working is dropped without a toast', () => {
    expect(finishedWorkflows(new Set(['w1']), turn(wf('w1')), false)).toEqual({ tracked: new Set(), finished: [] })
  })

  test('a call that left the latest turn or ended interrupted is dropped without a toast', () => {
    expect(finishedWorkflows(new Set(['w1']), turn(), true)).toEqual({ tracked: new Set(), finished: [] })
    const stopped = wf('w1', { isPending: false, isInterrupted: true })
    expect(finishedWorkflows(new Set(['w1']), turn(stopped), true)).toEqual({ tracked: new Set(), finished: [] })
    expect(finishedWorkflows(new Set(), undefined, true)).toEqual({ tracked: new Set(), finished: [] })
  })
})

describe('display width of emoji forms', () => {
  test('flags, keycaps and emoji-presentation symbols take two cells', () => {
    expect(displayWidth('🇨🇿')).toBe(2)
    expect(displayWidth('1\ufe0f\u20e3')).toBe(2)
    expect(displayWidth('✅')).toBe(2)
    expect(displayWidth('🀄')).toBe(2)
    expect(displayWidth('⌚')).toBe(2)
    expect(displayWidth('⭐')).toBe(2)
    expect(displayWidth('✓')).toBe(1)
    expect(displayWidth('a\ufe0f')).toBe(2)
  })

  test('truncateDisplay cuts flags by their real width', () => {
    expect(truncateDisplay('a🇨🇿🇨🇿b', 4, '…')).toBe('a🇨🇿…')
    expect(displayWidth(truncateDisplay('a🇨🇿🇨🇿b', 4))).toBeLessThanOrEqual(4)
  })

  test('without Intl.Segmenter widths fall back to code points', () => {
    expect(displayWidth('plain ascii')).toBe(11)
  })
})

describe('display width', () => {
  test('displayWidth counts cells per grapheme', () => {
    expect(displayWidth('')).toBe(0)
    expect(displayWidth('abc')).toBe(3)
    expect(displayWidth('日本語')).toBe(6)
    expect(displayWidth('한글')).toBe(4)
    expect(displayWidth('ＡＢ')).toBe(4)
    expect(displayWidth('😀')).toBe(2)
    expect(displayWidth('👨\u200d👩\u200d👧')).toBe(2)
    expect(displayWidth('e\u0301')).toBe(1)
    expect(displayWidth('a\ufe0e')).toBe(1)
    expect(displayWidth('\u2764\ufe0f')).toBe(2)
    expect(displayWidth('\u{F0BE0}')).toBe(1)
    expect(displayWidth('\ue0b0')).toBe(1)
  })

  test('padEndDisplay pads to cells, never cuts', () => {
    expect(padEndDisplay('ab', 5)).toBe('ab   ')
    expect(padEndDisplay('日本', 6)).toBe('日本  ')
    expect(padEndDisplay('日本語', 4)).toBe('日本語')
  })

  test('truncateDisplay cuts to cells and keeps graphemes whole', () => {
    expect(truncateDisplay('hello', 10)).toBe('hello')
    expect(truncateDisplay('hello world', 8)).toBe('hello w…')
    expect(truncateDisplay('hello world', 8, '...')).toBe('hello...')
    expect(truncateDisplay('日本語日本語', 7)).toBe('日本語…')
    expect(displayWidth(truncateDisplay('日本語日本語', 6))).toBeLessThanOrEqual(6)
    expect(truncateDisplay('a\nb', 5)).toBe('a b')
    expect(truncateDisplay('abcdef', 1, '...')).toBe('a')
    expect(truncateDisplay('abc', 0)).toBe('')
    const family = '👨\u200d👩\u200d👧'
    expect(truncateDisplay(`${family}${family}${family}`, 5)).toBe(`${family}${family}…`)
    expect(truncateDisplay('e\u0301e\u0301e\u0301e\u0301', 3)).toBe('e\u0301e\u0301…')
  })

  test('truncateMiddle counts cells too', () => {
    expect(displayWidth(truncateMiddle('日本語日本語日本語日本語', 9))).toBeLessThanOrEqual(9)
  })
})

describe('durationBar', () => {
  const nerd = ICON_SETS.nerd
  test('nothing under one percent, nothing without a duration', () => {
    expect(durationBar(0, 1000, 8, nerd)).toBe('')
    expect(durationBar(5, 1000, 8, nerd)).toBe('')
    expect(durationBar(10, 0, 8, nerd)).toBe('')
    expect(durationBar(Number.NaN, 1000, 8, nerd)).toBe('')
  })

  test('the longest call fills every cell, shorter ones scale', () => {
    expect(durationBar(1000, 1000, 8, nerd)).toBe('████████')
    expect(durationBar(2000, 1000, 8, nerd)).toBe('████████')
    expect(durationBar(500, 1000, 8, nerd)).toBe('████')
  })

  test('the remainder is drawn in eighths of a block', () => {
    expect(durationBar(140, 8000, 8, nerd)).toBe('▏')
    expect(durationBar(4500, 8000, 8, nerd)).toBe('████▌')
    expect(durationBar(7 * 1000 + 875, 8000, 8, nerd)).toBe('███████▉')
    expect(durationBar(20, 1000, 8, nerd)).toBe('▏')
  })

  test('ascii draws = for whole cells and - for a part', () => {
    expect(durationBar(1000, 1000, 8, ICON_SETS.ascii)).toBe('========')
    expect(durationBar(4500, 8000, 8, ICON_SETS.ascii)).toBe('====-')
    expect(durationBar(4500, 8000, 8, ICON_SETS.ascii)).toMatch(/^[\x20-\x7e]*$/)
  })

  test('every set has eight steps and a times sign', () => {
    for (const set of Object.values(ICON_SETS)) {
      expect(set.bar).toHaveLength(8)
      expect(set.times).not.toBe('')
    }
    expect(ICON_SETS.ascii.times).toBe('x')
  })
})

describe('groupRuns', () => {
  const tool = (id: string, name: string, input: Record<string, unknown> = {}, isError = false): ToolItem => ({
    kind: 'tool',
    id,
    tool: name,
    input,
    summary: name,
    isError,
    isPending: false,
  })
  const reads = (n: number, from = 0) =>
    Array.from({ length: n }, (_, i) => tool(`r${from + i}`, 'Read', { file_path: `/a/f${(from + i) % 4}.ts` }))

  test('fewer than three calls stay single rows', () => {
    const items = reads(2)
    expect(groupRuns(items)).toEqual(items)
    expect(groupRuns([])).toEqual([])
  })

  test('three or more consecutive calls of one tool become a group with a stable id', () => {
    const items = reads(7)
    const out = groupRuns(items)
    expect(out).toHaveLength(1)
    expect(out[0]).toEqual({ kind: 'group', id: 'group:r0', tool: 'Read', items })
    expect(groupRuns([...items, tool('r7', 'Read')])[0]).toMatchObject({ id: 'group:r0' })
    expect(groupRuns(items.slice(0, 3))[0]).toMatchObject({ id: 'group:r0' })
  })

  test('an error, another tool or a message breaks the run', () => {
    const items = [...reads(2), tool('e', 'Read', {}, true), ...reads(3, 10)]
    const out = groupRuns(items)
    expect(out.map(r => r.kind)).toEqual(['tool', 'tool', 'tool', 'group'])
    expect(groupRuns([...reads(2), tool('g', 'Grep'), ...reads(2, 10)]).every(r => r.kind === 'tool')).toBe(true)
    const output: Item = { kind: 'output', id: 'o', text: 'x' }
    expect(groupRuns([...reads(2), output, ...reads(2, 10)]).every(r => r.kind !== 'group')).toBe(true)
  })

  test('only read, search and web tools group', () => {
    for (const name of ['Grep', 'Glob', 'WebFetch', 'WebSearch'])
      expect(groupRuns([1, 2, 3].map(n => tool(`${name}${n}`, name)))[0]?.kind).toBe('group')
    for (const name of ['Edit', 'Bash', 'Agent', 'Write', 'Task'])
      expect(groupRuns([1, 2, 3].map(n => tool(`${name}${n}`, name))).every(r => r.kind === 'tool')).toBe(true)
  })

  test('two runs of different tools group apart', () => {
    const out = groupRuns([...reads(3), ...[3, 4, 5].map(n => tool(`g${n}`, 'Grep', { pattern: `p${n}` }))])
    expect(out.map(r => (r.kind === 'group' ? r.tool : '-'))).toEqual(['Read', 'Grep'])
  })

  test('the label counts calls and distinct files, patterns or pages', () => {
    const group = groupRuns(reads(7))[0] as Extract<ReturnType<typeof groupRuns>[number], { kind: 'group' }>
    expect(groupLabel(group, ICON_SETS.nerd)).toBe('Read ×7 · 4 files')
    expect(groupLabel(group, ICON_SETS.ascii)).toBe('Read x7 . 4 files')
    const one = groupRuns([1, 2, 3].map(n => tool(`x${n}`, 'Read', { file_path: '/a.ts' })))[0] as typeof group
    expect(groupLabel(one, ICON_SETS.nerd)).toBe('Read ×3 · 1 file')
    const search = groupRuns([1, 2, 3].map(n => tool(`s${n}`, 'Grep', { pattern: `p${n}` })))[0] as typeof group
    expect(groupLabel(search, ICON_SETS.nerd)).toBe('Grep ×3 · 3 patterns')
    const web = groupRuns([1, 2, 3].map(n => tool(`w${n}`, 'WebSearch', { query: 'q' })))[0] as typeof group
    expect(groupLabel(web, ICON_SETS.nerd)).toBe('WebSearch ×3 · 1 query')
    const fetch = groupRuns([1, 2, 3].map(n => tool(`f${n}`, 'WebFetch', { url: `u${n}` })))[0] as typeof group
    expect(groupLabel(fetch, ICON_SETS.nerd)).toBe('WebFetch ×3 · 3 pages')
    const bare = groupRuns([1, 2, 3].map(n => tool(`b${n}`, 'Glob')))[0] as typeof group
    expect(groupLabel(bare, ICON_SETS.nerd)).toBe('Glob ×3')
  })
})

describe('turnTable', () => {
  const turns = buildTurns([
    { role: 'user', text: 'Fix the bug', toolUses: [] },
    {
      role: 'assistant',
      text: '',
      toolUses: [
        { tool_use_id: 'a', tool: 'Bash', input: {}, text: 'x' },
        { tool_use_id: 'b', tool: 'Read', input: {}, text: 'x' },
      ],
    },
    { role: 'user', text: '日本語'.repeat(30), toolUses: [] },
    { role: 'assistant', text: 'ok', toolUses: [] },
    { role: 'user', text: 'Third', toolUses: [] },
    { role: 'assistant', text: 'ok', toolUses: [] },
  ])
  const stats = [
    { prompt: 'Fix the bug', durationMs: 65_000, endedAt: 0, inputTokens: 1000, outputTokens: 500 },
    { prompt: '', durationMs: 32_500, endedAt: 0, inputTokens: 40, outputTokens: 2 },
    undefined,
  ]
  const table = (width: number, icons = ICON_SETS.nerd) => turnTable(turns, stats, width, icons)
  const row = (t: ReturnType<typeof table>, i: number) => t.rows[i]!

  test('a very narrow pane never overflows', () => {
    for (const width of [40, 30, 20, 10]) {
      const t = table(width)
      for (const r of t.rows) expect(displayWidth(r.label)).toBeLessThanOrEqual(Math.max(0, width - 4))
    }
  })

  test('a wide pane shows number, prompt, tools, time, tokens and the bar', () => {
    const t = table(100)
    expect(t.header).toMatch(/^#\s+prompt\s+tools\s+time\s+tokens$/)
    expect(row(t, 0).cells).toMatchObject({ number: '#1', tools: '2', time: '1m 5s', tokens: '1.5k' })
    expect(row(t, 0).cells.bar).toBe('████████')
    expect(row(t, 1).cells.bar).toBe('████')
    expect(row(t, 2).cells).toMatchObject({ tools: '', time: '', tokens: '', bar: '' })
  })

  test('every row label is exactly as wide as the table, wide characters included', () => {
    for (const width of [100, 70, 69, 55, 54, 40]) {
      const t = table(width)
      const widths = new Set(t.rows.map(r => displayWidth(r.label)))
      expect(widths.size).toBe(1)
      expect(displayWidth(t.header)).toBeLessThanOrEqual([...widths][0]!)
      expect([...widths][0]).toBeLessThanOrEqual(width - 4)
    }
  })

  test('under 70 columns tokens and the bar are left out, under 55 tools too', () => {
    const mid = table(69)
    expect(mid.header).not.toContain('tokens')
    expect(mid.header).toContain('tools')
    expect(row(mid, 0).cells.bar).toBe('')
    expect(row(mid, 0).cells.tokens).toBe('')
    const narrow = table(54)
    expect(narrow.header).not.toContain('tools')
    expect(narrow.header).toContain('time')
    expect(row(narrow, 0).cells.tools).toBe('')
    expect(table(70).header).toContain('tokens')
    expect(table(55).header).toContain('tools')
  })

  test('the prompt is cut by cells with the set ellipsis and keeps its room', () => {
    const t = table(100)
    expect(row(t, 1).cells.prompt.endsWith('…')).toBe(true)
    expect(displayWidth(row(t, 1).cells.prompt)).toBeLessThanOrEqual(56)
    expect(displayWidth(row(t, 1).cells.prompt)).toBeGreaterThanOrEqual(55)
    const a = table(100, ICON_SETS.ascii)
    expect(row(a, 1).cells.prompt.endsWith('...')).toBe(true)
    expect(a.rows[0]!.label).toMatch(/^[\x20-\x7e]*$/)
    expect(a.header).toMatch(/^[\x20-\x7e]*$/)
  })

  test('a turn without a prompt reads (no prompt) and no turns give no rows', () => {
    const none = turnTable(buildTurns([{ role: 'assistant', text: 'hi', toolUses: [] }]), [], 100, ICON_SETS.nerd)
    expect(none.rows[0]!.cells.prompt).toContain('(no prompt)')
    expect(turnTable([], [], 100, ICON_SETS.nerd).rows).toEqual([])
  })
})

describe('moveCursor', () => {
  const ids = ['a', 'b', 'c']

  test('steps one row and clips at the first and the last', () => {
    expect(moveCursor(ids, 'a', 1)).toBe('b')
    expect(moveCursor(ids, 'c', -1)).toBe('b')
    expect(moveCursor(ids, 'c', 1)).toBe('c')
    expect(moveCursor(ids, 'a', -1)).toBe('a')
  })

  test('no cursor yet enters at the first row going down and the last going up', () => {
    expect(moveCursor(ids, null, 1)).toBe('a')
    expect(moveCursor(ids, null, -1)).toBe('c')
    expect(moveCursor(ids, 'gone', 1)).toBe('a')
  })

  test('an empty list has no cursor', () => {
    expect(moveCursor([], null, 1)).toBeNull()
    expect(moveCursor([], 'a', -1)).toBeNull()
  })
})

describe('cursorRows', () => {
  const t = (id: string, name = 'Bash', agentId?: string): ToolItem => ({
    kind: 'tool',
    id,
    tool: name,
    input: {},
    summary: '',
    isError: false,
    isPending: false,
    ...(agentId === undefined ? {} : { agentId }),
  })
  const kid = t('ag/k1')
  const childrenOf = (agentId: string) => (agentId === 'ag' ? [kid] : undefined)

  test('a subagent trace counts only while the subagent is open', () => {
    const items = [t('x1'), t('a1', 'Agent', 'ag'), t('x2')]
    expect(cursorRows(items, new Set(), childrenOf)).toEqual(['x1', 'a1', 'x2'])
    expect(cursorRows(items, new Set(['a1']), childrenOf)).toEqual(['x1', 'a1', 'ag/k1', 'x2'])
    expect(cursorRows(items, new Set(['a1']), () => undefined)).toEqual(['x1', 'a1', 'x2'])
  })

  test('a folded run is one row, and its calls count only while it is open', () => {
    const items = [t('r1', 'Read'), t('r2', 'Read'), t('r3', 'Read')]
    expect(cursorRows(items, new Set(), childrenOf)).toEqual(['group:r1'])
    expect(cursorRows(items, new Set(['group:r1']), childrenOf)).toEqual(['group:r1', 'r1', 'r2', 'r3'])
  })
})

describe('rowText', () => {
  const bash: ToolItem = {
    kind: 'tool',
    id: 'b1',
    tool: 'Bash',
    input: { command: 'go test ./...' },
    summary: '',
    isError: false,
    isPending: false,
    resultText: 'ok',
  }
  const none = () => undefined

  test('is the whole text of the sections of the row, found at any depth', () => {
    const text = rowText([bash], 'b1', none, ICON_SETS.nerd)!
    expect(text).toContain('go test ./...')
    expect(text).toContain('ok')
    const agent: ToolItem = { ...bash, id: 'a1', tool: 'Agent', agentId: 'ag', input: { description: 'd' } }
    expect(rowText([agent], 'b1', id => (id === 'ag' ? [bash] : undefined), ICON_SETS.nerd)).toContain('go test')
  })

  test('a group joins its calls, an output row is its message, an unknown id has no text', () => {
    const second = { ...bash, id: 'b2', input: { command: 'go vet' } }
    const group = rowText([bash, second], 'group:b1', none, ICON_SETS.nerd)
    expect(group).toBeUndefined()
    const reads = ['1', '2', '3'].map(n => ({ ...bash, id: `r${n}`, tool: 'Read', input: { file_path: `/f${n}` } }))
    expect(rowText(reads, 'group:r1', none, ICON_SETS.nerd)).toMatch(/f1[\s\S]*f2[\s\S]*f3/)
    const out = { kind: 'output' as const, id: 'o1', text: 'All done' }
    expect(rowText([out], 'o1', none, ICON_SETS.nerd)).toBe('All done')
    expect(rowText([out], 'nope', none, ICON_SETS.nerd)).toBeUndefined()
  })
})

describe('hoverCard', () => {
  const bash = (command: string): ToolItem => ({
    kind: 'tool',
    id: 'b1',
    tool: 'Bash',
    input: { command },
    summary: '',
    isError: false,
    isPending: false,
    resultText: 'RESULT',
  })

  test('is the first lines of the input section, never the output', () => {
    const card = hoverCard(bash(Array.from({ length: 9 }, (_, i) => `line${i}`).join('\n')), 40, ICON_SETS.nerd)!
    expect(card).toHaveLength(6)
    expect(card[0]).toBe('line0')
    expect(card.join('\n')).not.toContain('RESULT')
  })

  test('lines are cut to the width, the whole card to 600 characters, untrusted text is cleaned', () => {
    const wide = hoverCard(bash('x'.repeat(200)), 30, ICON_SETS.nerd)!
    expect(wide[0]).toHaveLength(30)
    expect(wide[0]!.endsWith('…')).toBe(true)
    const many = hoverCard(bash(Array.from({ length: 6 }, () => 'y'.repeat(300)).join('\n')), 300, ICON_SETS.nerd)!
    expect(many.join('\n').length).toBeLessThanOrEqual(600)
    expect(hoverCard(bash('a\u001b[31mb'), 40, ICON_SETS.nerd)).toEqual(['ab'])
    expect(hoverCard(bash('é'.repeat(100)), 30, ICON_SETS.ascii)![0]!.endsWith('...')).toBe(true)
  })

  test('a call drawn as JSON shows one key: value line per field, never braces or quotes', () => {
    const send: ToolItem = {
      ...bash(''),
      tool: 'SendMessage',
      input: { to: 'a811', summary: 'Wave 5 fix', message: 'line one\nline two', count: 3 },
    }
    expect(hoverCard(send, 60, ICON_SETS.nerd)).toEqual([
      'to: a811',
      'summary: Wave 5 fix',
      'message: line one line two',
      'count: 3',
    ])
  })

  test('a card is at most CARD_WIDTH cells wide however wide the pane', () => {
    const card = hoverCard(bash('x'.repeat(300)), 200, ICON_SETS.nerd)!
    expect(card[0]!.length).toBeLessThanOrEqual(72)
  })

  test('a call with no input has no card', () => {
    expect(hoverCard({ ...bash('x'), input: {} }, 40, ICON_SETS.nerd)).toBeUndefined()
  })

  const lines = (prefix: string, n: number) => Array.from({ length: n }, (_, i) => `${prefix}${i}`).join('\n')
  const edit = (input: Record<string, unknown>, tool = 'Edit'): ToolItem => ({ ...bash(''), id: 'e1', tool, input })

  test('an Edit card is its first old and new lines, read from the input without building the diff', () => {
    resetSectionCache()
    const card = hoverCard(edit({ file_path: '/a.go', old_string: lines('o', 400), new_string: lines('n', 400) }), 40)
    expect(card).toEqual(['-o0', '-o1', '-o2', '+n0', '+n1', '+n2'])
    expect(sectionCacheSize()).toBe(0)
    const short = hoverCard(edit({ file_path: '/a.go', old_string: 'x', new_string: lines('n', 9) }), 40)
    expect(short).toEqual(['-x', '+n0', '+n1', '+n2', '+n3', '+n4'])
  })

  test('a MultiEdit card takes its edits in order; an Edit with nothing to show has no card', () => {
    const multi = edit(
      {
        file_path: '/a.go',
        edits: [
          { old_string: 'a', new_string: 'b' },
          { old_string: 'c', new_string: 'd' },
          { old_string: 'e', new_string: 'f' },
          { old_string: 'g', new_string: 'h' },
        ],
      },
      'MultiEdit',
    )
    expect(hoverCard(multi, 40)).toEqual(['-a', '+b', '-c', '+d', '-e', '+f'])
    expect(hoverCard(edit({ edits: 'bogus' }, 'MultiEdit'), 40)).toBeUndefined()
    expect(hoverCard(edit({ file_path: '/a.go' }), 40)).toBeUndefined()
  })
})

describe('spinnerMessage and durationSuffix', () => {
  const started = (tool: string, input: Record<string, unknown>, at: number) => runningTool(tool, tool, input, at)

  test('the spinner says the tool, a 40 character summary and the elapsed time', () => {
    const bash = started('Bash', { command: 'go test ./...' }, 0)
    expect(spinnerMessage([bash], 12_400, ICON_SETS.nerd)).toBe('Bash go test ./... · 12s')
    expect(spinnerMessage([bash], 72_000, ICON_SETS.ascii)).toBe('Bash go test ./... . 1m 12s')
    const long = started('Bash', { command: `echo ${'x'.repeat(100)}` }, 0)
    const summary = spinnerMessage([long], 0, ICON_SETS.nerd)!.slice('Bash '.length, -' · 0s'.length)
    expect([...summary]).toHaveLength(40)
    expect(spinnerMessage([], 0, ICON_SETS.nerd)).toBeUndefined()
    expect(spinnerMessage([started('Task', {}, 0)], 1_000, ICON_SETS.nerd)).toBe('Subagent Task · 1s')
  })

  test('the oldest running call is the one the spinner names', () => {
    const calls = [started('Bash', { command: 'ls' }, 5_000), started('Grep', { pattern: 'x' }, 1_000)]
    expect(spinnerMessage(calls, 6_000, ICON_SETS.nerd)).toBe('Grep "x" · 5s')
  })

  test('the suffix counts tools and agents when they are not zero', () => {
    const turn = (toolCount: number, subagentCount: number): Turn => ({
      index: 0,
      prompt: '',
      items: [],
      toolCount,
      outputCount: 0,
      subagentCount,
    })
    expect(durationSuffix(turn(4, 1), '·')).toBe(' · 3 tools · 1 agent')
    expect(durationSuffix(turn(1, 0), '.')).toBe(' . 1 tool')
    expect(durationSuffix(turn(2, 2), '·')).toBe(' · 2 agents')
    expect(durationSuffix(turn(0, 0), '·')).toBe('')
    expect(durationSuffix(undefined, '·')).toBe('')
  })
})

describe('footerLayout', () => {
  test('two columns with labels from 64 columns up', () => {
    expect(footerLayout(100)).toEqual({ rows: 4, columns: 'two', labels: true })
    expect(footerLayout(64)).toEqual({ rows: 4, columns: 'two', labels: true })
  })

  test('stacked groups with labels from 40 to 63 columns', () => {
    expect(footerLayout(63)).toEqual({ rows: 6, columns: 'stacked', labels: true })
    expect(footerLayout(40)).toEqual({ rows: 6, columns: 'stacked', labels: true })
  })

  test('stacked groups without labels under 40 columns', () => {
    expect(footerLayout(39)).toEqual({ rows: 6, columns: 'stacked', labels: false })
    expect(footerLayout(0)).toEqual({ rows: 6, columns: 'stacked', labels: false })
  })
})

describe('footerLayout with the rows a view draws', () => {
  test('the footer is the rule, the group rows the view draws and the status row', () => {
    expect(footerLayout(100, 2).rows).toBe(4)
    expect(footerLayout(100, 1).rows).toBe(3)
    expect(footerLayout(60, 3).rows).toBe(5)
    expect(footerLayout(36, 4)).toEqual({ rows: 6, columns: 'stacked', labels: false })
  })
})

describe('contentRows of the turn list', () => {
  test('a turn row with an id has its start, as an item row does', () => {
    const rows = contentRows([
      { kind: 'line' },
      { kind: 'turn', id: 'turn:2' },
      { kind: 'turn', id: 'turn:1', snippet: 'x' },
    ])
    expect(rows.starts).toEqual({ 'turn:2': 1, 'turn:1': 2 })
    expect(rows.total).toBe(4)
  })
})

describe('footerPads', () => {
  test('every key but the last takes the gap after it', () => {
    expect(footerPads([9, 9, 9], 2)).toEqual([2, 2, 0])
    expect(footerPads([4], 2)).toEqual([0])
    expect(footerPads([], 2)).toEqual([])
  })

  test('with a width the last key fills the row up to it, never below zero', () => {
    expect(footerPads([9, 9, 9], 2, 35)).toEqual([2, 2, 4])
    expect(footerPads([9, 9, 9], 2, 31)).toEqual([2, 2, 0])
    expect(footerPads([9, 9, 9], 2, 20)).toEqual([2, 2, 0])
  })
})

describe('contentRows', () => {
  test('an item row is one row and its start is where it begins', () => {
    const rows = contentRows([{ kind: 'line' }, { kind: 'line', id: 'a' }, { kind: 'line', id: 'b' }])
    expect(rows.total).toBe(3)
    expect(rows.starts).toEqual({ a: 1, b: 2 })
  })

  test('a frame is two borders, a header and one row per line of each piece', () => {
    const rows = contentRows([
      { kind: 'line', id: 'a' },
      { kind: 'frame', body: ['one\ntwo', 'three'], notes: [], width: 72 },
      { kind: 'line', id: 'b' },
    ])
    expect(rows.total).toBe(1 + 2 + 1 + 3 + 1)
    expect(rows.starts['b']).toBe(7)
    expect(contentRows([{ kind: 'frame', body: [], notes: [], width: 72 }]).total).toBe(3)
  })

  test('a show all line under the body counts as a note', () => {
    expect(contentRows([{ kind: 'frame', body: ['x'], notes: ['show all'], width: 72 }]).total).toBe(5)
    expect(contentRows([{ kind: 'frame', body: ['x'], notes: ['note', 'show all'], width: 72 }]).total).toBe(6)
  })

  test('a turn of the list is one row, two with a search snippet', () => {
    const rows = contentRows([{ kind: 'turn' }, { kind: 'turn', snippet: 'a match' }])
    expect(rows.total).toBe(3)
  })

  test('the team board counts its headings, members and tasks', () => {
    const lines = ['Tasks (2)', 'alice', 'bob', '', 'Tasks', 'one', 'two'].map(() => ({ kind: 'line' as const }))
    expect(contentRows(lines).total).toBe(7)
  })

  test('a line wider than its width takes a row per width, a cut one row', () => {
    const paragraph = 'word '.repeat(60).trim()
    expect(paragraph.length).toBe(299)
    expect(contentRows([{ kind: 'line', text: paragraph, width: 72 }]).total).toBe(5)
    expect(contentRows([{ kind: 'line', text: paragraph, width: 32 }]).total).toBe(10)
    expect(contentRows([{ kind: 'line', text: paragraph }]).total).toBe(1)
    expect(contentRows([{ kind: 'line', text: '', width: 10 }]).total).toBe(1)
  })

  test('twenty 300-character paragraphs wrap in an 80 and a 40 column frame', () => {
    const prose = Array.from({ length: 20 }, () => 'x'.repeat(300)).join('\n\n')
    // 20 paragraphs and 19 blank lines between them, plus the frame's 3 rows.
    expect(contentRows([{ kind: 'frame', body: [prose], notes: [], width: 70 }]).total).toBe(3 + 20 * 5 + 19)
    expect(contentRows([{ kind: 'frame', body: [prose], notes: [], width: 30 }]).total).toBe(3 + 20 * 10 + 19)
  })

  test('one-line JSON of 8000 characters is many rows, the gutter of numbered code narrows the body', () => {
    const json = JSON.stringify({ data: 'y'.repeat(7989) })
    expect(json.length).toBe(8000)
    expect(contentRows([{ kind: 'frame', body: [json], notes: [], width: 70 }]).total).toBe(3 + 115)
    expect(contentRows([{ kind: 'frame', body: [json], notes: [], width: 30 }]).total).toBe(3 + 267)
    expect(contentRows([{ kind: 'frame', body: ['z'.repeat(70)], notes: [], width: 70, gutter: 5 }]).total).toBe(5)
  })

  test('a frame header and notes wrap at the frame width, a trailing newline adds no row', () => {
    expect(
      contentRows([{ kind: 'frame', body: ['a\n'], notes: ['n'.repeat(100)], width: 50, headRows: 2 }]).total,
    ).toBe(2 + 2 + 1 + 2)
    expect(contentRows([{ kind: 'frame', body: ['tab\there'], notes: [], width: 8 }]).total).toBe(3 + 2)
  })

  // Calibrated against the real engine (a pyte-rendered session): Code with
  // language markdown drops empty lines; a diff draws no ---, +++ or @@ line
  // and puts its line number and the +/- marker in a gutter of digits + 3.
  test('markdown counts no row for an empty line', () => {
    const prose = ['p'.repeat(250), '', 'q'.repeat(250), '', '', 'r'].join('\n')
    expect(contentRows([{ kind: 'frame', body: [prose], notes: [], width: 100, format: 'markdown' }]).total).toBe(
      3 + 3 + 3 + 1,
    )
    expect(contentRows([{ kind: 'frame', body: [prose], notes: [], width: 100 }]).total).toBe(3 + 3 + 1 + 3 + 2 + 1)
  })

  test('a diff counts only its changed and context lines, beside a gutter of its widest line number', () => {
    const diff = ['--- a', '+++ b', '@@ -10,2 +10,2 @@', `-${'y'.repeat(247)}`, `+${'z'.repeat(247)}`, ' same'].join(
      '\n',
    )
    // Line numbers up to 11: 2 digits + 3 = 5 cells, 95 left: 247 cells take 3 rows.
    expect(contentRows([{ kind: 'frame', body: [diff], notes: [], width: 100, format: 'diff' }]).total).toBe(
      3 + 3 + 3 + 1,
    )
    const small = ['--- a', '+++ b', '@@ -1,8 +1,8 @@', `-${'y'.repeat(247)}`].join('\n')
    // Up to line 8: 1 digit + 3 = 4 cells, 96 left: 3 rows.
    expect(contentRows([{ kind: 'frame', body: [small], notes: [], width: 100, format: 'diff' }]).total).toBe(3 + 3)
  })

  test('a search snippet wraps at its width', () => {
    expect(contentRows([{ kind: 'turn', snippet: 's'.repeat(90), width: 40 }]).total).toBe(1 + 3)
  })

  test('no blocks is no rows', () => {
    expect(contentRows([])).toEqual({ total: 0, starts: {} })
  })
})

describe('clampScroll', () => {
  test('content that fits the window does not scroll', () => {
    expect(clampScroll(5, 8, 10)).toBe(0)
    expect(clampScroll(5, 10, 10)).toBe(0)
  })

  test('longer content scrolls to two rows past its end, never above the top', () => {
    expect(clampScroll(100, 30, 10)).toBe(22)
    expect(clampScroll(7, 30, 10)).toBe(7)
    expect(clampScroll(-3, 30, 10)).toBe(0)
  })
})

describe('pageScroll', () => {
  test('moves a window less two rows down or up, never above the top', () => {
    expect(pageScroll(0, 1, 10)).toBe(8)
    expect(pageScroll(8, -1, 10)).toBe(0)
    expect(pageScroll(3, -1, 10)).toBe(0)
  })

  test('a window of two rows or less still moves by one', () => {
    expect(pageScroll(0, 1, 2)).toBe(1)
    expect(pageScroll(0, 1, 0)).toBe(1)
  })
})

describe('followCursor', () => {
  test('a row already inside the window keeps the scroll', () => {
    expect(followCursor(5, 6, 10)).toBe(5)
    expect(followCursor(5, 13, 10)).toBe(5)
  })

  test('a row below the window scrolls it to one row above the bottom edge', () => {
    expect(followCursor(0, 9, 10)).toBe(1)
    expect(followCursor(5, 30, 10)).toBe(22)
  })

  test('a row above the window scrolls it to one row below the top edge', () => {
    expect(followCursor(10, 10, 10)).toBe(9)
    expect(followCursor(10, 2, 10)).toBe(1)
    expect(followCursor(10, 0, 10)).toBe(0)
  })

  test('a window of two rows or less has no margin', () => {
    expect(followCursor(0, 5, 2)).toBe(4)
    expect(followCursor(5, 3, 2)).toBe(3)
  })
})

describe('overflowRows', () => {
  test('nothing more above or below while the content fits', () => {
    expect(overflowRows(0, 10, 10)).toEqual({ above: 0, below: 0 })
  })

  test('counts the rows out of the window and under the indicator rows', () => {
    expect(overflowRows(0, 30, 10)).toEqual({ above: 0, below: 21 })
    expect(overflowRows(5, 30, 10)).toEqual({ above: 6, below: 16 })
    expect(overflowRows(21, 30, 10)).toEqual({ above: 22, below: 0 })
    expect(overflowRows(22, 30, 10)).toEqual({ above: 23, below: 0 })
  })
})

describe('scrollToRow', () => {
  const frame = { scrollTop: 0, windowRows: 10, total: 30, starts: { a: 2, z: 29 } }

  test('scrolls so the row stays visible, clamped to the content', () => {
    expect(scrollToRow(frame, 'a')).toBe(0)
    expect(scrollToRow(frame, 'z')).toBe(21)
    expect(scrollToRow({ ...frame, scrollTop: 20 }, 'a')).toBe(1)
  })

  test('a row with no known start, or no row, keeps the scroll', () => {
    expect(scrollToRow({ ...frame, scrollTop: 4 }, 'nope')).toBe(4)
    expect(scrollToRow({ ...frame, scrollTop: 4 }, null)).toBe(4)
  })
})

describe('stepCursor', () => {
  const ids = ['a', 'b', 'c', 'd', 'e', 'f']
  // a..f start on rows 1..6 of a window of four rows scrolled to row 3.
  const frame = { scrollTop: 3, windowRows: 4, total: 30, starts: { a: 1, b: 2, c: 3, d: 4, e: 5, f: 6 } }

  test('without a cursor, j enters at the first row inside the window and k at the last, so it does not move', () => {
    expect(stepCursor(ids, null, 1, frame)).toBe('d')
    expect(stepCursor(ids, null, -1, frame)).toBe('e')
    expect(scrollToRow(frame, 'd')).toBe(3)
    expect(scrollToRow(frame, 'e')).toBe(3)
  })

  test('at the top of the content it enters at the first row as before', () => {
    expect(stepCursor(ids, null, 1, { ...frame, scrollTop: 0 })).toBe('a')
  })

  test('with no row inside the window, or a cursor not on the list, it falls back to the ends', () => {
    expect(stepCursor(ids, null, 1, { ...frame, scrollTop: 20 })).toBe('a')
    expect(stepCursor(ids, null, -1, { ...frame, scrollTop: 20 })).toBe('f')
    expect(stepCursor(ids, 'gone', 1, { ...frame, scrollTop: 20 })).toBe('a')
  })

  test('a cursor scrolled out of the window enters inside it again instead of pulling the view back', () => {
    expect(stepCursor(ids, 'a', 1, frame)).toBe('d')
    expect(stepCursor(ids, 'a', -1, frame)).toBe('e')
  })

  test('a cursor on the list moves one row as moveCursor does', () => {
    expect(stepCursor(ids, 'd', 1, frame)).toBe('e')
    expect(stepCursor(ids, 'a', -1, { ...frame, scrollTop: 0 })).toBe('a')
    expect(stepCursor([], null, 1, frame)).toBe(null)
  })
})

describe('engineScroll', () => {
  const frame = { scrollTop: 0, windowRows: 34, total: 200, starts: {} }
  const move = (by: number) => ({ by, bodyRows: 40, contentRows: 40 })

  test('a wheel step moves its rows, clamped to the content', () => {
    expect(engineScroll(10, move(3), frame)).toBe(13)
    expect(engineScroll(1, move(-3), frame)).toBe(0)
  })

  test('a page key, the whole body, moves one page of the own window', () => {
    expect(engineScroll(10, move(40), frame)).toBe(42)
    expect(engineScroll(42, move(-40), frame)).toBe(10)
  })

  test('Home and End beyond the body go to the top and the end', () => {
    expect(engineScroll(50, move(-500), frame)).toBe(0)
    expect(engineScroll(50, move(500), frame)).toBe(168)
  })
})
