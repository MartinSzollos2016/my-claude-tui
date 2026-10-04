import { describe, expect, test } from 'claude-code/testing'
import { clampDiff, splitDiff, unifiedDiff } from '../hooks/model/diff'

describe('unifiedDiff', () => {
  const lines = (n: number, from = 1) => Array.from({ length: n }, (_, i) => `l${i + from}`).join('\n')

  test('a replacement is one hunk with its header', () => {
    expect(unifiedDiff('a', 'b')).toBe('@@ -1,1 +1,1 @@\n-a\n+b')
  })

  test('an insertion and a deletion keep their context', () => {
    expect(unifiedDiff('a\nc', 'a\nb\nc')).toBe('@@ -1,2 +1,3 @@\n a\n+b\n c')
    expect(unifiedDiff('a\nb\nc', 'a\nc')).toBe('@@ -1,3 +1,2 @@\n a\n-b\n c')
  })

  test('context is at most three lines around a change, and far changes get their own hunks', () => {
    const before = lines(20)
    const after = before.replace('l2\n', 'L2\n').replace('l19', 'L19')
    const diff = unifiedDiff(before, after, { context: 3 })
    expect(diff).toBe(
      [
        '@@ -1,5 +1,5 @@',
        ' l1',
        '-l2',
        '+L2',
        ' l3',
        ' l4',
        ' l5',
        '@@ -16,5 +16,5 @@',
        ' l16',
        ' l17',
        ' l18',
        '-l19',
        '+L19',
        ' l20',
      ].join('\n'),
    )
  })

  test('changes closer than twice the context share a hunk', () => {
    const before = lines(10)
    const after = before.replace('l2\n', 'L2\n').replace('l8', 'L8')
    expect(unifiedDiff(before, after)?.match(/^@@/gm)).toHaveLength(1)
  })

  test('numbers start at startLine, and a pure insertion counts from the line before', () => {
    expect(unifiedDiff('a', 'b', { startLine: 40 })).toBe('@@ -40,1 +40,1 @@\n-a\n+b')
    expect(unifiedDiff('', 'x\ny')).toBe('@@ -0,0 +1,2 @@\n+x\n+y')
    expect(unifiedDiff('x', '')).toBe('@@ -1,1 +0,0 @@\n-x')
  })

  test('equal texts have no diff, and a side over 2000 lines is not diffed', () => {
    expect(unifiedDiff('a\nb', 'a\nb')).toBe('')
    expect(unifiedDiff(lines(2001), 'x')).toBeNull()
    expect(unifiedDiff('x', lines(2001))).toBeNull()
    expect(unifiedDiff(lines(1999), `${lines(1999)}\nmore`)).toBe(
      '@@ -1997,3 +1997,4 @@\n l1997\n l1998\n l1999\n+more',
    )
  })

  test('the result parses back to the new text', () => {
    const before = 'one\ntwo\nthree\nfour\nfive\nsix'
    const after = 'one\n2\nthree\nfour\nfive\nsix\nseven'
    const diff = unifiedDiff(before, after)!
    const rebuilt = diff
      .split('\n')
      .filter(l => l[0] === ' ' || l[0] === '+')
      .map(l => l.slice(1))
      .join('\n')
    expect(rebuilt).toBe(after)
  })
})

describe('splitDiff and clampDiff', () => {
  const body = Array.from({ length: 10 }, (_, i) => `+n${i}`).join('\n')
  const diff = `@@ -0,0 +1,10 @@\n${body}`

  test('a diff that fits comes back whole', () => {
    expect(splitDiff(diff, 100, 1000)).toEqual([diff])
  })

  test('a cut hunk continues under a header that counts its own lines', () => {
    const pieces = splitDiff(diff, 6, 1000)
    expect(pieces).toEqual(['@@ -0,0 +1,5 @@\n+n0\n+n1\n+n2\n+n3\n+n4', '@@ -0,0 +6,5 @@\n+n5\n+n6\n+n7\n+n8\n+n9'])
  })

  test('context lines advance both numbers when a hunk is cut', () => {
    const pieces = splitDiff('@@ -5,4 +5,4 @@\n a\n-b\n+B\n c\n d', 4, 1000)
    expect(pieces).toEqual(['@@ -5,2 +5,2 @@\n a\n-b\n+B', '@@ -7,2 +7,2 @@\n c\n d'])
  })

  test('pieces stay under the character size', () => {
    const pieces = splitDiff(diff, Infinity, 40)
    expect(pieces.length).toBeGreaterThan(1)
    for (const piece of pieces) expect(piece.length).toBeLessThanOrEqual(40)
    expect(pieces.flatMap(p => p.split('\n').filter(l => l[0] === '+'))).toHaveLength(10)
  })

  test('a text that is no diff is returned as one piece', () => {
    expect(splitDiff('not a diff', 2, 5)).toEqual(['not a diff'])
  })

  test('clampDiff keeps the first piece and says how many lines are hidden', () => {
    const clamped = clampDiff(diff, 6, 1000)
    expect(clamped.text).toBe('@@ -0,0 +1,5 @@\n+n0\n+n1\n+n2\n+n3\n+n4')
    expect(clamped.note).toBe('… (5 lines hidden)')
    expect(clampDiff(diff, 100, 1000)).toEqual({ text: diff })
    expect(clampDiff(diff, 100, 3, '...')).toEqual({ text: '', note: '... (10 lines hidden)' })
  })
})
