import { describe, expect, test } from 'claude-code/testing'
import {
  clampScroll,
  contentRows,
  engineScroll,
  followCursor,
  overflowRows,
  pageScroll,
  scrollToRow,
  stepCursor,
} from '../hooks/model/scroll'

describe('contentRows of the turn list', () => {
  test('a turn row with an id has its start, as an item row does', () => {
    const rows = contentRows([
      { kind: 'line' },
      { kind: 'turn', id: 'turn:2' },
      { kind: 'turn', id: 'turn:1', snippet: 'x' },
    ])
    expect(rows.starts).toEqual({ 'turn:2': 1, 'turn:1': 2 })
    expect(rows.total).toBe(4)
  })
})

describe('contentRows', () => {
  test('an item row is one row and its start is where it begins', () => {
    const rows = contentRows([{ kind: 'line' }, { kind: 'line', id: 'a' }, { kind: 'line', id: 'b' }])
    expect(rows.total).toBe(3)
    expect(rows.starts).toEqual({ a: 1, b: 2 })
  })

  test('a frame is two borders, a header and one row per line of each piece', () => {
    const rows = contentRows([
      { kind: 'line', id: 'a' },
      { kind: 'frame', body: ['one\ntwo', 'three'], notes: [], width: 72 },
      { kind: 'line', id: 'b' },
    ])
    expect(rows.total).toBe(1 + 2 + 1 + 3 + 1)
    expect(rows.starts['b']).toBe(7)
    expect(contentRows([{ kind: 'frame', body: [], notes: [], width: 72 }]).total).toBe(3)
  })

  test('a show all line under the body counts as a note', () => {
    expect(contentRows([{ kind: 'frame', body: ['x'], notes: ['show all'], width: 72 }]).total).toBe(5)
    expect(contentRows([{ kind: 'frame', body: ['x'], notes: ['note', 'show all'], width: 72 }]).total).toBe(6)
  })

  test('a turn of the list is one row, two with a search snippet', () => {
    const rows = contentRows([{ kind: 'turn' }, { kind: 'turn', snippet: 'a match' }])
    expect(rows.total).toBe(3)
  })

  test('the team board counts its headings, members and tasks', () => {
    const lines = ['Tasks (2)', 'alice', 'bob', '', 'Tasks', 'one', 'two'].map(() => ({ kind: 'line' as const }))
    expect(contentRows(lines).total).toBe(7)
  })

  test('a line wider than its width takes a row per width, a cut one row', () => {
    const paragraph = 'word '.repeat(60).trim()
    expect(paragraph.length).toBe(299)
    expect(contentRows([{ kind: 'line', text: paragraph, width: 72 }]).total).toBe(5)
    expect(contentRows([{ kind: 'line', text: paragraph, width: 32 }]).total).toBe(10)
    expect(contentRows([{ kind: 'line', text: paragraph }]).total).toBe(1)
    expect(contentRows([{ kind: 'line', text: '', width: 10 }]).total).toBe(1)
  })

  test('twenty 300-character paragraphs wrap in an 80 and a 40 column frame', () => {
    const prose = Array.from({ length: 20 }, () => 'x'.repeat(300)).join('\n\n')
    // 20 paragraphs and 19 blank lines between them, plus the frame's 3 rows.
    expect(contentRows([{ kind: 'frame', body: [prose], notes: [], width: 70 }]).total).toBe(3 + 20 * 5 + 19)
    expect(contentRows([{ kind: 'frame', body: [prose], notes: [], width: 30 }]).total).toBe(3 + 20 * 10 + 19)
  })

  test('one-line JSON of 8000 characters is many rows, the gutter of numbered code narrows the body', () => {
    const json = JSON.stringify({ data: 'y'.repeat(7989) })
    expect(json.length).toBe(8000)
    expect(contentRows([{ kind: 'frame', body: [json], notes: [], width: 70 }]).total).toBe(3 + 115)
    expect(contentRows([{ kind: 'frame', body: [json], notes: [], width: 30 }]).total).toBe(3 + 267)
    expect(contentRows([{ kind: 'frame', body: ['z'.repeat(70)], notes: [], width: 70, gutter: 5 }]).total).toBe(5)
  })

  test('a frame header and notes wrap at the frame width, a trailing newline adds no row', () => {
    expect(
      contentRows([{ kind: 'frame', body: ['a\n'], notes: ['n'.repeat(100)], width: 50, headRows: 2 }]).total,
    ).toBe(2 + 2 + 1 + 2)
    expect(contentRows([{ kind: 'frame', body: ['tab\there'], notes: [], width: 8 }]).total).toBe(3 + 2)
  })

  // Calibrated against the real engine (a pyte-rendered session): Code with
  // language markdown drops empty lines; a diff draws no ---, +++ or @@ line
  // and puts its line number and the +/- marker in a gutter of digits + 3.
  test('markdown counts no row for an empty line', () => {
    const prose = ['p'.repeat(250), '', 'q'.repeat(250), '', '', 'r'].join('\n')
    expect(contentRows([{ kind: 'frame', body: [prose], notes: [], width: 100, format: 'markdown' }]).total).toBe(
      3 + 3 + 3 + 1,
    )
    expect(contentRows([{ kind: 'frame', body: [prose], notes: [], width: 100 }]).total).toBe(3 + 3 + 1 + 3 + 2 + 1)
  })

  test('a diff counts only its changed and context lines, beside a gutter of its widest line number', () => {
    const diff = ['--- a', '+++ b', '@@ -10,2 +10,2 @@', `-${'y'.repeat(247)}`, `+${'z'.repeat(247)}`, ' same'].join(
      '\n',
    )
    // Line numbers up to 11: 2 digits + 3 = 5 cells, 95 left: 247 cells take 3 rows.
    expect(contentRows([{ kind: 'frame', body: [diff], notes: [], width: 100, format: 'diff' }]).total).toBe(
      3 + 3 + 3 + 1,
    )
    const small = ['--- a', '+++ b', '@@ -1,8 +1,8 @@', `-${'y'.repeat(247)}`].join('\n')
    // Up to line 8: 1 digit + 3 = 4 cells, 96 left: 3 rows.
    expect(contentRows([{ kind: 'frame', body: [small], notes: [], width: 100, format: 'diff' }]).total).toBe(3 + 3)
  })

  test('a search snippet wraps at its width', () => {
    expect(contentRows([{ kind: 'turn', snippet: 's'.repeat(90), width: 40 }]).total).toBe(1 + 3)
  })

  test('no blocks is no rows', () => {
    expect(contentRows([])).toEqual({ total: 0, starts: {} })
  })
})

