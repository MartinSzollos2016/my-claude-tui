import { describe, expect, test } from 'claude-code/testing'
import { ICON_SETS } from '../hooks/icons'
import { chunkText, clampText, gitDirFrom, parseGitHead, sanitizePrompt } from '../hooks/model'
import {
  contextMeter,
  engineDuration,
  formatDuration,
  formatTokens,
  shortModel,
  treePrefix,
} from '../hooks/model/format'

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

describe('contextMeter', () => {
  test('fills round(percent/100*cells) cells within 0..cells', () => {
    const { nerd, ascii } = ICON_SETS
    expect(contextMeter(0, 10, nerd)).toBe('▱▱▱▱▱▱▱▱▱▱')
    expect(contextMeter(100, 10, nerd)).toBe('▰▰▰▰▰▰▰▰▰▰')
    expect(contextMeter(62, 10, nerd)).toBe('▰▰▰▰▰▰▱▱▱▱')
    expect(contextMeter(65, 10, nerd)).toBe('▰▰▰▰▰▰▰▱▱▱')
    expect(contextMeter(-5, 10, nerd)).toBe('▱▱▱▱▱▱▱▱▱▱')
    expect(contextMeter(250, 10, nerd)).toBe('▰▰▰▰▰▰▰▰▰▰')
    expect(contextMeter(50, 4, nerd)).toBe('▰▰▱▱')
    expect(contextMeter(62, 10, ICON_SETS.unicode)).toBe('▰▰▰▰▰▰▱▱▱▱')
    expect(contextMeter(62, 10, ascii)).toBe('######----')
  })
})

describe('treePrefix', () => {
  const { nerd, ascii } = ICON_SETS
  test('the last item closes the branch, the others continue it', () => {
    expect(treePrefix([], false, nerd)).toBe('├─ ')
    expect(treePrefix([], true, nerd)).toBe('└─ ')
  })

  test('deeper levels draw a guide where the parent continues and blanks where it ended', () => {
    expect(treePrefix([true], false, nerd)).toBe('│  ├─ ')
    expect(treePrefix([true], true, nerd)).toBe('│  └─ ')
    expect(treePrefix([false], true, nerd)).toBe('   └─ ')
    expect(treePrefix([true, false], false, nerd)).toBe('│     ├─ ')
  })

  test('the ascii set draws only ASCII', () => {
    expect(treePrefix([], false, ascii)).toBe('|- ')
    expect(treePrefix([], true, ascii)).toBe('`- ')
    expect(treePrefix([true], true, ascii)).toBe('|  `- ')
    expect(treePrefix([true, true], false, ascii)).toMatch(/^[\x20-\x7e]*$/)
  })
})

describe('engineDuration', () => {
  test('is whole seconds, then minutes and seconds, as the engine words its line', () => {
    expect(engineDuration(0)).toBe('0s')
    expect(engineDuration(2_600)).toBe('3s')
    expect(engineDuration(59_400)).toBe('59s')
    expect(engineDuration(64_000)).toBe('1m 4s')
  })
})
