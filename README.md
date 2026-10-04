# tail-view

[![CI](https://github.com/MartinSzollos2016/my-claude-tui/actions/workflows/ci.yml/badge.svg)](https://github.com/MartinSzollos2016/my-claude-tui/actions/workflows/ci.yml)

A Claude Code plugin that brings the detail view and info bar of
[tail-claude](https://github.com/kylesnowschwartz/tail-claude) into Claude Code.

- **Detail pane**: the current turn as rows (model output, tool calls, subagents with their
  execution trace). Expanding a tool call shows its input and its output in separate frames.
- **Compact transcript**: tool calls and results take one line each in the conversation; the
  detail is in the pane.
- **Info bar** above the prompt: project, git branch, permission mode, running agents,
  context usage and cost.

Colors are Claude Code theme keys, so the plugin follows `/theme`.

## Install

Requires Claude Code 2.1.289 or newer and a [Nerd Font](https://www.nerdfonts.com/) for the
icons.

```bash
git clone https://github.com/MartinSzollos2016/my-claude-tui.git
claude --plugin-dir my-claude-tui
```

## Commands

| Command               | What it does                                                |
| --------------------- | ----------------------------------------------------------- |
| `/tail`               | open the detail pane                                        |
| `/tail-turns`         | list the session's turns and open one in the pane           |
| `/tail-width <30-80>` | pane width as % of the terminal (default 80, kept)          |
| `/tail-compact`       | toggle the compact transcript (on by default, kept)         |
| `/tail-bar`           | show or hide the info bar                                   |
| `/tail-theme`         | name the `Tail …` theme matching yours, to pick in `/theme` |
| `/tail-help`          | list commands and keys                                      |

`/tail <sub>` works too, e.g. `/tail width 70`.

## Keys in the pane

| Key                    | Action                                    |
| ---------------------- | ----------------------------------------- |
| Tab / shift+Tab        | move between rows                         |
| Enter / click on a row | expand or collapse, drill into a subagent |
| `p` / `n` / `l`        | previous / next / latest turn             |
| `t` / `d`              | turn list / back to detail                |
| `e` / `c`              | expand all / collapse all                 |
| Esc                    | back to the prompt                        |

Long blocks show a preview with **show all** / **show less**.

## Themes

Claude Code paints the pane's frame grey and plugins cannot draw over it. `themes/` ships a
variant of each built-in theme with a black (dark themes) or white (light themes) frame. Pick
one in `/theme`; `/tail-theme` tells you which.

## Security

- Text from the transcript is untrusted: terminal escape sequences, control characters and
  bidi overrides are stripped before drawing, and parsing is linear in the input length.
- `git status` runs with `core.fsmonitor` disabled, so a cloned repository's config cannot run
  a program through the info bar.

## Develop

```bash
npm install       # dev tools, and the husky pre-push hook
npm run format    # Prettier
npm run check     # format check, knip, typecheck, plugin validate, tests
```

`npm run typecheck` needs the plugin API types Claude Code writes to `.claude-plugin/types/`
when it loads the plugin. The pre-push hook runs `npm run check` and `npm audit`; CI runs the
same checks plus gitleaks.

Commits use [Conventional Commits](https://www.conventionalcommits.org/) with a
[gitmoji](https://gitmoji.dev/), e.g. `✨ feat(view): add turn list`.

## License

[MIT](LICENSE). Tool summaries, formatters, layout and colors are ported from
[tail-claude](https://github.com/kylesnowschwartz/tail-claude) and
[agent-ouija](https://github.com/kylesnowschwartz/agent-ouija) (MIT, Kyle Snow Schwartz); their
notice is in [LICENSE](LICENSE).
