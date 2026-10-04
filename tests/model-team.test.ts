import { describe, expect, test } from 'claude-code/testing'
import type { ToolUseSummary } from 'claude-code'
import { taskBoard, taskMark, teamMembers } from '../hooks/model/team'
import { buildTurns } from '../hooks/model/turns'
import { prompt } from './fixtures/model'

describe('taskBoard', () => {
  const use = (id: string, tool: string, input: Record<string, unknown>, text?: string): ToolUseSummary => ({
    tool_use_id: id,
    tool,
    input,
    ...(text === undefined ? {} : { text }),
  })

  test('creates, reassigns and completes tasks, the latest state winning', () => {
    const board = taskBoard(
      buildTurns([
        prompt('Plan'),
        {
          role: 'assistant',
          text: '',
          toolUses: [
            use('c1', 'TaskCreate', { subject: 'Write tests' }, 'Task #1 created successfully: Write tests'),
            use('c2', 'TaskCreate', { subject: 'Ship' }, 'Task #2 created successfully: Ship'),
            use('c3', 'TaskCreate', { subject: 'Drop me' }, 'Task #3 created successfully: Drop me'),
          ],
        },
        prompt('Go'),
        {
          role: 'assistant',
          text: '',
          toolUses: [
            use('u1', 'TaskUpdate', { taskId: '1', status: 'in_progress', owner: 'alice' }, 'Updated task #1'),
            use('u2', 'TaskUpdate', { taskId: '1', owner: 'bob', subject: 'Write more tests' }, 'ok'),
            use('u3', 'TaskUpdate', { taskId: '2', status: 'completed' }, 'ok'),
            use('u4', 'TaskUpdate', { taskId: '3', status: 'deleted' }, 'ok'),
            use('u5', 'TaskUpdate', { taskId: '7', status: 'in_progress' }, 'ok'),
            use('u6', 'TaskUpdate', { status: 'completed' }, 'ok'),
            use('u7', 'TaskCreate', { subject: 'Failed' }, 'boom'),
          ],
        },
      ]),
    )
    expect(board).toEqual([
      { id: '1', subject: 'Write more tests', status: 'in_progress', owner: 'bob' },
      { id: '2', subject: 'Ship', status: 'completed' },
      { id: '7', subject: 'Task #7', status: 'in_progress' },
      { id: '4', subject: 'Failed', status: 'pending' },
    ])
  })

  test('skips failed calls and numbers a task whose result has no id', () => {
    const board = taskBoard(
      buildTurns([
        prompt('Plan'),
        {
          role: 'assistant',
          text: '',
          toolUses: [
            { ...use('c1', 'TaskCreate', { subject: 'Nope' }, 'error'), isError: true },
            use('c2', 'TaskCreate', {}, 'ok'),
            use('c3', 'TaskCreate', { subject: 'Waiting' }),
          ],
        },
      ]),
    )
    expect(board).toEqual([{ id: '1', subject: 'Untitled task', status: 'pending' }])
    expect(taskBoard([])).toEqual([])
  })

  test('marks a task as TodoWrite does', () => {
    expect(taskMark('pending')).toBe('☐')
    expect(taskMark('in_progress')).toBe('◐')
    expect(taskMark('completed')).toBe('☑')
  })
})

describe('taskBoard edge cases', () => {
  const use = (id: string, tool: string, input: Record<string, unknown>, text?: string): ToolUseSummary => ({
    tool_use_id: id,
    tool,
    input,
    ...(text === undefined ? {} : { text }),
  })

  test('a fallback id never overwrites a real one, and a pending create does not shift numbering', () => {
    const board = taskBoard(
      buildTurns([
        prompt('Plan'),
        {
          role: 'assistant',
          text: '',
          toolUses: [
            use('u1', 'TaskUpdate', { taskId: '2', status: 'in_progress' }, 'ok'),
            use('c0', 'TaskCreate', { subject: 'Pending' }),
            use('c1', 'TaskCreate', { subject: 'First' }, 'ok'),
            use('c2', 'TaskCreate', { subject: 'Second' }, 'ok'),
          ],
        },
      ]),
    )
    expect(board.map(t => [t.id, t.subject])).toEqual([
      ['2', 'Task #2'],
      ['1', 'First'],
      ['3', 'Second'],
    ])
  })

  test('accepts a numeric taskId', () => {
    const board = taskBoard(
      buildTurns([
        prompt('Plan'),
        {
          role: 'assistant',
          text: '',
          toolUses: [
            use('c1', 'TaskCreate', { subject: 'A' }, 'Task #5 created'),
            use('u1', 'TaskUpdate', { taskId: 5, status: 'completed' }, 'ok'),
          ],
        },
      ]),
    )
    expect(board).toEqual([{ id: '5', subject: 'A', status: 'completed' }])
  })

  test('an empty name falls back to the whole teammate id', () => {
    expect(teamMembers([{ id: 'a', description: 'd', type: 'x', status: 'idle', teammateId: '@crew' }])[0]?.name).toBe(
      '@crew',
    )
  })
})

describe('teamMembers', () => {
  test('lists teammates only, by the name before @', () => {
    expect(
      teamMembers([
        { id: 'a', description: 'd', type: 'teammate', status: 'idle', teammateId: 'alice@crew' },
        { id: 'b', description: 'd', type: 'Explore', status: 'running' },
        { id: 'c', description: 'd', type: 'reviewer', status: 'running', teammateId: 'bo\u001b[31mb@crew' },
      ]),
    ).toEqual([
      { name: 'alice', type: 'teammate', status: 'idle' },
      { name: 'bob', type: 'reviewer', status: 'running' },
    ])
  })
})
