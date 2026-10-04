// Values read from untyped input (a tool's input record, a result's text).

export const str = (f: Record<string, unknown>, key: string): string =>
  typeof f[key] === 'string' ? (f[key] as string) : ''

export const num = (f: Record<string, unknown>, key: string): number =>
  typeof f[key] === 'number' ? Math.trunc(f[key] as number) : 0

export const lineCount = (s: string) => s.split('\n').length
