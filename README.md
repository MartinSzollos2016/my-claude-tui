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
claude plugin marketplace add MartinSzollos2016/my-claude-tui
claude plugin install tail-view@my-claude-tui
```

Or in Claude Code: `/plugin` → add the marketplace `MartinSzollos2016/my-claude-tui` → install
`tail-view`. Update with `claude plugin update tail-view@my-claude-tui`.

To run a local checkout instead: `claude --plugin-dir path/to/my-claude-tui`.

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

## What the plugin does on your machine

- **Reads** the current session through Claude Code's plugin API: the conversation and its tool
  calls and results, the session's agents, context usage and cost, and the permission mode from
  the prompt hook. It keeps its own UI state (expanded rows, timings) in the session and two
  preferences (pane width, compact transcript) in Claude Code's plugin store.
- **Runs no programs.** The branch in the info bar is read from the repository's `.git/HEAD`
  (through a worktree's `.git` file when there is one).
- **Sends nothing out**: no network requests, no telemetry. Everything it reads is drawn in the
  pane, the info bar and the transcript of the same session.
- **Hooks**: its own slash commands (`command.run`, registered per command, so it never sees
  others); `tool.call` and `turn.complete` to time calls and turns, passing each call on
  unchanged; `prompt.submit` and the `UserPromptSubmit` prompt hook to note the prompt and the
  permission mode, passing both on unchanged; `ui.render` to draw the pane, the info bar and the
  compact tool rows in the transcript. It makes no permission decisions and changes no settings.

## Security

- Text from the transcript is untrusted: terminal escape sequences, control characters and
  bidi overrides are stripped before drawing, and parsing is linear in the input length.
- No programs are started: the branch is read from `.git/HEAD`, so a cloned repository's
  config cannot run anything through the info bar.

## Develop

```bash
npm install       # dev tools, and the husky pre-push hook
npm run format    # Prettier
npm run check     # format check, knip, typecheck, plugin validate, tests
npm run coverage  # Istanbul coverage of the unit-tested logic (coverage/index.html)
```

`npm run typecheck` needs the plugin API types Claude Code writes to `.claude-plugin/types/`
when it loads the plugin. The pre-push hook runs `npm run check`, `npm run coverage` and
`npm audit`; CI runs the same plus gitleaks and an install from the marketplace
(`scripts/smoke-install.sh`).

Coverage (Vitest with Istanbul) measures the unit tests and the hook wiring: `tests/register.vitest.ts`
runs `register.tsx`'s hooks against a fake engine (`tests/coverage/engine.ts`), while the render tests
drive the same hooks inside Claude Code's sandboxed test runner, which cannot be instrumented. Floors
are enforced in CI and the pre-push hook.

Commits use [Conventional Commits](https://www.conventionalcommits.org/) with a
[gitmoji](https://gitmoji.dev/), e.g. `✨ feat(view): add turn list`.

## License

[MIT](LICENSE). Tool summaries, formatters, layout and colors are ported from
[tail-claude](https://github.com/kylesnowschwartz/tail-claude) and
[agent-ouija](https://github.com/kylesnowschwartz/agent-ouija) (MIT, Kyle Snow Schwartz); their
notice is in [LICENSE](LICENSE).
