// U51 O5-O8: scope select, intents, keyboard, announcer.
import { afterEach, describe, expect, it } from "vitest";
import { FB, LOCAL_ID, NET_ID, buttonByText, checkedRadios, cleanup, fb, key, local, net, radioOf, rig, rowByText, scopeSelect, setScope, snap, txt, radios } from "./helpers";

afterEach(cleanup);
const checkedText = (r: ReturnType<typeof rig>): string => txt(checkedRadios(r)[0]?.closest("[data-health]") ?? null);

describe("O5 scope select", () => {
  it("native select labelled 'Apply choice to' with the 5 options", () => {
    const r = rig();
    const s = scopeSelect(r);
    expect(s).not.toBeNull();
    const lab = (s.id !== "" ? r.el().querySelector(`label[for="${s.id}"]`) : null) ?? s.closest("label");
    expect((lab?.textContent ?? s.getAttribute("aria-label") ?? "")).toContain("Apply choice to");
    expect([...s.options].map((o) => [o.value, o.textContent])).toEqual([
      ["all", "Use for everything"], ["capsule", "Capsule tasks"], ["digest", "Digest"], ["routing", "Routing"], ["drift", "Drift review"],
    ]);
    expect(s.value).toBe("all");
  });
  it("scope change re-checks effectiveId (groups[g] ?? all ?? default) and emits nothing", () => {
    const r = rig(snap({ selection: { all: LOCAL_ID, groups: { digest: NET_ID } } }));
    expect(checkedText(r)).toContain("Studio box");
    setScope(r, "digest");
    expect(checkedText(r)).toContain("Office relay");
    setScope(r, "routing");
    expect(checkedText(r)).toContain("Studio box");
    setScope(r, "all");
    expect(checkedText(r)).toContain("Studio box");
    expect(checkedRadios(r).length).toBe(1);
    expect(r.intents).toEqual([]);
  });
  it("scope with nothing chosen falls to the default (Hybrid)", () => {
    const r = rig(snap({ selection: { groups: { capsule: LOCAL_ID } } }));
    setScope(r, "drift");
    expect(checkedText(r)).toContain("Hybrid — recommended");
    setScope(r, "capsule");
    expect(checkedText(r)).toContain("Studio box");
  });
  it("radio change emits select{scope,id} for the current scope", () => {
    const r = rig();
    radioOf(rowByText(r, "Studio box")).click();
    expect(r.intents).toEqual([{ t: "select", scope: "all", id: LOCAL_ID }]);
    setScope(r, "digest");
    radioOf(rowByText(r, "Office relay")).click();
    expect(r.intents.at(-1)).toEqual({ t: "select", scope: "digest", id: NET_ID });
    radioOf(rowByText(r, "Cloud only")).click();
    expect(r.intents.at(-1)).toEqual({ t: "select", scope: "digest", id: FB[2] });
    expect(r.intents.length).toBe(3);
  });
  it("the next render() is the truth: a selection that did not land is un-checked again", () => {
    const r = rig();
    radioOf(rowByText(r, "Studio box")).click();
    r.sheet.render(snap({ selection: {} }));
    expect(checkedText(r)).toContain("Hybrid — recommended");
    r.sheet.render(snap({ selection: { all: LOCAL_ID } }));
    expect(checkedText(r)).toContain("Studio box");
  });
  it("render() keeps the chosen scope", () => {
    const r = rig();
    setScope(r, "routing");
    r.sheet.render(snap({ selection: { groups: { routing: NET_ID } } }));
    expect(scopeSelect(r).value).toBe("routing");
    expect(checkedText(r)).toContain("Office relay");
  });
  it("disabled radios cannot emit", () => {
    const r = rig(snap({ providers: [...fb(), local({ health: "needs_setup" }), net({ health: "blocked", blockedReason: "policy" })] }));
    radioOf(rowByText(r, "Studio box")).click();
    radioOf(rowByText(r, "Office relay")).click();
    expect(r.intents).toEqual([]);
  });
});

