import { describe, expect, test } from 'claude-code/testing'

import { helpText } from '../hooks/commands'
import { compactCall, resultLine } from '../hooks/model'
import { clampText } from '../hooks/model/clamp'
import { formatClock, shortMode } from '../hooks/model/format'
import { itemName, itemSummary, toolCategory, toolSummary } from '../hooks/model/summaries'
import { traceStats } from '../hooks/model/turns'
import type { Item } from '../hooks/model/types'

const cases: [string, Record<string, unknown>, string][] = [
  ['Read', {}, 'Read'],
  ['Read', { file_path: '/a/b/c.go' }, 'b/c.go'],
  ['Write', {}, 'Write'],
  ['Write', { file_path: '/x/y.ts' }, 'x/y.ts'],
  ['Write', { file_path: '/x/y.ts', content: 'a\nb' }, 'x/y.ts - 2 lines'],
  ['Edit', {}, 'Edit'],
  ['Edit', { file_path: '/x/z.go' }, 'x/z.go'],
  ['Edit', { file_path: '/x/z.go', old_string: 'a', new_string: 'b' }, 'x/z.go - 1 line'],
  ['Edit', { file_path: '/x/z.go', old_string: 'a\nb', new_string: 'c\nd' }, 'x/z.go - 2 lines'],
  ['Bash', {}, 'Bash'],
  ['Bash', { description: 'List' }, 'List'],
  ['Bash', { command: 'ls' }, 'ls'],
  ['Grep', {}, 'Grep'],
  ['Grep', { pattern: 'foo' }, '"foo"'],
  ['Grep', { pattern: 'foo', glob: '*.go' }, '"foo" in *.go'],
  ['Glob', { pattern: '**/*.ts', path: '/src/app' }, '"**/*.ts" in app'],
  ['Glob', { pattern: 'x', glob: 'ignored' }, '"x"'],
  ['Agent', { subagent_type: 'Explore', description: 'Find' }, 'Explore - Find'],
  ['Agent', { description: 'Find' }, 'Find'],
  ['Skill', { skill: 'pdf' }, 'pdf'],
  ['Task', {}, 'Task'],
  ['Workflow', { name: 'review' }, 'review'],
  ['Workflow', { scriptPath: '/a/b/w.js' }, 'w.js'],
  ['Workflow', {}, 'inline script'],
  ['LSP', {}, 'LSP'],
  ['LSP', { operation: 'hover' }, 'hover'],
  ['LSP', { operation: 'hover', filePath: '/a/b.ts' }, 'hover - b.ts'],
  ['WebFetch', {}, 'WebFetch'],
  ['WebFetch', { url: 'not a url' }, 'not a url'],
  ['WebSearch', {}, 'WebSearch'],
  ['WebSearch', { query: 'bun test' }, '"bun test"'],
  ['TodoWrite', {}, 'TodoWrite'],
  ['TodoWrite', { todos: [1, 2] }, '2 items'],
  ['NotebookEdit', {}, 'NotebookEdit'],
  ['NotebookEdit', { notebook_path: '/n/a.ipynb' }, 'a.ipynb'],
  ['NotebookEdit', { notebook_path: '/n/a.ipynb', edit_mode: 'insert' }, 'insert - a.ipynb'],
  ['TaskCreate', {}, 'Create task'],
  ['TaskCreate', { subject: 'Ship it' }, 'Ship it'],
  ['TaskUpdate', {}, 'Update task'],
  ['TaskUpdate', { taskId: '3', status: 'done', owner: 'bob' }, '#3 done -> bob'],
  ['SendMessage', {}, 'Send message'],
  ['SendMessage', { type: 'shutdown_request', recipient: 'a' }, 'Shutdown a'],
  ['SendMessage', { type: 'shutdown_response' }, 'Shutdown response'],
  ['SendMessage', { type: 'broadcast', summary: 'hi' }, 'Broadcast: hi'],
  ['SendMessage', { recipient: 'a', summary: 'hi' }, 'To a: hi'],
  ['SendMessage', { to: 'b', message: 'yo' }, 'To b: yo'],
  ['ToolSearch', {}, 'ToolSearch'],
  ['ToolSearch', { query: 'select:Read' }, 'select:Read'],
  ['Custom', { path: '/p' }, '/p'],
  ['Custom', { zeta: 'z', alpha: 'a' }, 'a'],
  ['Custom', { n: 1 }, 'Custom'],
]

