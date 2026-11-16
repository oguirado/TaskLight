import blankJson from "../../templates/planning/blank.json";
import webAppJson from "../../templates/planning/web-app.json";
import cliLibraryJson from "../../templates/planning/cli-library.json";
import mobileAppJson from "../../templates/planning/mobile-app.json";
import dataMlJson from "../../templates/planning/data-ml.json";
import autonomousSoftwareJson from "../../templates/planning/autonomous-software.json";
import type { PlanningTemplate } from "../plan";

export interface TemplateMemorySectionMeta {
  readonly id: string;
  readonly label: string;
  readonly required: boolean;
  readonly maxChars: number;
  readonly hint: string;
}

export interface StarterTemplateMeta {
  readonly id: string;
  readonly name: string;
  readonly memorySections: readonly TemplateMemorySectionMeta[];
}

export const STARTER_TEMPLATE_IDS: readonly [
  "blank",
  "web-app",
  "cli-library",
  "mobile-app",
  "data-ml",
  "autonomous-software",
] = ["blank", "web-app", "cli-library", "mobile-app", "data-ml", "autonomous-software"];

const MAX_SECTIONS = 12;
const MAX_CHARS = 2000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeSections(raw: unknown): readonly TemplateMemorySectionMeta[] {
  if (!Array.isArray(raw)) return Object.freeze([]);
  const out: TemplateMemorySectionMeta[] = [];
  for (const entry of raw) {
    if (out.length >= MAX_SECTIONS) break;
    if (!isRecord(entry)) continue;
    const id = entry["id"];
    const label = entry["label"];
    const required = entry["required"];
    const maxCharsRaw = entry["max_chars"];
    const hint = entry["hint"];
    if (typeof id !== "string" || id.length === 0) continue;
    if (typeof label !== "string") continue;
    if (typeof required !== "boolean") continue;
    if (typeof maxCharsRaw !== "number" || !Number.isFinite(maxCharsRaw)) continue;
    if (typeof hint !== "string") continue;
    const capped = Math.floor(maxCharsRaw);
    if (capped <= 0) continue;
    out.push(Object.freeze({ id, label, required, maxChars: Math.min(MAX_CHARS, capped), hint }));
  }
  return Object.freeze(out);
}

function normalizeTemplate(raw: unknown, fallbackId: string): StarterTemplateMeta {
  if (!isRecord(raw)) {
    return Object.freeze({ id: fallbackId, name: "", memorySections: Object.freeze([]) });
  }
  const id = typeof raw["id"] === "string" && (raw["id"] as string).length > 0 ? (raw["id"] as string) : fallbackId;
  const name = typeof raw["name"] === "string" ? (raw["name"] as string) : "";
  const memorySections = normalizeSections(raw["memory_sections"]);
  return Object.freeze({ id, name, memorySections });
}

const META_BY_ID = new Map<string, StarterTemplateMeta>([
  ["blank", normalizeTemplate(blankJson, "blank")],
  ["web-app", normalizeTemplate(webAppJson, "web-app")],
  ["cli-library", normalizeTemplate(cliLibraryJson, "cli-library")],
  ["mobile-app", normalizeTemplate(mobileAppJson, "mobile-app")],
  ["data-ml", normalizeTemplate(dataMlJson, "data-ml")],
  ["autonomous-software", normalizeTemplate(autonomousSoftwareJson, "autonomous-software")],
]);

export function getStarterTemplateMeta(templateId: string): StarterTemplateMeta | undefined {
  try {
    if (typeof templateId !== "string") return undefined;
    return META_BY_ID.get(templateId);
  } catch {
    return undefined;
  }
}

export function getTemplateMemorySections(
  templateId: string,
): readonly TemplateMemorySectionMeta[] | undefined {
  const meta = getStarterTemplateMeta(templateId);
  return meta?.memorySections;
}

