import { describe, expect, test } from 'claude-code/testing'
import { ICON_SETS } from '../hooks/icons'
import { compactCall } from '../hooks/model'
import { clampText } from '../hooks/model/clamp'
import { searchTurns, splitMatch } from '../hooks/model/search'
import { toolSections } from '../hooks/model/sections'
import { toolSummary } from '../hooks/model/summaries'
import { taskMark } from '../hooks/model/team'
import { turnTail } from '../hooks/model/transcript'
import { buildTurns } from '../hooks/model/turns'
import type { ToolItem } from '../hooks/model/types'
import {
  displayWidth,
  durationBar,
  fitPath,
  padEndDisplay,
  truncate,
  truncateDisplay,
  truncateMiddle,
} from '../hooks/model/width'
import { transcript } from './fixtures/model'

describe('truncateMiddle', () => {
  test('keeps both ends and favours the end, the file name', () => {
    expect(truncateMiddle('src/a/b/auth/session.ts', 16)).toBe('src/a…session.ts')
    expect(truncateMiddle('src/session.ts', 20)).toBe('src/session.ts')
    expect(truncateMiddle('abcdefghij', 5)).toBe('a…hij')
    expect(truncateMiddle('abcdef', 1)).toBe('…')
    expect(truncateMiddle('abcdef', 0)).toBe('')
    expect(truncateMiddle('a\nb\ncdefgh', 6)).toBe('a…efgh')
  })

  test('counts cells and never splits a surrogate pair', () => {
    const out = truncateMiddle('😀'.repeat(10) + 'end', 11)
    expect(displayWidth(out)).toBeLessThanOrEqual(11)
    expect(out).toBe('😀…😀😀end')
    expect(out).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/)
  })
})

describe('fitPath', () => {
  const item = (tool: string, input: Record<string, unknown>): ToolItem => ({
    kind: 'tool',
    id: 'x',
    tool,
    input,
    summary: toolSummary(tool, input),
    isError: false,
    isPending: false,
  })
  const file = '/home/dev/project/src/server/auth/session.ts'

  test('a path summary is cut in the middle and keeps the file name', () => {
    const read = item('Read', { file_path: file })
    const fitted = fitPath(read, read.summary, 28)
    expect([...fitted].length).toBeLessThanOrEqual(28)
    expect(fitted).toContain('…')
    expect(fitted.endsWith('auth/session.ts')).toBe(true)
  })

  test('room to spare shows more of the path, and the rest of the summary stays', () => {
    const read = item('Read', { file_path: file, offset: 3, limit: 7 })
    expect(fitPath(read, read.summary, 80)).toBe('dev/project/src/server/auth/session.ts - lines 3-9')
    const tight = fitPath(read, read.summary, 36)
    expect(tight.endsWith(' - lines 3-9')).toBe(true)
    expect([...tight].length).toBeLessThanOrEqual(36)
    expect(tight).toContain('…')
  })

  test('covers Write, Edit, NotebookEdit and Grep/Glob with a path', () => {
    for (const [tool, input] of [
      ['Write', { file_path: file, content: 'x' }],
      ['Edit', { file_path: file, old_string: 'a', new_string: 'b' }],
      ['NotebookEdit', { notebook_path: file, edit_mode: 'insert' }],
      ['Grep', { pattern: 'x', path: file }],
      ['Glob', { pattern: 'x', path: file }],
    ] as const) {
      const it = item(tool, input)
      const fitted = fitPath(it, it.summary, 30)
      expect(fitted, tool).toContain('…')
      expect([...fitted].length, tool).toBeLessThanOrEqual(30)
    }
  })

  test('other text is still cut at the end', () => {
    const bash = item('Bash', { command: 'x'.repeat(100) })
    expect(fitPath(bash, bash.summary, 10)).toBe('xxxxxxxxx…')
    const grep = item('Grep', { pattern: 'x' })
    expect(fitPath(grep, grep.summary, 30)).toBe('"x"')
  })
})

