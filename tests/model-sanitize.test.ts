import { describe, expect, test } from 'claude-code/testing'
import {
  handBackSenders,
  isHandBack,
  promptDigest,
  promptKey,
  sanitizePrompt,
  sanitizeText,
  statPrompt,
} from '../hooks/model/sanitize'

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

  test('a block quoted inside a report adds no sender', () => {
    const report = `<agent-message from="a1">\nThe fixture reads <agent-message from="zz">x</agent-message> as before.\n</agent-message>`
    expect(handBackSenders(`Another Claude session sent a message:\n${report}`)).toEqual(['a1'])
    expect(handBackSenders(`${report}\n${block('b2')}`)).toEqual(['a1', 'b2'])
  })

  test('blocks quoted inside a report add no sender, however many', () => {
    const quotes = `<agent-message from="a1">quotes <agent-message from="zz">x</agent-message> and <agent-message from="yy">x</agent-message> end</agent-message>`
    expect(handBackSenders(quotes)).toEqual(['a1'])
    expect(handBackSenders(`${quotes}\n${block('b2')}`)).toEqual(['a1', 'b2'])
  })

  test('the scan follows tags, not meaning: an unclosed block holds the rest, a stray end closes it', () => {
    expect(handBackSenders(`<agent-message from="a1">report ${block('b2')}`)).toEqual(['a1'])
    expect(
      handBackSenders(`<agent-message from="a1">see </agent-message> then ${block('zz')} end</agent-message>`),
    ).toEqual(['a1', 'zz'])
  })

  test('only a whole open tag opens a block: quoted code and longer tag names do not', () => {
    const report = `<agent-message from="a1">const HAND_BACK = '<agent-message'; /<agent-message/; <agent-messages from="q"> <agent-message-x></agent-message>`
    expect(handBackSenders(`${report}\n${block('b2')}`)).toEqual(['a1', 'b2'])
  })

  test('an end tag inside the quotes of from ends nothing', () => {
    const odd = `<agent-message from="a1</agent-message>">quotes ${block('zz')} end</agent-message>`
    expect(handBackSenders(odd)).toEqual(['a1</agent-message>'])
  })

  test('a stray end tag before the first block does not lift the blocks it holds', () => {
    expect(
      handBackSenders(
        `</agent-message><agent-message from="A">x <agent-message from="B">y</agent-message></agent-message>`,
      ),
    ).toEqual(['A'])
  })

  test('from is the open tag own attribute named from, nothing else', () => {
    expect(handBackSenders('<agent-message to=" from=" from="b">x</agent-message>')).toEqual(['b'])
    expect(handBackSenders('<agent-message data-from="q" from="a1">x</agent-message>')).toEqual(['a1'])
    expect(handBackSenders('<agent-message>the body says from="X"</agent-message>')).toEqual([])
    expect(handBackSenders('<agent-message from="a" from="b">x</agent-message>')).toEqual(['a'])
  })

  test('an open tag takes attributes around from, new lines and a space before >, up to the limits', () => {
    expect(handBackSenders('<agent-message to="me"\n  from="a1" ts="2026" >\nx</agent-message>')).toEqual(['a1'])
    const nine = Array.from({ length: 8 }, (_, i) => ` a${i}="v"`).join('')
    expect(handBackSenders(`<agent-message from="a1"${nine}>x</agent-message>`)).toEqual([])
    expect(handBackSenders(`<agent-message from="${'x'.repeat(201)}">x</agent-message>`)).toEqual([])
    expect(handBackSenders(`<agent-message from="${'x'.repeat(200)}">x</agent-message>`)).toEqual(['x'.repeat(200)])
  })

  test('a block inside a reminder is not a sender', () => {
    expect(handBackSenders(`<system-reminder>${block('r1')}</system-reminder>\n${block('a1')}`)).toEqual(['a1'])
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

describe('isHandBack', () => {
  test('a text with an agent-message tag is a hand-back, and its stat key says so', () => {
    expect(isHandBack('Another Claude session sent a message:\n<agent-message from="a1">x</agent-message>')).toBe(true)
    expect(isHandBack('plain prompt')).toBe(false)
    expect(statPrompt('<agent-message from="a1">x</agent-message>')).toBe(
      promptDigest(promptKey({ prompt: 'shown name', senders: ['a1'] })),
    )
    expect(statPrompt('plain prompt')).toBe(promptDigest('plain prompt'))
  })
})

describe('promptDigest', () => {
  test('promptDigest is stable, short and holds no prompt text', () => {
    expect(promptDigest('Fix the login bug')).toBe(promptDigest('Fix the login bug'))
    expect(promptDigest('Fix the login bug')).toMatch(/^[0-9a-z]{1,11}$/)
    expect(promptDigest('Fix the login bug')).not.toContain('login')
    expect(promptDigest('a')).not.toBe(promptDigest('b'))
    expect(promptDigest('')).toBe('')
    expect(statPrompt('Fix it')).toBe(promptDigest('Fix it'))
  })
})
