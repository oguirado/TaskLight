// Static scanner for repo/extension (shared by static.test.ts; control cases exercise it on planted text).
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve, dirname, relative } from "node:path";

export const EXT_DIR = resolve(__dirname, "../../../extension");
export const REPO_DIR = resolve(__dirname, "../../..");
export const FORBIDDEN: Array<[string, RegExp]> = [
  ["firebase import/path", /firebase\//],
  ["firebase module", /from\s+["']firebase|require\(\s*["']firebase|import\(\s*["']firebase/],
  ["getAI", /\bgetAI\b/],
  ["generateContent", /generateContent/],
  ["initializeDeviceModel", /initializeDeviceModel/],
  ["LanguageModel.create", /LanguageModel\s*\.\s*create/],
  ["eval(", /\beval\s*\(/],
  ["new Function(", /new\s+Function\s*\(/],
  ["importScripts(", /importScripts\s*\(/],
  ["remote import()", /import\(\s*["'`]https?:/],
  ["remote import from", /from\s+["']https?:/],
];
export const stripComments = (s: string): string => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
export function scanText(text: string): string[] {
  const t = stripComments(text);
  return FORBIDDEN.filter(([, re]) => re.test(t)).map(([n]) => n);
}
export function walk(dir: string, out: string[] = []): string[] {
  for (const n of readdirSync(dir)) {
    if (n === "node_modules" || n === "dist" || n === "__tests__" || n === "__fixtures__") continue;
    const p = join(dir, n);
    if (statSync(p).isDirectory()) walk(p, out); else out.push(p);
  }
  return out;
}
export const codeFiles = (): string[] => walk(EXT_DIR).filter((f) => /\.(ts|js|mjs|html)$/.test(f));
export function scanTree(): Array<{ file: string; hit: string }> {
  return codeFiles().flatMap((f) => scanText(readFileSync(f, "utf8")).map((hit) => ({ file: relative(EXT_DIR, f), hit })));
}
/** Import specifiers of a TS file: [spec, typeOnly]. */
export function importsOf(text: string): Array<[string, boolean]> {
  const out: Array<[string, boolean]> = [];
  const re = /(?:^|\n)\s*(import|export)(\s+type)?\b[^;]*?\bfrom\s*["']([^"']+)["']|(?:^|\n)\s*import\s*["']([^"']+)["']/g;
  for (const m of stripComments(text).matchAll(re)) out.push([(m[3] ?? m[4])!, Boolean(m[2])]);
  return out;
}
export const resolvesOutside = (file: string, spec: string): string | null => {
  if (!spec.startsWith(".")) return null;
  const abs = resolve(dirname(file), spec);
  return relative(EXT_DIR, abs).startsWith("..") ? abs : null;
};
