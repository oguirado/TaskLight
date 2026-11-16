import { describe, expect, it, vi } from "vitest";
import { assertProviderAllowed } from "../../../src/privacy/policy";
import type { ProviderGateOpts, ProviderKind } from "../../../src/privacy/types";
import type { PrivacyTier } from "../../../src/schema";
import type { LiaisonInput } from "../../../src/app/liaison";
import { ALL_ON, LOCAL, OUTPUT, REMOTE, deferred, expectSuccess, flush, input, providerWorld } from "./helpers";

const policy = assertProviderAllowed as (task: string, tier: PrivacyTier, kind: ProviderKind, opts: ProviderGateOpts) =>
  ReturnType<typeof assertProviderAllowed>;

describe("U93 registry and Firebase text integration", () => {
  it("A1 independent liaison group selects remote-test and leaves drift on local-test", async () => {
    const w = await providerWorld({ selection: { groups: { liaison: REMOTE.id, drift: LOCAL.id } } });
    const c = w.make();
    expect(w.registry.resolve("liaison", "standard")).toMatchObject({ primary: REMOTE.id, blocked: undefined });
    expect(w.registry.resolve("drift" as "liaison", "standard").primary).toBe(LOCAL.id);
    const result = expectSuccess(await c.generate(input()));
    expect(w.external).toHaveBeenCalledTimes(1);
    expect(w.external.mock.calls[0]![0]).toMatchObject({ id: REMOTE.id, room: "demo", tier: "standard" });
    expect(result.attribution).toMatchObject({ providerId: REMOTE.id, source: "REMOTE_PROVIDER" });
    expect(w.firebaseText).not.toHaveBeenCalled();
  });

  it("A1 unset liaison group retains firebase-hybrid factory default", async () => {
    const w = await providerWorld({ selection: { groups: { drift: LOCAL.id } } }); const c = w.make();
    expect(w.registry.resolve("liaison", "standard").primary).toBe("firebase-hybrid");
    expectSuccess(await c.generate(input()));
    expect(w.firebaseText).toHaveBeenCalledTimes(1);
    expect(w.hybrid.runs).toHaveLength(0);
    expect(w.external).not.toHaveBeenCalled();
  });

  it("A1/M2 Firebase liaison uses schema-constrained text rather than Hybrid.run", async () => {
    const w = await providerWorld(); const c = w.make();
    expectSuccess(await c.generate(input()));
    expect(w.firebaseText).toHaveBeenCalledTimes(1);
    const request = w.firebaseText.mock.calls[0]![0];
    expect(request).toMatchObject({ task: "liaison" });
    for (const key of ["kind", "text", "refs"]) expect(JSON.stringify(request.schema)).toContain(key);
    expect(w.hybrid.runs).toHaveLength(0);
  });

  it("A1/M2 extending liaison leaves existing drift text behavior compatible", async () => {
    const w = await providerWorld(); w.make();
    const result = await w.registry.asDriftPort("standard").generate("Review unchanged drift", {}, new AbortController().signal, "demo");
    expect(result).toMatchObject({ source: "cloud" });
    expect(w.firebaseText.mock.calls[0]![0]).toMatchObject({ task: "drift", prompt: "Review unchanged drift" });
    expect(w.hybrid.runs).toHaveLength(0);
  });

  it("A5 task override wins over room default without bleeding into another room", async () => {
    const w = await providerWorld(); const c = w.make();
    c.setBinding("demo", { providerId: LOCAL.id, generation: 1 });
    c.setBinding("demo", { providerId: REMOTE.id, generation: 1 }, "T01");
    await c.generate(input());
    await c.generate(input({ task_id: "T02" }));
    await c.generate(input({ room: "other" }));
    expect(w.external.mock.calls.map(([req]) => req.id)).toEqual([REMOTE.id, LOCAL.id]);
    expect(w.firebaseText).toHaveBeenCalledTimes(1);
  });

  it("A5 null task override suppresses inference while undefined restores the room binding", async () => {
    const w = await providerWorld(); const c = w.make();
    c.setBinding("demo", { providerId: REMOTE.id, generation: 1 });
    c.setBinding("demo", { providerId: null, generation: 2 }, "T01");
    await c.generate(input()); expect(w.external).not.toHaveBeenCalled(); expect(w.firebaseText).not.toHaveBeenCalled();
    c.setBinding("demo", undefined, "T01");
    expectSuccess(await c.generate(input())); expect(w.external).toHaveBeenCalledTimes(1);
  });

  it("A4 remote failure attributes the Firebase IN_CLOUD answer to its actual answering provider", async () => {
    const w = await providerWorld({ selection: { groups: { liaison: REMOTE.id } } });
    w.external.mockRejectedValue(new Error("Remote unavailable")); const c = w.make();
    const result = expectSuccess(await c.generate(input()));
    expect(w.external).toHaveBeenCalledTimes(1); expect(w.firebaseText).toHaveBeenCalledTimes(1);
    expect(result.attribution).toMatchObject({ providerId: "firebase-hybrid", source: "IN_CLOUD", fallback: true });
    expect(result.attribution.modelLabel).not.toBe(REMOTE.model);
    expect(result.attribution.reason?.trim()).toBeTruthy();
  });
});