// Canonical JSON matching bridge/plan/template.py canonical_template_json:
// root hash excluded, keys sorted, compact separators, UTF-8 preserved.
function canonicalTemplateJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return JSON.stringify(value) as string;
  }
  if (Array.isArray(value)) return `[${value.map(canonicalTemplateJson).join(",")}]`;
  if (isRecord(value)) {
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalTemplateJson(value[k])}`).join(",")}}`;
  }
  return String(value);
}

function sha256HexUtf8(text: string): string {
  const bytes = new TextEncoder().encode(text);
  const K = new Uint32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ]);
  const H = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  const rotr = (x: number, n: number): number => (x >>> n) | (x << (32 - n));
  const bitLen = bytes.length * 8;
  const paddedLen = (((bytes.length + 9 + 63) >> 6) << 6);
  const padded = new Uint8Array(paddedLen);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(paddedLen - 4, bitLen >>> 0, false);
  view.setUint32(paddedLen - 8, Math.floor(bitLen / 4294967296), false);
  const w = new Uint32Array(64);
  for (let off = 0; off < paddedLen; off += 64) {
    for (let i = 0; i < 16; i += 1) w[i] = view.getUint32(off + i * 4, false);
    for (let i = 16; i < 64; i += 1) {
      const s0 = rotr(w[i - 15] as number, 7) ^ rotr(w[i - 15] as number, 18) ^ ((w[i - 15] as number) >>> 3);
      const s1 = rotr(w[i - 2] as number, 17) ^ rotr(w[i - 2] as number, 19) ^ (w[i - 2] as number) >>> 10;
      w[i] = (((w[i - 16] as number) + s0 + (w[i - 7] as number) + s1) as number) | 0;
    }
    let a = H[0] as number; let b = H[1] as number; let c = H[2] as number; let d = H[3] as number;
    let e = H[4] as number; let f = H[5] as number; let g = H[6] as number; let h = H[7] as number;
    for (let i = 0; i < 64; i += 1) {
      const s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (h + s1 + ch + (K[i] as number) + (w[i] as number)) | 0;
      const s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (s0 + maj) | 0;
      h = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
    }
    H[0] = (H[0] as number + a) | 0; H[1] = (H[1] as number + b) | 0; H[2] = (H[2] as number + c) | 0;
    H[3] = (H[3] as number + d) | 0; H[4] = (H[4] as number + e) | 0; H[5] = (H[5] as number + f) | 0;
    H[6] = (H[6] as number + g) | 0; H[7] = (H[7] as number + h) | 0;
  }
  let hex = "";
  for (let i = 0; i < 8; i += 1) hex += ((H[i] as number) >>> 0).toString(16).padStart(8, "0");
  return hex;
}

export function canonicalStarterTemplateHash(raw: unknown): string {
  const body: Record<string, unknown> = isRecord(raw) ? { ...(raw as Record<string, unknown>) } : {};
  if (isRecord(raw)) delete body["hash"];
  return sha256HexUtf8(canonicalTemplateJson(body));
}

const STARTER_RAW_BY_ID = new Map<string, unknown>([
  ["blank", blankJson],
  ["web-app", webAppJson],
  ["cli-library", cliLibraryJson],
  ["mobile-app", mobileAppJson],
  ["data-ml", dataMlJson],
  ["autonomous-software", autonomousSoftwareJson],
]);

export function resolveStarterTemplate(templateId: string, templateHash: string): PlanningTemplate | undefined {
  try {
    if (typeof templateId !== "string" || typeof templateHash !== "string") return undefined;
    const raw = STARTER_RAW_BY_ID.get(templateId);
    if (raw === undefined) return undefined;
    const hash = canonicalStarterTemplateHash(raw);
    if (hash !== templateHash) return undefined;
    const cloned = JSON.parse(JSON.stringify(raw)) as Record<string, unknown>;
    cloned["hash"] = hash;
    return cloned as unknown as PlanningTemplate;
  } catch {
    return undefined;
  }
}