describe('a custom ellipsis (the ascii set)', () => {
  test('truncate and truncateMiddle count the width of the ellipsis', () => {
    expect(truncate('abcdefghij', 6, '...')).toBe('abc...')
    expect(truncate('abcdef', 6, '...')).toBe('abcdef')
    expect(truncate('abcdefghij', 2, '...')).toBe('ab')
    expect(truncateMiddle('abcdefghij', 7, '...')).toBe('a...hij')
    expect(truncateMiddle('abcdefghij', 2, '...')).toBe('..')
    expect(displayWidth(truncateMiddle('😀'.repeat(20), 9, '...'))).toBeLessThanOrEqual(9)
  })

  test('clampText, searchTurns and splitMatch use it', () => {
    expect(clampText('a\nb\nc', 2, 100, '...').note).toBe('... (1 line hidden)')
    expect(clampText('x'.repeat(10), 5, 4, '...').note).toBe('... (6 chars hidden)')
    const long = `${'a'.repeat(60)} needle ${'b'.repeat(60)}`
    const turns = buildTurns([
      { role: 'user', text: long, toolUses: [] },
      { role: 'assistant', text: 'ok', toolUses: [] },
    ])
    const [hit] = searchTurns(turns, 'needle', '...')
    expect(hit!.snippet.startsWith('...')).toBe(true)
    expect(hit!.snippet.endsWith('...')).toBe(true)
    expect(hit!.snippet).not.toContain('…')
    expect(splitMatch(hit!.snippet, 'needle', '...').match).toBe('needle')
    // A query of dots finds no hit in the ellipsis itself.
    expect(splitMatch('...abc', '.', '...')).toEqual({ before: '...abc', match: '', after: '' })
  })

  test('task marks follow the set', () => {
    const marks = { taskDone: '[x]', taskActive: '[~]', taskTodo: '[ ]' }
    expect(taskMark('completed', marks)).toBe('[x]')
    expect(taskMark('in_progress', marks)).toBe('[~]')
    expect(taskMark('pending', marks)).toBe('[ ]')
  })

  test('compactCall, turnTail and toolSections take their glyphs from the set', () => {
    const glyphs = { ellipsis: '...', dot: '.', taskDone: '[x]', taskActive: '[~]', taskTodo: '[ ]' }
    expect(compactCall('Bash', { command: 'x'.repeat(100) }, '...').summary).toBe(`${'x'.repeat(77)}...`)
    expect(turnTail(buildTurns(transcript)[0]!, { durationMs: 2000 }, '.')).toContain(' . ')
    const todo: ToolItem = {
      kind: 'tool',
      id: 't',
      tool: 'TodoWrite',
      input: {
        todos: [
          { content: 'a', status: 'completed' },
          { content: 'b', status: 'pending' },
        ],
      },
      summary: '',
      resultText: 'ok',
      isError: false,
      isPending: false,
    }
    const sections = toolSections(todo, glyphs)
    expect(sections[0]!.body).toBe('[x] a\n[ ] b')
    expect(sections[1]!.meta).toBe('ok . 1 line')
  })
})

describe('display width of emoji forms', () => {
  test('flags, keycaps and emoji-presentation symbols take two cells', () => {
    expect(displayWidth('🇨🇿')).toBe(2)
    expect(displayWidth('1\ufe0f\u20e3')).toBe(2)
    expect(displayWidth('✅')).toBe(2)
    expect(displayWidth('🀄')).toBe(2)
    expect(displayWidth('⌚')).toBe(2)
    expect(displayWidth('⭐')).toBe(2)
    expect(displayWidth('✓')).toBe(1)
    expect(displayWidth('a\ufe0f')).toBe(2)
  })

  test('truncateDisplay cuts flags by their real width', () => {
    expect(truncateDisplay('a🇨🇿🇨🇿b', 4, '…')).toBe('a🇨🇿…')
    expect(displayWidth(truncateDisplay('a🇨🇿🇨🇿b', 4))).toBeLessThanOrEqual(4)
  })

  test('without Intl.Segmenter widths fall back to code points', () => {
    expect(displayWidth('plain ascii')).toBe(11)
  })
})

