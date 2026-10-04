import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

// Coverage for the logic the unit tests import directly. The engine-mounted
// render tests (tests/render.test.tsx) run only under `claude plugin test`,
// whose sandbox cannot be instrumented.
export default defineConfig({
  resolve: {
    alias: {
      'claude-code/testing': 'vitest',
      'claude-code': fileURLToPath(new URL('./tests/coverage/claude-code.ts', import.meta.url)),
    },
  },
  oxc: { jsx: { runtime: 'classic', pragma: 'h', pragmaFrag: 'Fragment' } },
  test: {
    include: ['tests/model.test.ts', 'tests/theme.test.ts'],
    coverage: {
      provider: 'istanbul',
      include: ['hooks/**/*.{ts,tsx}'],
      reporter: ['text', 'html', 'lcov', 'json-summary'],
      reportsDirectory: 'coverage',
    },
  },
})
