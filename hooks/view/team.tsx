// The team board: teammates with their state and the tasks Claude planned.
import { taskMark, type TaskEntry, type TeamMember } from '../model/team'
import { padEndDisplay } from '../model/width'
import { agentStatusColor, C } from '../theme'
import { LINE, textLine, type Ctx, type PaneParts } from './context'
import { cutter, endWrap, isUnicodeCut, type El } from './kit'

// The team board: each teammate with its type and status, then the tasks
// with their TodoWrite marks and owners.
const NO_MEMBERS = 'No teammates in this session.'

const NO_MEMBERS_HINT = 'Teammates show up once Claude starts a team.'

const NO_TASKS = 'No tasks yet.'

const NO_TASKS_HINT = 'Tasks show up when Claude plans with TodoWrite or TaskCreate.'

export function renderTeam(el: El, data: Ctx): PaneParts {
  const trunc = cutter(data.icons)
  const { Box, Text } = el
  const members = data.members ?? []
  const tasks = data.tasks ?? []

  // Every row draws from the pane's text budget; what does not fit is counted.
  const memberRows: { member: TeamMember; name: string; type: string; cost: number }[] = []
  for (const member of members) {
    const name = padEndDisplay(trunc(member.name, 24), 24)
    const type = padEndDisplay(trunc(member.type, 20), 20)
    const cost = name.length + type.length + member.status.length + 4
    if (cost > data.budget.left) break
    data.budget.left -= cost
    memberRows.push({ member, name, type, cost })
  }
  const taskRows: { task: TaskEntry; label: string }[] = []
  for (const task of tasks) {
    const owner = task.owner ? `  ${data.icons.arrow} ${trunc(task.owner, 40)}` : ''
    const label = `${taskMark(task.status, data.icons)} #${trunc(task.id, 20)} ${trunc(task.subject, 200)}${owner}`
    if (label.length > data.budget.left) break
    data.budget.left -= label.length
    taskRows.push({ task, label })
  }
  const hiddenMembers = members.length - memberRows.length
  const hiddenTasks = tasks.length - taskRows.length
  // A blank row and the members (or the two empty lines), then a blank row,
  // the tasks heading and the tasks (or the two empty lines), each wrapped.
  const line = (text: string, isCut = false) => textLine(data, text, 0, isCut)
  data.layout.push(
    LINE,
    ...(members.length === 0 ? [line(NO_MEMBERS), line(NO_MEMBERS_HINT)] : []),
    ...memberRows.map(row => line(`${data.icons.bullet} ${row.name} ${row.type} ${row.member.status}`)),
    ...(hiddenMembers > 0 ? [line(`${hiddenMembers} more teammates`)] : []),
    LINE,
    LINE,
    ...(tasks.length === 0 ? [line(NO_TASKS), line(NO_TASKS_HINT)] : []),
    ...taskRows.map(row => line(row.label, isUnicodeCut(data.icons))),
    ...(hiddenTasks > 0 ? [line(`${hiddenTasks} more tasks`)] : []),
  )

  const header = [
    {
      rows: 1,
      node: (
        <Box key="team-title" flexDirection="row" gap={2}>
          <Text bold color={C.brand}>{`Team (${members.length})`}</Text>
        </Box>
      ),
    },
  ]
  const content = (
    <Box flexDirection="column">
      <Box flexDirection="column" marginTop={1}>
        {members.length === 0 && (
          <Box flexDirection="column">
            <Text color={C.muted}>{NO_MEMBERS}</Text>
            <Text key="empty-members" color={C.muted}>
              {NO_MEMBERS_HINT}
            </Text>
          </Box>
        )}
        {memberRows.map((row, i) => (
          <Box key={`member-${i}`} flexDirection="row">
            <Text color={agentStatusColor(row.member.status)}>{`${data.icons.bullet} `}</Text>
            <Text bold color={C.text}>
              {row.name}
            </Text>
            <Text color={C.muted}>{` ${row.type} `}</Text>
            <Text color={agentStatusColor(row.member.status)}>{row.member.status}</Text>
          </Box>
        ))}
        {hiddenMembers > 0 && <Text color={C.muted}>{`${hiddenMembers} more teammates`}</Text>}
      </Box>
      <Box flexDirection="column" marginTop={1}>
        <Text bold color={C.text}>{`Tasks (${tasks.length})`}</Text>
        {tasks.length === 0 && (
          <Box flexDirection="column">
            <Text color={C.muted}>{NO_TASKS}</Text>
            <Text key="empty-tasks" color={C.muted}>
              {NO_TASKS_HINT}
            </Text>
          </Box>
        )}
        {taskRows.map(row => (
          <Text
            key={`task-${row.task.id}`}
            color={row.task.status === 'completed' ? C.muted : C.text}
            wrap={endWrap(data.icons)}
          >
            {row.label}
          </Text>
        ))}
        {hiddenTasks > 0 && <Text color={C.muted}>{`${hiddenTasks} more tasks`}</Text>}
      </Box>
    </Box>
  )
  return { header, content }
}
