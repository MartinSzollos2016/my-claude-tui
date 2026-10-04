// Inside Claude Code, JSX compiles against the engine's global h; under
// Vitest the views need a stand-in that calls element constructors.
type Component = (props: Record<string, unknown>) => unknown

const createElement = (type: Component | string, props: Record<string, unknown> | null, ...children: unknown[]) =>
  typeof type === 'function' ? type({ ...props, children: children.flat() }) : { type, props, children }

Object.assign(globalThis, { h: createElement, Fragment: 'Fragment' })
