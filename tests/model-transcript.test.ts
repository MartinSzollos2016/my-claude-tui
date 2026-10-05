import { describe, expect, test } from 'claude-code/testing'
import { inlineRows, paneColumns, paneRows, resultLine, terminalWidth, turnTail } from '../hooks/model/transcript'
import { buildTurns } from '../hooks/model/turns'
import { main, prompt } from './fixtures/model'

describe('paneColumns', () => {
  test('asks for the share of the terminal, keeping room for the transcript', () => {
    expect(paneColumns(200, 60)).toBe(120)
    expect(paneColumns(200, 80)).toBe(160)
    expect(paneColumns(200, 95)).toBe(160)
    expect(paneColumns(120, 30)).toBe(40)
    expect(paneColumns(70, 60)).toBe(undefined)
  })
})

describe('terminalWidth', () => {
  test('adds a docked pane to the transcript column its drawing reports', () => {
    expect(terminalWidth(164, 'dock', 89)).toBe(254)
    expect(terminalWidth(90, 'inline', 86)).toBe(90)
  })
})

describe('paneRows', () => {
  test('asks for half the terminal inline, never under a usable minimum', () => {
    expect(paneRows(50)).toBe(25)
    expect(paneRows(41)).toBe(20)
    expect(paneRows(16)).toBe(12)
  })
})

describe('inlineRows', () => {
  // The inline block is as tall as the tree drawn, up to what it asked for
  // and what the layout spares: drawing only the rows it reports would keep
  // a first empty drawing empty.
  test('draws the rows asked for until the engine reports a window, then the window', () => {
    expect(inlineRows(0, 25)).toBe(25)
    expect(inlineRows(14, 25)).toBe(14)
    expect(inlineRows(25, 25)).toBe(25)
    expect(inlineRows(30, 25)).toBe(30)
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

describe('turnTail', () => {
  const turn = buildTurns(main)[0]!
  test('counts, then the duration when a stat is known', () => {
    expect(turnTail(turn)).toBe('3 tools · 1 agent')
    expect(turnTail(turn, { durationMs: 65_000 })).toBe('3 tools · 1 agent · 1m 5s')
    expect(turnTail(buildTurns([prompt('hi')])[0]!, { durationMs: 2_000 })).toBe('reply · 2.0s')
  })
})
