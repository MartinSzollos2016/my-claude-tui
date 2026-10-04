import { describe, expect, test } from 'claude-code/testing'
import { lineCount, num, str } from '../hooks/model/values'

describe('values read from untyped input', () => {
  test('str reads a string field and gives an empty string for anything else', () => {
    expect(str({ a: 'x' }, 'a')).toBe('x')
    expect(str({ a: 1 }, 'a')).toBe('')
    expect(str({}, 'a')).toBe('')
  })

  test('num reads a number field cut to an integer and gives 0 for anything else', () => {
    expect(num({ n: 2.9 }, 'n')).toBe(2)
    expect(num({ n: -2.9 }, 'n')).toBe(-2)
    expect(num({ n: '2' }, 'n')).toBe(0)
  })

  test('lineCount counts the lines of a text, an empty text being one', () => {
    expect(lineCount('a\nb')).toBe(2)
    expect(lineCount('')).toBe(1)
  })
})
