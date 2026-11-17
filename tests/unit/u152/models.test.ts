import { describe, expect, it, vi } from "vitest";
import { DESTINATIONS, assertSingleModels, mount, text, visible } from "./helpers";

describe("U152 AC3 Models opener and consolidated status", () => {
  it("AC3 keeps one working Models opener across every destination and status refresh", () => {
    const onOpenModels = vi.fn();
    const { host, update } = mount({}, { onOpenModels });
    for (const [view] of DESTINATIONS) {
      update({ view, model: { state: "unavailable", label: "Gemini Nano unavailable · Rules reviewer" } });
      const opener = assertSingleModels(host);
      expect(opener.getAttribute("aria-haspopup")).toBe("dialog");
      expect(opener.getAttribute("aria-controls")).toBe("model-sheet");
      opener.click();
      expect(onOpenModels).toHaveBeenLastCalledWith(opener);
    }
    expect(onOpenModels).toHaveBeenCalledTimes(DESTINATIONS.length);
  });

  it.each(["ready", "downloading", "unavailable"] as const)("AC3 %s has one passive record containing provider, reviewer and room policy", state => {
    const label = `Gemini Nano ${state} · Rules reviewer`;
    const policy = "Private room · cloud disabled";
    const { host } = mount({ model: { state, label }, availability: policy });
    assertSingleModels(host);
    const containsFacts = (element: HTMLElement) => text(element).includes(label) && text(element).includes(policy);
    const records = [...host.querySelectorAll<HTMLElement>("p,div,section,[role=status]")]
      .filter(element => visible(element) && containsFacts(element)
        && ![...element.querySelectorAll<HTMLElement>("p,div,section,[role=status]")].some(containsFacts));
    expect(records, "provider, reviewer and private-room policy must be readable together").toHaveLength(1);
    const record = records[0]!;
    expect(record.matches('button,a,input,select,textarea,[role=button],[role=link]')).toBe(false);
    expect(record.tabIndex).toBeLessThan(0);
    expect(record.querySelector('button,a,input,select,textarea,[role=button],[role=link]')).toBeNull();
    expect(text(host).split(label)).toHaveLength(2);
  });
});

describe("U152 AC5 hostile private-room availability", () => {
  it("AC5 an unavailable on-device provider with cloud disabled is never described as active", () => {
    const { host } = mount({ model: { state: "unavailable", label: "" }, availability: "Private room · cloud disabled" });
    const copy = text(host);
    expect(copy).toMatch(/(?:unavailable|not available)/i);
    expect(copy).toContain("Private room · cloud disabled");
    expect(copy).toMatch(/Rules/i);
    // Rules may truthfully be the active reviewer; the unavailable provider may not.
    expect(copy).not.toMatch(/\b(?:Gemini Nano|on[- ]device(?: provider| model)?|cloud(?: provider| model)?)\s*[:·-]?\s*(?:is\s+)?(?:active|ready)\b/i);
    assertSingleModels(host);
  });

  it("AC5 a ready-to-unavailable refresh removes a stale active-provider claim in the private room", () => {
    const { host, update } = mount({ model: { state: "ready", label: "Gemini Nano active" } });
    expect(text(host)).toContain("Gemini Nano active");
    update({ model: { state: "unavailable", label: "Gemini Nano unavailable · Rules reviewer" } });
    expect(text(host)).toContain("Gemini Nano unavailable");
    expect(text(host)).toContain("Private room · cloud disabled");
    expect(text(host)).not.toContain("Gemini Nano active");
    expect(text(host)).not.toMatch(/\bcloud\s+(?:is\s+)?active\b/i);
  });
});

describe("U152 AC6 negative control", () => {
  it("AC6 the same production-facing opener assertion rejects a second Models opener", () => {
    const { host } = mount();
    const original = assertSingleModels(host);
    const duplicate = original.cloneNode(true) as HTMLButtonElement;
    original.parentElement!.append(duplicate);
    try {
      expect(() => assertSingleModels(host)).toThrowError(/exactly one Models opener/);
    } finally {
      duplicate.remove();
    }
    assertSingleModels(host);
  });
});
