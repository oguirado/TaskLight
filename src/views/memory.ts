import type { AnnounceFn } from "./plan";
import type { MemoryVM } from "./types";

export const MEMORY_VIEW_LIMITS = Object.freeze({
  SECTIONS_MAX: 12,
  SECTION_TEXT_MAX: 2000,
  LABEL_MAX: 64,
} as const);

function asStr(v: unknown): string {
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean" || typeof v === "bigint") return String(v);
  return "";
}

function trunc(v: string, max: number): string {
  return v.length > max ? v.slice(0, max) : v;
}

function el<K extends keyof HTMLElementTagNameMap>(
  doc: Document,
  tag: K,
  cls?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const n = doc.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}

export function renderMemoryView(
  doc: Document,
  memory: MemoryVM | undefined,
  opts?: { announce?: AnnounceFn },
): HTMLElement {
  void opts;
  const sec = el(doc, "section", "memory");
  try {
    const raw = memory && typeof memory === "object" ? (memory as unknown as Record<string, unknown>) : undefined;
    const sections = raw && Array.isArray(raw.sections) ? (raw.sections as unknown[]) : [];
    const valid: Record<string, unknown>[] = [];
    for (const s of sections) {
      if (!s || typeof s !== "object") continue;
      valid.push(s as Record<string, unknown>);
    }
    if (valid.length === 0) {
      sec.appendChild(el(doc, "p", "memory-empty", "No memory sections yet."));
      return sec;
    }
    const capped = valid.slice(0, MEMORY_VIEW_LIMITS.SECTIONS_MAX);
    const list = el(doc, "div", "memory-list");
    for (const s of capped) {
      const id = asStr(s.id);
      const label = trunc(asStr(s.label), MEMORY_VIEW_LIMITS.LABEL_MAX);
      const text = trunc(asStr(s.text), MEMORY_VIEW_LIMITS.SECTION_TEXT_MAX);
      const required = s.required === true;
      const emptyFlag = s.empty === true;
      const isEmpty = emptyFlag || text.trim().length === 0;
      const by = asStr(s.by);
      const changedAt = asStr(s.changedAt);
      const rev = typeof s.rev === "number" && Number.isFinite(s.rev) ? String(s.rev) : asStr(s.rev);
      const panel = el(doc, "article", "memory-panel");
      if (id) panel.setAttribute("data-section-id", id);
      if (required && isEmpty) panel.setAttribute("data-required-empty", "true");
      panel.appendChild(el(doc, "h2", "memory-label", label));
      if (required && isEmpty) {
        panel.appendChild(el(doc, "p", "memory-flag", "Required — empty"));
      }
      const metaParts: string[] = [];
      if (rev.length > 0) metaParts.push(`Revision ${rev}`);
      if (by.length > 0) metaParts.push(`by ${by}`);
      if (changedAt.length > 0) metaParts.push(changedAt);
      if (metaParts.length > 0) panel.appendChild(el(doc, "p", "memory-meta", metaParts.join(", ")));
      if (rev.length > 0) panel.appendChild(el(doc, "p", "memory-note", "Room log position of this section's last accepted update"));
      panel.appendChild(el(doc, "p", "memory-text", text));
      list.appendChild(panel);
    }
    sec.appendChild(list);
  } catch { /* contained: never throw */ }
  return sec;
}
