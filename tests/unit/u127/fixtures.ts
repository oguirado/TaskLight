import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { renderSwarmView } from "../../../src/views/swarm";
import { renderNarrator } from "../../../src/views/narrator";
import { createModelSheet } from "../../../src/ui/model_selector";
import { createSyncNotice } from "../../../src/views/sync_notice";
import type { SwarmAgentVM } from "../../../src/app/swarm_vm";
import type { PlanTask } from "../../../src/plan/types";

export const styleNames = ["tokens", "wall", "views", "plan", "swarm", "model_selector", "agents", "narrator"] as const;
export const sources = Object.fromEntries(styleNames.map(name => [name,
  readFileSync(resolve(import.meta.dirname, "../../../styles", `${name}.css`), "utf8")])) as Record<typeof styleNames[number], string>;
export const css = styleNames.map(name => sources[name]).join("\n");
export const aliases = [
  ["--color-bg", "--c-wall"], ["--color-surface", "--c-surface-1"],
  ["--color-text", "--c-text-1"], ["--color-text-muted", "--c-text-3"],
  ["--color-accent", "--c-primary"], ["--color-danger", "--c-st-blocked"],
  ["--color-warning", "--c-st-waiting"], ["--color-ok", "--c-st-done"],
] as const;
export const durations = ["--motion-duration", "--dur-1", "--dur-2", "--dur-3", "--dur-spin", "--dur-live"];

/** Production renderers with fixed view models; no inference, transports or clocks. */
export function markup(long = false): string {
  const slug = long ? "a".repeat(120) : "executor-a";
  const task: PlanTask = {
    id: "T01", title: long ? "t".repeat(120) : "Verify the current work", type: "implementation", phase: "build",
    accept: "Tests pass", deps: [], assignee: slug, claim_lamport: 1, claim_ts: 1000,
    estimate: null, explicit_state: null, blocked_reason: null, state: "active", ready: true, rev: 1,
    microtasks: [{ id: "T01.M01", text: "Working", accept: "Recorded evidence", state: "active",
      outcome: null, took: null, evidence: [], rev: 1 }],
  };
  const agent: SwarmAgentVM = {
    agent: slug, lifecycle: "alive", run_id: "run-a", harness: "Fixture harness", swarm: "alpha",
    tasks: [task], current_task_id: "T01", active_micro_id: "T01.M01", micro_done: 0, micro_total: 1,
    activity: "working", last_beat_ts: 1000, last_beat_age_ms: 1000,
    waiting_on: [{ task_id: "T01", upstream_id: "T02", owner: "executor-b", missing: false }], unanswered_questions: 0,
  };
  const app = document.createElement("div"); app.className = "app";
  const rail = document.createElement("aside"); rail.className = "rail";
  const main = document.createElement("main"); main.className = "main"; app.append(rail, main);
  main.append(renderSwarmView(document, {
    room: "demo", agents: [agent, { ...agent, agent: "executor-failed", lifecycle: "failed" },
      { ...agent, agent: "executor-unknown", activity: "unknown" }], progress: null, refresh_at_ms: null,
  }));
  // Open real disclosures before serialization; route wiring is U118/U125's gate.
  for (const toggle of app.querySelectorAll<HTMLButtonElement>(".swarm-metadata-toggle")) toggle.click();
  app.querySelector<HTMLButtonElement>(".swarm-task-open")?.click();
  main.append(renderNarrator(document, { kind: "rules", text: "Liveness unknown · Waiting on T02 · executor-b", source: null }, () => undefined));
  const trigger = document.createElement("button"); trigger.className = "status-line models-trigger";
  trigger.textContent = "Models"; trigger.setAttribute("aria-controls", "model-sheet"); rail.append(trigger);
  const sheet = createModelSheet({ doc: document, mount: main,
    announcer: { say: () => undefined, flushedCount: () => 0 }, onIntent: () => undefined });
  sheet.render({ providers: [{ id: "firebase-hybrid", kind: "firebase-hybrid", label: "Hybrid", health: "available" },
    { id: "fixture-local", kind: "local-openai-compatible", label: long ? "m".repeat(120) : "Local model", health: "available" }],
    selection: { all: "firebase-hybrid" }, device: { state: "not_initialised" }, hostPresent: true });
  sheet.open(trigger);
  const notice = createSyncNotice(main);
  notice.update([{ room: long ? "r".repeat(120) : "demo", fromLamport: 7, toLamport: 9 }]);
  // Public CSS hooks for preserved Diary/detail/legacy surfaces not mounted by Swarm.
  const fixture = document.createElement("section");
  fixture.innerHTML = `<div class="diary"><ol class="timeline"><li class="entry"><time class="entry-time">10:05</time>
    <div class="entry-body"><p class="entry-title">Completed work</p><p class="entry-outcome">Evidence recorded</p>
    <div class="entry-meta"><span>executor-a</span><span>2m</span></div><p class="entry-project">demo</p></div></li></ol></div>
    <ol class="steps"><li class="step" data-state="active" data-activity="working"><button class="step-row">
    <span class="step-indicator"></span><span class="step-label">Working</span><span class="step-chevron"></span></button>
    <div class="step-detail">Task evidence</div></li></ol><button class="wall-banner" data-role="wall-banner">Legacy status</button>
    <button class="phase-chip">Build</button>`;
  main.append(fixture);
  const html = app.outerHTML;
  sheet.dispose();
  document.body.replaceChildren();
  return html;
}

