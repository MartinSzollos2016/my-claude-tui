import { describe, expect, test } from 'claude-code/testing'
import { ICON_SETS } from '../hooks/icons'
import { chunkText } from '../hooks/model/clamp'
import { splitDiff, unifiedDiff } from '../hooks/model/diff'
import {
  cachedSections,
  firstErrorLine,
  languageFor,
  parseNumbered,
  pieceStarts,
  resetSectionCache,
  sectionCacheSize,
  toolSections,
} from '../hooks/model/sections'
import { tool } from './fixtures/model'

describe('section cache', () => {
  test('one cache serves cachedSections, its size and its reset', () => {
    resetSectionCache()
    expect(sectionCacheSize()).toBe(0)
    const item = {
      kind: 'tool' as const,
      id: 'cache-1',
      tool: 'Bash',
      input: { command: 'ls' },
      summary: 'ls',
      resultText: 'a',
      isError: false,
      isPending: false,
    }
    const first = cachedSections(item)
    expect(cachedSections(item)).toBe(first)
    expect(sectionCacheSize()).toBe(1)
    resetSectionCache()
    expect(sectionCacheSize()).toBe(0)
  })
})

describe('toolSections', () => {
  test('Bash separates the command from its output', () => {
    const sections = toolSections(
      tool({ input: { command: 'go test ./...', description: 'Run tests' }, resultText: 'ok\nPASS' }),
    )
    expect(sections.map(s => s.kind)).toEqual(['command', 'output'])
    expect(sections[0]).toEqual({
      kind: 'command',
      title: '$ command',
      meta: 'Run tests',
      body: 'go test ./...',
      format: { kind: 'code', language: 'bash' },
    })
    expect(sections[1]?.meta).toBe('ok · 2 lines')
  })

  test('an errored result is an error section', () => {
    const sections = toolSections(tool({ input: { command: 'false' }, resultText: 'exit 1', isError: true }))
    expect(sections[1]?.kind).toBe('error')
    expect(sections[1]?.meta).toBe('error · 1 line')
  })

  test('a pending call has no output section yet', () => {
    expect(toolSections(tool({ input: { command: 'sleep 9' }, isPending: true })).map(s => s.kind)).toEqual(['command'])
  })

  test('Read shows the file and highlights its content by extension', () => {
    const [file, out] = toolSections(
      tool({
        tool: 'Read',
        input: { file_path: '/src/app/main.go', offset: 10, limit: 5 },
        resultText: 'package main',
      }),
    )
    expect(file?.kind).toBe('file')
    expect(file?.body).toBe('/src/app/main.go')
    expect(file?.meta).toBe('lines 10-14')
    expect(out?.format).toEqual({ kind: 'code', path: '/src/app/main.go' })
  })

  test('Edit is a unified diff of the file', () => {
    const [diff] = toolSections(
      tool({ tool: 'Edit', input: { file_path: '/a.ts', old_string: 'a', new_string: 'b' }, resultText: 'ok' }),
    )
    expect(diff).toEqual({
      kind: 'diff',
      title: 'diff',
      meta: '/a.ts',
      isPathMeta: true,
      body: '@@ -1,1 +1,1 @@\n-a\n+b',
      format: { kind: 'diff' },
    })
  })

  test('Edit numbers the hunk from the cat -n snippet its result carries', () => {
    const [diff] = toolSections(
      tool({
        tool: 'Edit',
        input: { file_path: '/a.ts', old_string: 'foo()', new_string: 'bar()\nbaz()' },
        resultText:
          "The file /a.ts has been updated. Here's the result of running `cat -n` on a snippet:\n    41\tlet x\n    42\tbar()\n    43\tbaz()",
      }),
    )
    expect(diff?.body).toBe('@@ -42,1 +42,2 @@\n-foo()\n+bar()\n+baz()')
  })

  test('MultiEdit has one hunk per edit', () => {
    const [diff] = toolSections(
      tool({
        tool: 'MultiEdit',
        input: {
          file_path: '/a.ts',
          edits: [
            { old_string: 'a', new_string: 'b' },
            { old_string: 'c', new_string: 'd' },
          ],
        },
      }),
    )
    expect(diff?.format).toEqual({ kind: 'diff' })
    expect(diff?.body).toBe('@@ -1,1 +1,1 @@\n-a\n+b\n@@ -1,1 +1,1 @@\n-c\n+d')
  })

  test('an edit that cannot be diffed keeps the plain - and + lines', () => {
    const big = Array.from({ length: 2001 }, (_, i) => `l${i}`).join('\n')
    const [diff] = toolSections(tool({ tool: 'Edit', input: { file_path: '/a.ts', old_string: big, new_string: 'x' } }))
    expect(diff?.format).toEqual({ kind: 'code', language: 'diff' })
    expect(diff?.body.startsWith('-l0\n-l1')).toBe(true)
    expect(diff?.body.endsWith('\n+x')).toBe(true)
    const [same] = toolSections(tool({ tool: 'Edit', input: { file_path: '/a.ts', old_string: 'q', new_string: 'q' } }))
    expect(same?.body).toBe('-q\n+q')
    const [multi] = toolSections(
      tool({ tool: 'MultiEdit', input: { file_path: '/a.ts', edits: [{ old_string: big, new_string: 'x' }, 'junk'] } }),
    )
    expect(multi?.format).toEqual({ kind: 'code', language: 'diff' })
  })

  test('the diff text is sanitized', () => {
    const [diff] = toolSections(
      tool({ tool: 'Edit', input: { file_path: '/a.ts', old_string: 'a\u001b[31m', new_string: 'b\u202e' } }),
    )
    expect(diff?.body).toBe('@@ -1,1 +1,1 @@\n-a\n+b')
  })

  test('Write shows the written content in its language', () => {
    const [file] = toolSections(tool({ tool: 'Write', input: { file_path: '/x/y.py', content: 'print(1)' } }))
    expect(file).toEqual({
      kind: 'file',
      title: 'write',
      meta: '/x/y.py',
      isPathMeta: true,
      body: 'print(1)',
      format: { kind: 'code', path: '/x/y.py' },
    })
  })

  test('Grep and WebSearch are queries; web results are markdown', () => {
    expect(toolSections(tool({ tool: 'Grep', input: { pattern: 'Run(', glob: '*.go' } }))[0]?.body).toBe(
      'Run(  in *.go',
    )
    const web = toolSections(tool({ tool: 'WebSearch', input: { query: 'bubbletea' }, resultText: '# hits' }))
    expect(web.map(s => s.kind)).toEqual(['query', 'output'])
    expect(web[1]?.format).toEqual({ kind: 'markdown' })
  })

  test('TodoWrite lists items with their status', () => {
    const [list] = toolSections(
      tool({
        tool: 'TodoWrite',
        input: {
          todos: [
            { content: 'a', status: 'completed' },
            { content: 'b', status: 'in_progress' },
            { content: 'c', status: 'pending' },
          ],
        },
      }),
    )
    expect(list?.body).toBe('☑ a\n◐ b\n☐ c')
  })

  test('other tools show their input as JSON', () => {
    const [input] = toolSections(tool({ tool: 'mcp__x__y', input: { q: 1 }, resultText: 'r' }))
    expect(input?.kind).toBe('input')
    expect(input?.format).toEqual({ kind: 'code', language: 'json' })
    expect(input?.body).toBe('{\n  "q": 1\n}')
  })

  test('languageFor maps common extensions', () => {
    expect(languageFor('a/b.tsx')).toBe('tsx')
    expect(languageFor('Makefile')).toBe(undefined)
    expect(languageFor('x.YAML')).toBe('yaml')
  })
})

