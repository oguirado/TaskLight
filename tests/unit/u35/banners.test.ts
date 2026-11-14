import { afterEach, describe, expect, it } from "vitest";
import { cleanup, click, mount, mountSpied, q, qa, txt, txts } from "./helpers";
import { DRIFT, DRIFT_NEEDS_USER, DRIFT_ON_TRACK, DRIFT_RULES, FIXTURE, SILENT, SILENT_NO_FOR } from "./fixture";

afterEach(cleanup);

const silentBanner = (h: ParentNode) => q(h, "div.chat-banner[data-kind=silent]");
const driftBanner = (h: ParentNode) => q(h, "div.chat-banner[data-kind=drift]");
const escalate = (h: ParentNode) => q<HTMLButtonElement>(h, "button.chat-escalate");

describe("U35 C5 silent banner", () => {
  it("absent when not silent", () => {
    const { host } = mount();
    expect(qa(host, "[data-kind=silent]").length).toBe(0);
    expect(qa(host, "button.chat-escalate").length).toBe(0);
  });

  it("silentFor present: '<agent> has been silent for <silentFor>'", () => {
    const { host } = mount(SILENT);
    expect(silentBanner(host).textContent).toContain("Atlas has been silent for 12 min");
  });

  it("silentFor absent: '<agent> is silent' (no 'has been')", () => {
    const { host } = mount(SILENT_NO_FOR);
    const t = silentBanner(host).textContent ?? "";
    expect(t).toContain("Atlas is silent");
    expect(t).not.toContain("has been silent");
    expect(t).not.toContain("undefined");
  });

  it("escalate button copy, inside the banner, enabled", () => {
    const { host } = mount(SILENT);
    expect(txt(escalate(host))).toBe("Notify orchestrator");
    expect(silentBanner(host).contains(escalate(host))).toBe(true);
    expect(escalate(host).disabled).toBe(false);
    expect(escalate(host).getAttribute("type")).toBe("button");
  });

  it("banner is a single element with the exact classes", () => {
    const { host } = mount(SILENT);
    expect(qa(host, "div.chat-banner").length).toBe(1);
    expect(qa(host, "div.chat-banner[data-kind=silent]").length).toBe(1);
  });

  it("click calls onEscalate once and disables the button", () => {
    const { host, spies } = mountSpied(SILENT);
    click(escalate(host));
    expect(spies.onEscalate).toHaveBeenCalledTimes(1);
    expect(escalate(host).disabled).toBe(true);
    click(escalate(host));
    expect(spies.onEscalate).toHaveBeenCalledTimes(1);
  });

  it("stays disabled across update() while silent remains true", () => {
    const { host, handle, spies } = mountSpied(SILENT);
    click(escalate(host));
    handle.update({ ...SILENT, silentFor: "20 min" });
    expect(silentBanner(host).textContent).toContain("Atlas has been silent for 20 min");
    expect(escalate(host).disabled).toBe(true);
    click(escalate(host));
    handle.update(SILENT);
    expect(escalate(host).disabled).toBe(true);
    expect(spies.onEscalate).toHaveBeenCalledTimes(1);
  });

  it("silent false then true again re-enables escalation (new cycle) and fires once more", () => {
    const { host, handle, spies } = mountSpied(SILENT);
    click(escalate(host));
    handle.update(FIXTURE);
    expect(qa(host, "[data-kind=silent]").length).toBe(0);
    handle.update(SILENT);
    expect(escalate(host).disabled).toBe(false);
    click(escalate(host));
    expect(spies.onEscalate).toHaveBeenCalledTimes(2);
    expect(escalate(host).disabled).toBe(true);
  });

  it("without a prior click, a false/true cycle leaves the button enabled", () => {
    const { host, handle } = mountSpied(SILENT);
    handle.update(FIXTURE);
    handle.update(SILENT);
    expect(escalate(host).disabled).toBe(false);
  });

  it("a click does not affect other handlers", () => {
    const { host, spies } = mountSpied(SILENT);
    click(escalate(host));
    expect(spies.onSend).not.toHaveBeenCalled();
    expect(spies.onAcceptDrift).not.toHaveBeenCalled();
    expect(spies.onSuggest).not.toHaveBeenCalled();
  });

  it("escalate without handlers does not throw (and still disables)", () => {
    const { host } = mount(SILENT);
    expect(() => click(escalate(host))).not.toThrow();
    expect(escalate(host).disabled).toBe(true);
  });

  it("update to a different agent changes the banner text", () => {
    const { host, handle } = mount(SILENT);
    handle.update({ ...SILENT, agent: "Orion" });
    expect(silentBanner(host).textContent).toContain("Orion has been silent for 12 min");
  });
});

