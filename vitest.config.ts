import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

// Coverage for the logic the unit tests import directly, and for the hook
// wiring in register.tsx, which tests/register.vitest.ts runs against a fake
// engine. The engine-mounted render tests (tests/render.test.tsx) run only
// under `claude plugin test`, whose sandbox cannot be instrumented.
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
    include: ['tests/**/*.test.{ts,tsx}', 'tests/**/*.vitest.ts'],
    exclude: ['tests/render.test.tsx', 'tests/fixtures/**', 'tests/coverage/**'],
    coverage: {
      provider: 'istanbul',
      include: ['hooks/**/*.{ts,tsx}'],
      reporter: ['text', 'html', 'lcov', 'json-summary'],
      reportsDirectory: 'coverage',
      // Floors just under the measured numbers, so coverage cannot quietly
      // drop. register.tsx is measured through tests/register.vitest.ts,
      // which runs its hooks against a fake engine.
      thresholds: {
        lines: 80,
        statements: 80,
        functions: 70,
        branches: 75,
        'hooks/{model/**/*,theme,commands}.ts': { lines: 98, statements: 98, functions: 98, branches: 90 },
        'hooks/session.ts': { lines: 98, statements: 98, functions: 98, branches: 90 },
        'hooks/{register.tsx,session.ts}': { lines: 60, statements: 60, functions: 50, branches: 50 },
        'hooks/view/**/*.{ts,tsx}': { lines: 95, statements: 95, functions: 90, branches: 85 },
      },
    },
  },
})
