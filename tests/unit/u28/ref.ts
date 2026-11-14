// Independent reference helpers for the U28 oracle (never import src/ctx here).
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

export const FIX = join(dirname(fileURLToPath(import.meta.url)), "../../../fixtures/ctx/v1");
export const SRC_CTX = join(dirname(fileURLToPath(import.meta.url)), "../../../src/ctx");
export const refSha = (s: string): string => createHash("sha256").update(s, "utf8").digest("hex");
export function refCanon(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return "[" + v.map(refCanon).join(",") + "]";
  const o = v as Record<string, unknown>;
  return "{" + Object.keys(o).sort().map((k) => JSON.stringify(k) + ":" + refCanon(o[k])).join(",") + "}";
}
export const refEnv = (verb: string, rc: number, data: unknown) =>
  ({ schema: "ctx.resp/v1", ok: rc === 0, rc, verb, data, sha256: refSha(refCanon(data)) });
export const refRender = (blocks: { coord: { src: string; from: number; to: number }; text: string }[]): string =>
  blocks.map((b) => `@@ ${b.coord.src}:${b.coord.from}-${b.coord.to}\n${b.text}\n`).join("");
export const fixIn = (n: string): unknown => JSON.parse(readFileSync(join(FIX, n + ".in.json"), "utf8"));
export const fixOut = (n: string): string => readFileSync(join(FIX, n + ".out.jsonl"), "utf8").replace(/\n$/, "");
export const ex = (src: string, from: number, to: number, text: string, sha256?: string) =>
  ({ coord: sha256 === undefined ? { src, from, to } : { src, from, to, sha256 }, text });
export const errs = (r: { data: unknown }): { code: string; path: string }[] =>
  ((r.data as { errors?: { code: string; path: string }[] }).errors ?? []);
export function deepFreeze<T>(o: T): T {
  if (o && typeof o === "object") { Object.values(o).forEach(deepFreeze); Object.freeze(o); }
  return o;
}
