import { describe, expect, test } from 'claude-code/testing'
import { handBackSenders, sanitizePrompt, sanitizeText } from '../hooks/model/sanitize'

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

describe('sanitizeText', () => {
  test('clean text, tabs, newlines and non-ASCII come back as they are', () => {
    for (const clean of ['', 'plain', 'a\tb\nc', 'café 日本 😀 ├─ ']) expect(sanitizeText(clean)).toBe(clean)
  })

  test('drops escapes, controls and bidi marks, alone or mixed, call after call', () => {
    for (let round = 0; round < 2; round++) {
      expect(sanitizeText('a\u001b[31mred\u001b[0m')).toBe('ared')
      expect(sanitizeText('a\u001b]52;c;eA==\u0007b')).toBe('ab')
      expect(sanitizeText('a\rb\u0000c\u007fd\u009be')).toBe('abcde')
      expect(sanitizeText('if\u202e x \u2066y\u2069\u200f')).toBe('if x y')
      expect(sanitizeText('\u001b[1m\u202ex\r')).toBe('x')
      expect(sanitizeText('clean')).toBe('clean')
    }
  })
})

describe('handBackSenders', () => {
  const block = (from: string) => `<agent-message from="${from}">\n[Subagent hand-back] report</agent-message>`

  test('handBackSenders reads the from of each agent-message block at the start', () => {
    expect(handBackSenders(`Another Claude session sent a message:\n${block('af14c17612eabac64')}`)).toEqual([
      'af14c17612eabac64',
    ])
    expect(handBackSenders(`sent while you were working:\n${block('a1')}\n${block('b2')}`)).toEqual(['a1', 'b2'])
    expect(handBackSenders(`${block('a1')}\n${block('a1')}`)).toEqual(['a1'])
    expect(handBackSenders('plain text')).toEqual([])
    expect(handBackSenders(block('a\u001b[31m1'))).toEqual(['a1'])
  })

  test('handBackSenders finds the second block after a long report', () => {
    const report = (from: string) => `<agent-message from="${from}">\n${'report line\n'.repeat(200)}</agent-message>`
    expect(handBackSenders(`sent while you were working:\n${report('a1')}\n${report('b2')}`)).toEqual(['a1', 'b2'])
  })

  test('a long reminder before the block does not hide its sender', () => {
    const reminder = `<system-reminder>${'r'.repeat(600)}</system-reminder>\n`
    expect(handBackSenders(`${reminder}Another Claude session sent a message:\n${block('a1')}`)).toEqual(['a1'])
  })

  test('handBackSenders names at most eight senders, in linear time', () => {
    const long = Array.from({ length: 10_000 }, (_, i) => block(`x${i}`)).join('') + 'y'.repeat(1_000_000)
    const started = performance.now()
    expect(handBackSenders(long)).toEqual(['x0', 'x1', 'x2', 'x3', 'x4', 'x5', 'x6', 'x7'])
    expect(performance.now() - started).toBeLessThan(50)
  })
})
