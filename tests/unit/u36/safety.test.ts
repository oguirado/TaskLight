import { afterEach, describe, expect, it, vi } from "vitest";
import type { ViewId } from "../../../src/views/types";
import { FIXTURE, mapIds, mapText, vm } from "./fixture";
import { ALL_VIEWS, attr, cleanup, click, mount, mountSpied, q, qa, signature, txt } from "./helpers";

afterEach(cleanup);

const PAYLOADS = [
  "<img src=x onerror=alert(1)>",
  "<script>alert(1)</script>",
  "\"><svg onload=alert(1)>",
  "<b>bold</b> &amp; &lt;i&gt; <iframe src=javascript:alert(1)></iframe>",
  "'; alert(1); //",
  "<style>*{display:none}</style><a href=\"javascript:alert(1)\">x</a>",
];
const ALLOWED = new Set(["div", "span", "p", "ul", "ol", "li", "button", "nav", "aside", "main", "header", "section", "article", "footer", "h1", "h2", "a", "kbd", "time", "dl", "dt", "dd"]);
const FORBIDDEN = "img,script,svg,iframe,style,b,i,object,embed,link,meta,form,input,textarea,video,audio,math,base,template";

const hostile = (p: string) => mapText(FIXTURE, (s) => `${p}|${s}`);
const benign = () => mapText(FIXTURE, (s) => `x|${s}`);
const full = (view: ViewId, base = FIXTURE) => ({ ...base, view, archiveScope: "all" as const });

