// U51 test support. No product behaviour is asserted here.
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import type { ProviderDescriptor, ModelSelection } from "../../../src/providers/types";
import type { DeviceStatus } from "../../../src/ai/types";
import { createModelSheet } from "../../../src/ui/model_selector";
import type { ModelSheet, ModelSheetIntent, ModelSheetSnapshot } from "../../../src/ui/model_selector";
import type { Announcer, Politeness } from "../../../src/ui/types";

export const ROOT = resolve(__dirname, "../../..");
export const read = (rel: string): string => readFileSync(resolve(ROOT, rel), "utf8");
export const exists = (rel: string): boolean => existsSync(resolve(ROOT, rel));
export const stripCss = (s: string): string => s.replace(/\/\*[\s\S]*?\*\//g, "");
export const stripTs = (s: string): string => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

/** Vendor-neutral labels and ids on purpose (O13). */
export const LOCAL_ID = "ep-local-9f3";
export const NET_ID = "ep-net-4c1";
export const FB = ["firebase-hybrid", "firebase-ondevice", "firebase-cloud"] as const;

export const fb = (over: Partial<Record<(typeof FB)[number], Partial<ProviderDescriptor>>> = {}): ProviderDescriptor[] =>
  FB.map((id) => ({ id, kind: id, label: id, health: "available" as const, ...(over[id] ?? {}) }));
export const local = (over: Partial<ProviderDescriptor> = {}): ProviderDescriptor =>
  ({ id: LOCAL_ID, kind: "local-openai-compatible", label: "Studio box", health: "available", rung: 2, ...over });
export const net = (over: Partial<ProviderDescriptor> = {}): ProviderDescriptor =>
  ({ id: NET_ID, kind: "remote-openai-compatible", label: "Office relay", health: "available", rung: 2, ...over });

export const snap = (over: Partial<ModelSheetSnapshot> = {}): ModelSheetSnapshot => ({
  providers: [...fb(), local(), net()],
  modelIds: { [LOCAL_ID]: "m-7b", [NET_ID]: "big-1" },
  selection: {} as ModelSelection,
  device: { state: "ready" } as DeviceStatus,
  hostPresent: true,
  ...over,
});

export interface Say { key: string; text: string; p: Politeness }
export class FakeAnnouncer implements Announcer {
  calls: Say[] = [];
  say(key: string, text: string, p: Politeness): void { this.calls.push({ key, text, p }); }
  flushedCount(): number { return this.calls.length; }
  byKey(prefix: string): Say[] { return this.calls.filter((c) => c.key === prefix || c.key.startsWith(prefix)); }
}

export interface Rig {
  mount: HTMLElement; trigger: HTMLButtonElement; sheet: ModelSheet; intents: ModelSheetIntent[]; ann: FakeAnnouncer;
  el: () => HTMLElement;
}
const live: Rig[] = [];
export function rig(s: ModelSheetSnapshot | null = snap()): Rig {
  const mount = document.createElement("div");
  const trigger = document.createElement("button"); trigger.type = "button"; trigger.textContent = "Models";
  document.body.append(trigger, mount);
  const intents: ModelSheetIntent[] = [];
  const ann = new FakeAnnouncer();
  const sheet = createModelSheet({ doc: document, mount, announcer: ann, onIntent: (i) => { intents.push(i); } });
  if (s !== null) sheet.render(s);
  const r: Rig = { mount, trigger, sheet, intents, ann, el: () => mount.querySelector<HTMLElement>("#model-sheet") as HTMLElement };
  live.push(r);
  return r;
}
export function cleanup(): void {
  for (const r of live.splice(0)) { try { r.sheet.dispose(); } catch { /* stub */ } r.mount.remove(); r.trigger.remove(); }
  document.body.replaceChildren();
}

export const txt = (e: Element | null): string => e?.textContent ?? "";
export const sections = (r: Rig): HTMLElement[] => [...r.el().querySelectorAll<HTMLElement>("section")];
export const section = (r: Rig, g: string): HTMLElement | null => r.el().querySelector<HTMLElement>(`section[data-group="${g}"]`);
export const radios = (root: ParentNode): HTMLInputElement[] => [...root.querySelectorAll<HTMLInputElement>('input[type="radio"]')];
/** Row = the `[data-health]` element holding a radio, found by its visible text. */
export const rowByText = (r: Rig, needle: string): HTMLElement => {
  const row = [...r.el().querySelectorAll<HTMLElement>("[data-health]")].find((x) => (x.textContent ?? "").includes(needle));
  if (row === undefined) throw new Error(`no row with text ${needle}`);
  return row;
};
export const radioOf = (row: HTMLElement): HTMLInputElement => row.querySelector<HTMLInputElement>('input[type="radio"]') as HTMLInputElement;
export const checkedRadios = (r: Rig): HTMLInputElement[] => radios(r.el()).filter((x) => x.checked);
export const scopeSelect = (r: Rig): HTMLSelectElement => r.el().querySelector("select") as HTMLSelectElement;
export const buttonByText = (r: Rig, t: string): HTMLButtonElement => {
  const b = [...r.el().querySelectorAll<HTMLButtonElement>("button")].find((x) => (x.textContent ?? "").trim() === t);
  if (b === undefined) throw new Error(`no button ${t}`);
  return b;
};
export function key(el: Element, k: string, init: KeyboardEventInit = {}): KeyboardEvent {
  const ev = new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...init });
  el.dispatchEvent(ev);
  return ev;
}
export function setScope(r: Rig, v: string): void {
  const s = scopeSelect(r); s.value = v; s.dispatchEvent(new Event("change", { bubbles: true }));
}
export const VENDOR_RE = /openai|anthropic|claude|ollama|llama|mistral|gpt|deepseek|qwen|lm ?studio/i;