describe('firstErrorLine', () => {
  test('is the first line that names an error, trimmed', () => {
    expect(firstErrorLine('compiling\n\n   src/a.ts:3: error TS2304: nope  \nError: later')).toBe(
      'src/a.ts:3: error TS2304: nope',
    )
    expect(firstErrorLine('ok\n--- FAIL: TestX (0.00s)\nmore')).toBe('--- FAIL: TestX (0.00s)')
    expect(firstErrorLine('running\npanic: nil pointer\n')).toBe('panic: nil pointer')
    expect(firstErrorLine('trace\njava.lang.NullPointerException at x')).toBe('java.lang.NullPointerException at x')
  })

  test('without a match it is the first non-empty line, and empty text gives nothing', () => {
    expect(firstErrorLine('\n \n  command not found \nsecond')).toBe('command not found')
    expect(firstErrorLine('')).toBe('')
    expect(firstErrorLine(' \n\t\n')).toBe('')
  })

  test('stays linear on one huge line', () => {
    const started = performance.now()
    expect(firstErrorLine('x'.repeat(2_000_000)).length).toBe(2_000_000)
    expect(performance.now() - started).toBeLessThan(200)
  })
})

describe('parseNumbered', () => {
  test('reads the arrow form and returns the first number with the bare lines', () => {
    expect(parseNumbered('     3→const a = 1\n     4→\n     5→  return a')).toEqual({
      startLine: 3,
      body: 'const a = 1\n\n  return a',
    })
  })

  test('reads the tab form and keeps tabs inside a line', () => {
    expect(parseNumbered('12\tone\n13\ttwo\tcols')).toEqual({ startLine: 12, body: 'one\ntwo\tcols' })
  })

  test('numbers that skip, repeat or run backwards leave the text alone', () => {
    expect(parseNumbered('1→a\n3→b')).toBeNull()
    expect(parseNumbered('1→a\n1→b')).toBeNull()
    expect(parseNumbered('2→a\n1→b')).toBeNull()
  })

  test('plain text, a partly numbered text and nothing are not numbered', () => {
    expect(parseNumbered('package main\nfunc main() {}')).toBeNull()
    expect(parseNumbered('1→a\nnote')).toBeNull()
    expect(parseNumbered('1→a\n\n2→b')).toBeNull()
    expect(parseNumbered('')).toBeNull()
  })
})