describe('display width', () => {
  test('displayWidth counts cells per grapheme', () => {
    expect(displayWidth('')).toBe(0)
    expect(displayWidth('abc')).toBe(3)
    expect(displayWidth('日本語')).toBe(6)
    expect(displayWidth('한글')).toBe(4)
    expect(displayWidth('ＡＢ')).toBe(4)
    expect(displayWidth('😀')).toBe(2)
    expect(displayWidth('👨\u200d👩\u200d👧')).toBe(2)
    expect(displayWidth('e\u0301')).toBe(1)
    expect(displayWidth('a\ufe0e')).toBe(1)
    expect(displayWidth('\u2764\ufe0f')).toBe(2)
    expect(displayWidth('\u{F0BE0}')).toBe(1)
    expect(displayWidth('\ue0b0')).toBe(1)
  })

  test('padEndDisplay pads to cells, never cuts', () => {
    expect(padEndDisplay('ab', 5)).toBe('ab   ')
    expect(padEndDisplay('日本', 6)).toBe('日本  ')
    expect(padEndDisplay('日本語', 4)).toBe('日本語')
  })

  test('truncateDisplay cuts to cells and keeps graphemes whole', () => {
    expect(truncateDisplay('hello', 10)).toBe('hello')
    expect(truncateDisplay('hello world', 8)).toBe('hello w…')
    expect(truncateDisplay('hello world', 8, '...')).toBe('hello...')
    expect(truncateDisplay('日本語日本語', 7)).toBe('日本語…')
    expect(displayWidth(truncateDisplay('日本語日本語', 6))).toBeLessThanOrEqual(6)
    expect(truncateDisplay('a\nb', 5)).toBe('a b')
    expect(truncateDisplay('abcdef', 1, '...')).toBe('a')
    expect(truncateDisplay('abc', 0)).toBe('')
    const family = '👨\u200d👩\u200d👧'
    expect(truncateDisplay(`${family}${family}${family}`, 5)).toBe(`${family}${family}…`)
    expect(truncateDisplay('e\u0301e\u0301e\u0301e\u0301', 3)).toBe('e\u0301e\u0301…')
  })

  test('truncateMiddle counts cells too', () => {
    expect(displayWidth(truncateMiddle('日本語日本語日本語日本語', 9))).toBeLessThanOrEqual(9)
  })
})

describe('durationBar', () => {
  const nerd = ICON_SETS.nerd
  test('nothing under one percent, nothing without a duration', () => {
    expect(durationBar(0, 1000, 8, nerd)).toBe('')
    expect(durationBar(5, 1000, 8, nerd)).toBe('')
    expect(durationBar(10, 0, 8, nerd)).toBe('')
    expect(durationBar(Number.NaN, 1000, 8, nerd)).toBe('')
  })

  test('the longest call fills every cell, shorter ones scale', () => {
    expect(durationBar(1000, 1000, 8, nerd)).toBe('████████')
    expect(durationBar(2000, 1000, 8, nerd)).toBe('████████')
    expect(durationBar(500, 1000, 8, nerd)).toBe('████')
  })

  test('the remainder is drawn in eighths of a block', () => {
    expect(durationBar(140, 8000, 8, nerd)).toBe('▏')
    expect(durationBar(4500, 8000, 8, nerd)).toBe('████▌')
    expect(durationBar(7 * 1000 + 875, 8000, 8, nerd)).toBe('███████▉')
    expect(durationBar(20, 1000, 8, nerd)).toBe('▏')
  })

  test('ascii draws = for whole cells and - for a part', () => {
    expect(durationBar(1000, 1000, 8, ICON_SETS.ascii)).toBe('========')
    expect(durationBar(4500, 8000, 8, ICON_SETS.ascii)).toBe('====-')
    expect(durationBar(4500, 8000, 8, ICON_SETS.ascii)).toMatch(/^[\x20-\x7e]*$/)
  })

  test('every set has eight steps and a times sign', () => {
    for (const set of Object.values(ICON_SETS)) {
      expect(set.bar).toHaveLength(8)
      expect(set.times).not.toBe('')
    }
    expect(ICON_SETS.ascii.times).toBe('x')
  })
})
