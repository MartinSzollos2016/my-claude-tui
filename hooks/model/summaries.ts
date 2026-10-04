// Per-tool one-line summaries (ported from agent-ouija claude/tools/summary.go)
// and the category each tool falls in.
import { SUBAGENT_TOOLS, type Item } from './types'
import { lineCount, num, str } from './values'
import { basename, shortPath, truncate } from './width'

export function toolSummary(name: string, f: Record<string, unknown>): string {
  switch (name) {
    case 'Read': {
      const fp = str(f, 'file_path')
      if (!fp) return 'Read'
      const limit = num(f, 'limit')
      if (limit > 0) {
        const offset = num(f, 'offset') || 1
        return `${shortPath(fp, 2)} - lines ${offset}-${offset + limit - 1}`
      }
      return shortPath(fp, 2)
    }
    case 'Write': {
      const fp = str(f, 'file_path')
      if (!fp) return 'Write'
      const content = str(f, 'content')
      return content ? `${shortPath(fp, 2)} - ${lineCount(content)} lines` : shortPath(fp, 2)
    }
    case 'Edit': {
      const fp = str(f, 'file_path')
      if (!fp) return 'Edit'
      const oldS = str(f, 'old_string')
      const newS = str(f, 'new_string')
      if (oldS && newS) {
        const a = lineCount(oldS)
        const b = lineCount(newS)
        if (a === b) return `${shortPath(fp, 2)} - ${a} line${a > 1 ? 's' : ''}`
        return `${shortPath(fp, 2)} - ${a} -> ${b} lines`
      }
      return shortPath(fp, 2)
    }
    case 'Bash': {
      const desc = str(f, 'description')
      const cmd = str(f, 'command')
      if (desc && cmd) return truncate(`${desc}: ${cmd}`, 60)
      if (desc || cmd) return truncate(desc || cmd, 60)
      return 'Bash'
    }
    case 'Grep':
    case 'Glob': {
      const pattern = str(f, 'pattern')
      if (!pattern) return name
      const pat = `"${truncate(pattern, 30)}"`
      const glob = name === 'Grep' ? str(f, 'glob') : ''
      if (glob) return `${pat} in ${glob}`
      const p = str(f, 'path')
      return p ? `${pat} in ${basename(p)}` : pat
    }
    case 'Task':
    case 'Agent':
    case 'Skill': {
      const type = str(f, 'subagent_type') || str(f, 'skill')
      const desc = str(f, 'description')
      const prefix = type ? `${type} - ` : ''
      if (desc) return prefix + truncate(desc, 40)
      return type || 'Task'
    }
    case 'Workflow':
      return str(f, 'name') || (str(f, 'scriptPath') ? basename(str(f, 'scriptPath')) : 'inline script')
    case 'LSP': {
      const op = str(f, 'operation')
      if (!op) return 'LSP'
      const fp = str(f, 'filePath')
      return fp ? `${op} - ${basename(fp)}` : op
    }
    case 'WebFetch': {
      const raw = str(f, 'url')
      if (!raw) return 'WebFetch'
      try {
        const u = new URL(raw)
        return truncate(u.hostname + u.pathname, 50)
      } catch {
        return truncate(raw, 50)
      }
    }
    case 'WebSearch': {
      const q = str(f, 'query')
      return q ? `"${truncate(q, 40)}"` : 'WebSearch'
    }
    case 'TodoWrite': {
      const todos = f['todos']
      if (!Array.isArray(todos)) return 'TodoWrite'
      return `${todos.length} item${todos.length === 1 ? '' : 's'}`
    }
    case 'NotebookEdit': {
      const nb = str(f, 'notebook_path')
      if (!nb) return 'NotebookEdit'
      const mode = str(f, 'edit_mode')
      return mode ? `${mode} - ${basename(nb)}` : basename(nb)
    }
    case 'TaskCreate':
      return str(f, 'subject') ? truncate(str(f, 'subject'), 50) : 'Create task'
    case 'TaskUpdate': {
      const parts: string[] = []
      if (str(f, 'taskId')) parts.push(`#${str(f, 'taskId')}`)
      if (str(f, 'status')) parts.push(str(f, 'status'))
      if (str(f, 'owner')) parts.push(`-> ${str(f, 'owner')}`)
      return parts.length > 0 ? parts.join(' ') : 'Update task'
    }
    case 'SendMessage': {
      const type = str(f, 'type')
      const to = str(f, 'recipient') || str(f, 'to')
      const summary = str(f, 'summary')
      if (type === 'shutdown_request' && to) return `Shutdown ${to}`
      if (type === 'shutdown_response') return 'Shutdown response'
      if (type === 'broadcast') return `Broadcast: ${truncate(summary, 30)}`
      if (to) return `To ${to}: ${truncate(summary || str(f, 'message'), 30)}`
      return 'Send message'
    }
    case 'ToolSearch':
      return str(f, 'query') ? truncate(str(f, 'query'), 50) : 'ToolSearch'
    default:
      return summaryDefault(name, f)
  }
}

function summaryDefault(name: string, f: Record<string, unknown>): string {
  for (const key of ['name', 'path', 'file', 'query', 'command']) {
    if (str(f, key)) return truncate(str(f, key), 50)
  }
  for (const key of Object.keys(f).sort()) {
    if (str(f, key)) return truncate(str(f, key), 40)
  }
  return name
}

export type ToolCategory = 'read' | 'edit' | 'search' | 'task' | 'web' | 'other'

export function toolCategory(name: string): ToolCategory {
  switch (name) {
    case 'Read':
      return 'read'
    case 'Edit':
    case 'MultiEdit':
    case 'Write':
    case 'NotebookEdit':
      return 'edit'
    case 'Grep':
    case 'Glob':
      return 'search'
    case 'Task':
    case 'Agent':
    case 'Skill':
    case 'Workflow':
      return 'task'
    case 'WebFetch':
    case 'WebSearch':
      return 'web'
    default:
      return 'other'
  }
}

// Display name for a row: the subagent type for Agent calls, the tool otherwise.
export function itemName(item: Item): string {
  if (item.kind === 'output') return 'Output'
  if (SUBAGENT_TOOLS.has(item.tool)) return str(item.input, 'subagent_type') || 'Subagent'
  if (item.tool.startsWith('mcp__')) return item.tool.split('__').at(-1) ?? item.tool
  return item.tool
}

export function itemSummary(item: Item): string {
  if (item.kind === 'output') return truncate(item.text, 40)
  if (SUBAGENT_TOOLS.has(item.tool)) return str(item.input, 'description') || item.summary
  return item.summary === item.tool ? '' : item.summary
}
