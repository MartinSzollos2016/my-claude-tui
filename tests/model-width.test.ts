import { describe, expect, test } from 'claude-code/testing'
import { ICON_SETS } from '../hooks/icons'
import { compactCall } from '../hooks/model/activity'
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
  expandTabs,
  fitPath,
  graphemesOf,
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

  test('without Intl.Segmenter graphemes fall back to code points, never halving a surrogate pair', () => {
    expect(graphemesOf('e\u0301😀🇨🇿')).toEqual(['e\u0301', '😀', '🇨🇿'])
    expect(graphemesOf('e\u0301😀🇨🇿', null)).toEqual(['e', '\u0301', '😀', '🇨', '🇿'])
    expect(graphemesOf('', null)).toEqual([])
  })
})

describe('display width beyond ASCII', () => {
  test('Latin-1 and Latin Extended letters take one cell each', () => {
    expect(displayWidth('café')).toBe(4)
    expect(displayWidth('naïve résumé')).toBe(12)
    expect(displayWidth('\u00a0©®±·')).toBe(5)
    expect(displayWidth('Āžʼ˿')).toBe(4)
  })

  test('a soft hyphen draws nothing', () => {
    expect(displayWidth('a\u00adb')).toBe(2)
    expect(displayWidth('\u00ad')).toBe(0)
    expect(truncateDisplay('ab\u00adcdef', 4)).toBe('ab\u00adc…')
  })

  test('combining marks join the letter before them', () => {
    expect(displayWidth('é\u0300')).toBe(1)
    expect(displayWidth('cafe\u0301 ok')).toBe(7)
    expect(truncateDisplay('e\u0301e\u0301e\u0301e\u0301', 3)).toBe('e\u0301e\u0301…')
  })

  test('punctuation, arrows, box drawing, blocks and Nerd icons take one cell', () => {
    expect(displayWidth('…—•→')).toBe(4)
    expect(displayWidth('├──│└')).toBe(5)
    expect(displayWidth('█▌░')).toBe(3)
    expect(displayWidth('\ue0b0\uf8ff\ue000')).toBe(3)
    expect(truncateDisplay('├── tree │ box', 6)).toBe('├── t…')
    expect(truncateMiddle('├── a/b/c/file.ts', 10)).toBe('├──…ile.ts')
  })

  test('a variation selector still makes a narrow symbol an emoji', () => {
    expect(displayWidth('│\ufe0f')).toBe(2)
    expect(displayWidth('↔\ufe0f')).toBe(2)
    expect(displayWidth('é\ufe0f')).toBe(2)
  })

  test('surrogate pairs and wide text mixed with narrow non-ASCII', () => {
    expect(displayWidth('café 日本 😀')).toBe(12)
    expect(truncateDisplay('日本語abc', 5)).toBe('日本…')
    expect(truncateDisplay('é😀é😀é', 4)).toBe('é😀…')
    expect(truncateMiddle('é😀é😀é😀é😀', 6)).toBe('é…é😀')
  })

  test('truncateMiddle keeps the end in order and flags whole', () => {
    expect(truncateMiddle('abcdefgh🇨🇿🇨🇿', 7)).toBe('ab…🇨🇿🇨🇿')
    expect(truncateMiddle('abcdefgh🇨🇿x', 6)).toBe('a…h🇨🇿x')
    expect(truncateMiddle('abcdefgh🇨🇿🇨', 6)).toBe('a…🇨🇿🇨')
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

describe('expandTabs', () => {
  test('a tab runs to the next stop of 8 cells, per line', () => {
    expect(expandTabs('\tx')).toBe(`${' '.repeat(8)}x`)
    expect(expandTabs('ab\tc')).toBe(`ab${' '.repeat(6)}c`)
    expect(expandTabs('abcdefgh\ti')).toBe(`abcdefgh${' '.repeat(8)}i`)
    expect(expandTabs('a\t\tb')).toBe(`a${' '.repeat(15)}b`)
    expect(expandTabs('x\tb\nab\tc')).toBe(`x${' '.repeat(7)}b\nab${' '.repeat(6)}c`)
  })

  test('the text before a tab is measured in cells, a given size is kept', () => {
    // 日本 is four cells wide.
    expect(expandTabs('日本\tx')).toBe(`日本${' '.repeat(4)}x`)
    expect(expandTabs('ab\tc', 4)).toBe('ab  c')
  })

  test('the expanded text is as wide as the terminal draws it, with no tab left', () => {
    const out = expandTabs('id\tname\tstatus\n1\talpha\tok')
    expect(out.includes('\t')).toBe(false)
    expect(out.split('\n').map(displayWidth)).toEqual([16 + 6, 16 + 2])
  })

  test('a text without tabs is returned as it is', () => {
    const plain = 'no tabs\nhere'
    expect(expandTabs(plain)).toBe(plain)
    expect(expandTabs('')).toBe('')
  })
})

describe('fitPath and a quoted pattern', () => {
  test('a Grep pattern that names the path stays the pattern', () => {
    const input = { pattern: 'hooks', glob: '*.ts', path: '/repo/hooks' }
    const item: ToolItem = {
      kind: 'tool',
      id: 'g',
      tool: 'Grep',
      input,
      summary: toolSummary('Grep', input),
      isError: false,
      isPending: false,
    }
    expect(fitPath(item, item.summary, 80, '…')).toBe('"hooks" in *.ts')
  })
})

describe('wide characters the table missed', () => {
  test('the clock, hourglass, medium squares, angle brackets and vertical forms are two cells', () => {
    for (const ch of [
      '\u23f0',
      '\u23f3',
      '\u25fd',
      '\u25fe',
      '\u2329',
      '\u232a',
      '\ufe10',
      '\ufe19',
      '\ufe50',
      '\ufe6b',
    ])
      expect(displayWidth(ch), ch.codePointAt(0)!.toString(16)).toBe(2)
  })
})

describe('graphemes without the segmenter', () => {
  const throwing = {
    segment: () => {
      throw new Error('segmenter used')
    },
  } as unknown as Intl.Segmenter

  test('CJK, wide emoji and symbols split per code point, the segmenter untouched', () => {
    expect(graphemesOf('日本語 \u{1f600} ⏰ ｱ', throwing)).toEqual([
      '日',
      '本',
      '語',
      ' ',
      '\u{1f600}',
      ' ',
      '⏰',
      ' ',
      'ｱ',
    ])
  })

  test('graphemes match the segmenter on a mixed corpus', () => {
    const segmenter = new Intl.Segmenter()
    const corpus = [
      '日本語のコマンド \u{1f600} echo',
      'é café',
      '\u{1f468}‍\u{1f469}‍\u{1f467} family',
      '\u{1f1e8}\u{1f1ff} flag',
      '1️⃣ keycap',
      '\u{1f44d}\u{1f3fd} tone',
      '각 jamo',
      'a\r\nb',
      '❤️ heart',
      '\u{1f3f4}\u{e0067}\u{e0062}\u{e0073}\u{e0063}\u{e0074}\u{e007f} tag',
      'x​y zero width',
    ]
    for (const text of corpus) {
      const reference = Array.from(segmenter.segment(text), part => part.segment)
      expect(graphemesOf(text), JSON.stringify(text)).toEqual(reference)
    }
  })

  test('widths of the corpus stay as they were', () => {
    expect(displayWidth('日本語')).toBe(6)
    expect(displayWidth('\u{1f468}‍\u{1f469}‍\u{1f467}')).toBe(2)
    expect(displayWidth('\u{1f1e8}\u{1f1ff}')).toBe(2)
    expect(displayWidth('é')).toBe(1)
    expect(displayWidth('1️⃣')).toBe(2)
    expect(truncateDisplay('日本語のコマンド', 7, '…')).toBe('日本語…')
  })
})
