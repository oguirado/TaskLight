import type { LensDescriptor } from "./types";

function canonicalValue(value: unknown): string {
  if (Array.isArray(value)) {
    return "[" + value.map(canonicalValue).join(",") + "]";
  }
  if (value !== null && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    const parts = keys.map((k) => JSON.stringify(k) + ":" + canonicalValue(obj[k]));
    return "{" + parts.join(",") + "}";
  }
  const s = JSON.stringify(value);
  return s === undefined ? "null" : s;
}

export function canonicalLensJson(d: Omit<LensDescriptor, "template_hash">): string {
  return canonicalValue(d as unknown);
}

export function lensHash(d: Omit<LensDescriptor, "template_hash">): string {
  const s = canonicalValue(d as unknown);
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}
