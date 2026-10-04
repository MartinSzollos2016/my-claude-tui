// The slash commands tail-view registers. Each subcommand is its own command
// so the slash menu lists it; `/tail <sub>` stays as a shorthand.

type Subcommand = 'turns' | 'bar' | 'compact' | 'icons' | 'width' | 'status' | 'notify' | 'help'

type CommandSpec = {
  name: string
  description: string
  argumentHint?: string
  sub?: Subcommand
}

export const COMMANDS: readonly CommandSpec[] = [
  {
    name: 'tail',
    description: 'Open the tail-view detail pane (tool calls, subagents)',
    argumentHint: '[turns|bar|compact|icons|width N|status|notify|help]',
  },
  { name: 'tail-turns', description: 'List the turns of this session and switch the detail pane to one', sub: 'turns' },
  {
    name: 'tail-width',
    description: 'Set the detail pane width as a share of the terminal (30-80 %)',
    argumentHint: '<30-80>',
    sub: 'width',
  },
  { name: 'tail-compact', description: 'Toggle one-line tool results in the transcript', sub: 'compact' },
  {
    name: 'tail-icons',
    description: 'Choose the icon set: Nerd Font, plain Unicode or ASCII',
    argumentHint: '[nerd|unicode|ascii]',
    sub: 'icons',
  },
  { name: 'tail-bar', description: 'Show or hide the tail-view info bar above the prompt', sub: 'bar' },
  {
    name: 'tail-status',
    description: 'Show a status line under the prompt while a tool runs',
    argumentHint: '[on|off]',
    sub: 'status',
  },
  {
    name: 'tail-notify',
    description: 'Toast when a subagent or a workflow finishes',
    argumentHint: '[on|off]',
    sub: 'notify',
  },
  { name: 'tail-help', description: 'List the tail-view commands and pane keys', sub: 'help' },
]

// Routes a run to its subcommand and argument: `/tail-width 70` and
// `/tail width 70` both give ['width', '70']; a bare `/tail` opens the pane.
export function parseCommand(command: string, args: string): { sub: Subcommand | 'open'; arg: string } | undefined {
  const spec = COMMANDS.find(c => c.name === command)
  if (!spec) return undefined
  const trimmed = args.trim()
  if (spec.sub) return { sub: spec.sub, arg: trimmed }
  const [first = '', ...rest] = trimmed.split(/\s+/)
  const sub = COMMANDS.find(c => c.sub === first)?.sub
  return sub ? { sub, arg: rest.join(' ') } : { sub: 'open', arg: trimmed }
}

export function helpText(): string {
  const width = Math.max(...COMMANDS.map(c => `/${c.name}${c.argumentHint ? ` ${c.argumentHint}` : ''}`.length))
  const lines = COMMANDS.map(
    c => `  ${`/${c.name}${c.argumentHint ? ` ${c.argumentHint}` : ''}`.padEnd(width)}  ${c.description}`,
  )
  return [
    'tail-view commands:',
    ...lines,
    '',
    'In the pane: Tab/shift+Tab move, Enter or click expands a row, p/n/l previous/next/latest turn,',
    't turn list, s search turns, m team board, j/k move the row cursor, y copies its row, e/c expand/collapse all, "show all" opens a long block,',
    '"copy" copies it whole, Esc returns to the prompt.',
  ].join('\n')
}
