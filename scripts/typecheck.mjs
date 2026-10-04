// Runs tsc once Claude Code has laid its plugin API types into
// .claude-plugin/types/ (it does on loading the plugin), and says how to get
// them when they are missing instead of failing on hundreds of unknown names.
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'

if (!existsSync('.claude-plugin/types/claude-code/index.d.ts')) {
  console.error('Missing .claude-plugin/types/: load the plugin once with `claude --plugin-dir .` to generate them.')
  process.exit(1)
}

const { status } = spawnSync('tsc', ['-p', '.'], { stdio: 'inherit', shell: process.platform === 'win32' })
process.exit(status ?? 1)
