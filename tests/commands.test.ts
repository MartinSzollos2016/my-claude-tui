import { describe, expect, test } from 'claude-code/testing'
import { helpText, parseCommand, unknownText } from '../hooks/commands'
import { ICON_SETS } from '../hooks/icons'

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

describe('helpText legend', () => {
  test('explains the header glyphs in the set it is given', () => {
    for (const icons of [ICON_SETS.nerd, ICON_SETS.unicode, ICON_SETS.ascii]) {
      const help = helpText(icons)
      expect(help).toContain(`${icons.wrench} tool calls`)
      expect(help).toContain(`${icons.output} outputs`)
      expect(help).toContain(`${icons.thinking} thinking blocks`)
      expect(help).toContain(`${icons.token} tokens`)
      expect(help).toContain(`${icons.clock} duration`)
    }
  })
})

describe('help legend and focus', () => {
  test('the legend names everything the header draws', () => {
    for (const icons of [ICON_SETS.nerd, ICON_SETS.unicode, ICON_SETS.ascii]) {
      const help = helpText(icons)
      for (const part of [
        `${icons.wrench} tool calls`,
        `${icons.output} outputs`,
        `${icons.thinking} thinking blocks`,
        `${icons.robot} a subagent`,
        `${icons.token} tokens`,
        'context use',
        `${icons.clock} duration`,
        'end time',
      ])
        expect(help, part).toContain(part)
    }
  })

  test('help says how the pane gets the keys', () => {
    expect(helpText()).toMatch(/ctrl\+x tab or a click gives the pane the keys/)
  })

  test('the legend in the ascii set is ASCII', () => {
    const legend = helpText(ICON_SETS.ascii)
      .split('\n')
      .filter(line => line.startsWith('The header') || line.startsWith('at the right'))
    expect(legend).toHaveLength(2)
    expect(legend.join('')).toMatch(/^[\x20-\x7e]+$/)
  })
})

describe('command descriptions', () => {
  test('/tail-status names all three things it switches, /tail-width that it shows the width alone', () => {
    const help = helpText()
    expect(help).toMatch(
      /\/tail-status \[on\|off\]\s+Status line under the prompt \(off by default\), spinner text and turn counts/,
    )
    expect(help).toMatch(/\/tail-width \[30-80\]\s+Show or set/)
  })
})

describe('help on Esc', () => {
  test('says Esc leaves the search field first, then gives the keys back', () => {
    const help = helpText()
    expect(help).not.toContain('Esc returns to the prompt')
    expect(help).toMatch(/Esc leaves the search field, then gives the keys back to the prompt/)
  })
})
