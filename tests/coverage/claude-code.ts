// Stand-ins for the engine's runtime exports, so the modules can be imported
// outside Claude Code for coverage. Atom state lives in memory per `$`, so
// tests/register.vitest.ts can run register()'s hooks against a fake engine.
type AtomRef = { ref: { key: string }; initial: unknown }

const states = new WeakMap<object, Map<string, unknown>>()

function stateOf($: object): Map<string, unknown> {
  let state = states.get($)
  if (!state) {
    state = new Map()
    states.set($, state)
  }
  return state
}

export const atom = (ref: unknown, initial: unknown) => ({ ref, initial })

export const read = async ($: object, a: AtomRef): Promise<unknown> => {
  const state = stateOf($)
  return state.has(a.ref.key) ? state.get(a.ref.key) : a.initial
}

export const update = async ($: object, a: AtomRef, fn: (cur: unknown) => unknown): Promise<unknown> => {
  const state = stateOf($)
  const next = fn(state.has(a.ref.key) ? state.get(a.ref.key) : a.initial)
  state.set(a.ref.key, next)
  return next
}
