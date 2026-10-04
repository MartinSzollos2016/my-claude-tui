// The team board: tasks from TaskCreate / TaskUpdate and the teammates of a session.
import type { AgentInfo, AgentStatus } from 'claude-code'
import { DEFAULT_GLYPHS, type TaskMarks } from './format'
import { sanitizeText } from './sanitize'
import type { Turn } from './types'
import { str } from './values'

export type TaskEntry = { id: string; subject: string; status: string; owner?: string }

export const taskMark = (status: string, marks: TaskMarks = DEFAULT_GLYPHS): string =>
  status === 'completed' ? marks.taskDone : status === 'in_progress' ? marks.taskActive : marks.taskTodo

// The team's tasks as the main loop's TaskCreate and TaskUpdate calls left
// them: the latest status, owner and subject win, a deleted task drops out.
// A created task's id is read from its result ("Task #3 created ..."), else
// counted in creation order; an update for a task created elsewhere (by a
// teammate) adds it.
export function taskBoard(turns: readonly Turn[]): TaskEntry[] {
  const tasks = new Map<string, TaskEntry>()
  let created = 0
  for (const turn of turns) {
    for (const item of turn.items) {
      if (item.kind !== 'tool' || item.isError || item.isPending) continue
      if (item.tool === 'TaskCreate') {
        created += 1
        let id = taskIdIn(item.resultText ?? '')
        if (id === undefined) {
          let next = created
          while (tasks.has(String(next))) next += 1
          id = String(next)
        }
        tasks.set(id, { id, subject: str(item.input, 'subject') || 'Untitled task', status: 'pending' })
      } else if (item.tool === 'TaskUpdate') {
        const raw = item.input['taskId']
        const id = typeof raw === 'number' ? String(raw) : str(item.input, 'taskId')
        if (id === '') continue
        const status = str(item.input, 'status')
        if (status === 'deleted') {
          tasks.delete(id)
          continue
        }
        const task = tasks.get(id) ?? { id, subject: `Task #${id}`, status: 'pending' }
        const owner = str(item.input, 'owner')
        const subject = str(item.input, 'subject')
        tasks.set(id, {
          ...task,
          ...(status ? { status } : {}),
          ...(owner ? { owner } : {}),
          ...(subject ? { subject } : {}),
        })
      }
    }
  }
  return [...tasks.values()]
}

// The digits after the first '#', as TaskCreate's result names the new task.
function taskIdIn(text: string): string | undefined {
  const at = text.indexOf('#')
  if (at < 0) return undefined
  let end = at + 1
  while (end < text.length && text[end]! >= '0' && text[end]! <= '9') end += 1
  return end > at + 1 ? text.slice(at + 1, end) : undefined
}

export type TeamMember = { name: string; type: string; status: AgentStatus }

// The session's teammates (agents with a teammateId, `<name>@<team>`).
export function teamMembers(agents: readonly AgentInfo[]): TeamMember[] {
  return agents.flatMap(agent =>
    agent.teammateId === undefined
      ? []
      : [
          {
            name: sanitizeText(agent.teammateId.split('@')[0] || agent.teammateId),
            type: sanitizeText(agent.type),
            status: agent.status,
          },
        ],
  )
}
