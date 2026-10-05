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

// A fake engine (tests/coverage/engine.ts) counts each state round trip, as
// the engine's $.state.get and $.state.set would be.
type Tracked = { __track?: (name: string, result: Promise<unknown>) => Promise<unknown> }
const trip = ($: object, name: string, result: Promise<unknown>): Promise<unknown> =>
  ($ as Tracked).__track?.(name, result) ?? result

export const read = async ($: object, a: AtomRef): Promise<unknown> => {
  const state = stateOf($)
  return trip($, `state.get:${a.ref.key}`, Promise.resolve(state.has(a.ref.key) ? state.get(a.ref.key) : a.initial))
}

// One read and one write, as the engine's update does them; `fn` sees the
// value at the write, as the engine's retry on a missed version would.
export const update = async ($: object, a: AtomRef, fn: (cur: unknown) => unknown): Promise<unknown> => {
  const state = stateOf($)
  await read($, a)
  const next = fn(state.has(a.ref.key) ? state.get(a.ref.key) : a.initial)
  state.set(a.ref.key, next)
  await trip($, `state.set:${a.ref.key}`, Promise.resolve())
  return next
}
