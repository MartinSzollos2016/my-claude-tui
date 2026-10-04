import { describe, expect, test } from 'claude-code/testing'
import { ICON_SETS } from '../hooks/icons'
import type { ToolItem } from '../hooks/model/types'
import { withWorkflowNote } from '../hooks/view/row'

describe('withWorkflowNote', () => {
  const workflow = (isPending: boolean): ToolItem => ({
    kind: 'tool',
    id: 'w1',
    tool: 'Workflow',
    input: {},
    summary: '',
    isError: false,
    isPending,
  })
  const data = (extra: Record<string, unknown>) =>
    ({ icons: ICON_SETS.nerd, isLatest: true, isWorking: true, ...extra }) as unknown as Parameters<
      typeof withWorkflowNote
    >[2]

  test('a Workflow row says running while the latest turn works, done once answered', () => {
    expect(withWorkflowNote(workflow(true), 'build', data({}))).toBe('build · running')
    expect(withWorkflowNote(workflow(false), '', data({}))).toBe('done')
  })

  test('a pending Workflow of an ended turn has no result; other tools keep their summary', () => {
    expect(withWorkflowNote(workflow(true), 'build', data({ isWorking: false }))).toBe('build · no result')
    expect(withWorkflowNote({ ...workflow(true), tool: 'Bash' }, 'ls', data({}))).toBe('ls')
  })
})
