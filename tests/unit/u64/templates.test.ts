import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { getStarterTemplateMeta, getTemplateMemorySections, STARTER_TEMPLATE_IDS } from "../../../src/app/starter_templates";
const ids = ["blank", "web-app", "cli-library", "mobile-app", "data-ml"] as const;
afterEach(() => { vi.doUnmock("../../../templates/planning/blank.json"); vi.resetModules(); });
describe("U64 bundled template metadata", () => {
  it.each(ids)("A9 %s is normalized, deeply frozen and matches bundled JSON", id => {
    const raw = JSON.parse(readFileSync(resolve(process.cwd(), `templates/planning/${id}.json`), "utf8")) as { id: string; name: string; memory_sections: { id: string; label: string; required: boolean; max_chars: number; hint: string }[] };
    const meta = getStarterTemplateMeta(id); const sections = getTemplateMemorySections(id);
    expect(STARTER_TEMPLATE_IDS).toEqual(ids); expect(meta?.id).toBe(raw.id); expect(meta?.name).toBe(raw.name);
    expect(sections).toEqual(raw.memory_sections.map(s => ({ id: s.id, label: s.label, required: s.required, maxChars: s.max_chars, hint: s.hint })));
    expect(sections?.length).toBeGreaterThan(0); expect(sections!.length).toBeLessThanOrEqual(12);
    expect(Object.isFrozen(meta)).toBe(true); expect(Object.isFrozen(meta?.memorySections)).toBe(true); expect(Object.isFrozen(sections)).toBe(true);
    for (const section of sections!) { expect(Object.isFrozen(section)).toBe(true); expect(section.maxChars).toBeLessThanOrEqual(2000); }
  });
  it.each(["unknown-id", "", "__proto__", "constructor", "toString"])("A9 unknown or hostile id %j falls back cleanly", id => {
    expect(getStarterTemplateMeta(id)).toBeUndefined(); expect(getTemplateMemorySections(id)).toBeUndefined();
  });
  it("A9 malformed entries are skipped, section count and lengths are capped", async () => {
    vi.resetModules();
    const valid = { id: "valid", label: "Valid", required: true, max_chars: 9000, hint: "Hint" };
    vi.doMock("../../../templates/planning/blank.json", () => ({ default: { id: "blank", name: "Blank", memory_sections: [null, {}, { ...valid, id: 3 }, { ...valid, required: "true" }, ...Array.from({ length: 20 }, (_, i) => ({ ...valid, id: `s${i}` }))] } }));
    const mod = await import("../../../src/app/starter_templates");
    const sections = mod.getTemplateMemorySections("blank");
    expect(sections).toHaveLength(12);
    for (const section of sections!) { expect(section.id).toMatch(/^s/); expect(section.maxChars).toBe(2000); expect(Object.isFrozen(section)).toBe(true); }
  });
  it("A9 malformed memory_sections never throws", async () => {
    vi.resetModules(); vi.doMock("../../../templates/planning/blank.json", () => ({ default: { id: "blank", name: "Blank", memory_sections: null } }));
    const mod = await import("../../../src/app/starter_templates");
    expect(() => mod.getTemplateMemorySections("blank")).not.toThrow();
  });
});
