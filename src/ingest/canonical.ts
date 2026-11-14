import type { CapsuleEvent } from "./types";

function serializeValue(value: unknown): string {
  if (typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    return JSON.stringify(value);
  }
  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }
  if (value === null) {
    return "null";
  }
  if (typeof value === "object") {
    if (Array.isArray(value)) {
      return "[" + value.map((v) => serializeValue(v)).join(",") + "]";
    }
    const rec = value as Record<string, unknown>;
    const keys = Object.keys(rec).filter((k) => rec[k] !== undefined).sort();
    return "{" + keys.map((k) => JSON.stringify(k) + ":" + serializeValue(rec[k])).join(",") + "}";
  }
  return JSON.stringify(String(value));
}

export function canonicalJson(e: Omit<CapsuleEvent, "eventId"> | CapsuleEvent): string {
  const rec = e as Record<string, unknown>;
  const keys = Object.keys(rec).filter((k) => rec[k] !== undefined).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + serializeValue(rec[k])).join(",") + "}";
}