describe('pieceStarts', () => {
  test('gives the line each chunkText piece starts at', () => {
    const text = ['aaaa', 'bbbb', 'cccc', 'dddd'].join('\n')
    const pieces = chunkText(text, 9)
    expect(pieces).toEqual(['aaaa\nbbbb', 'cccc\ndddd'])
    expect(pieceStarts(text, pieces)).toEqual([0, 2])
  })

  test('a hard cut inside a line continues on that line', () => {
    const text = 'abcdefghij\nxyz'
    const pieces = chunkText(text, 4)
    expect(pieceStarts(text, pieces)[1]).toBe(0)
  })
})

describe('Read sections', () => {
  test('numbered output loses its numbers, gains startLine and the path', () => {
    const [, out] = toolSections(
      tool({
        tool: 'Read',
        input: { file_path: '/src/a.rs' },
        resultText: '    10→fn main() {\n    11→}',
      }),
    )
    expect(out).toMatchObject({
      body: 'fn main() {\n}',
      meta: 'ok · 2 lines',
      format: { kind: 'code', path: '/src/a.rs', startLine: 10 },
    })
  })

  test('numbers that do not run on stay in the text, with no startLine', () => {
    const [, out] = toolSections(tool({ tool: 'Read', input: { file_path: '/src/a.go' }, resultText: '1→a\n5→b' }))
    expect(out?.body).toBe('1→a\n5→b')
    expect(out?.format).toEqual({ kind: 'code', path: '/src/a.go' })
  })

  test('an unknown extension without numbers stays text, an error stays text', () => {
    expect(
      toolSections(tool({ tool: 'Read', input: { file_path: '/x/LICENSE' }, resultText: 'MIT' }))[1]?.format,
    ).toEqual({ kind: 'text' })
    expect(
      toolSections(tool({ tool: 'Read', input: { file_path: '/a.go' }, resultText: '1→x', isError: true }))[1]?.format,
    ).toEqual({ kind: 'text' })
  })
})