describe("O6 reset / refresh", () => {
  it("Reset is visible and enabled in the normal state; click emits reset", () => {
    const r = rig();
    const b = buttonByText(r, "Reset to Firebase hybrid");
    expect(b.disabled).toBe(false);
    expect(b.hidden).toBe(false);
    expect(b.getAttribute("type")).toBe("button");
    b.click();
    expect(r.intents).toEqual([{ t: "reset" }]);
  });
  it("Reset stays enabled when every external provider is blocked or needs setup", () => {
    const r = rig(snap({ providers: [...fb(), local({ health: "blocked", blockedReason: "policy" }), net({ health: "blocked", blockedReason: "remote_config" })],
      selection: { all: LOCAL_ID } }));
    const b = buttonByText(r, "Reset to Firebase hybrid");
    expect(b.disabled).toBe(false);
    expect(b.closest("[hidden]")).toBeNull();
    b.click();
    expect(r.intents).toEqual([{ t: "reset" }]);
  });
  it("Reset exists in the judge state and with selection already on the default", () => {
    const r = rig(snap({ hostPresent: false, providers: fb() }));
    expect(buttonByText(r, "Reset to Firebase hybrid").disabled).toBe(false);
  });
  it("open emits exactly one refresh per open; render and close emit none", () => {
    const r = rig();
    expect(r.intents).toEqual([]);
    r.sheet.open(r.trigger);
    expect(r.intents).toEqual([{ t: "refresh" }]);
    r.sheet.render(snap());
    expect(r.intents.length).toBe(1);
    r.sheet.close();
    expect(r.intents.length).toBe(1);
    r.sheet.open(r.trigger);
    expect(r.intents.filter((i) => i.t === "refresh").length).toBe(2);
  });
  it("'Check again' emits refresh; 'Close' closes without intent", () => {
    const r = rig();
    r.sheet.open(r.trigger);
    r.intents.length = 0;
    buttonByText(r, "Check again").click();
    expect(r.intents).toEqual([{ t: "refresh" }]);
    buttonByText(r, "Close").click();
    expect(r.sheet.isOpen()).toBe(false);
    expect(r.intents.length).toBe(1);
  });
});

