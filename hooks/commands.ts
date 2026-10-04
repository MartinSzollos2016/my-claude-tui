// The slash commands tail-view registers. Each subcommand is its own command
// so the slash menu lists it; `/tail <sub>` stays as a shorthand.

export type Subcommand = 'bar' | 'compact' | 'width' | 'theme' | 'help'

export type CommandSpec = {
  name: string
  description: string
  argumentHint?: string
  sub?: Subcommand
}

export const COMMANDS: readonly CommandSpec[] = [
  { name: 'tail', description: 'Open the tail-view detail pane (tool calls, subagents)', argumentHint: '[bar|compact|width N|theme|help]' },
  { name: 'tail-width', description: 'Set the detail pane width as a share of the terminal (30-80 %)', argumentHint: '<30-80>', sub: 'width' },
  { name: 'tail-theme', description: 'Name the tail-view theme with a black/white pane frame for /theme', sub: 'theme' },
  { name: 'tail-compact', description: 'Toggle one-line tool results in the transcript', sub: 'compact' },
  { name: 'tail-bar', description: 'Show or hide the tail-view info bar above the prompt', sub: 'bar' },
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
  const lines = COMMANDS.map(c => `  ${`/${c.name}${c.argumentHint ? ` ${c.argumentHint}` : ''}`.padEnd(width)}  ${c.description}`)
  return [
    'tail-view commands:',
    ...lines,
    '',
    'In the pane: Tab/shift+Tab move, Enter or click expands a row, p/n/l previous/next/latest turn,',
    'e/c expand/collapse all, "show all" opens a long block, Esc returns to the prompt.',
  ].join('\n')
}
