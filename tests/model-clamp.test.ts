import { describe, expect, test } from 'claude-code/testing'
import { chunkText, clampText } from '../hooks/model/clamp'

describe('clampText', () => {
  test('keeps a text within its caps whole, without a note', () => {
    expect(clampText('ok', 5, 5)).toEqual({ text: 'ok' })
  })

  test('cuts the lines over the cap and says how many', () => {
    expect(clampText('a\nb\nc', 2, 100)).toEqual({ text: 'a\nb', note: '… (1 line hidden)' })
  })

  test('cuts the characters over the cap, naming the lines cut too', () => {
    expect(clampText('abcdef', 5, 3)).toEqual({ text: 'abc', note: '… (3 chars hidden)' })
    expect(clampText('a\nb\nc', 2, 2, '...')).toEqual({ text: 'a\n', note: '... (1 chars hidden, 1 more line)' })
  })
})

describe('chunkText', () => {
  test('cuts at a newline in the second half of a piece', () => {
    expect(chunkText('aaaa\nbbbb', 6)).toEqual(['aaaa', 'bbbb'])
  })

  test('cuts at the size where no newline falls late enough', () => {
    expect(chunkText('abcdefgh', 3)).toEqual(['abc', 'def', 'gh'])
  })
})
