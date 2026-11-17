// @vitest-environment node
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { SCOPED, availabilityIssues, cleanup, corpus, discoveryIssues, forbiddenTokens,
  legacyIssues, linkIssues, privacyIssues, probe, publicationIssues, trustIssues } from "./support";
import type { Corpus } from "./support";

const original = corpus();
afterAll(cleanup);
afterEach(() => { expect([...corpus()], "Mutation controls must never change documentation on disk").toEqual([...original]); });

describe("A8 non-vacuous in-memory documentation mutations", () => {
  let live: ReturnType<typeof probe>;
  beforeAll(() => { live = probe("discovery"); }, 30000);

  function discoveryWitness(): Corpus {
    const copy = new Map(original);
    for (const [file, value] of copy) copy.set(file, value
      .replace(/\b\d+\s+(?:(?:MCP|registered|available|exposed|discovered)\s+)*tools\b/gi, "the discovered tools")
      .replace(/\btool\s+(?:count|total)\s*(?:is|:|=)\s*[`*]*\d+/gi, "tool total comes from discovery")
      .replace(/(protocolVersion[`*\s:"=]*)\d{4}-\d{2}-\d{2}/g, `$1${live.initialize.protocolVersion}`)
      .replace(/("name"\s*:\s*"tasklight"\s*,\s*"version"\s*:\s*")[^"]+("})/g,
        `$1${live.initialize.serverInfo.version}$2`));
    copy.set("docs/MCP.md", (copy.get("docs/MCP.md") ?? "")
      + `\n${live.tools.length} tools are exposed.\nprotocolVersion "${live.initialize.protocolVersion}"\n`
      + JSON.stringify(live.initialize.serverInfo));
    expect(discoveryIssues(copy, live.tools.length, live.initialize.protocolVersion, live.initialize.serverInfo.version)).toEqual([]);
    return copy;
  }

  function checkDiscovery(copy: Corpus): string[] {
    return discoveryIssues(copy, live.tools.length, live.initialize.protocolVersion, live.initialize.serverInfo.version);
  }

  it("rejects an in-memory stale total after accepting the live discovery witness", () => {
    const copy = discoveryWitness();
    copy.set("docs/MCP.md", copy.get("docs/MCP.md")!.replace(`${live.tools.length} tools are exposed.`, `${live.tools.length + 1} tools are exposed.`));
    expect(checkDiscovery(copy)).toContain("The unique total in docs/MCP.md must equal live discovery");
  });

  it("rejects a duplicate total outside MCP.md even when its number is current", () => {
    const copy = discoveryWitness();
    copy.set("README.md", copy.get("README.md") + `\n${live.tools.length} tools are available.`);
    expect(checkDiscovery(copy)).not.toEqual([]);
  });

  it("rejects a stale protocol version after accepting the initialized-version witness", () => {
    const copy = discoveryWitness();
    copy.set("docs/MCP.md", copy.get("docs/MCP.md")!.replace(live.initialize.protocolVersion, "1900-01-01"));
    expect(checkDiscovery(copy)).toContain("Stale protocol version");
  });

  it("rejects a stale server version rather than validating only protocolVersion", () => {
    const copy = discoveryWitness();
    copy.set("docs/MCP.md", copy.get("docs/MCP.md")!.replace(/("name"\s*:\s*"tasklight"\s*,\s*"version"\s*:\s*")[^"]+/, "$10.0.0-stale"));
    expect(checkDiscovery(copy)).toContain("Stale server version");
  });

  it("rejects removal of legacy labels from an otherwise accepted document copy", () => {
    const copy = new Map(original);
    for (const file of SCOPED) copy.set(file, (copy.get(file) ?? "") + "\nChat and liaison are legacy, with no new investment.\n");
    expect(legacyIssues(copy)).toEqual([]);
    for (const [file, value] of copy) copy.set(file, value.replace(/\blegacy\b/gi, ""));
    expect(legacyIssues(copy)).not.toEqual([]);
  });

  it("rejects replacing the trust warning with authenticated identity", () => {
    const copy = new Map(original);
    copy.set("docs/HEADLESS.md", copy.get("docs/HEADLESS.md")
      + "\nIdentity is caller-asserted under same-user storage trust. Pins and hooks are not authentication.\n");
    expect(trustIssues(copy)).toEqual([]);
    copy.set("docs/HEADLESS.md", copy.get("docs/HEADLESS.md")!
      .replace("Pins and hooks are not authentication.", "Pins and hooks authenticate identity."));
    expect(trustIssues(copy)).not.toEqual([]);
  });

  it.each(["missing-file", "missing-anchor"])("rejects a broken %s link without touching source files", kind => {
    const copy = new Map([["README.md", original.get("README.md") ?? ""]]);
    expect(linkIssues(copy)).toEqual([]);
    const target = kind === "missing-file" ? "docs/u131-missing-guide.md" : "docs/HEADLESS.md#u131-missing-anchor";
    copy.set("README.md", copy.get("README.md") + `\n[Invalid guide](${target})\n`);
    expect(linkIssues(copy)).not.toEqual([]);
  });

  it.each(forbiddenTokens.map((token, index) => ({ token, index })))("rejects forbidden publication token $index assembled only in memory", ({ token }) => {
    const copy = new Map(original);
    for (const [file, value] of copy) copy.set(file, forbiddenTokens.reduce((safe, forbidden) => safe.replaceAll(forbidden, "<redacted>"), value));
    expect(publicationIssues(copy)).toEqual([]);
    copy.set("README.md", copy.get("README.md") + `\n${token}oracle-only\n`);
    expect(publicationIssues(copy)).not.toEqual([]);
  });

  it.each(["work_acquire", "work_report", "agent_lifecycle"])("rejects executable %s examples under simulated missing discovery", name => {
    const copy = new Map(original);
    // An absent-contract fixture must have no runnable examples before mutation.
    for (const [file, value] of copy) copy.set(file, value.replace(/^```[^\n]*\n[\s\S]*?^```/gm, ""));
    copy.set("docs/MCP.md", copy.get("docs/MCP.md") + `\n${name} is [TARGET], unavailable until discovery and owner admission.\n`);
    const registered = new Set<string>(live.tools.map((tool: { name: string }) => tool.name));
    registered.delete(name);
    expect(availabilityIssues(copy, registered)).toEqual([]);
    copy.set("docs/MCP.md", copy.get("docs/MCP.md") + `\n\`\`\`sh exec\npython3 -m bridge.room call ${name} --json '{}'\n\`\`\`\n`);
    expect(availabilityIssues(copy, registered)).not.toEqual([]);
  });

  it("rejects private-room cloud narration after accepting the on-device Rules summary witness", () => {
    const copy = new Map(original);
    copy.set("docs/HEADLESS.md", copy.get("docs/HEADLESS.md")
      + "\nPrivate narration stays on-device. Unavailable narration uses Rules summary. "
      + "Narration cannot mutate or write to the room. Private rooms never use cloud narration when Nano is unavailable.\n");
    expect(privacyIssues(copy)).toEqual([]);
    copy.set("docs/HEADLESS.md", copy.get("docs/HEADLESS.md")!
      .replace("Private rooms never use cloud narration when Nano is unavailable.", "Private rooms use cloud narration when Nano is unavailable."));
    expect(privacyIssues(copy)).toContain("Private-room cloud claim");
  });
});
