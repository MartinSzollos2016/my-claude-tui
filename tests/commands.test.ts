import { describe, expect, test } from 'claude-code/testing'
import { helpText, parseCommand, unknownText } from '../hooks/commands'

describe('parseCommand', () => {
  test('routes subcommands and their /tail shorthand alike', () => {
    expect(parseCommand('tail', '')).toEqual({ sub: 'open', arg: '' })
    expect(parseCommand('tail', 'width 70')).toEqual({ sub: 'width', arg: '70' })
    expect(parseCommand('tail-width', ' 70 ')).toEqual({ sub: 'width', arg: '70' })
    expect(parseCommand('tail', 'help')).toEqual({ sub: 'help', arg: '' })
    expect(parseCommand('tail', 'nonsense')).toEqual({ sub: 'unknown', arg: 'nonsense' })
    expect(parseCommand('tail', '  ')).toEqual({ sub: 'open', arg: '' })
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

describe('helpText', () => {
  test('names both view keys of the pane: t for the turn list, d for the detail view', () => {
    expect(helpText()).toMatch(/\bt turn list\b/)
    expect(helpText()).toMatch(/\bd detail view\b/)
  })
})

describe('helpText keys', () => {
  test('help names h for the full key map', () => {
    expect(helpText()).toMatch(/\bh shows or hides all keys\b/)
  })
})

describe('unknownText', () => {
  test('names the word it did not know and lists the valid subcommands', () => {
    const answer = unknownText('foo')
    expect(answer).toContain('"foo"')
    for (const sub of ['turns', 'bar', 'compact', 'icons', 'width', 'status', 'notify', 'help'])
      expect(answer).toContain(sub)
  })
})