describe('clampScroll', () => {
  test('content that fits the window does not scroll', () => {
    expect(clampScroll(5, 8, 10)).toBe(0)
    expect(clampScroll(5, 10, 10)).toBe(0)
  })

  test('longer content scrolls to two rows past its end, never above the top', () => {
    expect(clampScroll(100, 30, 10)).toBe(22)
    expect(clampScroll(7, 30, 10)).toBe(7)
    expect(clampScroll(-3, 30, 10)).toBe(0)
  })
})

describe('pageScroll', () => {
  test('moves a window less two rows down or up, never above the top', () => {
    expect(pageScroll(0, 1, 10)).toBe(8)
    expect(pageScroll(8, -1, 10)).toBe(0)
    expect(pageScroll(3, -1, 10)).toBe(0)
  })

  test('a window of two rows or less still moves by one', () => {
    expect(pageScroll(0, 1, 2)).toBe(1)
    expect(pageScroll(0, 1, 0)).toBe(1)
  })
})

describe('followCursor', () => {
  test('a row already inside the window keeps the scroll', () => {
    expect(followCursor(5, 6, 10)).toBe(5)
    expect(followCursor(5, 13, 10)).toBe(5)
  })

  test('a row below the window scrolls it to one row above the bottom edge', () => {
    expect(followCursor(0, 9, 10)).toBe(1)
    expect(followCursor(5, 30, 10)).toBe(22)
  })

  test('a row above the window scrolls it to one row below the top edge', () => {
    expect(followCursor(10, 10, 10)).toBe(9)
    expect(followCursor(10, 2, 10)).toBe(1)
    expect(followCursor(10, 0, 10)).toBe(0)
  })

  test('a window of two rows or less has no margin', () => {
    expect(followCursor(0, 5, 2)).toBe(4)
    expect(followCursor(5, 3, 2)).toBe(3)
  })
})

