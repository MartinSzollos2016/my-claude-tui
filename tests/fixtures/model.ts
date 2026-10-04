import type { SessionMessage } from 'claude-code'
import type { ToolItem } from '../../hooks/model/types'
const prompt = (text: string): SessionMessage => ({ role: 'user', text, toolUses: [] })

export const transcript: SessionMessage[] = [
  prompt('Fix the bug'),
  {
    role: 'assistant',
    text: 'Looking.',
    toolUses: [
      { tool_use_id: 'r1', tool: 'Read', input: { file_path: '/a/b/c/main.go' }, text: 'package main' },
      {
        tool_use_id: 'a1',
        tool: 'Agent',
        input: { subagent_type: 'Explore', description: 'Find callers' },
        agentId: 'agent-1',
        text: 'done',
        durationMs: 4200,
      },
    ],
  },
  {
    role: 'user',
    text: '',
    toolUses: [],
    toolResults: [{ tool_use_id: 'r1', text: 'package main', isError: false, result: null } as never],
  },
  {
    role: 'assistant',
    text: 'Fixed.',
    toolUses: [{ tool_use_id: 'b1', tool: 'Bash', input: { command: 'go test ./...' } }],
  },
  prompt('Thanks'),
  { role: 'assistant', text: 'You are welcome.', toolUses: [] },
]

export const tool = (over: Partial<ToolItem>): ToolItem => ({
  kind: 'tool',
  id: 't',
  tool: 'Bash',
  input: {},
  summary: '',
  isError: false,
  isPending: false,
  ...over,
})
