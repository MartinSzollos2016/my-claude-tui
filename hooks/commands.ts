// The slash commands tail-view registers. Each subcommand is its own command
// so the slash menu lists it; `/tail <sub>` stays as a shorthand.

import { ICON_SETS, type Icons } from './icons'

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
    description: 'Show or set the detail pane width as a share of the terminal (30-80 %)',
    argumentHint: '[30-80]',
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
    description:
      'Status line under the prompt (off by default), spinner text and turn counts (on); on|off sets all three',
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
// `/tail width 70` both give ['width', '70']; a bare `/tail` opens the pane,
// `/tail foo` is 'unknown' with the word it did not know.
export function parseCommand(
  command: string,
  args: string,
): { sub: Subcommand | 'open' | 'unknown'; arg: string } | undefined {
  const spec = COMMANDS.find(c => c.name === command)
  if (!spec) return undefined
  const trimmed = args.trim()
  if (spec.sub) return { sub: spec.sub, arg: trimmed }
  const [first = '', ...rest] = trimmed.split(/\s+/)
  const sub = COMMANDS.find(c => c.sub === first)?.sub
  if (sub) return { sub, arg: rest.join(' ') }
  return first === '' ? { sub: 'open', arg: '' } : { sub: 'unknown', arg: first }
}

// The answer to `/tail <word>` with a word that is no subcommand.
export function unknownText(word: string): string {
  const subs = COMMANDS.flatMap(c => (c.sub ? [c.sub] : []))
  return `Unknown /tail subcommand "${word}". Valid: ${subs.join(', ')}. /tail alone opens the pane, /tail-help lists the keys.`
}

// The commands, the keys and what the header's glyphs count, in the icon set
// the pane draws.
export function helpText(icons: Icons = ICON_SETS.nerd): string {
  const width = Math.max(...COMMANDS.map(c => `/${c.name}${c.argumentHint ? ` ${c.argumentHint}` : ''}`.length))
  const lines = COMMANDS.map(
    c => `  ${`/${c.name}${c.argumentHint ? ` ${c.argumentHint}` : ''}`.padEnd(width)}  ${c.description}`,
  )
  return [
    'tail-view commands:',
    ...lines,
    '',
    'In the pane: Tab/shift+Tab move, Enter or click expands a row, p/n/l previous/next/latest turn,',
    't turn list, d detail view, s search turns, m team board, j/k move the row cursor, o opens it, y copies it, e/c expand/collapse all,',
    'f/b page the pane down/up (the wheel and PgUp/PgDn scroll it too), "show all" opens a long block,',
    '"copy" copies it whole, h shows or hides all keys in the footer, Esc returns to the prompt.',
    'ctrl+x tab or a click gives the pane the keys (twice while the info bar shows).',
    `The header shows ${icons.wrench} tool calls, ${icons.output} outputs, ${icons.thinking} thinking blocks and ${icons.robot} a subagent each;`,
    `at the right ${icons.token} tokens, context use (meter and percent), ${icons.clock} duration and the end time.`,
  ].join('\n')
}
