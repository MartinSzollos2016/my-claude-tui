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
    setupFiles: ['tests/coverage/setup.ts'],
    include: [
      'tests/model.test.ts',
      'tests/theme.test.ts',
      'tests/summaries.test.ts',
      'tests/view.test.tsx',
      'tests/session.test.ts',
      'tests/register.vitest.ts',
    ],
    coverage: {
      provider: 'istanbul',
      include: ['hooks/**/*.{ts,tsx}'],
      reporter: ['text', 'html', 'lcov', 'json-summary'],
      reportsDirectory: 'coverage',
      // Floors just under the current numbers, so coverage cannot quietly
      // drop. register.tsx is engine wiring that only the render tests reach.
      thresholds: {
        lines: 70,
        statements: 70,
        functions: 50,
        branches: 70,
        'hooks/{model,theme,commands}.ts': { lines: 98, statements: 98, functions: 98, branches: 90 },
        'hooks/view.tsx': { lines: 95, statements: 95, functions: 90, branches: 85 },
      },
    },
  },
})
