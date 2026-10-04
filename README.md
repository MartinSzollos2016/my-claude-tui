# tail-view (my-claude-tui)

A Claude Code mod that brings [tail-claude](https://github.com/kylesnowschwartz/tail-claude)'s **detail view** and
**info bar** into Claude Code itself.

- **Detail pane** (`/tail`): the current turn as rows (outputs, tool calls with
  one-line summaries, durations). Click a row (or Enter on it) to expand it.
  An expanded tool call shows **what went in apart from what came out**, each
  in a rounded frame colored by the theme:

  | Frame                        | Shows                                                                     | Color (theme key) |
  | ---------------------------- | ------------------------------------------------------------------------- | ----------------- |
  | `$ command` / query          | Bash command, Grep/Glob pattern, Web URL or query                         | `permission`      |
  | read / write / input / todos | file path, written file (highlighted by extension), JSON input, todo list | `suggestion`      |
  | diff                         | Edit as `-`/`+` diff                                                      | `autoAccept`      |
  | output                       | result, with `ok · N lines`                                               | `success`         |
  | error                        | failed result                                                             | `error`           |

  Subagent rows drill into the agent's **Execution Trace** (nested,
  expandable). Header: model, tool/output counts, subagent icons, tokens,
  ctx %, duration.

- **Layout**: the pane asks for **80 %** of the terminal (`/tail width 30–80`
  sets the share, kept across sessions; a width you drag the dock to wins),
  and the transcript on the left stays a **conversation**: tool results are
  one dim line (`⎿ 12 lines`, errors in red with their first line) and tool
  groups stay folded, since the detail is in the pane. `/tail compact`
  switches this off and on.
- **Long output**: results, inputs and outputs are previewed (100 lines /
  8k chars for results, 60 lines for code) with a **show all** / **show less**
  toggle per block. Claude Code refuses a pane with a text over 10k
  characters or 100k characters in total, so long blocks are cut into pieces
  and the pane keeps a 70k text budget; past it a block says so instead of
  breaking the pane.
- **Info bar** above the prompt: project · branch(*dirty) · permission mode ·
  running agents, and context tokens/% plus cost on the right. `/tail bar`
  toggles it.
- **Themes** (`/tail theme`): black/white pane column and frame, see below.

Data comes from the engine (`$.session.messages`, `$.agent.list`,
`$.session.usage`), not from parsing JSONL; durations are measured live by the
`tool.call` / `turn.complete` hooks, so turns from before the session loaded
the mod show no timing.

## Theme

Every color is a Claude Code **theme key** (`success`, `warning`, `planMode`,
…, see `hooks/theme.ts`), so the mod follows `/theme` (dark, light,
daltonized, ANSI) including a switch mid-session. The pane body is painted
with `inverseText` (black on dark themes, white on light ones) instead of the
engine's grey sidebar fill, for full text contrast.

The pane's column and frame are painted by Claude Code itself with the
`composerSidebarBackground` key, which a plugin cannot draw over. The plugin
therefore ships a variant of each built-in theme in `themes/` that overrides
only that key (black on dark themes, white on light ones):

| Built-in                                  | tail-view variant                          |
| ----------------------------------------- | ------------------------------------------ |
| `dark`, `dark-daltonized`, `dark-ansi`    | `Tail Dark …` (`custom:tail-view:dark…`)   |
| `light`, `light-daltonized`, `light-ansi` | `Tail Light …` (`custom:tail-view:light…`) |

Claude Code only lets plugins set the built-in themes, so pick the variant
in `/theme`; `/tail theme` names the one matching your current theme.

## Security

- Transcript text (tool results, model output, tool inputs) is untrusted and
  passes through `sanitizeText`: ANSI/OSC/DCS escape sequences, C0/C1
  controls (bar tab and newline) and bidi overrides are stripped before drawing.
- `git status` runs with `-c core.fsmonitor=false` and `--no-optional-locks`:
  a cloned repo's config cannot make the info bar execute a program.
- Persisted state is bounded (timings, turn stats, expanded rows).

## Commands

Each command shows up in the slash menu; `/tail <sub>` works too
(`/tail width 70`, `/tail help`).

| Command               | What it does                                                     |
| --------------------- | ---------------------------------------------------------------- |
| `/tail`               | open the detail pane at its width share                          |
| `/tail-turns`         | list the session's turns (newest first) and open one in the pane |
| `/tail-width <30-80>` | pane width as % of the terminal, kept across sessions            |
| `/tail-theme`         | name the `Tail …` theme matching yours, to pick in `/theme`      |
| `/tail-compact`       | toggle one-line tool results in the transcript                   |
| `/tail-bar`           | show or hide the info bar above the prompt                       |
| `/tail-help`          | list the commands and pane keys                                  |

## Keys (pane focused: `/tail`, or ctrl+x tab)

| Key                    | Action                                                     |
| ---------------------- | ---------------------------------------------------------- |
| Tab / shift+Tab        | move between rows                                          |
| Enter / click on a row | expand / collapse row, drill into subagent                 |
| `p` / `n` / `l`        | previous / next / latest turn                              |
| `t` / `d`              | turn list / back to detail; Enter or click a turn opens it |
| `e` / `c`              | expand all / collapse all                                  |
| Esc                    | back to the prompt                                         |

## Requirements

- Claude Code 2.1.289 or newer (function-hook plugins, early access API)
- A [Nerd Font](https://www.nerdfonts.com/) in the terminal for the icons
- `git` on `PATH` for the branch in the info bar (optional)

## Run

```bash
claude --plugin-dir ~/Sites/claude/my-claude-tui
```

The pane docks beside the transcript in fullscreen from 144 columns on its
own; on narrower terminals open it with `/tail`. Nerd Font glyphs as in
tail-claude.

## Develop

```bash
npm install          # prettier and typescript (exact versions, lockfile)
npm run format       # format everything with Prettier
npm run check        # format check, typecheck, plugin validate, tests
```

`npm run typecheck` needs the types Claude Code lays into
`.claude-plugin/types/` once it has loaded the plugin.

- `hooks/model.ts` – pure: rows → turns → items and sections, tool summaries
  (ported from agent-ouija `claude/tools/summary.go`), formatters
- `hooks/view.tsx` – rendering of pane and bar
- `hooks/theme.ts` – theme keys, semantic color roles, section tones
- `hooks/commands.ts` – slash commands and help
- `hooks/register.tsx` – event wiring and state
- `types/index.d.ts` – the `$.state` contract

## Contributing

Commits follow [Conventional Commits](https://www.conventionalcommits.org/)
prefixed with a [gitmoji](https://gitmoji.dev/):

```
✨ feat(view): add subagent execution trace
🐛 fix(view): cap text blocks below the engine limit
```

Before committing: `npm run check` must pass.

## License

[MIT](LICENSE) © 2026 Martin Szollos.

Parts of the tool summaries, formatters, layout and color roles are ported
from [tail-claude](https://github.com/kylesnowschwartz/tail-claude) and
[agent-ouija](https://github.com/kylesnowschwartz/agent-ouija) by Kyle Snow
Schwartz, also MIT; their notice is reproduced in [LICENSE](LICENSE).
