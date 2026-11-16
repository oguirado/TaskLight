import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

const read = (file: string) => readFileSync(join(process.cwd(), file), "utf8");
const demo = read("tools/demo/run_demo.mjs");
const config = read("tools/demo/vite.demo.config.ts");
const css = read("styles/wall.css");
const docs = read("tools/demo/README_DEMO.md");
// Passive lexical checks only: never import the executable demo or launch its children.
const withoutComments = (source: string) => source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const code = withoutComments(demo);

function trackBackgrounds(source: string): string[] {
  const track = document.createElement("div");
  track.className = "progress-track";
  track.setAttribute("role", "progressbar");
  const found: string[] = [];
  for (const rule of source.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selector = rule[1]!.trim();
    if (!/background(?:-color)?\s*:/i.test(rule[2]!)) continue;
    if (selector.split(",").some(s => track.matches(s.trim()))) found.push(selector);
  }
  return found;
}

describe("A2 / M2 progress track cascade", () => {
  test("A2 wall stylesheet does not paint the task progress track", () => {
    expect(trackBackgrounds(css)).toEqual([]);
  });
  test("A2 negative control catches an unscoped background", () => {
    expect(trackBackgrounds('[role="progressbar"] { background-color: var(--color-ok); }')).toEqual(['[role="progressbar"]']);
  });
  test("A2 negative control catches shorthand and comma selector bypass", () => {
    expect(trackBackgrounds('.other, [role="progressbar"] { background: green; }')).toHaveLength(1);
  });
  test("A2 scoped progressbar rule permits other progress indicators", () => {
    expect(trackBackgrounds('[role="progressbar"]:not(.progress-track) { background-color: var(--color-ok); }')).toEqual([]);
  });
});

describe("M1 stylesheet derivation wiring", () => {
  test("M1 Vite reads hosting main imports and uses the pure helper", () => {
    const source = withoutComments(config);
    expect(source).toMatch(/demo_lib\.mjs/);
    expect(source).toMatch(/parseStylesheetImports/);
    expect(source).toMatch(/main\.ts/);
    expect(source).toMatch(/readFile/);
    expect(source).toMatch(/stylesheet/);
  });
});

describe("A5 / M3 / M4 current wall interactions", () => {
  test("A5 obsolete drift copy is absent", () => {
    expect(demo).not.toContain("Reviewed by rules");
  });
  test("M3 Rules label matches both current renderers", () => {
    // Neither renderer exports its source label table today; fallback is one constant.
    expect(read("src/agentsui/index.ts")).toContain("rules");
    expect(read("src/views/index.ts")).toContain('"Rules"');
    expect(code).toMatch(/(?:const|let)\s+\w+\s*=\s*["']Rules["']/);
  });
  test("A5 task Chat is opened before selecting input and sending", () => {
    const open = code.indexOf("button.task-chat");
    const input = code.indexOf("textarea.chat-input");
    const send = code.indexOf("button.chat-send");
    expect(open).toBeGreaterThanOrEqual(0);
    expect(input).toBeGreaterThan(open);
    expect(send).toBeGreaterThan(input);
    // Accept DOM clicks or CDP clicks, rather than imposing one interaction method.
    expect(code.slice(open, input)).toMatch(/\.click\s*\(|dispatchMouseEvent/);
    expect(code.slice(input)).toMatch(/insertText|\.value\s*=/);
    expect(code.slice(send)).toMatch(/\.click\s*\(|dispatchMouseEvent/);
  });
});

describe("M5 MCP planning and Memory static integration", () => {
  test("M5 MCP stdio module uses python3 and the demo CW_HOME", () => {
    expect(code).toContain("bridge.room.mcp");
    expect(code).toContain("python3");
    expect(code).toMatch(/CW_HOME\s*:\s*P\.cwhome/);
  });
  test("M5 all required v2 calls and template payload are present", () => {
    for (const tool of ["plan_create", "task_claim", "microtask_set", "memory_set"]) expect(code).toContain(tool);
    expect(code).toContain("web-app");
    expect(code).toContain("architecture");
    expect(code).toMatch(/["']done["']/);
    expect(code).toMatch(/tasks\s*:/);
  });
  test("M5 plan and Memory screenshots follow chat in the required order", () => {
    const chat = code.indexOf("3_chat.png");
    const plan = code.indexOf("4_plan_v2.png");
    const memory = code.indexOf("5_memory.png");
    expect(chat).toBeGreaterThanOrEqual(0);
    expect(plan).toBeGreaterThan(chat);
    expect(memory).toBeGreaterThan(plan);
    expect(code).toContain("Memory");
    expect(code.slice(plan, memory)).toMatch(/\.click\s*\(|dispatchMouseEvent/);
  });
  test("M5 summary and no-mcp exit gate are wired to the shared helper", () => {
    expect(code).toContain("--no-mcp");
    expect(code).toContain("summaryExitCode");
    expect(code).toContain("demo_lib.mjs");
    expect(code).toMatch(/planV2\s*[:=.]/);
    expect(code).toMatch(/memory\s*[:=.]/);
  });
});

describe("M6 browser discovery wiring", () => {
  test("M6 demo consumes candidates and has a clear no-browser error", () => {
    expect(code).toContain("chromeCandidates");
    expect(code).toMatch(/existsSync|accessSync/);
    expect(code).toMatch(/(?:Chrome|Chromium|browser)[^\n]*(?:not found|not installed|cannot find|could not find|no .*found)|(?:no|unable to find|cannot find)[^\n]*(?:Chrome|Chromium|browser)/i);
  });
});

describe("M7 README current steps and remaining gaps", () => {
  test("M7 documents new MCP steps, screenshots and skip flag", () => {
    for (const text of ["plan_create", "task_claim", "microtask_set", "memory_set", "Memory", "4_plan_v2.png", "5_memory.png", "--no-mcp", "CHROME"]) expect(docs).toContain(text);
    for (const flag of ["--headless", "--keep", "--dir"]) expect(docs).toContain(flag);
  });
  test("M7 known gaps no longer claim the confirmed fixed defects", () => {
    const gaps = docs.match(/## Known gaps[^\n]*\n([\s\S]*?)(?=\n#{1,2} |$)/)?.[1] ?? "";
    expect(docs).toMatch(/## Known gaps/);
    for (const stale of ["History is not replayed to a fresh page", "puts only `bridge/`", "Nothing links `styles/*.css`", "shows the user agent (`wall-user`) as its own task"]) expect(gaps).not.toContain(stale);
  });
});