describe("O7 keyboard and focus", () => {
  it("open: isOpen, aria-expanded true, focus on the scope select, inside the sheet", () => {
    const r = rig();
    expect(r.sheet.isOpen()).toBe(false);
    r.trigger.focus();
    r.sheet.open(r.trigger);
    expect(r.sheet.isOpen()).toBe(true);
    expect(r.trigger.getAttribute("aria-expanded")).toBe("true");
    expect(document.activeElement).toBe(scopeSelect(r));
    expect(r.el().contains(document.activeElement)).toBe(true);
    expect(r.el().hasAttribute("hidden")).toBe(false);
  });
  it("Escape closes, focus returns to the trigger, aria-expanded false", () => {
    const r = rig();
    r.trigger.focus();
    r.sheet.open(r.trigger);
    key(document.activeElement as Element, "Escape");
    expect(r.sheet.isOpen()).toBe(false);
    expect(document.activeElement).toBe(r.trigger);
    expect(r.trigger.getAttribute("aria-expanded")).toBe("false");
  });
  it("close() also returns focus and toggles aria-expanded", () => {
    const r = rig();
    r.sheet.open(r.trigger);
    r.sheet.close();
    expect(document.activeElement).toBe(r.trigger);
    expect(r.trigger.getAttribute("aria-expanded")).toBe("false");
  });
  it("open(null) works: no trigger to restore, no throw", () => {
    const r = rig();
    r.sheet.open(null);
    expect(r.sheet.isOpen()).toBe(true);
    expect(() => r.sheet.close()).not.toThrow();
  });
  it("Tab on the last control wraps to the first; Shift+Tab on the first wraps to the last (focus never leaves)", () => {
    const r = rig();
    r.sheet.open(r.trigger);
    const close = buttonByText(r, "Close");
    const first = scopeSelect(r);
    close.focus();
    const ev = key(close, "Tab");
    expect(ev.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(first);
    const ev2 = key(first, "Tab", { shiftKey: true });
    expect(ev2.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(close);
  });
  it("Escape when closed does nothing; Escape does not emit intents", () => {
    const r = rig();
    key(r.trigger, "Escape");
    r.sheet.open(r.trigger);
    r.intents.length = 0;
    key(document.activeElement as Element, "Escape");
    expect(r.intents).toEqual([]);
  });
  it("radios are native, one name, disabled radios skipped by the group", () => {
    const r = rig(snap({ providers: [...fb(), local({ health: "needs_setup" }), net()] }));
    const all = radios(r.el());
    expect(all.length).toBe(5);
    expect(new Set(all.map((x) => x.name))).toEqual(new Set(["model-choice"]));
    for (const x of all) expect(x.closest("label") !== null || r.el().querySelector(`label[for="${x.id}"]`) !== null).toBe(true);
    expect(radioOf(rowByText(r, "Studio box")).disabled).toBe(true);
  });
  it("dispose removes the sheet and stops intents", () => {
    const r = rig();
    r.sheet.open(r.trigger);
    r.sheet.dispose();
    expect(r.mount.querySelector("#model-sheet")).toBeNull();
    expect(r.sheet.isOpen()).toBe(false);
  });
});

describe("O8 announcer", () => {
  it("nothing on first render, nothing on identical re-render", () => {
    const r = rig();
    r.sheet.render(snap());
    expect(r.ann.calls).toEqual([]);
  });
  it("open: models.open polite", () => {
    const r = rig();
    r.sheet.open(r.trigger);
    expect(r.ann.calls).toEqual([{ key: "models.open", text: "Models sheet open", p: "polite" }]);
  });
  it("select confirmed by the next render: '<scope label>: <provider label>'", () => {
    const r = rig();
    radioOf(rowByText(r, "Studio box")).click();
    expect(r.ann.byKey("models.select")).toEqual([]);
    r.sheet.render(snap({ selection: { all: LOCAL_ID } }));
    expect(r.ann.byKey("models.select")).toEqual([{ key: "models.select", text: "Use for everything: Studio box", p: "polite" }]);
    r.sheet.render(snap({ selection: { all: LOCAL_ID } }));
    expect(r.ann.byKey("models.select").length).toBe(1);
  });
  it("scoped select uses the scope option text", () => {
    const r = rig();
    setScope(r, "drift");
    radioOf(rowByText(r, "Office relay")).click();
    r.sheet.render(snap({ selection: { groups: { drift: NET_ID } } }));
    expect(r.ann.byKey("models.select")).toEqual([{ key: "models.select", text: "Drift review: Office relay", p: "polite" }]);
  });
  it("a select that the render does not confirm is not announced", () => {
    const r = rig();
    radioOf(rowByText(r, "Studio box")).click();
    r.sheet.render(snap({ selection: {} }));
    expect(r.ann.byKey("models.select")).toEqual([]);
  });
  it("reset confirmed: 'Using Firebase hybrid'", () => {
    const r = rig(snap({ selection: { all: LOCAL_ID } }));
    buttonByText(r, "Reset to Firebase hybrid").click();
    r.sheet.render(snap({ selection: {} }));
    expect(r.ann.byKey("models.select")).toEqual([{ key: "models.select", text: "Using Firebase hybrid", p: "polite" }]);
  });
  it("health change between renders: models.health.<id> '<label>: <state copy>'", () => {
    const r = rig();
    r.sheet.render(snap({ providers: [...fb(), local({ health: "offline" }), net()] }));
    expect(r.ann.byKey("models.health.")).toEqual([
      { key: `models.health.${LOCAL_ID}`, text: "Studio box: Offline. Using Firebase hybrid.", p: "polite" }]);
    r.sheet.render(snap({ providers: [...fb(), local({ health: "offline" }), net({ health: "blocked", blockedReason: "policy" })] }));
    expect(r.ann.byKey("models.health.").map((c) => c.key)).toEqual([`models.health.${LOCAL_ID}`, `models.health.${NET_ID}`]);
    expect(r.ann.byKey("models.health.")[1]?.text).toBe("Office relay: Not allowed for this project's privacy level");
  });
  it("all announcements are polite, none assertive", () => {
    const r = rig();
    r.sheet.open(r.trigger);
    r.sheet.render(snap({ providers: [...fb(), local({ health: "needs_setup" }), net()] }));
    expect(r.ann.calls.length).toBeGreaterThan(0);
    expect(r.ann.calls.every((c) => c.p === "polite")).toBe(true);
  });
});
