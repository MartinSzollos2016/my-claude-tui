// The few Node APIs the golden test reads and writes its fixture with; the
// project carries no @types/node.
declare module 'node:fs' {
  export function existsSync(path: string): boolean
  export function readFileSync(path: string): Uint8Array
  export function writeFileSync(path: string, data: Uint8Array): void
}
declare module 'node:path' {
  export function join(...parts: string[]): string
}
declare module 'node:zlib' {
  export function gzipSync(data: string, options?: { level?: number }): Uint8Array
  export function gunzipSync(data: Uint8Array): { toString(encoding: 'utf8'): string }
}
declare const process: { env: Record<string, string | undefined> }
declare const __dirname: string
