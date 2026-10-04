import type { SessionMessage } from 'claude-code'
import { describe, expect, test } from 'claude-code/testing'

import { buildTurns, sanitizeText, sanitizeValue } from '../hooks/model'
import { C, contextColor, modeColor, modelColor, THEME_KEYS, toggleTailTheme } from '../hooks/theme'

const keys = new Set<string>(THEME_KEYS)

describe('theme', () => {
  test('every semantic role is a Claude Code theme key', () => {
    for (const value of Object.values(C)) expect(keys.has(value)).toBe(true)
  })

  test('model, context and mode colors are theme keys', () => {
    for (const model of ['opus5.5', 'sonnet5', 'haiku4.5', 'fable5.1']) {
      expect(keys.has(modelColor(model) ?? '')).toBe(true)
    }
    expect(modelColor('gpt')).toBe(undefined)
    expect(contextColor(10)).toBe('success')
    expect(contextColor(50)).toBe('warning')
    expect(contextColor(80)).toBe('error')
    for (const mode of ['plan', 'acceptEdits', 'bypassPermissions', 'auto']) {
      expect(keys.has(modeColor(mode) ?? '')).toBe(true)
    }
    expect(modeColor('default')).toBe(undefined)
    expect(modeColor(null)).toBe(undefined)
  })
})

describe('toggleTailTheme', () => {
  test('switches a built-in theme to its tail-view variant and back', () => {
    for (const base of ['dark', 'light', 'dark-daltonized', 'light-daltonized', 'dark-ansi', 'light-ansi']) {
      expect(toggleTailTheme(base)).toBe(`custom:tail-view:${base}`)
      expect(toggleTailTheme(`custom:tail-view:${base}`)).toBe(base)
    }
  })

  test('leaves auto and other custom themes to /theme', () => {
    expect(toggleTailTheme('auto')).toBe(undefined)
    expect(toggleTailTheme('custom:mine')).toBe(undefined)
    expect(toggleTailTheme('custom:tail-view:unknown')).toBe(undefined)
  })
})

describe('sanitizeText', () => {
  test('strips CSI, OSC and DCS escape sequences', () => {
    expect(sanitizeText('a\u001b[31mred\u001b[0m b')).toBe('ared b')
    expect(sanitizeText('x\u001b]52;c;ZXZpbA==\u0007y')).toBe('xy')
    expect(sanitizeText('x\u001b]8;;https://evil\u001b\\link\u001b]8;;\u001b\\y')).toBe('xlinky')
    expect(sanitizeText('x\u001bPpayload\u001b\\y')).toBe('xy')
    expect(sanitizeText('x\u001b]0;unterminated title')).toBe('x')
  })

  test('strips controls but keeps tabs and newlines', () => {
    expect(sanitizeText('a\tb\nc\rd\u0000e\u0007f\u007fg\u009bh')).toBe('a\tb\ncdefgh')
  })

  test('strips bidi overrides (Trojan Source)', () => {
    expect(sanitizeText('if (a‮) {} ⁦b⁩')).toBe('if (a) {} b')
  })

  test('leaves ordinary text and Unicode alone', () => {
    const text = 'Příliš žluťoučký kůň · 日本語 · emoji 🚀 · \u{F167A}'
    expect(sanitizeText(text)).toBe(text)
  })

  test('sanitizes nested input values and caps depth', () => {
    expect(sanitizeValue({ cmd: 'ls\u001b[2J', list: ['‮x'], n: 1, ok: true, none: null })).toEqual({
      cmd: 'ls',
      list: ['x'],
      n: 1,
      ok: true,
      none: null,
    })
    let deep: unknown = 'leaf'
    for (let i = 0; i < 100; i++) deep = { d: deep }
    expect(JSON.stringify(sanitizeValue(deep))).toContain('"…"')
  })

  test('buildTurns sanitizes prompts, outputs, inputs and results', () => {
    const messages: SessionMessage[] = [
      { role: 'user', text: 'go\u001b[2J', toolUses: [] },
      {
        role: 'assistant',
        text: 'out\u001b]52;c;eA==\u0007',
        toolUses: [{ tool_use_id: 't1', tool: 'Bash', input: { command: 'cat x\u001b[1A' }, text: 'res\u001b[31m' }],
      },
    ]
    const turn = buildTurns(messages)[0]!
    expect(turn.prompt).toBe('go')
    const [output, tool] = turn.items
    expect(output?.kind === 'output' && output.text).toBe('out')
    expect(tool?.kind === 'tool' && tool.input['command']).toBe('cat x')
    expect(tool?.kind === 'tool' && tool.summary).toBe('cat x')
    expect(tool?.kind === 'tool' && tool.resultText).toBe('res')
  })
})
