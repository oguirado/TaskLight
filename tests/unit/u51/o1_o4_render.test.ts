// U51 O1-O4: health states, judge state, groups, literal text.
import { afterEach, describe, expect, it } from "vitest";
import type { ProviderDescriptor } from "../../../src/providers/types";
import { MODEL_SHEET_COPY } from "../../../src/ui/model_selector";
import { LOCAL_ID, NET_ID, cleanup, checkedRadios, fb, local, net, radioOf, radios, rig, rowByText, section, sections, snap, txt } from "./helpers";

afterEach(cleanup);

describe("O1 health states", () => {
  type Case = [string, Partial<ProviderDescriptor>, string, boolean];
  const CASES: Case[] = [
    ["available", { health: "available" }, "Ready", false],
    ["needs_setup", { health: "needs_setup" }, "Needs setup. See docs/MODELS.md", true],
    ["offline", { health: "offline" }, "Offline. Using Firebase hybrid.", false],
    ["blocked", { health: "blocked", blockedReason: "policy" }, "Not allowed for this project's privacy level", true],
    ["blocked", { health: "blocked", blockedReason: "remote_config" }, "Turned off by app configuration", true],
    ["blocked", { health: "blocked", blockedReason: "unknown_id" }, "Not found. Using Firebase hybrid.", true],
  ];
  it.each(CASES)("local row %s %j", (health, over, copy, disabled) => {
    const r = rig(snap({ providers: [...fb(), local(over)] }));
    const row = rowByText(r, "Studio box");
    expect(row.getAttribute("data-health")).toBe(health);
    expect(txt(row)).toContain(copy);
    expect(radioOf(row).disabled).toBe(disabled);
  });
  it("row has an aria-hidden .status-dot", () => {
    const r = rig();
    const dot = rowByText(r, "Studio box").querySelector(".status-dot");
    expect(dot).not.toBeNull();
    expect(dot?.getAttribute("aria-hidden")).toBe("true");
  });
  it("Firebase rows reuse the states (cloud blocked by kill switch)", () => {
    const r = rig(snap({ providers: fb({ "firebase-cloud": { health: "blocked", blockedReason: "remote_config" } }), hostPresent: false }));
    const row = rowByText(r, "Cloud only");
    expect(row.getAttribute("data-health")).toBe("blocked");
    expect(txt(row)).toContain("Turned off by app configuration");
    expect(radioOf(row).disabled).toBe(true);
    expect(radioOf(rowByText(r, "On-device only")).disabled).toBe(false);
  });
  it("the sheet re-renders a changed health state (idempotent render, last snapshot wins)", () => {
    const r = rig();
    r.sheet.render(snap({ providers: [...fb(), local({ health: "offline" })] }));
    expect(rowByText(r, "Studio box").getAttribute("data-health")).toBe("offline");
    r.sheet.render(snap());
    expect(rowByText(r, "Studio box").getAttribute("data-health")).toBe("available");
  });
});

describe("O2 judge state (no host)", () => {
  it("only the firebase section, 3 radios, hybrid checked", () => {
    const r = rig(snap({ hostPresent: false, providers: fb() }));
    const s = sections(r);
    expect(s.length).toBe(1);
    expect(s[0]?.getAttribute("data-group")).toBe("firebase");
    expect(radios(r.el()).length).toBe(3);
    const c = checkedRadios(r);
    expect(c.length).toBe(1);
    expect(txt(c[0]!.closest("[data-health]"))).toContain("Hybrid — recommended");
  });
  it("external providers in the snapshot are ignored when hostPresent is false (not hidden by CSS: absent)", () => {
    const r = rig(snap({ hostPresent: false }));
    expect(sections(r).length).toBe(1);
    expect(r.el().querySelector('[data-group="local"], [data-group="network"]')).toBeNull();
    expect(r.el().textContent).not.toContain("Studio box");
  });
  it("factory snapshot (selection {}) checks 'Hybrid — recommended' with a Default tag; headings and order", () => {
    const r = rig();
    expect(txt(rowByText(r, "Hybrid — recommended"))).toContain("Default");
    expect(txt(rowByText(r, "On-device only"))).not.toContain("Default");
    expect(txt(rowByText(r, "Cloud only"))).not.toContain("Default");
    expect(checkedRadios(r).length).toBe(1);
    expect(txt(checkedRadios(r)[0]!.closest("[data-health]"))).toContain("Hybrid — recommended");
    const fbs = section(r, "firebase")!;
    expect(txt(fbs)).toContain("Firebase AI Logic");
    expect(radios(fbs).length).toBe(3);
    const order = sections(r).map((x) => x.getAttribute("data-group"));
    expect(order).toEqual(["firebase", "local", "network"]);
  });
  it("dialog skeleton: role, aria-modal, labelled title 'Models'", () => {
    const r = rig();
    const el = r.el();
    expect(el.getAttribute("role")).toBe("dialog");
    expect(el.getAttribute("aria-modal")).toBe("true");
    expect(el.getAttribute("aria-labelledby")).toBe("model-sheet-title");
    expect(txt(el.querySelector("#model-sheet-title"))).toBe("Models");
    expect(el.classList.contains("model-sheet")).toBe(true);
  });
  it.each([
    [{ state: "ready" }, "On-device model ready"],
    [{ state: "downloading", progress: 0.4 }, "Downloading on-device model: 40%"],
    [{ state: "not_initialised" }, "On-device model not set up"],
    [{ state: "needs_gesture" }, "On-device model needs a click to start"],
    [{ state: "failed", detail: "SECRET_DETAIL_XYZ" }, "On-device model unavailable"],
  ] as const)("device line %j", (device, copy) => {
    const r = rig(snap({ device: device as never }));
    expect(txt(section(r, "firebase"))).toContain(copy);
    expect(r.el().textContent).not.toContain("SECRET_DETAIL_XYZ");
  });
});

