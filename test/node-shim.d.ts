// Minimal ambient types so tests typecheck without adding @types/node.
declare module "node:test" { const test: (name: string, fn: () => void | Promise<void>) => void; export default test; }
declare module "node:assert/strict" {
  const assert: { (v: unknown, m?: string): void; ok(v: unknown, m?: string): void; equal(a: unknown, b: unknown, m?: string): void; notEqual(a: unknown, b: unknown): void; deepEqual(a: unknown, b: unknown): void; match(s: string, r: RegExp): void; throws(f: () => unknown): void; };
  export default assert;
}
declare module "node:crypto" { export function createHash(a: string): { update(s: string): { digest(e: "hex"): string } }; }
