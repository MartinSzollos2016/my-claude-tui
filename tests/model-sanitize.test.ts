import { describe, expect, test } from 'claude-code/testing'
import { sanitizePrompt, sanitizeText } from '../hooks/model/sanitize'

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
