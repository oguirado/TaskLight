import blankJson from "../../templates/planning/blank.json";
import webAppJson from "../../templates/planning/web-app.json";
import cliLibraryJson from "../../templates/planning/cli-library.json";
import mobileAppJson from "../../templates/planning/mobile-app.json";
import dataMlJson from "../../templates/planning/data-ml.json";

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
] = ["blank", "web-app", "cli-library", "mobile-app", "data-ml"];

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