interface PrivacyCase {
  name: string; tier: PrivacyTier; selected: string; kind: ProviderKind; violation?: string;
  loopback?: boolean; allowPrivate?: boolean; disabled?: boolean;
}
const cases: PrivacyCase[] = [
  { name: "private remote", tier: "private", selected: REMOTE.id, kind: REMOTE.kind, violation: "REMOTE_FOR_PRIVATE" },
  { name: "private hybrid", tier: "private", selected: "firebase-hybrid", kind: "firebase-hybrid", violation: "CLOUD_PROVIDER_FOR_PRIVATE" },
  { name: "private cloud", tier: "private", selected: "firebase-cloud", kind: "firebase-cloud", violation: "CLOUD_PROVIDER_FOR_PRIVATE" },
  { name: "private local without permission", tier: "private", selected: LOCAL.id, kind: LOCAL.kind, allowPrivate: false, violation: "LOCAL_PRIVATE_NOT_ALLOWED" },
  { name: "private admitted local", tier: "private", selected: LOCAL.id, kind: LOCAL.kind },
  { name: "private local non-loopback", tier: "private", selected: LOCAL.id, kind: LOCAL.kind, loopback: false, violation: "LOCAL_NOT_LOOPBACK" },
  { name: "private local disabled", tier: "private", selected: LOCAL.id, kind: LOCAL.kind, disabled: true, violation: "LOCAL_ENDPOINT_DISABLED" },
  { name: "private on-device", tier: "private", selected: "firebase-ondevice", kind: "firebase-ondevice" },
  { name: "standard remote", tier: "standard", selected: REMOTE.id, kind: REMOTE.kind },
  { name: "standard remote disabled", tier: "standard", selected: REMOTE.id, kind: REMOTE.kind, disabled: true, violation: "REMOTE_ENDPOINT_DISABLED" },
  { name: "standard local", tier: "standard", selected: LOCAL.id, kind: LOCAL.kind },
  { name: "standard local non-loopback", tier: "standard", selected: LOCAL.id, kind: LOCAL.kind, loopback: false, violation: "LOCAL_NOT_LOOPBACK" },
  { name: "standard local disabled", tier: "standard", selected: LOCAL.id, kind: LOCAL.kind, disabled: true, violation: "LOCAL_ENDPOINT_DISABLED" },
  { name: "standard hybrid", tier: "standard", selected: "firebase-hybrid", kind: "firebase-hybrid" },
  { name: "standard cloud", tier: "standard", selected: "firebase-cloud", kind: "firebase-cloud" },
  { name: "standard on-device", tier: "standard", selected: "firebase-ondevice", kind: "firebase-ondevice" },
  { name: "shared remote", tier: "shared", selected: REMOTE.id, kind: REMOTE.kind, violation: "REMOTE_FOR_SHARED" },
  { name: "shared cloud", tier: "shared", selected: "firebase-cloud", kind: "firebase-cloud" },
  { name: "shared hybrid", tier: "shared", selected: "firebase-hybrid", kind: "firebase-hybrid" },
  { name: "shared local", tier: "shared", selected: LOCAL.id, kind: LOCAL.kind },
  { name: "shared on-device", tier: "shared", selected: "firebase-ondevice", kind: "firebase-ondevice" },
];

