// Ambient declarations so the plugin can use a few Node globals/modules without
// pulling in the full @types/node dependency. This is a script (no import/export)
// so `declare module` here introduces ambient modules rather than augmenting.

declare const process: {
  env: Record<string, string | undefined>
  exit(code?: number): never
}

declare class TextEncoder {
  encode(input?: string): Uint8Array
}

declare module "node:fs" {
  export function readFileSync(path: string, encoding: string): string
  export function statSync(path: string): { mtimeMs: number }
}
