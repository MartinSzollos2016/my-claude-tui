# tail-view

[![CI](https://github.com/MartinSzollos2016/my-claude-tui/actions/workflows/ci.yml/badge.svg)](https://github.com/MartinSzollos2016/my-claude-tui/actions/workflows/ci.yml)

A Claude Code plugin that brings the detail view and info bar of
[tail-claude](https://github.com/kylesnowschwartz/tail-claude) into Claude Code.

- **Detail pane**: the current turn as rows (thinking, model output, tool calls, subagents with their
  execution trace). Expanding a tool call shows its input and its output in separate frames.
- **Compact transcript**: tool calls and results take one line each in the conversation; the
  detail is in the pane.
- **Info bar** above the prompt: project, git branch, permission mode, running agents and a running Workflow,
  context usage and cost.
- **Team board** (`m` in the pane, in a team session): teammates with their status and the tasks
  from `TaskCreate` / `TaskUpdate`.

Colors are Claude Code theme keys, so the plugin follows `/theme`.

## Install

Requires Claude Code 2.1.289 or newer. The default icons need a [Nerd Font](https://www.nerdfonts.com/);
without one, `/tail-icons unicode` or `/tail-icons ascii` switches to plain symbols.

```bash
claude plugin marketplace add MartinSzollos2016/my-claude-tui
claude plugin install tail-view@my-claude-tui
```

Or in Claude Code: `/plugin` → add the marketplace `MartinSzollos2016/my-claude-tui` → install
`tail-view`. Update with `claude plugin update tail-view@my-claude-tui`.

To run a local checkout instead: `claude --plugin-dir path/to/my-claude-tui`.

## Commands

| Command                  | What it does                                                                    |
| ------------------------ | ------------------------------------------------------------------------------- |
| `/tail`                  | open the detail pane                                                            |
| `/tail-turns`            | list the session's turns and open one in the pane                               |
| `/tail-width <30-80>`    | pane width as % of the terminal (default 80, kept)                              |
| `/tail-compact`          | toggle the compact transcript (on by default, kept)                             |
| `/tail-icons [set]`      | icon set: `nerd` (default), `unicode` or `ascii`                                |
| `/tail-bar`              | show or hide the info bar                                                       |
| `/tail-status [on\|off]` | status line, spinner text and turn counts while tools run (on by default, kept) |
| `/tail-notify [on\|off]` | toast when a subagent or workflow finishes (off by default, kept)               |
| `/tail-help`             | list commands and keys                                                          |

`/tail <sub>` works too, e.g. `/tail width 70`.

In VS Code and `claude -p`, where no pane is drawn, `/tail` and `/tail-turns` answer with the same content as text.

## Keys in the pane

| Key                    | Action                                                    |
| ---------------------- | --------------------------------------------------------- |
| Tab / shift+Tab        | move between rows                                         |
| Enter / click on a row | expand or collapse, drill into a subagent                 |
| `p` / `n` / `l`        | previous / next / latest turn                             |
| `t` / `d`              | turn list / back to detail                                |
| `s`                    | search the turn list (Enter opens the newest match)       |
| `m`                    | team board: teammates and tasks (shown in a team session) |
| `j` / `k` / `o` / `y`  | cursor down / up a row, open or close it, copy it         |
| `e` / `c`              | expand all / collapse all                                 |
| Esc                    | back to the prompt                                        |

Hovering a collapsed row previews its input in a card. Long blocks show a preview with **show all** / **show less**; **copy** in a section's frame copies the whole block.

## Pane frame

Claude Code paints the pane's frame grey and a plugin cannot change it.

## What the plugin does on your machine

- **Reads** the current session through Claude Code's plugin API: the conversation and its tool
  calls and results, the session's agents, context usage and cost, and the permission mode from
  the prompt hook. It keeps its own UI state (expanded rows, timings) in the session and five
  preferences (pane width, compact transcript, icon set, status line, notifications) in Claude
  Code's plugin store.
- **Runs no programs.** The branch in the info bar is read from the repository's `.git/HEAD`
  (through a worktree's `.git` file when there is one).
- **Sends nothing out**: no network requests, no telemetry. Everything it reads is drawn in the
  pane, the info bar and the transcript of the same session.
- **Hooks**: its own slash commands (`command.run`, registered per command, so it never sees
  others); `tool.call`, `turn.start` and `turn.complete` to time calls and turns and match each
  turn to its prompt, passing each on unchanged; `prompt.submit` and the `UserPromptSubmit`
  prompt hook to note the prompt and the permission mode, passing both on unchanged; `ui.render`
  to draw the pane, the info bar and the compact tool rows in the transcript, to name the running
  tool in the transcript's spinner and to add the tool and agent counts to a turn's "Baked for
  3s" line (both left to Claude Code with `/tail-status off`).
- **Shows** the running tool and its elapsed time in the status line under the prompt
  (`$.ui.status`, off with `/tail-status off`), and a toast when a subagent or a Workflow
  finishes (`$.ui.toast`, only after `/tail-notify on`), plus "Copied" after a copy. It makes no
  permission decisions and changes no settings.

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
