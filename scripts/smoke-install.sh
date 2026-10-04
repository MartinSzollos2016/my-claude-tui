#!/usr/bin/env bash
# Installs tail-view through this repo's marketplace into a throwaway HOME,
# the way a user would, and checks that Claude Code loads its hooks module
# and registers its commands. Needs no credentials: the session stops at the
# login check, after plugins load.
set -euo pipefail

repo="$(cd "$(dirname "$0")/.." && pwd)"
home="$(mktemp -d)"
trap 'rm -rf "$home"' EXIT
export HOME="$home"
unset ANTHROPIC_API_KEY

claude plugin marketplace add "$repo" >/dev/null
claude plugin install tail-view@my-claude-tui >/dev/null
claude plugin list | grep -A4 'tail-view@my-claude-tui' | grep -q 'enabled'

claude --debug -p noop </dev/null >/dev/null 2>&1 || true
log="$(cat "$home"/.claude/debug/*.txt)"
grep -q 'hooks module tail-view@my-claude-tui loaded' <<<"$log"
grep -q 'plugin.register: tail-view .* admitted' <<<"$log"
for command in tail tail-turns tail-width tail-compact tail-icons tail-bar tail-status tail-help; do
  grep -q "(tail-view): /$command listed" <<<"$log" || { echo "missing /$command"; exit 1; }
done
echo "tail-view installs from the marketplace and loads"
