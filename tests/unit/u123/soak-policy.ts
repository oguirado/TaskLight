// Pure hardening stop rules shared with the offline driver. No product hooks.
export type GateStatus = "PASS" | "BLOCK" | "INCONCLUSIVE";
export const quiet = (load5: number): boolean => Number.isFinite(load5) && load5 >= 0 && load5 < 18;
export function admission(load5: number, explicitGc: boolean): string | undefined {
  if (!quiet(load5)) return "INCONCLUSIVE: quiet-window precondition failed; no benchmark started";
  if (!explicitGc) return "INCONCLUSIVE: explicit GC unavailable; use --expose-gc";
  return undefined;
}
export function timingStatus(loads: readonly number[]): "MEASURED" | "INCONCLUSIVE" {
  return loads.length > 0 && loads.every(quiet) ? "MEASURED" : "INCONCLUSIVE";
}
export function finalStatus(semantic: GateStatus, retention: GateStatus, measured: boolean, paired: boolean): GateStatus {
  if (semantic === "BLOCK" || retention === "BLOCK") return "BLOCK";
  return semantic === "PASS" && retention === "PASS" && measured && paired ? "PASS" : "INCONCLUSIVE";
}
export interface ComparisonRun {
  label?: unknown; count?: unknown; seed?: unknown; fixtureSha256?: unknown; timing?: unknown;
  runtime?: { node?: unknown; arch?: unknown; platform?: unknown } | undefined;
  measurements?: { postGcRetainedHeapBytes?: unknown; heapSlopeBytesPerAcceptedEvent?: unknown;
    peakRssBytes?: unknown; updateLatencyNs?: unknown; readLatencyNs?: unknown } | undefined;
}
export function comparable(baseline: ComparisonRun, candidate: ComparisonRun): boolean {
  const latency = (v: unknown): boolean => {
    if (v === null || typeof v !== "object") return false;
    const record = v as Record<string, unknown>;
    return ["p50", "p95", "max"].every(k => typeof record[k] === "number" && Number.isFinite(record[k]) && record[k] >= 0);
  };
  const measured = (run: ComparisonRun): boolean => {
    const m = run.measurements;
    return run.timing === "MEASURED" && typeof run.fixtureSha256 === "string"
      && /^[a-f0-9]{64}$/.test(run.fixtureSha256)
      && typeof run.count === "number" && run.count > 0 && Number.isInteger(run.count)
      && typeof run.seed === "number" && Number.isInteger(run.seed)
      && [run.runtime?.node, run.runtime?.arch, run.runtime?.platform].every(v => typeof v === "string" && v.length > 0)
      && [m?.postGcRetainedHeapBytes, m?.heapSlopeBytesPerAcceptedEvent, m?.peakRssBytes].every(v => typeof v === "number" && Number.isFinite(v))
      && latency(m?.updateLatencyNs) && latency(m?.readLatencyNs);
  };
  return baseline.label === "baseline" && candidate.label === "candidate" && measured(baseline) && measured(candidate)
    && baseline.count === candidate.count && baseline.seed === candidate.seed && baseline.fixtureSha256 === candidate.fixtureSha256
    && baseline.runtime?.node === candidate.runtime?.node && baseline.runtime?.arch === candidate.runtime?.arch
    && baseline.runtime?.platform === candidate.runtime?.platform;
}
