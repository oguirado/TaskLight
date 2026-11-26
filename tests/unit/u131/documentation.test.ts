// @vitest-environment node
import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ROOT, SCOPED, availabilityIssues, cleanup, corpus, discoveryIssues, fences,
  legacyIssues, linkIssues, plain, privacyIssues, probe, publicationIssues, read, schemaIssues, totals, trustIssues } from "./support";

const docs = corpus();
const text = (path: string) => docs.get(path) ?? "";
const scoped = SCOPED.map(path => text(path)).join("\n");
const workflow = plain([text("docs/HEADLESS.md"), text("docs/PLANNING.md"), text("docs/PLANNING_CONTRACT.md")].join("\n"));
afterAll(cleanup);

describe("M1 positioning and legacy scope", () => {
  it("positions the introduction around external harness deployment and shared coarse work", () => {
    const intro = plain(text("README.md").split(/^## /m)[0] ?? "");
    expect(intro).toMatch(/harness/i);
    expect(intro).toMatch(/deploy|direct/i);
    expect(intro).toMatch(/external|outside/i);
    expect(intro).toMatch(/shared.{0,80}plans?|plans?.{0,80}shared/i);
    expect(intro).toMatch(/coarse.{0,40}microtasks?/i);
  });

  it.each(["identity", "harness", "current work", "state", "liveness", "dependencies", "progress"])("describes operator visibility of %s", field => {
    const aliases: Record<string, RegExp> = { identity: /identity|agent names?/i, harness: /harness/i,
      "current work": /current work|current task|working on|active work/i, state: /state|status/i,
      liveness: /liveness/i, dependencies: /dependenc/i, progress: /progress/i };
    expect(plain(text("README.md"))).toMatch(aliases[field]!);
  });

  it("labels retained chat and liaison legacy in every scoped guide that discusses them", () => {
    expect(legacyIssues(docs)).toEqual([]);
  });

  it("states that legacy chat and liaison receive no new investment", () => {
    expect(plain(scoped)).toMatch(/(?:chat|liaison).{0,200}(?:no (?:new|further) (?:investment|development)|maintenance.only|no longer.{0,30}invest)|no (?:new|further) (?:investment|development).{0,100}(?:chat|liaison)/i);
  });

  it("keeps human conversations and terminals in the harness", () => {
    const prose = plain(text("README.md") + "\n" + text("docs/HEADLESS.md"));
    expect(prose).toMatch(/(?:human|conversation).{0,130}harness|harness.{0,130}(?:human|conversation)/i);
    expect(prose).toMatch(/terminal.{0,100}harness|harness.{0,100}terminal/i);
  });

  it("describes Firebase hosting without claiming a deployment that is unavailable", () => {
    const readme = plain(text("README.md"));
    expect(readme).toMatch(/Firebase/i);
    // Hosting is live: the README names the hosted wall and no longer calls the deployment pending.
    expect(readme).toContain("https://tasklight-d59f6.web.app");
    expect(readme).not.toMatch(/pending|not.{0,20}deployed|not yet.{0,20}hosted/i);
  });
});

describe("M2/A1 live discovery documentation", () => {
  let live: ReturnType<typeof probe>;
  beforeAll(() => { live = probe("discovery"); }, 30000);

  it("has one current total across README and recursive documentation, only in MCP.md", () => {
    expect(totals(docs)).toEqual([{ file: "docs/MCP.md", value: live.tools.length }]);
  });

  it("documents initialize protocol and server version from the candidate", () => {
    expect(discoveryIssues(docs, live.tools.length, live.initialize.protocolVersion,
      live.initialize.serverInfo.version).filter(issue => /version|protocol/i.test(issue))).toEqual([]);
  });

  it("documents the complete discovered inventory including registered extensions", () => {
    // A-C3c: include the snapshot tool exactly once and link its contract guide.
    expect(live.tools.filter((tool: { name: string }) => tool.name === "orchestrator_snapshot")).toHaveLength(1);
    expect(text("docs/MCP.md")).toContain("[Orchestrator snapshots](ORCHESTRATOR.md)");
    // A-C6: include the waiter exactly once and link its dedicated contract guide.
    expect(live.tools.filter((tool: { name: string }) => tool.name === "wait_agents")).toHaveLength(1);
    expect(text("docs/MCP.md")).toContain("[Waiting for agent results](WAIT_AGENTS.md)");
    const missing = live.tools.map((tool: { name: string }) => tool.name)
      .filter((name: string) => !text("docs/MCP.md").includes(name));
    expect(missing).toEqual([]);
  });

  it("keeps published JSON tool-call examples consistent with discovered argument schemas", () => {
    for (const file of SCOPED) {
      for (const block of fences(text(file)).filter(item => /^json\b/.test(item.info))) {
        if (!/"method"\s*:\s*"tools\/call"/.test(block.text)) continue;
        let example: unknown;
        expect(() => { example = JSON.parse(block.text); }, `${file}: executable JSON request must parse`).not.toThrow();
        expect(example, `${file}: tool-call request must name the tool`).toHaveProperty("params.name");
        expect(example, `${file}: tool-call request must provide arguments`).toHaveProperty("params.arguments");
        const call = example as { params: { name: string; arguments: unknown } };
        const descriptor = live.tools.find((tool: { name: string }) => tool.name === call.params.name);
        expect(descriptor, `${file}: example must target a discovered tool`).toBeDefined();
        expect(schemaIssues(call.params.arguments, descriptor.inputSchema), `${file}: ${call.params.name}`).toEqual([]);
      }
    }
  });

  it("retains generic stdio registration with repository cwd and CW_HOME", () => {
    const registrations = fences(text("docs/MCP.md")).filter(block => block.info.trim() === "json").flatMap(block => {
      try { return [JSON.parse(block.text)]; } catch { return []; }
    });
    expect(registrations).toContainEqual({ command: "python3", args: ["-m", "bridge.room.mcp"],
      cwd: "<repo-root>", env: { CW_HOME: "<cw-home-path>" } });
    expect(text("docs/MCP.md")).toContain("python3 -m bridge.room tools");
  });

  it("distinguishes installer preview from --apply", () => {
    const guide = text("docs/DESKTOP_SETUP.md");
    const commands = fences(guide).flatMap(block => block.text.split("\n"))
      .filter(line => /^python3 bridge\/install\.py\b/.test(line));
    expect(commands.some(line => !line.includes("--apply"))).toBe(true);
    expect(commands.some(line => line.includes("--apply"))).toBe(true);
    expect(plain(guide)).toMatch(/dry.run.{0,80}writes nothing/i);
  });

  it.each(["docs/MCP.md", "docs/HEADLESS.md", "docs/PLANNING_CONTRACT.md"])("documents optional claim_lamport and stale_rev without banning all revisions in %s", file => {
    const prose = plain(text(file));
    expect(prose).toContain("claim_lamport");
    expect(prose).toContain("stale_rev");
    expect(prose).not.toMatch(/or any revision field|never pass a revision field|omit revision on microtask_set/i);
  });

  it("keeps resource URI references resolvable by the same candidate", () => {
    const registered = new Set(live.resources.map((item: { uri: string }) => item.uri));
    const templates = live.resourceTemplates.map((item: { uriTemplate: string }) => item.uriTemplate);
    const uris = [...scoped.matchAll(/tasklight:\/\/[A-Za-z0-9_/.{}-]+/g)].map(match => match[0]);
    const unresolved = uris.filter(uri => !registered.has(uri) && !templates.some((template: string) => {
      const escaped = template.split(/\{[^}]+\}/).map(part => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
      return new RegExp(`^${escaped.join("[^/]+")}$`).test(uri);
    }));
    expect(unresolved).toEqual([]);
  });
});

describe("M3/A4/A5 messaging guidance", () => {
  it("documents the typed request, four acts, evidence objects, and untrusted durable receipt", () => {
    const guide = text("docs/MCP.md");
    expect(guide).toContain("room_send");
    for (const field of ["room", "agent", "to", "act", "text", "re", "evidence", "op_id", "path", "sha256", "untrusted", "ok", "id", "lamport"]) {
      expect(guide, `room_send field ${field}`).toMatch(new RegExp(`\\b${field}\\b`));
    }
    for (const act of ["question", "answer", "handoff", "ack"]) expect(guide).toMatch(new RegExp(`\\b${act}\\b`));
  });

  it("documents bad_args, bad_act, bad_re, same-room references and recipient checks", () => {
    const guide = plain(text("docs/MCP.md"));
    for (const code of ["bad_args", "bad_act", "bad_re"]) expect(guide).toContain(code);
    expect(guide).toMatch(/same.room/);
    expect(guide).toMatch(/recipient|addressee/i);
    expect(guide).toMatch(/(?:acknowledg|ack).{0,140}(?:question|handoff)|(?:question|handoff).{0,140}(?:acknowledg|ack)/i);
    expect(guide).toMatch(/identical.{0,100}(?:request|replay)|same.{0,60}request/i);
  });

  it("separates persistence from receipt, understanding and application", () => {
    const prose = plain(scoped);
    expect(prose).toMatch(/persist|durab/i);
    expect(prose).toMatch(/(?:not|no|never|does not).{0,100}(?:understand|understanding)/i);
    expect(prose).toMatch(/(?:not|no|never|unavailable).{0,100}(?:recei(?:pt|ved)|applied|application)|read receipts are unavailable/i);
    expect(prose).not.toMatch(/(?:delivery|message) states? (?:are|include) received.{0,40}answered.{0,40}applied/i);
  });

  it("treats agent text and prompt arguments as passive data", () => {
    const prose = plain(scoped);
    expect(prose).toMatch(/passive.data|passive data/i);
    expect(prose).toMatch(/prompt arguments|arguments.{0,60}passive|passive.{0,60}arguments/i);
    expect(prose).toMatch(/(?:never|not|must not).{0,60}(?:execute|obey|follow).{0,100}(?:message|directive|instruction)/i);
  });
});

describe("M4 gates and M5 executor guidance", () => {
  it("explains shared dispatch, claim ownership and unfinished closure errors", () => {
    const prose = plain(text("docs/MCP.md") + "\n" + text("docs/HEADLESS.md"));
    expect(prose).toMatch(/same validated|shared.{0,40}(?:dispatch|handler)/i);
    expect(prose).toContain("not_conformant");
    expect(prose).toContain("claimed_by_other");
    expect(prose).toMatch(/unassigned|claim.{0,50}before/i);
    expect(prose).toMatch(/unfinished.{0,100}(?:identif|task)|(?:close|closure).{0,100}unfinished/i);
  });

  it("documents dependency guards for active/done, cancellation and release reset", () => {
    expect(workflow).toMatch(/dependenc.{0,160}(?:active|done)|(?:active|done).{0,160}dependenc/i);
    expect(workflow).toMatch(/cancelled/);
    expect(workflow).toMatch(/release.{0,150}(?:reset|pending)|(?:reset|pending).{0,150}release/i);
  });

  it("links the swarm guide only when supplied and references all executor prompts", () => {
    const target = "docs/SWARM.md";
    const linked = /\]\((?:docs\/)?SWARM\.md(?:#[^)]*)?\)/.test(scoped);
    expect(linked).toBe(existsSync(join(ROOT, target)));
    for (const prompt of ["swarm_coordinator", "swarm_executor", "executor_loop"]) expect(scoped).toContain(prompt);
  });

  it("documents coarse boundaries, outcome/evidence and stable per-attempt run_id", () => {
    expect(workflow).toMatch(/coarse.{0,60}microtask/i);
    expect(workflow).toMatch(/boundar/);
    expect(workflow).toContain("outcome");
    expect(workflow).toContain("evidence");
    expect(workflow).toMatch(/stable.{0,100}run_id|run_id.{0,100}stable/i);
    expect(workflow).toMatch(/per (?:execution )?attempt|per.attempt/i);
  });

  it("documents 30 s beats and 90 s expiry to Liveness unknown", () => {
    expect(workflow).toMatch(/30(?:\s|-)(?:s\b|second)/);
    expect(workflow).toMatch(/90(?:\s|-)(?:s\b|second)/);
    expect(workflow).toContain("Liveness unknown");
  });

  it("routes human questions through the harness and forbids executor deployment/exit announcements", () => {
    expect(workflow).toMatch(/(?:human|question).{0,130}harness|harness.{0,130}(?:human|question)/i);
    expect(workflow).toMatch(/executor.{0,160}(?:never|not|must not).{0,80}(?:self.announce|deployment|exit)/i);
  });

  it("preserves stop rules, evidence verification and the resume ladder before writing", () => {
    const contract = plain(text("docs/PLANNING_CONTRACT.md"));
    for (const phrase of [/stop|halt/i, /ambigu/i, /conflict/i, /two repair attempts|repeated failures/i,
      /credentials/i, /destructive/i, /privilege/i, /conformance/i, /open-items/]) expect(contract).toMatch(phrase);
    expect(contract).toMatch(/before.{0,40}writ/i);
    for (const tool of ["memory_get", "plan_get", "read_inbox", "next_work"]) expect(contract).toContain(tool);
    expect(contract).toMatch(/verify.{0,100}evidence|evidence.{0,100}verif/i);
  });
});

describe("M6–M8/A6 availability and lean-plan stop gates", () => {
  let live: ReturnType<typeof probe>;
  beforeAll(() => { live = probe("discovery"); }, 30000);

  it.each(["work_acquire", "work_report", "agent_lifecycle"])("documents %s against its landed descriptor or explicitly marks it unavailable", name => {
    const tool = live.tools.find((item: { name: string }) => item.name === name);
    const guide = text("docs/MCP.md");
    expect(guide).toContain(name);
    if (tool) {
      for (const field of Object.keys(tool.inputSchema.properties)) expect(guide, `${name}.${field}`).toContain(field);
    } else {
      expect(plain(guide)).toMatch(/unavailable|pending|AUSENTE|TARGET/);
      expect(availabilityIssues(docs, new Set(live.tools.map((item: { name: string }) => item.name)))).toEqual([]);
    }
  });

  it("retains next_work then task_claim and documents atomic acquisition without takeover", () => {
    expect(workflow).toMatch(/next_work.{0,240}task_claim/);
    expect(plain(scoped)).toMatch(/work_acquire/);
    expect(plain(scoped)).toMatch(/(?:without|no|never).{0,50}takeover|(?:does not|cannot).{0,50}take over/i);
    expect(scoped).toMatch(/["`]?task["`]?\s*:\s*null/);
    expect(scoped).toMatch(/["`]?items["`]?\s*:\s*\[\s*\]/);
  });

  it("documents work_report batching, evidence, next activation and one append", () => {
    const prose = plain(scoped);
    expect(prose).toContain("work_report");
    expect(prose).toMatch(/batch/);
    expect(prose).toMatch(/next.{0,80}activat|activat.{0,80}next/i);
    expect(prose).toMatch(/(?:one|single).{0,30}append/i);
  });

  it("documents lifecycle states and hook-driven release of open work without plan closure", () => {
    const prose = plain(scoped);
    expect(prose).toContain("agent_lifecycle");
    for (const state of ["deployed", "alive", "finished", "failed"]) expect(prose).toMatch(new RegExp(`\\b${state}\\b`));
    expect(prose).toMatch(/hooks?.{0,100}(?:no model|without model)|(?:no model|without model).{0,100}hooks?/i);
    expect(prose).toMatch(/(?:failure|failed|exit).{0,150}release/i);
    expect(prose).toMatch(/(?:never|not|no).{0,60}(?:plan closure|close.{0,20}plan)/i);
  });

  it.each(["HARNESS_HOOKS", "FAMILY_CHANNEL"])("links supplied %s owner guidance and avoids imaginary links", owner => {
    const supplied = existsSync(join(ROOT, `docs/${owner}.md`));
    expect(new RegExp(`\\]\\((?:docs/)?${owner}\\.md(?:#[^)]*)?\\)`).test(scoped)).toBe(supplied);
  });

  it("describes pending harness/executor pin roles and their scopes without inventing launch flags", () => {
    const prose = plain(scoped);
    expect(prose).toMatch(/pins?/i);
    expect(prose).toMatch(/self.scope|self.only|own (?:agent|identity)/i);
    expect(prose).toMatch(/cross.agent|other agents/i);
    expect(prose).toMatch(/(?:pin|launch).{0,160}(?:pending|unavailable|AUSENTE|TARGET)|(?:pending|unavailable|AUSENTE|TARGET).{0,160}(?:pin|launch)/i);
    expect(trustIssues(docs)).toEqual([]);
  });

  it("requires explicit missing-contract HOLD criteria rather than claiming a lean plan passes", () => {
    expect(workflow).toMatch(/lean.plan|lean plan/i);
    expect(workflow).toMatch(/HOLD/);
    expect(workflow).toMatch(/discover|descriptor/i);
    expect(workflow).toMatch(/upstream|owner|dependenc/i);
    expect(workflow).toMatch(/(?:until|before|only after).{0,160}(?:contract|discover|descriptor|land|admi)/i);
  });

  it("keeps the family consumer pending under its owner admission gates", () => {
    const prose = plain(scoped);
    expect(prose).toMatch(/family/i);
    const ownerHeld = /\bHOLD\b/.test(read("docs/FAMILY_CHANNEL.md"));
    if (ownerHeld) expect(prose).toMatch(/family.{0,200}(?:HOLD|pending|unavailable|TARGET)|(?:HOLD|pending|unavailable|TARGET).{0,200}family/i);
    expect(prose).toMatch(/opened_lamport/);
    expect(prose).toMatch(/commit.before.receipt|commit.{0,60}before.{0,60}(?:receipt|response)/i);
    expect(prose).toMatch(/allowlist|allow.list/i);
    expect(prose).toMatch(/cursor.{0,60}recover|recover.{0,60}cursor/i);
    expect(prose).toMatch(/(?:not|no|never).{0,80}(?:FIFO|push fan.out|interoperability)/i);
  });

  it("describes the family envelope and recipient-owned transport through supplied owner guidance", () => {
    const owner = read("docs/FAMILY_CHANNEL.md");
    if (!owner) {
      expect(plain(scoped)).toMatch(/family.{0,160}(?:pending|unavailable|AUSENTE|TARGET)/i);
      return;
    }
    const combined = scoped + "\n" + owner;
    const prose = plain(combined);
    for (const field of ["schema", "id", "source", "target", "kind", "room", "agent", "run_id",
      "plan_opened", "correlation_id", "after", "payload", "opened_lamport"]) expect(prose).toMatch(new RegExp(`\\b${field}\\b`));
    expect(combined).toContain("python3 -m bridge.room.family drain");
    expect(combined).toContain("$CW_HOME/family/");
    expect(prose).toMatch(/recipient.{0,80}(?:own|provision)|(?:own|provision).{0,80}recipient/i);
    expect(prose).toMatch(/lifecycle/i);
    expect(prose).toMatch(/capabilit/i);
    expect(prose).toMatch(/planning.{0,100}(?:defer|disable|HOLD)|(?:defer|disable|HOLD).{0,100}planning/i);
    expect(prose).toMatch(/replay.{0,100}identit|identit.{0,100}replay|same envelope and id/i);
  });

  it("never publishes an executable example for an undiscovered optional tool", () => {
    expect(availabilityIssues(docs, new Set(live.tools.map((item: { name: string }) => item.name)))).toEqual([]);
  });
});

describe("M9/A7 hybrid narration and privacy", () => {
  it("showcases on-device Nano swarm narration, cloud executors and Firebase hosting", () => {
    const prose = plain(text("README.md"));
    expect(prose).toMatch(/Nano/);
    expect(prose).toMatch(/(?:swarm.{0,100}narrat|narrat.{0,100}swarm)/i);
    expect(prose).toMatch(/cloud.{0,100}(?:agent|executor)/i);
    expect(prose).toMatch(/Firebase.{0,100}host|host.{0,100}Firebase/i);
  });

  it("retains firebase-hybrid as factory default with privacy overriding availability", () => {
    const prose = plain(text("docs/MODELS.md"));
    expect(prose).toMatch(/firebase-hybrid.{0,100}(?:factory )?default|(?:factory )?default.{0,100}firebase-hybrid/i);
    expect(prose).toMatch(/privacy.{0,100}(?:precedence|override|takes precedence)|policy.{0,100}precedence/i);
    expect(prose).toContain("firebase-ondevice");
    expect(prose).toContain("allow_private");
    expect(prose).toContain("remote-openai-compatible");
  });

  it("promises Rules summary for unavailable private narration with no cloud or room writes", () => {
    expect(privacyIssues(docs)).toEqual([]);
    expect(plain(scoped)).toMatch(/(?:unavailable|fails?|blocked).{0,160}Rules summary|Rules summary.{0,160}(?:unavailable|fails?|blocked)/i);
  });

  it("documents landed PREFER_ON_DEVICE gemini-4-hydrogen fallback and live inference-source display", () => {
    const narrator = read("src/app/narrator.ts");
    const prose = plain(text("docs/MODELS.md") + "\n" + text("README.md"));
    if (narrator.includes("gemini-4-hydrogen")) {
      expect(prose).toContain("PREFER_ON_DEVICE");
      expect(prose).toContain("gemini-4-hydrogen");
      expect(prose).toMatch(/(?:live|actual|current).{0,80}(?:inference|source)|(?:inference|source).{0,80}(?:live|actual|current)/i);
      expect(prose).toMatch(/private/);
    } else {
      expect(prose).toMatch(/(?:gemini-4-hydrogen|gemini-4-hydrogen).{0,100}(?:pending|TARGET)|(?:pending|TARGET).{0,100}(?:gemini-4-hydrogen|gemini-4-hydrogen)/);
    }
  });

  it("does not claim Antigravity 2 support before its owner contract lands", () => {
    const prose = plain(text("docs/DESKTOP_SETUP.md") + "\n" + text("docs/HEADLESS.md"));
    const owner = read("docs/HARNESS_HOOKS.md");
    if (/Antigravity\s*2/i.test(owner)) expect(prose).toMatch(/Antigravity\s*2/i);
    else if (/Antigravity\s*2/i.test(prose)) expect(prose).toMatch(/(?:Antigravity\s*2).{0,180}(?:pending|unavailable|TARGET)|(?:pending|unavailable|TARGET).{0,180}(?:Antigravity\s*2)/i);
  });

  it("removes the blanket locality claim and does not promise browserless Nano", () => {
    expect(plain(text("README.md"))).not.toMatch(/Plan and memory data stay on your machine/i);
    expect(plain(text("docs/HEADLESS.md"))).toMatch(/on.device browser inference is unavailable in pure headless|(?:Nano|on.device).{0,80}(?:requires? (?:a |the )?browser|unavailable.{0,40}headless)/i);
  });

  it("explicitly preserves caller-asserted identity and denies authentication", () => {
    expect(trustIssues(docs)).toEqual([]);
  });
});

describe("M10/A8 publication and retained exports", () => {
  it("resolves relative links and Markdown anchors throughout public documentation", () => {
    expect(linkIssues(docs)).toEqual([]);
  });

  it("contains none of the specified forbidden public tokens", () => {
    expect(publicationIssues(docs)).toEqual([]);
  });

  it("preserves the room_export loop and direct memory_history/room_export examples unchanged", () => {
    const guide = text("docs/HEADLESS.md");
    expect(guide).toContain('for what in ("plan", "memory"):\n    exported = call("room_export", what=what)\n    assert exported["format"] == "markdown"\n    print(exported["text"])');
    for (const command of [
      'python3 -m bridge.room call memory_history --json \'{"room":"demo","agent":"worker-a","section":"goal","limit":10}\'',
      'python3 -m bridge.room call room_export --json \'{"room":"demo","agent":"worker-a","what":"plan"}\'',
      'python3 -m bridge.room call room_export --json \'{"room":"demo","agent":"worker-a","what":"memory"}\'',
    ]) expect(guide).toContain(command);
    expect(guide).toContain('`room_export` and `memory_history` are shipped tools. Exports return');
  });
});