describe("B2 text safety: markup in data renders literally", () => {
  describe.each(PAYLOADS)("payload %s", (p) => {
    it.each(ALL_VIEWS)("view %s: same element tree as benign text, only allowed tags, no on* / javascript: attributes", (view) => {
      const a = mount({ ...hostile(p), view, archiveScope: "all" }).host;
      const b = mount({ ...benign(), view, archiveScope: "all" }).host;
      expect(signature(a)).toBe(signature(b));
      expect(qa(a, FORBIDDEN).length).toBe(0);
      for (const e of qa<Element>(a, "*")) {
        expect(ALLOWED.has(e.tagName.toLowerCase()), e.tagName).toBe(true);
        for (const at of Array.from(e.attributes)) {
          expect(at.name.startsWith("on"), `${e.tagName}@${at.name}`).toBe(false);
          expect(["src", "srcdoc", "action", "formaction", "data"]).not.toContain(at.name);
          if (at.name === "style") expect(at.value).toMatch(/^\s*--p\s*:/);
          if (at.name === "href") expect(at.value).toMatch(/^#/);
        }
      }
      expect(a.textContent).toContain(p);
    });

    it("title, summary, step label/note, outcome, evidence and next appear literally in the Wall", () => {
      const { host } = mount(hostile(p));
      const a = q(host, "article#t1");
      expect(txt(q(a, "h2.task-title"))).toBe(`${p}|${FIXTURE.tasks[0]?.title}`);
      expect(txt(q(a, "p.task-summary"))).toBe(`${p}|${FIXTURE.tasks[0]?.summary}`);
      expect(txt(q(a, ".step-label"))).toBe(`${p}|Port handlers to the v2 schema`);
      expect(txt(q(a, ".next-text"))).toContain(p);
      expect(txt(q(a, "p.step-note"))).toContain(p);
      expect(txt(q(a, "p.detail-outcome"))).toContain(p);
      expect(txt(q(a, "ul.detail-evidence > li"))).toContain(p);
      expect(txt(q(a, ".updated"))).toContain(p);
      expect(txt(q(host, ".ws-name"))).toBe(`${p}|Backend & API`);
      expect(txt(q(host, "p.view-eyebrow"))).toBe(`${p}|Backend & API`);
      expect(txt(q(host, ".status-line[data-model] .status-text"))).toBe(`${p}|Gemini Nano ready on this device`);
      expect(txt(q(host, ".focus-project"))).toBe(`${p}|Payments gateway`);
      expect(txt(q(host, ".focus-step"))).toContain(p);
    });

    it("agenda, diary and archive text appear literally", () => {
      const ag = mount(full("agenda", hostile(p))).host;
      expect(txt(q(ag, "h2.agenda-heading"))).toBe(`${p}|Waiting on you`);
      expect(txt(q(ag, ".agenda-what"))).toBe(`${p}|Add the staging signing key`);
      expect(txt(q(ag, ".agenda-when"))).toBe(`${p}|Now`);
      const di = mount(full("diary", hostile(p))).host;
      expect(txt(q(di, ".entry-title"))).toContain(p);
      expect(txt(q(di, ".entry-outcome"))).toContain(p);
      expect(txt(q(di, ".entry-took"))).toContain(p);
      const ar = mount(full("archive", hostile(p))).host;
      expect(txt(q(ar, ".archived-title"))).toBe(`${p}|Rate limiting shipped to production`);
      expect(txt(q(ar, ".archived-outcome"))).toContain(p);
      expect(txt(q(ar, ".archived-date"))).toContain(p);
      expect(txt(q(ar, ".archived-ws"))).toContain(p);
    });
  });

  it("alert is never reached and no script/handler executes while rendering and clicking everything", () => {
    const alert = vi.fn();
    vi.stubGlobal("alert", alert);
    (window as unknown as { alert: unknown }).alert = alert;
    const p = PAYLOADS[0] ?? "";
    for (const view of ALL_VIEWS) {
      const { host } = mount(full(view, hostile(p)));
      for (const b of qa<HTMLElement>(host, "button")) click(b);
    }
    expect(alert).not.toHaveBeenCalled();
    expect(document.querySelectorAll("img,script").length).toBe(0);
  });

  it("update() with hostile data stays safe too", () => {
    const { host, handle } = mount();
    handle.update(hostile(PAYLOADS[1] ?? ""));
    expect(qa(host, FORBIDDEN).length).toBe(0);
    expect(host.textContent).toContain(PAYLOADS[1]);
    handle.update(full("diary", hostile(PAYLOADS[2] ?? "")));
    expect(qa(host, FORBIDDEN).length).toBe(0);
  });

  it("entities are not decoded: '&lt;' stays six characters '&lt;'", () => {
    const { host } = mount(vm({ model: { state: "ready", label: "&lt;b&gt; &amp; <u>" } }));
    expect(txt(q(host, ".status-line[data-model] .status-text"))).toBe("&lt;b&gt; &amp; <u>");
    expect(host.querySelector("u")).toBeNull();
  });
});

describe("B2 hostile ids and attribute values", () => {
  const BAD_ID = (s: string) => `x"><img src=x onerror=alert(1)>${s}`;
  const withBadIds = () => mapIds(FIXTURE, BAD_ID);

  it.each(ALL_VIEWS)("view %s renders with hostile ids: no extra elements, no on* attributes", (view) => {
    const { host } = mount(full(view, withBadIds()));
    const { host: ref } = mount(full(view, mapIds(FIXTURE, (s) => `id-${s}`)));
    expect(signature(host)).toBe(signature(ref));
    expect(qa(host, FORBIDDEN).length).toBe(0);
    for (const e of qa<Element>(host, "*")) for (const at of Array.from(e.attributes)) expect(at.name.startsWith("on")).toBe(false);
  });

  it("focus link href is '#' + raw id and the target exists", () => {
    const { host } = mount(withBadIds());
    const a = q(host, "a.focus-link");
    expect(attr(a, "href")).toBe(`#${BAD_ID("t1")}`);
    expect(document.getElementById(BAD_ID("t1"))).toBe(q(host, "article.task"));
  });

  it("handlers receive the raw ids", () => {
    const { host, spies } = mountSpied(full("archive", withBadIds()));
    click(q(host, "button.archived-restore"));
    expect(spies.onRestore.mock.calls).toEqual([[BAD_ID("a1")]]);
    click(q(host, "button.workspace"));
    expect(spies.onWorkspace.mock.calls).toEqual([[BAD_ID("w1")]]);
  });

  it("text containing quotes, backticks, </script> and null bytes renders without throwing", () => {
    const nasty = "\"'`</script></style>\u0000   \\u003cb\\u003e";
    expect(() => mount(mapText(FIXTURE, (s) => nasty + s))).not.toThrow();
  });
});
