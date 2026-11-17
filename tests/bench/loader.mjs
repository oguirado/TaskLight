// Resolve the project's extensionless TS imports; Node performs native type stripping.
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith('.') && context.parentURL) {
    const url = new URL(specifier, context.parentURL);
    for (const suffix of ['.ts', '/index.ts']) {
      const candidate = new URL(url.href + suffix);
      if (existsSync(fileURLToPath(candidate))) return nextResolve(candidate.href, context);
    }
  }
  return nextResolve(specifier, context);
}