describe("O3 optional groups", () => {
  it("host present, 0 remote endpoints: no network section", () => {
    const r = rig(snap({ providers: [...fb(), local()] }));
    expect(section(r, "network")).toBeNull();
    expect(section(r, "local")).not.toBeNull();
    expect(r.el().textContent).not.toContain("Not used for private projects or screenshots");
  });
  it("host present, 1 remote endpoint: section with the privacy line", () => {
    const r = rig(snap({ providers: [...fb(), net()] }));
    const n = section(r, "network");
    expect(n).not.toBeNull();
    expect(txt(n)).toContain("Your network providers");
    expect(txt(n)).toContain("Not used for private projects or screenshots");
    expect(section(r, "local")).toBeNull();
  });
  it("local section carries heading 'Your local models'", () => {
    const r = rig();
    expect(txt(section(r, "local"))).toContain("Your local models");
    expect(radios(section(r, "local")!).length).toBe(1);
    expect(radios(section(r, "network")!).length).toBe(1);
  });
});

describe("O4 row text and literal rendering", () => {
  it("'<label> · <model id>'", () => {
    const r = rig();
    expect(txt(rowByText(r, "Studio box"))).toContain("Studio box · m-7b");
    expect(txt(rowByText(r, "Office relay"))).toContain("Office relay · big-1");
  });
  it("absent modelIds: label only, no separator, no 'undefined'", () => {
    const { modelIds: _m, ...rest } = snap();
    const r = rig(rest);
    const t = txt(rowByText(r, "Studio box"));
    expect(t).not.toContain("·");
    expect(t).not.toContain("undefined");
  });
  it("model id missing for one endpoint: label only for that row", () => {
    const r = rig(snap({ modelIds: { [NET_ID]: "big-1" } }));
    expect(txt(rowByText(r, "Studio box"))).not.toContain("·");
    expect(txt(rowByText(r, "Office relay"))).toContain("Office relay · big-1");
  });
  it("<b>x</b> in label and model renders literally; no element injected", () => {
    const r = rig(snap({ providers: [...fb(), local({ label: "<b>x</b>" })], modelIds: { [LOCAL_ID]: "<i>y</i>" } }));
    expect(txt(rowByText(r, "<b>x</b>"))).toContain("<b>x</b> · <i>y</i>");
    expect(r.el().querySelector("b, i")).toBeNull();
    expect(r.el().querySelector("[onerror], script, iframe")).toBeNull();
  });
  it("label with img/script payload stays text", () => {
    const evil = '<img src=x onerror="window.__u51=1"><script>window.__u51=2</script>';
    const r = rig(snap({ providers: [...fb(), local({ label: evil })] }));
    expect(r.el().querySelector("img, script")).toBeNull();
    expect((window as unknown as { __u51?: number }).__u51).toBeUndefined();
    expect(r.el().textContent).toContain(evil);
  });
  it("MODEL_SHEET_COPY holds every static string of the spec", () => {
    const vals = Object.values(MODEL_SHEET_COPY);
    for (const s of ["Models", "Apply choice to", "Use for everything", "Capsule tasks", "Digest", "Routing", "Drift review",
      "Firebase AI Logic", "Your local models", "Your network providers", "Not used for private projects or screenshots",
      "Hybrid — recommended", "Default", "On-device only", "Cloud only", "On-device model ready", "On-device model not set up",
      "On-device model needs a click to start", "On-device model unavailable", "Ready", "Needs setup. See docs/MODELS.md",
      "Offline. Using Firebase hybrid.", "Not allowed for this project's privacy level", "Turned off by app configuration",
      "Not found. Using Firebase hybrid.", "Reset to Firebase hybrid", "Check again", "Close", "Models sheet open",
      "Using Firebase hybrid", "On device", "Cloud", "Local model", "Network model"]) expect(vals).toContain(s);
  });
});
