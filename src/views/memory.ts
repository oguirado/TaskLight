import type { AnnounceFn } from "./plan";
import type { MemoryVM } from "./types";
import type { MemoryVersionVM } from "../app/agent_store";

type MemoryWithHistoryVM = MemoryVM & {
  room?: string;
  history?: Readonly<Record<string, readonly MemoryVersionVM[]>>;
};
const ROOM_RE = /^[a-z0-9][a-z0-9-]{0,47}$/;
const UNSAFE_KEYS = new Set(["__proto__", "constructor", "prototype"]);

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

function retainedVersions(history: unknown, section: string): readonly MemoryVersionVM[] | undefined {
  try {
    if (!history || typeof history !== "object" || Array.isArray(history) || UNSAFE_KEYS.has(section)) return undefined;
    const own = Object.getOwnPropertyDescriptor(history, section);
    if (!own || !Array.isArray(own.value)) return undefined;
    const versions: MemoryVersionVM[] = [];
    for (const entry of own.value.slice(0, 100)) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
      const fields = Object.getOwnPropertyDescriptors(entry);
      const rev: unknown = fields.rev?.value;
      const by: unknown = fields.by?.value;
      const ts: unknown = fields.ts?.value;
      const text: unknown = fields.text?.value;
      if (typeof rev !== "number" || !Number.isSafeInteger(rev) || rev < 1 ||
          typeof by !== "string" || by.length === 0 || typeof ts !== "number" ||
          !Number.isSafeInteger(ts) || Math.abs(ts) > 8.64e15 || typeof text !== "string") continue;
      versions.push({ rev, by, ts, text });
    }
    return own.value.length > 0 && versions.length === 0 ? undefined : versions;
  } catch { return undefined; }
}

export function renderMemoryView(
  doc: Document,
  memory: MemoryWithHistoryVM | undefined,
  opts?: { announce?: AnnounceFn },
): HTMLElement {
  void opts;
  const sec = el(doc, "section", "memory");
  try {
    const raw = memory && typeof memory === "object" ? (memory as unknown as Record<string, unknown>) : undefined;
    const exportPanel = el(doc, "div", "memory-export");
    const commandLabel = el(doc, "label", "memory-export-label", "Memory export command");
    exportPanel.appendChild(commandLabel);
    const room = raw?.room;
    if (typeof room === "string" && ROOM_RE.test(room)) {
      const command = el(doc, "textarea", "memory-export-command");
      command.readOnly = true;
      command.spellcheck = false;
      command.rows = 4;
      command.setAttribute("aria-label", "Memory export command");
      command.value = `python3 -m bridge.room call room_export --json '${JSON.stringify({ room, agent: "worker-a", what: "memory" })}'`;
      commandLabel.appendChild(command);
      exportPanel.appendChild(el(doc, "p", "memory-export-note",
        "Run this command in the configured checkout with CW_HOME. It returns Markdown and does not automatically save a file."));
    } else {
      exportPanel.appendChild(el(doc, "p", "memory-export-note", "Command unavailable"));
    }
    sec.appendChild(exportPanel);
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
      const history = el(doc, "details", "memory-history");
      history.appendChild(el(doc, "summary", undefined, "History"));
      history.appendChild(el(doc, "p", "memory-history-note", "Retained history — newest first"));
      const versions = retainedVersions(raw?.history, id);
      if (versions === undefined) {
        history.appendChild(el(doc, "p", "memory-history-empty", "History unavailable"));
      } else if (versions.length === 0) {
        history.appendChild(el(doc, "p", "memory-history-empty", "No retained versions"));
      } else {
        const entries = el(doc, "ol", "memory-history-list");
        for (const version of versions) {
          const entry = el(doc, "li", "memory-history-version");
          entry.appendChild(el(doc, "p", "memory-meta", `Revision ${version.rev} by ${version.by}`));
          const iso = new Date(version.ts).toISOString();
          const timestamp = el(doc, "time", "memory-history-time", iso);
          timestamp.dateTime = iso;
          entry.appendChild(timestamp);
          entry.appendChild(el(doc, "p", "memory-text memory-history-text", version.text));
          entries.appendChild(entry);
        }
        history.appendChild(entries);
      }
      panel.appendChild(history);
      list.appendChild(panel);
    }
    sec.appendChild(list);
  } catch { /* contained: never throw */ }
  return sec;
}