describe('fix round 1: model', () => {
  const many = (n: number, tag: string) => Array.from({ length: n }, (_, i) => `${tag}${i}`).join('\n')

  test('a changed middle over the cell cap is not diffed, one under it is', () => {
    expect(unifiedDiff(many(600, 'a'), many(600, 'b'))).toBeNull()
    expect(unifiedDiff(many(400, 'a'), many(400, 'b'))).not.toBeNull()
    // The common head and tail do not count against the cap.
    const shared = many(1500, 's')
    expect(unifiedDiff(`${shared}\nold`, `${shared}\nnew`)).not.toBeNull()
  })

  test('a big edit falls back to the plain - and + lines', () => {
    const [diff] = toolSections(
      tool({ tool: 'Edit', input: { file_path: '/a.ts', old_string: many(600, 'a'), new_string: many(600, 'b') } }),
    )
    expect(diff?.format).toEqual({ kind: 'code', language: 'diff' })
    expect(diff?.body.startsWith('-a0\n-a1')).toBe(true)
  })

  test('splitDiff of a very long hunk is linear', () => {
    const diff = `@@ -0,0 +1,20000 @@\n${Array.from({ length: 20000 }, (_, i) => `+line ${i}`).join('\n')}`
    const started = Date.now()
    const pieces = splitDiff(diff, Infinity, 8000)
    expect(Date.now() - started).toBeLessThan(400)
    expect(pieces.length).toBeGreaterThan(20)
    for (const piece of pieces) expect(piece.length).toBeLessThanOrEqual(8000)
  })

  test('editStartLine matches the whole new block, not a first line seen earlier', () => {
    const [diff] = toolSections(
      tool({
        tool: 'Edit',
        input: { file_path: '/a.ts', old_string: '}\nold', new_string: '}\nnew' },
        resultText: 'Updated:\n     3\t}\n     4\tx\n    10\t}\n    11\tnew\n    12\ty',
      }),
    )
    expect(diff?.body.startsWith('@@ -10,2 +10,2 @@')).toBe(true)
  })

  test('parseNumbered survives CRLF lines and a trailing blank tab line', () => {
    expect(parseNumbered('1\ta\r\n2\tb\r')).toEqual({ startLine: 1, body: 'a\nb' })
    expect(parseNumbered('1\ta\n2\tb\n3')).toEqual({ startLine: 1, body: 'a\nb\n' })
    expect(parseNumbered('1\ta\u2028b\n2\tc')).toEqual({ startLine: 1, body: 'a\u2028b\nc' })
    expect(parseNumbered('5')).toBeNull()
    expect(parseNumbered('1\n2\n3')).toBeNull()
  })

  test('cachedSections returns the same sections until the item changes', () => {
    const item = tool({ id: 'cache-1', tool: 'Edit', input: { file_path: '/a.ts', old_string: 'a', new_string: 'b' } })
    const first = cachedSections(item, ICON_SETS.nerd)
    expect(cachedSections({ ...item }, ICON_SETS.nerd)).toBe(first)
    const changed = { ...item, input: { file_path: '/a.ts', old_string: 'a', new_string: 'c' } }
    expect(cachedSections(changed, ICON_SETS.nerd)).not.toBe(first)
    expect(cachedSections(changed, ICON_SETS.ascii)).not.toBe(cachedSections(changed, ICON_SETS.nerd))
    expect(cachedSections({ ...item, resultText: 'ok' }, ICON_SETS.nerd)).not.toBe(first)
  })

  test('cachedSections keeps at most 200 items', () => {
    const first = cachedSections(tool({ id: 'cap-0', input: { command: 'ls' } }), ICON_SETS.nerd)
    for (let i = 1; i <= 200; i++) cachedSections(tool({ id: `cap-${i}`, input: { command: 'ls' } }), ICON_SETS.nerd)
    expect(cachedSections(tool({ id: 'cap-0', input: { command: 'ls' } }), ICON_SETS.nerd)).not.toBe(first)
  })
})
