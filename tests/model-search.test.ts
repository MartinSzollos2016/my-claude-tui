import { describe, expect, test } from 'claude-code/testing'
import { searchTurns, splitMatch } from '../hooks/model/search'
import { buildTurns } from '../hooks/model/turns'
import { main, prompt } from './fixtures/model'

describe('splitMatch', () => {
  test('splits a snippet around the query, whatever the case', () => {
    expect(splitMatch('foo Bar baz', 'bar')).toEqual({ before: 'foo ', match: 'Bar', after: ' baz' })
    expect(splitMatch('foo Bar baz', '  BAR ')).toEqual({ before: 'foo ', match: 'Bar', after: ' baz' })
    expect(splitMatch('…tail Bar', 'bar')).toEqual({ before: '…tail ', match: 'Bar', after: '' })
  })

  test('no match, or no query, leaves the snippet whole', () => {
    expect(splitMatch('foo', 'zzz')).toEqual({ before: 'foo', match: '', after: '' })
    expect(splitMatch('foo', '  ')).toEqual({ before: 'foo', match: '', after: '' })
  })

  test('maps offsets like snippetAt: lowercase length changes and surrogate pairs', () => {
    // "İ" lowercases to two UTF-16 units, so offsets in the lowercased text drift.
    expect(splitMatch('İx', 'x')).toEqual({ before: 'İ', match: 'x', after: '' })
    expect(splitMatch('😀 Bar 😀', 'bar')).toEqual({ before: '😀 ', match: 'Bar', after: ' 😀' })
    expect(splitMatch('😀😀', '😀')).toEqual({ before: '', match: '😀', after: '😀' })
  })

  test('agrees with searchTurns: the snippet it made holds the match it finds', () => {
    const long = `${'a'.repeat(60)} needle ${'b'.repeat(60)}`
    const turns = buildTurns([
      { role: 'user', text: long, toolUses: [] },
      { role: 'assistant', text: 'ok', toolUses: [] },
    ])
    const [hit] = searchTurns(turns, 'NEEDLE')
    const split = splitMatch(hit!.snippet, 'NEEDLE')
    expect(split.match).toBe('needle')
    expect(split.before.startsWith('…')).toBe(true)
    expect(split.after.endsWith('…')).toBe(true)
  })
})

describe('searchTurns', () => {
  const turns = buildTurns([
    ...main,
    prompt('Now add TESTS'),
    { role: 'assistant', text: 'Added.', toolUses: [] },
    prompt('Explain (a+)+$[ please'),
    { role: 'assistant', text: 'It is a pattern.', toolUses: [] },
  ])

  test('finds prompts, outputs, summaries and results, ignoring case', () => {
    expect(searchTurns(turns, 'tests').map(m => m.index)).toEqual([1])
    expect(searchTurns(turns, 'PACKAGE MAIN').map(m => m.index)).toEqual([0])
    expect(searchTurns(turns, 'find callers').map(m => m.index)).toEqual([0])
    expect(searchTurns(turns, 'looking').map(m => m.index)).toEqual([0])
    expect(searchTurns(turns, 'nowhere')).toEqual([])
  })

  test('an empty query matches nothing, so the list shows every turn', () => {
    expect(searchTurns(turns, '')).toEqual([])
    expect(searchTurns(turns, '   ')).toEqual([])
  })

  test('matches regex-special characters literally', () => {
    expect(searchTurns(turns, '(a+)+$[').map(m => m.index)).toEqual([2])
    expect(searchTurns(turns, '.*')).toEqual([])
    expect(searchTurns(turns, 'a.*(b')).toEqual([])
    const literal = buildTurns([prompt('see a.*(b here')])
    expect(searchTurns(literal, 'a.*(b').map(m => m.index)).toEqual([0])
  })

  test('a snippet of at most 80 characters around the first hit', () => {
    const long = buildTurns([prompt(`${'a'.repeat(200)} needle ${'b'.repeat(200)}`)])
    const [match] = searchTurns(long, 'needle')
    expect(match!.snippet.length).toBeLessThanOrEqual(80)
    expect(match!.snippet).toContain('needle')
    expect(match!.snippet.startsWith('…')).toBe(true)
    expect(match!.snippet.endsWith('…')).toBe(true)
    expect(searchTurns(buildTurns([prompt('short\nline')]), 'line')[0]!.snippet).toBe('short line')
  })

  test('never splits a surrogate pair or loses the hit when lowercasing changes the length', () => {
    const lone = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/
    for (let pad = 0; pad < 16; pad++) {
      const dense = buildTurns([prompt(`${'😀'.repeat(60 + pad)}needle${'😀'.repeat(60 + pad)}`)])
      const snippet = searchTurns(dense, 'needle')[0]!.snippet
      expect(snippet).toContain('needle')
      expect(lone.test(snippet)).toBe(false)
    }
    const dotted = buildTurns([prompt(`${'İ'.repeat(100)}needle${'İ'.repeat(100)}`)])
    const [match] = searchTurns(dotted, 'needle')
    expect(match!.snippet).toContain('needle')
    expect(lone.test(match!.snippet)).toBe(false)
  })

  test('stays linear on a long input', () => {
    const big = buildTurns([prompt('x'), { role: 'assistant', text: 'a'.repeat(1_000_000), toolUses: [] }])
    const started = performance.now()
    expect(searchTurns(big, 'ab')).toEqual([])
    expect(searchTurns(big, 'a'.repeat(50) + 'b')).toEqual([])
    expect(performance.now() - started).toBeLessThan(500)
  })
})