describe("U35 C6 drift banner", () => {
  it("absent without drift and for on_track (even with added items)", () => {
    for (const vm of [FIXTURE, DRIFT_ON_TRACK]) {
      const { host } = mount(vm);
      expect(qa(host, "[data-kind=drift]").length).toBe(0);
      expect(qa(host, "button.chat-accept-drift").length).toBe(0);
      expect(qa(host, "ul.drift-added, ul.drift-removed").length).toBe(0);
      expect(host.textContent).not.toContain("Everything matches the plan.");
      expect(host.textContent).not.toContain("Should not show");
    }
  });

  it.each([[DRIFT, "drift"], [DRIFT_NEEDS_USER, "needs_user"]] as const)("verdict %# renders div.chat-banner[data-kind=drift][data-verdict=%s]", (vm, verdict) => {
    const { host } = mount(vm);
    const b = driftBanner(host);
    expect(b.tagName).toBe("DIV");
    expect(b.classList.contains("chat-banner")).toBe(true);
    expect(b.getAttribute("data-verdict")).toBe(verdict);
    expect(b.textContent).toContain(vm.drift?.reason ?? "MISSING");
  });

  it("added and removed lists render one li per item, in order", () => {
    const { host } = mount(DRIFT);
    const b = driftBanner(host);
    expect(txts(b, "ul.drift-added > li")).toEqual(["Add a changelog", "Publish to docs"]);
    expect(txts(b, "ul.drift-removed > li")).toEqual(["Skip tests"]);
    expect(qa(b, "ul.drift-added > li").length).toBe(qa(b, "ul.drift-added li").length);
  });

  it("empty added list is omitted (not rendered empty); removed stays", () => {
    const { host } = mount(DRIFT_NEEDS_USER);
    const b = driftBanner(host);
    expect(qa(b, "ul.drift-added").length).toBe(0);
    expect(txts(b, "ul.drift-removed > li")).toEqual(["Ship Friday"]);
  });

  it("empty removed list is omitted; added stays", () => {
    const { host } = mount(DRIFT_RULES);
    const b = driftBanner(host);
    expect(qa(b, "ul.drift-removed").length).toBe(0);
    expect(txts(b, "ul.drift-added > li")).toEqual(["x"]);
  });

  it("both lists empty: neither list rendered", () => {
    const { host } = mount({ ...FIXTURE, drift: { verdict: "drift", reason: "r", added: [], removed: [], source: "device" } });
    expect(qa(host, "ul.drift-added, ul.drift-removed").length).toBe(0);
    expect(driftBanner(host).textContent).toContain("r");
  });

  it.each([
    [DRIFT, "Reviewed by Gemini Nano on this device"],
    [DRIFT_NEEDS_USER, "Reviewed by Gemini in the cloud"],
    [DRIFT_RULES, "Reviewed by rules"],
  ] as const)("source note %# is '%s' and only that one", (vm, note) => {
    const { host } = mount(vm);
    const t = driftBanner(host).textContent ?? "";
    expect(t).toContain(note);
    const all = ["Reviewed by Gemini Nano on this device", "Reviewed by Gemini in the cloud", "Reviewed by rules"];
    for (const other of all.filter((n) => n !== note)) expect(t).not.toContain(other);
  });

  it("accept button copy, inside banner, calls onAcceptDrift once", () => {
    const { host, spies } = mountSpied(DRIFT);
    const b = q<HTMLButtonElement>(driftBanner(host), "button.chat-accept-drift");
    expect(txt(b)).toBe("Accept new plan");
    expect(b.getAttribute("type")).toBe("button");
    click(b);
    expect(spies.onAcceptDrift).toHaveBeenCalledTimes(1);
    expect(spies.onSend).not.toHaveBeenCalled();
    expect(spies.onEscalate).not.toHaveBeenCalled();
  });

  it("needs_user also offers the accept button", () => {
    const { host, spies } = mountSpied(DRIFT_NEEDS_USER);
    click(q(host, "button.chat-accept-drift"));
    expect(spies.onAcceptDrift).toHaveBeenCalledTimes(1);
  });

  it("accept is not one-shot: it stays usable and fires per click", () => {
    const { host, spies } = mountSpied(DRIFT);
    click(q(host, "button.chat-accept-drift"));
    click(q(host, "button.chat-accept-drift"));
    expect(spies.onAcceptDrift).toHaveBeenCalledTimes(2);
  });

  it("update() adds, changes and removes the drift banner", () => {
    const { host, handle } = mount();
    expect(qa(host, "[data-kind=drift]").length).toBe(0);
    handle.update(DRIFT);
    expect(driftBanner(host).getAttribute("data-verdict")).toBe("drift");
    handle.update(DRIFT_NEEDS_USER);
    expect(qa(host, "[data-kind=drift]").length).toBe(1);
    expect(driftBanner(host).getAttribute("data-verdict")).toBe("needs_user");
    expect(qa(host, "ul.drift-added").length).toBe(0);
    handle.update(DRIFT_ON_TRACK);
    expect(qa(host, "[data-kind=drift]").length).toBe(0);
    handle.update(FIXTURE);
    expect(qa(host, ".chat-banner").length).toBe(0);
  });

  it("silent and drift banners can coexist, silent first, both before the log", () => {
    const { host } = mount({ ...DRIFT, silent: true, silentFor: "3 min" });
    const banners = qa(host, "div.chat-banner");
    expect(banners.map((b) => b.getAttribute("data-kind"))).toEqual(["silent", "drift"]);
    const log = q(host, "ol.agent-chat-log");
    for (const b of banners) expect(b.compareDocumentPosition(log) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});