describe('overflowRows', () => {
  test('nothing more above or below while the content fits', () => {
    expect(overflowRows(0, 10, 10)).toEqual({ above: 0, below: 0 })
  })

  test('counts the rows out of the window and under the indicator rows', () => {
    expect(overflowRows(0, 30, 10)).toEqual({ above: 0, below: 21 })
    expect(overflowRows(5, 30, 10)).toEqual({ above: 6, below: 16 })
    expect(overflowRows(21, 30, 10)).toEqual({ above: 22, below: 0 })
    expect(overflowRows(22, 30, 10)).toEqual({ above: 23, below: 0 })
  })
})

describe('scrollToRow', () => {
  const frame = { scrollTop: 0, windowRows: 10, total: 30, starts: { a: 2, z: 29 } }

  test('scrolls so the row stays visible, clamped to the content', () => {
    expect(scrollToRow(frame, 'a')).toBe(0)
    expect(scrollToRow(frame, 'z')).toBe(21)
    expect(scrollToRow({ ...frame, scrollTop: 20 }, 'a')).toBe(1)
  })

  test('a row with no known start, or no row, keeps the scroll', () => {
    expect(scrollToRow({ ...frame, scrollTop: 4 }, 'nope')).toBe(4)
    expect(scrollToRow({ ...frame, scrollTop: 4 }, null)).toBe(4)
  })
})

describe('stepCursor', () => {
  const ids = ['a', 'b', 'c', 'd', 'e', 'f']
  // a..f start on rows 1..6 of a window of four rows scrolled to row 3.
  const frame = { scrollTop: 3, windowRows: 4, total: 30, starts: { a: 1, b: 2, c: 3, d: 4, e: 5, f: 6 } }

  test('without a cursor, j enters at the first row inside the window and k at the last, so it does not move', () => {
    expect(stepCursor(ids, null, 1, frame)).toBe('d')
    expect(stepCursor(ids, null, -1, frame)).toBe('e')
    expect(scrollToRow(frame, 'd')).toBe(3)
    expect(scrollToRow(frame, 'e')).toBe(3)
  })

  test('at the top of the content it enters at the first row as before', () => {
    expect(stepCursor(ids, null, 1, { ...frame, scrollTop: 0 })).toBe('a')
  })

  test('with no row inside the window, or a cursor not on the list, it falls back to the ends', () => {
    expect(stepCursor(ids, null, 1, { ...frame, scrollTop: 20 })).toBe('a')
    expect(stepCursor(ids, null, -1, { ...frame, scrollTop: 20 })).toBe('f')
    expect(stepCursor(ids, 'gone', 1, { ...frame, scrollTop: 20 })).toBe('a')
  })

  test('a cursor scrolled out of the window enters inside it again instead of pulling the view back', () => {
    expect(stepCursor(ids, 'a', 1, frame)).toBe('d')
    expect(stepCursor(ids, 'a', -1, frame)).toBe('e')
  })

  test('a cursor on the list moves one row as moveCursor does', () => {
    expect(stepCursor(ids, 'd', 1, frame)).toBe('e')
    expect(stepCursor(ids, 'a', -1, { ...frame, scrollTop: 0 })).toBe('a')
    expect(stepCursor([], null, 1, frame)).toBe(null)
  })
})

describe('engineScroll', () => {
  const frame = { scrollTop: 0, windowRows: 34, total: 200, starts: {} }
  const move = (by: number) => ({ by, bodyRows: 40, contentRows: 40 })

  test('a wheel step moves its rows, clamped to the content', () => {
    expect(engineScroll(10, move(3), frame)).toBe(13)
    expect(engineScroll(1, move(-3), frame)).toBe(0)
  })

  test('a page key, the whole body, moves one page of the own window', () => {
    expect(engineScroll(10, move(40), frame)).toBe(42)
    expect(engineScroll(42, move(-40), frame)).toBe(10)
  })

  test('Home and End beyond the body go to the top and the end', () => {
    expect(engineScroll(50, move(-500), frame)).toBe(0)
    expect(engineScroll(50, move(500), frame)).toBe(168)
  })
})
