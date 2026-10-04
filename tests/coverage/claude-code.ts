// Stand-ins for the engine's runtime exports, so the pure modules can be
// imported outside Claude Code for coverage. register.tsx only calls read
// and update inside hooks; at import time it creates atoms.
const needsEngine = () => {
  throw new Error('needs the Claude Code engine')
}

export const atom = (ref: unknown, initial: unknown) => ({ ref, initial })
export const read = needsEngine
export const update = needsEngine
