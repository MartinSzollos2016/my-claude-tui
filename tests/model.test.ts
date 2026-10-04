import type { SessionMessage } from 'claude-code'
import { describe, expect, test } from 'claude-code/testing'

import { GIT_STATUS_ARGV, parseGitStatus, statFor } from '../hooks/register'
import {
  buildTurns,
  chunkMarkdown,
  chunkText,
  clampText,
  formatDuration,
  formatTokens,
  itemName,
  itemSummary,
  sanitizePrompt,
  shortModel,
  toolSummary,
  traceItems,
} from '../hooks/model'

const prompt = (text: string): SessionMessage => ({ role: 'user', text, toolUses: [] })

const transcript: SessionMessage[] = [
  prompt('Fix the bug'),
  {
    role: 'assistant',
    text: 'Looking.',
    toolUses: [
      { tool_use_id: 'r1', tool: 'Read', input: { file_path: '/a/b/c/main.go' }, text: 'package main' },
      { tool_use_id: 'a1', tool: 'Agent', input: { subagent_type: 'Explore', description: 'Find callers' }, agentId: 'agent-1', text: 'done', durationMs: 4200 },
    ],
  },
  { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 'r1', text: 'package main', isError: false, result: null } as never] },
  { role: 'assistant', text: 'Fixed.', toolUses: [{ tool_use_id: 'b1', tool: 'Bash', input: { command: 'go test ./...' } }] },
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
    expect(toolSummary('Edit', { file_path: '/x/z.go', old_string: 'a', new_string: 'b\nc' })).toBe('x/z.go - 1 -> 2 lines')
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
    expect(sanitizePrompt('<task-notification><summary>Agent done</summary></task-notification>')).toBe('Task notification: Agent done')
    expect(sanitizePrompt('hi<system-reminder>x</system-reminder>')).toBe('hi')
  })

  test('git status overrides repo-controlled command execution', () => {
    const argv = GIT_STATUS_ARGV.join(' ')
    expect(argv).toContain('-c core.fsmonitor=false')
    expect(argv).toContain('--no-optional-locks')
    expect(GIT_STATUS_ARGV.indexOf('-c')).toBeLessThan(GIT_STATUS_ARGV.indexOf('status'))
  })

  test('clampText caps by lines and by characters', () => {
    expect(clampText('a\nb', 5)).toEqual({ text: 'a\nb' })
    expect(clampText('a\nb\nc', 2)).toEqual({ text: 'a\nb', note: '… (1 lines hidden)' })
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

  test('parseGitStatus', () => {
    expect(parseGitStatus('## main...origin/main\n')).toEqual({ branch: 'main', isDirty: false })
    expect(parseGitStatus('## feat\n M a.go\n')).toEqual({ branch: 'feat', isDirty: true })
    expect(parseGitStatus('fatal')).toBe(null)
  })

  test('statFor picks the latest stat for the turn prompt', () => {
    const turn = buildTurns(transcript)[1]!
    const stats = [
      { prompt: 'Thanks', durationMs: 1, endedAt: 0 },
      { prompt: 'Thanks', durationMs: 2, endedAt: 0 },
    ]
    expect(statFor(stats, turn)?.durationMs).toBe(2)
    expect(statFor(stats, undefined)).toBe(undefined)
  })
})