export const aliasProbe = `(() => ${JSON.stringify(aliases)}.map(([alias, canonical]) => {
  const value = name => {
    const node = document.createElement('i'); node.style.color = 'var(' + name + ')'; document.querySelector('.app').append(node);
    const result = { raw: getComputedStyle(node).getPropertyValue(name).trim(), color: getComputedStyle(node).color };
    node.remove(); return result;
  };
  return { alias, canonical, actual: value(alias), expected: value(canonical) };
}))()`;

export const motionProbe = `(() => {
  const app = document.querySelector('.app');
  try { CSS.registerProperty({ name: '--u127-time-probe', syntax: '<time>', inherits: false, initialValue: '-1ms' }); }
  catch (error) { if (error.name !== 'InvalidModificationError') throw error; }
  const values = Array.from([app, app.querySelector('.step-indicator')]).flatMap(node =>
    ${JSON.stringify(durations)}.map(name => {
      const probe = document.createElement('i'); probe.style.setProperty('--u127-time-probe', 'var(' + name + ')'); node.append(probe);
      const resolved = getComputedStyle(probe).getPropertyValue('--u127-time-probe');
      const result = { node: node.className, name, raw: getComputedStyle(node).getPropertyValue(name).trim(),
        milliseconds: parseFloat(resolved) * (resolved.trim().endsWith('ms') ? 1 : 1000) };
      probe.remove(); return result;
    }));
  const layers = [app, ...app.querySelectorAll('*')].flatMap(node => [null, '::before', '::after'].map(pseudo => {
    const style = getComputedStyle(node, pseudo);
    return { node: node.className, pseudo, animation: style.animationDuration, transition: style.transitionDuration };
  }));
  const working = app.querySelector('.step-label'); const rect = working.getBoundingClientRect();
  return { values, layers, working: working.textContent, visible: rect.width > 0 && rect.height > 0 };
})()`;

/** M5 is deliberately a source contract, unlike the rendered A1/A2/A3 gates. */
export function spacingViolations(text: string): string[] {
  const bad: string[] = [];
  const variables = new Map([...css.matchAll(/(--[\w-]+)\s*:\s*([^;{}]+);/g)].map(match => [match[1]!, match[2]!]));
  const expand = (value: string, seen = new Set<string>()): string => value.replace(/var\(\s*(--[\w-]+)\s*\)/g, (original, name: string) => {
    if (name.startsWith("--sp-")) return "0px"; // Scale values are explicitly allowed by M5.
    if (seen.has(name) || !variables.has(name)) return original;
    return expand(variables.get(name)!, new Set([...seen, name]));
  });
  for (const match of text.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selector = match[1]!.replace(/\/\*[\s\S]*?\*\//g, "").trim();
    if (!selector || selector === ":root" || selector.startsWith(":root[")) continue;
    for (const declaration of match[2]!.matchAll(/(?:^|[;\n])\s*((?:margin|padding)(?:-[\w-]+)?|(?:row-|column-)?gap)\s*:\s*([^;]+);/g)) {
      const start = declaration.index! + declaration[0].length;
      const before = match[2]!.slice(0, declaration.index!).trimEnd();
      const after = match[2]!.slice(start).trimStart();
      const optical = /\/\*\s*optical:([^*]*(?:\*(?!\/)[^*]*)*)\*\/\s*$/i.exec(before)
        ?? /^\/\*\s*optical:([\s\S]*?)\*\//i.exec(after);
      if (optical?.[1]?.trim()) continue;
      const value = declaration[2]!;
      if ([...expand(value).matchAll(/(-?[\d.]+)(px|rem|em)\b/g)].some(m => Math.abs(Number(m[1])) * (m[2] === "px" ? 1 : 16) > 2)) {
        bad.push(`${selector} { ${declaration[1]}: ${value} }`);
      }
    }
  }
  return bad;
}
