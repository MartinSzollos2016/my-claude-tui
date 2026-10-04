import { describe, expect, test } from 'claude-code/testing'
import { buildTurns } from '../hooks/model/turns'
import { renderPane } from '../hooks/view/pane'
import { act, base, byKey, calls, el, nodes, text } from './fixtures/view'

describe('diff blocks', () => {
  const editTurn = (input: Record<string, unknown>, tool = 'Edit') =>
    buildTurns([
      { role: 'user', text: 'go', toolUses: [] },
      { role: 'assistant', text: '', toolUses: [{ tool_use_id: 'd1', tool, input, text: 'ok' }] },
    ])
  const drawn = (turns: ReturnType<typeof buildTurns>, extra: Record<string, unknown> = {}) =>
    renderPane(el, { ...base, turns, selected: 0, expanded: new Set(['d1']), ...extra }, act)

  test('an Edit draws a Code with format diff and copies the whole diff', () => {
    const tree = drawn(editTurn({ file_path: '/a.go', old_string: 'x', new_string: 'y' }))
    const code = nodes(tree).filter(n => n.type === 'Code')
    expect(code).toHaveLength(1)
    expect(code[0]?.props['format']).toBe('diff')
    expect(code[0]?.props['source']).toBe('@@ -1,1 +1,1 @@\n-x\n+y')
    calls.length = 0
    ;(byKey(tree, 'copy:d1:diff')?.props['onPress'] as (p: unknown) => void)({ surface: 'terminal' })
    expect(calls).toEqual(['copy:terminal:@@ -1,1 +1,1 @@\n-x\n+y'])
  })

  test('a long diff previews 60 lines as a valid diff and shows all on request', () => {
    const turns = editTurn({
      file_path: '/a.go',
      old_string: '',
      new_string: Array.from({ length: 200 }, (_, i) => `n${i}`).join('\n'),
    })
    const preview = nodes(drawn(turns)).filter(n => n.type === 'Code')
    expect(preview).toHaveLength(1)
    const source = preview[0]?.props['source'] as string
    expect(source.split('\n')).toHaveLength(60)
    expect(source.startsWith('@@ -0,0 +1,59 @@\n+n0')).toBe(true)
    expect(text(drawn(turns))).toContain('141 lines hidden')

    const all = nodes(drawn(turns, { full: new Set(['d1:diff']) })).filter(n => n.type === 'Code')
    const lines = all.flatMap(n => (n.props['source'] as string).split('\n').filter(l => l[0] === '+'))
    expect(lines).toHaveLength(200)
    for (const piece of all) expect(piece.props['format']).toBe('diff')
    expect(all.every(n => (n.props['source'] as string).startsWith('@@'))).toBe(true)
  })

  test('a diff the pane budget has no room for draws no empty Code', () => {
    const body = Array.from({ length: 150 }, (_, i) => `line ${i} ${'x'.repeat(50)}`).join('\n')
    const uses = Array.from({ length: 14 }, (_, i) => ({
      tool_use_id: `m${i}`,
      tool: 'Edit',
      input: { file_path: '/a.go', old_string: '', new_string: body },
      text: 'ok',
    }))
    const turns = buildTurns([
      { role: 'user', text: 'go', toolUses: [] },
      { role: 'assistant', text: '', toolUses: uses },
    ])
    const open = new Set(uses.map(u => u.tool_use_id))
    const tree = renderPane(
      el,
      { ...base, turns, selected: 0, expanded: open, full: new Set(uses.map(u => `${u.tool_use_id}:diff`)) },
      act,
    )
    const code = nodes(tree).filter(n => n.type === 'Code')
    expect(code.length).toBeGreaterThan(1)
    expect(code.some(n => n.props['source'] === '')).toBe(false)
    expect(text(tree)).toContain('pane text budget reached')
    expect(code.reduce((sum, n) => sum + (n.props['source'] as string).length, 0)).toBeLessThanOrEqual(85_000)
  })
})

describe('code blocks', () => {
  const readTurn = (path: string, result: string, tool = 'Read') =>
    buildTurns([
      { role: 'user', text: 'go', toolUses: [] },
      {
        role: 'assistant',
        text: '',
        toolUses: [{ tool_use_id: 'c1', tool, input: { file_path: path, content: result }, text: result }],
      },
    ])
  const codes = (turns: ReturnType<typeof buildTurns>, extra: Record<string, unknown> = {}) =>
    nodes(renderPane(el, { ...base, turns, selected: 0, expanded: new Set(['c1']), ...extra }, act)).filter(
      n => n.type === 'Code',
    )

  test('a numbered Read draws the bare lines with startLine and infers the language from the path', () => {
    const [code] = codes(readTurn('/a/b.go', '    12→package a\n    13→func b() {}'))
    expect(code?.props['source']).toBe('package a\nfunc b() {}')
    expect(code?.props['startLine']).toBe(12)
    expect(code?.props['path']).toBe('/a/b.go')
    expect(code?.props).not.toHaveProperty('language')
    expect(code?.props).not.toHaveProperty('format')
  })

  test('numbers that do not run on stay in the text and no gutter is asked for', () => {
    const [code] = codes(readTurn('/a/b.go', '1→x\n9→y'))
    expect(code?.props['source']).toBe('1→x\n9→y')
    expect(code?.props).not.toHaveProperty('startLine')
  })

  test('a Write draws its content by path, and a language-less shell block keeps its language', () => {
    const [write] = codes(readTurn('/a/s.py', 'print(1)', 'Write'))
    expect(write?.props['path']).toBe('/a/s.py')
    expect(write?.props).not.toHaveProperty('startLine')
    const bash = buildTurns([
      { role: 'user', text: 'go', toolUses: [] },
      { role: 'assistant', text: '', toolUses: [{ tool_use_id: 'c1', tool: 'Bash', input: { command: 'ls' } }] },
    ])
    expect(codes(bash)[0]?.props['language']).toBe('bash')
  })

  test('the gutter continues over the pieces of a long block shown whole', () => {
    const rows = Array.from({ length: 1500 }, (_, i) => `${i + 5}→${'x'.repeat(20)}`).join('\n')
    const turns = readTurn('/a/b.go', rows)
    const all = codes(turns, { full: new Set(['c1:output']) })
    expect(all.length).toBeGreaterThan(1)
    let at = 5
    for (const piece of all) {
      expect(piece.props['startLine']).toBe(at)
      at += (piece.props['source'] as string).split('\n').length
    }
    expect(at).toBe(1505)
  })
})