describe('toolSummary', () => {
  test('summarizes every built-in tool and falls back for the rest', () => {
    for (const [tool, input, summary] of cases)
      expect(`${tool}: ${toolSummary(tool, input)}`).toBe(`${tool}: ${summary}`)
  })
})

const tool = (name: string, input: Record<string, unknown> = {}): Item => ({
  kind: 'tool',
  id: 't',
  tool: name,
  input,
  summary: toolSummary(name, input),
  isError: false,
  isPending: false,
})

describe('row naming', () => {
  test('toolCategory groups tools by what they do', () => {
    const expected = {
      Read: 'read',
      Edit: 'edit',
      Write: 'edit',
      NotebookEdit: 'edit',
      Grep: 'search',
      Glob: 'search',
      Agent: 'task',
      Skill: 'task',
      Workflow: 'task',
      WebFetch: 'web',
      WebSearch: 'web',
      Bash: 'other',
    }
    for (const [name, category] of Object.entries(expected)) expect(toolCategory(name)).toBe(category)
  })

  test('itemName and itemSummary', () => {
    expect(itemName({ kind: 'output', id: 'o', text: 'hi' })).toBe('Output')
    expect(itemName(tool('Agent', { subagent_type: 'Plan' }))).toBe('Plan')
    expect(itemName(tool('Agent'))).toBe('Subagent')
    expect(itemName(tool('mcp__srv__lookup'))).toBe('lookup')
    expect(itemSummary({ kind: 'output', id: 'o', text: 'x'.repeat(50) })).toHaveLength(40)
    expect(itemSummary(tool('Agent', { description: 'Look around' }))).toBe('Look around')
    expect(itemSummary(tool('Task'))).toBe('Task')
    expect(itemSummary(tool('Read'))).toBe('')
  })

  test('traceStats counts tool calls and messages', () => {
    expect(traceStats([tool('Read'), { kind: 'output', id: 'o', text: 'x' }, tool('Bash')])).toEqual({
      tools: 2,
      messages: 1,
    })
  })
})

describe('compactCall', () => {
  test('one line per tool call', () => {
    expect(compactCall('Bash', { command: 'go test ./...', description: 'Run tests' })).toEqual({
      name: 'Bash',
      summary: 'Run tests',
    })
    expect(compactCall('Bash', { command: 'make\nmake install' })).toEqual({ name: 'Bash', summary: 'make' })
    expect(compactCall('Agent', { subagent_type: 'Explore', description: 'Find callers' })).toEqual({
      name: 'Explore',
      summary: 'Find callers',
    })
    expect(compactCall('mcp__docs__search', { query: 'hooks' })).toEqual({ name: 'search', summary: 'hooks' })
    expect(compactCall('Read', null)).toEqual({ name: 'Read', summary: '' })
  })
})

describe('formatting edges', () => {
  test('shortMode and formatClock', () => {
    expect(shortMode('bypassPermissions')).toBe('bypass')
    expect(shortMode('acceptEdits')).toBe('accept edits')
    expect(shortMode('default')).toBe('')
    expect(shortMode('plan')).toBe('plan')
    expect(formatClock(new Date(2026, 0, 1, 0, 5, 9).getTime())).toBe('12:05:09 AM')
    expect(formatClock(new Date(2026, 0, 1, 13, 0, 0).getTime())).toBe('1:00:00 PM')
  })

  test('clampText reports cut characters and lines together', () => {
    expect(clampText('ab\ncd\nef', 2, 1)).toEqual({ text: 'a', note: '… (4 chars hidden, 1 more line)' })
  })

  test('resultLine edge cases', () => {
    expect(resultLine({ stdout: 'out', stderr: 'err' }, false)).toBe('2 lines')
    expect(resultLine({ count: 3 }, false)).toBe('done')
    expect(resultLine(null, true)).toBe('error: ')
  })

  test('helpText lists every command', () => {
    const help = helpText()
    for (const name of [
      '/tail ',
      '/tail-turns',
      '/tail-width',
      '/tail-compact',
      '/tail-bar',
      '/tail-status',
      '/tail-help',
    ]) {
      expect(help).toContain(name)
    }
  })

  test('helpText names the page keys of the pane', () => {
    expect(helpText()).toContain('f/b page the pane down/up')
  })
})
