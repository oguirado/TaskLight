import { describe, expect, it, vi } from "vitest";
import { button, mounted, q, running, setup, storeFixture, visible, vm } from "./helpers";

setup();
describe("A1 / M1 theme", () => {
  it("toggles the CSS root light → dark → light and reports the current theme", () => {
    localStorage.setItem("tasklight.theme", "light"); const { host } = running();
    expect(document.documentElement.dataset.theme).toBe("light");
    const light = getComputedStyle(document.documentElement).getPropertyValue("--c-wall");
    button(host, /toggle theme/i).click();
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(button(host, /toggle theme/i).getAttribute("aria-label") ?? button(host, /toggle theme/i).textContent).toMatch(/dark/i);
    expect(getComputedStyle(document.documentElement).getPropertyValue("--c-wall")).not.toBe(light);
    expect(localStorage.getItem("tasklight.theme")).toBe("dark");
    button(host, /toggle theme/i).click(); expect(document.documentElement.dataset.theme).toBe("light");
    expect(localStorage.getItem("tasklight.theme")).toBe("light");
  });
  it("a fresh mount restores the persisted dark choice", () => {
    localStorage.setItem("tasklight.theme", "dark"); const { host } = running();
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(button(host, /toggle theme/i).getAttribute("aria-label") ?? button(host, /toggle theme/i).textContent).toMatch(/dark/i);
  });
  it("blocked storage reads and writes do not disable visible switching", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("denied"); });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("denied"); });
    const { host } = running(); button(host, /toggle theme/i).click();
    expect(document.documentElement.dataset.theme).toBe("dark");
  });
  it("hostile stored text cannot become a theme or executable markup", () => {
    localStorage.setItem("tasklight.theme", '<img src=x onerror="alert(1)">'); const { host } = running();
    expect(["light", "dark"]).toContain(document.documentElement.dataset.theme);
    expect(host.querySelector("img, script, [onerror]")).toBeNull();
  });
  it("dark tokens differ for wall, sidebar and card surfaces", () => {
    document.documentElement.dataset.theme = "light";
    const tokens = ["--c-wall", "--c-rail", "--c-surface-1"];
    const light = tokens.map(t => getComputedStyle(document.documentElement).getPropertyValue(t));
    document.documentElement.dataset.theme = "dark";
    tokens.forEach((t, i) => { const value = getComputedStyle(document.documentElement).getPropertyValue(t); expect(value).not.toBe(""); expect(value).not.toBe(light[i]); });
  });
});
describe("A2 / M2 workspace help", () => {
  it("opens inline setup instructions with a copyable --room command and docs link; Escape closes", () => {
    const { host } = running(); button(host, /new workspace/i).click();
    const link = host.querySelector<HTMLAnchorElement>('a[href$="docs/DESKTOP_SETUP.md"]');
    expect(link, "inline docs link after click").not.toBeNull();
    expect(visible(host)).toContain("wall.config.json"); expect(visible(host)).toMatch(/agent.*MCP|MCP.*agent/i);
    expect([...host.querySelectorAll("code, pre, input, textarea")].some(n => (n.textContent ?? (n as HTMLInputElement).value ?? "").includes("--room"))).toBe(true);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(link!.isConnected && visible(link!).length > 0).toBe(false);
  });
  it("Close dismisses the help panel without creating a workspace or posting", () => {
    const { host, post } = running(); const before = host.querySelectorAll(".workspace").length;
    button(host, /new workspace/i).click(); button(host, /close/i).click();
    expect(host.querySelectorAll(".workspace")).toHaveLength(before); expect(post).not.toHaveBeenCalled();
    const link = host.querySelector<HTMLElement>('a[href$="docs/DESKTOP_SETUP.md"]'); expect(link === null || visible(link) === "").toBe(true);
  });
});
describe("A3 / M3 model feedback", () => {
  it("a never-settling verdict stops checking by ten seconds, with a Chrome/flags hint and Rules active", async () => {
    const { host } = running(storeFixture(), true);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(visible(host)).toContain("Gemini Nano: not available on this device");
    expect(visible(host)).not.toContain("checking…"); expect(visible(host)).toMatch(/Chrome/i); expect(visible(host)).toMatch(/flag/i);
    expect(visible(host)).toMatch(/Rules/);
  });
  it("Suggest while unavailable displays inline feedback and never posts", async () => {
    const s = storeFixture();
    expect(s.ingest({ id: "e-0000000000000064", lamport: 100, ts: Date.now(), room: "oracle", agent: "helper", act: "plan", text: "", plan: { title: "Legacy", steps: [{ text: "Check" }] } })).toBe(true);
    const { host, chat, post } = running(s); await vi.advanceTimersByTimeAsync(10_000);
    const card = [...host.querySelectorAll<HTMLElement>("article.task")].find(n => n.getAttribute("data-task-id") === "agent:oracle:helper" || n.id === "agent:oracle:helper");
    expect(card).toBeDefined(); card!.click();
    button(chat, /suggest with Gemini Nano/i).click();
    expect(visible(chat)).toMatch(/not available on this device|Gemini Nano.*unavailable/i); expect(post).not.toHaveBeenCalled();
  });
  it.each([/Gemini Nano/i, /Rules/i])("status %s opens the existing Models sheet via its public handler", name => {
    const onOpenModels = vi.fn(); const { host } = mounted(vm(), { onOpenModels });
    const status = button(host, name); status.click();
    expect(onOpenModels).toHaveBeenCalledExactlyOnceWith(status);
  });
  it("destroy cancels pending feedback and leaves no UI after the timeout", async () => {
    const { host, wall } = running(storeFixture(), true); wall.destroy();
    await vi.advanceTimersByTimeAsync(10_000); expect(host.childNodes).toHaveLength(0);
  });
});
describe("A4 / M4 phase selection", () => {
  it("Build filters phase sections, is pressed, and Show all restores the full list", () => {
    const { host, wall } = running();
    const sections = () => [...host.querySelectorAll<HTMLElement>(".phase-group")].filter(n => visible(n).trim());
    const before = sections().length;
    expect(before).toBeGreaterThan(1); button(host, /^Build$/).click();
    expect(button(host, /^Build$/).getAttribute("aria-pressed")).toBe("true");
    expect(sections()).toHaveLength(1);
    expect(sections()[0]!.textContent).toContain("Build");
    wall.refresh(); expect(sections()).toHaveLength(1);
    button(host, /show all phases/i).click(); expect(sections()).toHaveLength(before);
  });
  it("Discovery retains a distinct current marker when Build is selected", () => {
    const { host } = running(); button(host, /^Build$/).click();
    const discovery = button(host, /Discovery/);
    expect(discovery.getAttribute("aria-pressed")).not.toBe("true");
    expect(`${discovery.textContent} ${discovery.getAttribute("aria-label") ?? ""} ${discovery.getAttribute("aria-current") ?? ""}`).toMatch(/current|step|true/i);
  });
});
describe("A5 / M5 open work counts", () => {
  it.each([
    { cancelled: false, field: "header" }, { cancelled: false, field: "workspace" },
    { cancelled: true, field: "header" }, { cancelled: true, field: "workspace" },
  ])("excludes done and closed legacy work; cancelled=$cancelled field=$field", ({ cancelled, field }) => {
    const { host } = running(storeFixture({ completed: true, cancelled, legacy: true }));
    const count = cancelled ? 3 : 4;
    if (field === "header") expect(q(host, ".view-sub").textContent).toContain(`${count} open tasks`);
    else expect(q(host, '.workspace[data-wsid="oracle"] .ws-lens').textContent).toMatch(new RegExp(`\\b${count} open\\b`));
  });
  it("an open legacy card is counted until its close event arrives", () => {
    const store = createLegacy(); const { host, wall } = running(store);
    expect(q(host, ".view-sub").textContent).toContain("6 open tasks");
    expect(store.ingest({ id: "e-0000000000000066", lamport: 102, ts: Date.now(), room: "oracle", agent: "legacy", act: "close", text: "Done" })).toBe(true);
    wall.refresh(); expect(q(host, ".view-sub").textContent).toContain("5 open tasks");
  });
});
function createLegacy() {
  const s = storeFixture();
  expect(s.ingest({ id: "e-0000000000000065", lamport: 101, ts: Date.now(), room: "oracle", agent: "legacy", act: "plan", text: "", plan: { title: "Legacy", steps: [{ text: "Check" }] } })).toBe(true);
  return s;
}
