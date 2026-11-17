// Fixed, offline hardening driver; emits data only under tests/unit/u123/.
// Run: node --expose-gc --experimental-vm-modules tests/unit/u123/wall-history-soak.mjs --label baseline
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { loadavg } from "node:os";
import { dirname, resolve, relative, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { SourceTextModule, SyntheticModule } from "node:vm";
import { stripTypeScriptTypes } from "node:module";
import { admission, comparable, finalStatus, timingStatus } from "./soak-policy.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const allowed = resolve(root, "tests/unit/u123");
const args = process.argv.slice(2);
const option = (name, fallback) => args.includes(name) ? args[args.indexOf(name) + 1] : fallback;
const label = option("--label", "baseline");
if (!["baseline", "candidate"].includes(label)) throw new Error("label must be baseline or candidate");
const output = resolve(root, option("--out", `tests/unit/u123/soak-${label}.json`));
if (!output.startsWith(allowed + sep) || !output.endsWith(".json")) throw new Error("output must be JSON under tests/unit/u123");
const count = 100_000, seed = 0x1235eed;
const runtime = { node: process.version, arch: process.arch, platform: process.platform };
const report = { label, count, seed, runtime, status: "INCONCLUSIVE", heapSlopeBudget: "AUSENTE — no inventar", comparison: "INCONCLUSIVE: paired run AUSENTE" };
function finish(code) { writeFileSync(output, JSON.stringify(report, null, 2) + "\n"); console.log(JSON.stringify(report)); process.exitCode = code; }
const startLoad5 = loadavg()[1];
report.startLoad5 = startLoad5;
const stopped = admission(startLoad5, typeof global.gc === "function");
if (stopped !== undefined) {
  report.reason = stopped; finish(2);
} else {
  const modules = new Map();
  function sourceFile(request) {
    for (const file of [request, `${request}.ts`, resolve(request, "index.ts")]) if (existsSync(file) && file.endsWith(".ts")) return file;
    throw new Error(`module unavailable: ${relative(root, request)}`);
  }
  async function getModule(file) {
    if (modules.has(file)) return modules.get(file);
    const source = stripTypeScriptTypes(readFileSync(file, "utf8"), { mode: "transform" });
    const module = new SourceTextModule(source, { identifier: file,
      initializeImportMeta(meta) { meta.url = pathToFileURL(file).href; } });
    modules.set(file, module); return module;
  }
  async function linker(specifier, parent) {
    if (specifier.startsWith("node:")) {
      if (modules.has(specifier)) return modules.get(specifier);
      const exports = await import(specifier); const names = Object.keys(exports);
      const module = new SyntheticModule(names, function () { for (const name of names) this.setExport(name, exports[name]); });
      modules.set(specifier, module); return module;
    }
    if (!specifier.startsWith(".")) throw new Error("unexpected external dependency in offline source loader");
    return getModule(sourceFile(resolve(dirname(parent.identifier), specifier)));
  }
  async function load(file) {
    const module = await getModule(resolve(root, file));
    if (module.status === "unlinked") await module.link(linker);
    if (module.status === "linked") await module.evaluate();
    return module.namespace;
  }
  try {
    const oracle = await load("tests/unit/u123/oracle.ts");
    const heap = await load("tests/unit/u123/retained-heap.ts");
    const { bytes, FullHistory, makeStore } = oracle;
    const fixed = await load("tests/unit/u123/soak-fixture.ts");
    const { soakHistory: history, SOAK_ROOM: room } = fixed;
    assert.equal(fixed.SOAK_COUNT, count); assert.equal(fixed.SOAK_SEED, seed);
    const digest = createHash("sha256");
    for (const e of history()) digest.update(JSON.stringify(e) + "\n");
    report.fixtureSha256 = digest.digest("hex");
    report.surfaceSha256 = createHash("sha256").update(readFileSync(resolve(root, "src/app/agent_store.ts"))).digest("hex");
    const measurementLoad5 = loadavg()[1]; report.measurementStartLoad5 = measurementLoad5;
    const measurementStop = admission(measurementLoad5, typeof global.gc === "function");
    if (measurementStop !== undefined) { report.reason = measurementStop; finish(2); }
    else {
    const marked = { candidate: makeStore(), __u123HeapRoot: room };
    const store = marked.candidate;
    const sizes = new Map(); const samples = []; const updateNs = []; const readNs = [];
    const now = () => process.hrtime.bigint();
    const measureRead = () => {
      const start = now(); store.plan(room); store.plans(); store.states(); readNs.push(Number(now() - start));
    };
    const gcHeap = () => { global.gc(); return process.memoryUsage().heapUsed; };
    const initialHeap = gcHeap();
    let accepted = 0;
    // Batch function prevents fixture event locals escaping into heap probes.
    const iterator = history();
    function ingestBatch(n) {
      for (let j = 0; j < n; j++) {
        const next = iterator.next(); assert.equal(next.done, false); const e = next.value;
        sizes.set(e.id, bytes(e));
        const start = now(); const ingested = store.ingestChecked(e); updateNs.push(Number(now() - start));
        if (ingested !== "accepted") { report.semantic = "BLOCK"; throw new Error("generated valid event was not accepted"); }
        accepted++;
      }
    }
    const checkpoints = [1000, 25_000, 50_000, count];
    for (const target of checkpoints) {
      ingestBatch(target - accepted); measureRead();
      samples.push({ accepted, postGcHeapBytes: gcHeap(), rssBytes: process.memoryUsage().rss, load5: loadavg()[1] });
    }
    // Finish the generator so its last yielded raw object does not remain live.
    assert.equal(iterator.next().done, true);
    const cleanHeap = gcHeap();
    const peakStoreRssBytes = process.resourceUsage().maxRSS * 1024;
    const inventory = await heap.retainedEnvelopes(room, sizes);
    assert.equal(marked.candidate, store);
    report.storage = { pinned: inventory.pinned, recent: { ...inventory.recent, ids: undefined }, auxiliary: inventory.auxiliary,
      exclusiveStoreBytes: inventory.exclusiveStoreBytes, dedup: { ids: sizes.size, idUtf8Bytes: [...sizes.keys()].reduce((n, key) => n + Buffer.byteLength(key), 0) } };
    const projected = store.plan(room)?.projection;
    const legacy = store.states();
    report.storage.replaySummaries = {
      scope: "logical public replay metadata; not additive to exclusive heap totals",
      receiptEntries: Object.keys(projected?.replayed_ops ?? {}).length,
      receiptJsonBytes: Buffer.byteLength(JSON.stringify(projected?.replayed_ops ?? {})),
      legacyAgentStates: legacy.length, legacyStateJsonBytes: Buffer.byteLength(JSON.stringify(legacy)),
      privateAllocationAttribution: "AUSENTE — no inventar",
    };
    report.storage.dedup.scope = "accepted unique IDs and logical UTF-8 size; allocation layout unspecified";
    // Do not keep the oracle's raw histories live during candidate measurements.
    function fullReplay() {
      const ref = new FullHistory(); for (const e of history()) ref.accept(e);
      return { plan: ref.plan(room), plans: ref.plans(), states: ref.states(), since: ref.since() };
    }
    const expected = fullReplay();
    let semantic = "PASS";
    try { assert.deepEqual({ plan: store.plan(room), plans: store.plans(), states: store.states(), since: store.since() }, expected); }
    catch { semantic = "BLOCK"; }
    const percentile = (xs, p) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(xs.length * p))] ?? null;
    const xMean = samples.reduce((n, s) => n + s.accepted, 0) / samples.length;
    const yMean = samples.reduce((n, s) => n + s.postGcHeapBytes, 0) / samples.length;
    const slope = samples.reduce((n, s) => n + (s.accepted - xMean) * (s.postGcHeapBytes - yMean), 0)
      / samples.reduce((n, s) => n + (s.accepted - xMean) ** 2, 0);
    report.measurements = { samples, initialPostGcHeapBytes: initialHeap, postGcRetainedHeapBytes: cleanHeap,
      peakRssBytes: peakStoreRssBytes, heapSlopeBytesPerAcceptedEvent: slope,
      heapSlopeIncludes: "store, size map and timing samples; exclusive store bytes are reported separately",
      updateLatencyNs: { p50: percentile(updateNs, .5), p95: percentile(updateNs, .95), max: Math.max(...updateNs) },
      readLatencyNs: { p50: percentile(readNs, .5), p95: percentile(readNs, .95), max: Math.max(...readNs) } };
    report.semantic = semantic;
    try { heap.storageGate(inventory, 5000, 16 * 1024 * 1024); report.retention = "PASS"; }
    catch (error) { report.retention = "BLOCK"; report.retentionReason = error.message; }
    const endLoad5 = loadavg()[1]; report.endLoad5 = endLoad5;
    report.timing = timingStatus([measurementLoad5, ...samples.map(s => s.load5), endLoad5]);
    const comparePath = option("--compare", null);
    if (comparePath) {
      const previous = JSON.parse(readFileSync(resolve(root, comparePath), "utf8"));
      const same = comparable(previous, report);
      report.comparison = same ? { baseline: previous.measurements, candidate: report.measurements } : "INCONCLUSIVE: fixture/runtime/quiet-window mismatch";
    }
    report.status = finalStatus(semantic, report.retention, report.timing === "MEASURED", typeof report.comparison === "object");
    finish(report.status === "BLOCK" ? 1 : report.status === "PASS" ? 0 : 2);
    }
  } catch (error) {
    report.status = report.semantic === "BLOCK" || report.retention === "BLOCK" ? "BLOCK" : "INCONCLUSIVE";
    report.reason = report.status === "BLOCK" ? "BLOCK: semantic or retention gate failed" : "INCONCLUSIVE: driver failure";
    report.failureKind = error?.name ?? "Error"; finish(report.status === "BLOCK" ? 1 : 2);
    // Keep stack traces in the console, never in the public JSON report.
    console.error(error);
  }
}
