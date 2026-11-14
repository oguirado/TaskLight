import { expect } from "vitest";
import type { Built, BuiltPrompt, CapsuleInput, DigestEntry, PromptEvent, PrevState } from "../../../src/prompts/index";

export const STATUSES = ["running", "waiting_input", "blocked", "failed", "done", "idle"] as const;
export const ATTENTIONS = ["none", "low", "high", "now"] as const;
export const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

export const PREV: PrevState = {
  status: "running", attention: "low",
  headline: "Build running", summary: "Compiling the project.", next_action: "Wait for the build",
};

export function ev(seq: number, len = 1000, kind = "log"): PromptEvent {
  const head = `START${seq}_`;
  const tail = `_TAIL${seq}`;
  return { seq, kind, text: head + "x".repeat(Math.max(0, len - head.length - tail.length)) + tail };
}
export const evs = (from: number, to: number, len = 1000): PromptEvent[] => {
  const out: PromptEvent[] = [];
  for (let i = from; i <= to; i++) out.push(ev(i, len));
  return out;
};
export function cap(task: CapsuleInput["task"], delta: readonly PromptEvent[], extra: Partial<CapsuleInput> = {}): CapsuleInput {
  return { task, projectId: "p1", tier: "standard", prev: PREV, delta, ...extra };
}
export const entry = (projectId: string, attention: DigestEntry["attention"], extra: Partial<DigestEntry> = {}): DigestEntry =>
  ({ projectId, tier: "standard", status: "running", attention, ...extra });

export function ok(b: Built): BuiltPrompt {
  expect(b.ok, JSON.stringify(b.ok ? "" : b.errors)).toBe(true);
  if (!b.ok) throw new Error("not ok");
  return b.value;
}
export const codes = (b: Built): string[] => (b.ok ? [] : b.errors.map((e) => e.code));
export const count = (s: string, sub: string): number => s.split(sub).length - 1;
export const tails = (text: string): number[] =>
  [...text.matchAll(/_TAIL(\d+)/g)].map((m) => Number(m[1]));