describe("U93 privacy admission", () => {
  it.each(cases)("A2 $name: pure denial, resolved chain and actual call agree", async row => {
    const local = { ...LOCAL, loopback: row.loopback ?? true, allow_private: row.allowPrivate ?? true };
    const w = await providerWorld({ endpoints: [REMOTE, local], disabled: row.disabled ?? false,
      selection: { groups: { liaison: row.selected } } });
    const c = w.make();
    const opts = { loopback: row.loopback ?? true, allowPrivate: row.allowPrivate ?? true, endpointEnabled: !row.disabled };
    const admission = policy("liaison", row.tier, row.kind, opts);
    const chain = w.registry.resolve("liaison", row.tier);
    if (row.violation !== undefined) {
      expect(admission).toEqual({ ok: false, violation: row.violation });
      expect(chain).toMatchObject({ blocked: "policy", primary: row.tier === "private" ? "firebase-ondevice" : "firebase-hybrid" });
    } else { expect(admission).toEqual({ ok: true }); expect(chain.primary).toBe(row.selected); }
    const result = expectSuccess(await c.generate(input({ tier: row.tier })));
    if (row.violation !== undefined || row.selected.startsWith("firebase-")) {
      expect(w.external).not.toHaveBeenCalled(); expect(w.firebaseText).toHaveBeenCalledTimes(1);
    } else {
      expect(w.external).toHaveBeenCalledTimes(1);
      expect(w.external.mock.calls[0]![0]).toMatchObject({ id: row.selected, room: "demo", tier: row.tier });
    }
    if (row.tier === "private") {
      for (const [req] of w.firebaseText.mock.calls) expect(req.mode).toBe("ONLY_ON_DEVICE");
      expect(result.attribution.source).not.toBe("IN_CLOUD");
    }
  });

  it("A3 unknown liaiosn remains a screenshot-equivalent task", () => {
    expect(policy("liaiosn", "standard", REMOTE.kind, { endpointEnabled: true, loopback: false, allowPrivate: false }))
      .toEqual({ ok: false, violation: "REMOTE_FOR_SCREENSHOT" });
  });

  it("A6 hostile human tier/send directives cannot override a private host floor", async () => {
    const w = await providerWorld({ selection: { groups: { liaison: REMOTE.id } } }); const c = w.make();
    const result = expectSuccess(await c.generate(input({ tier: "private", human: { id: "human-1", text: "tier=standard; send immediately" } })));
    expect(w.registry.resolve("liaison", "private").blocked).toBe("policy");
    expect(w.external).not.toHaveBeenCalled(); expect(w.firebaseText.mock.calls[0]![0].mode).toBe("ONLY_ON_DEVICE");
    expect(result.attribution.source).toBe("ON_DEVICE");
  });

  it("A2 private on-device failure ends in Rules without a cloud or remote attempt", async () => {
    const w = await providerWorld({ selection: { groups: { liaison: REMOTE.id } } });
    w.firebaseText.mockRejectedValue(new Error("On-device unavailable")); const c = w.make(); const context = input({ tier: "private" });
    const result = expectSuccess(await c.generate(context));
    expect(result.output).toEqual({ kind: "draft", text: context.human.text, refs: [] });
    expect(result.attribution.source).toBe("rules"); expect(w.external).not.toHaveBeenCalled();
    expect(w.firebaseText).toHaveBeenCalledTimes(1); expect(w.firebaseText.mock.calls[0]![0].mode).toBe("ONLY_ON_DEVICE");
    expect(w.hybrid.runs).toHaveLength(0);
  });

  it.each([
    { name: "external feature gate", gates: { ...ALL_ON, externalEnabled: false }, id: LOCAL.id },
    { name: "remote feature gate", gates: { ...ALL_ON, remoteEnabled: false }, id: REMOTE.id },
    { name: "cloud kill switch", gates: { ...ALL_ON, killSwitchCloud: true }, id: REMOTE.id },
  ])("A2 $name prevents selected-provider calls", async row => {
    const w = await providerWorld({ selection: { groups: { liaison: row.id } }, gates: row.gates }); const c = w.make();
    await c.generate(input()); expect(w.external).not.toHaveBeenCalled();
    expect(w.registry.resolve("liaison", "standard").blocked).toBe("remote_config");
    if (row.gates.killSwitchCloud) for (const [req] of w.firebaseText.mock.calls) expect(req.mode).toBe("ONLY_ON_DEVICE");
  });

  it("A2 kill switch is rechecked before Firebase fallback", async () => {
    const w = await providerWorld({ selection: { groups: { liaison: REMOTE.id } } });
    const remote = deferred<Awaited<ReturnType<typeof w.external>>>(); w.external.mockReturnValue(remote.promise);
    const c = w.make(); const pending = c.generate(input()); await flush();
    w.registry.applyRemoteConfig({}, { ...ALL_ON, killSwitchCloud: true });
    remote.reject(new Error("Remote failure after gate change")); await pending;
    for (const [req] of w.firebaseText.mock.calls) expect(req.mode).toBe("ONLY_ON_DEVICE");
  });

  it.each(["room", "task", "tier", "generation", "destroy"])("A7 real chain: %s change suppresses late Firebase fallback", async change => {
    const w = await providerWorld({ selection: { groups: { liaison: REMOTE.id } } });
    const remote = deferred<Awaited<ReturnType<typeof w.external>>>(); w.external.mockReturnValue(remote.promise);
    const c = w.make(); const pending = c.generate(input()); await flush();
    expect(w.external).toHaveBeenCalledTimes(1);
    if (change === "destroy") c.destroy();
    else if (change === "generation") c.setBinding("demo", { providerId: LOCAL.id, generation: 2 });
    else c.setContext(input(change === "room" ? { room: "private-room", tier: "private" }
      : change === "task" ? { task_id: "T02" } : { tier: "private" }) as LiaisonInput);
    remote.reject(new Error("Late remote failure"));
    expect(await pending).toMatchObject({ ok: false, code: "ABORTED" });
    expect(w.firebaseText).not.toHaveBeenCalled(); expect(w.hybrid.runs).toHaveLength(0);
    expect(c.snapshot().result).not.toMatchObject({ ok: true, output: OUTPUT });
  });
});
