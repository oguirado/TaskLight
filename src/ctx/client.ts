import { CTX_LIMITS, CTX_SCHEMA, type CtxVerb } from "./limits";
import type { CtxResp } from "./types";
import { canonicalJson } from "./canonical";
import { sha256Hex } from "./sha256";
import { seal } from "./envelope";
import { check } from "./check";

export interface Timer { set(ms: number, fn: () => void): () => void }
export interface CtxClient { call(verb: CtxVerb, input: unknown): Promise<CtxResp<unknown>> }

export function createCtxClient(
  w: { post(m: unknown): void; onMessage(cb: (m: unknown) => void): void },
  timer: Timer,
): CtxClient {
  let nextId = 0;
  const pending = new Map<unknown, { verb: CtxVerb; resolve: (r: CtxResp<unknown>) => void; cancel: () => void }>();

  function handle(msg: unknown): void {
    try {
      if (msg === null || typeof msg !== "object") return;
      const id = (msg as { id?: unknown }).id;
      const entry = pending.get(id);
      if (entry === undefined) return;
      const line = (msg as { line?: unknown }).line;
      if (typeof line !== "string") return;
      let parsed: CtxResp<unknown>;
      try {
        parsed = JSON.parse(line) as CtxResp<unknown>;
      } catch {
        return;
      }
      pending.delete(id);
      entry.cancel();
      if (check({ kind: "envelope", value: parsed }).rc !== 0) {
        entry.resolve(
          seal(entry.verb, 2, { errors: [{ code: "WRONG_TYPE", path: "" }] } as never) as CtxResp<unknown>,
        );
      } else {
        entry.resolve(parsed);
      }
    } catch {
      return;
    }
  }

  w.onMessage(handle);

  return {
    call(verb: CtxVerb, input: unknown): Promise<CtxResp<unknown>> {
      nextId++;
      const id = nextId;
      return new Promise<CtxResp<unknown>>((resolve) => {
        const entry: { verb: CtxVerb; resolve: (r: CtxResp<unknown>) => void; cancel: () => void } = {
          verb,
          resolve,
          cancel: (): void => undefined,
        };
        pending.set(id, entry);
        let cancel: () => void = (): void => undefined;
        try {
          cancel = timer.set(CTX_LIMITS.CTX_TIMEOUT_MS, () => {
            if (!pending.has(id)) return;
            pending.delete(id);
            const data = { errors: [] as never[] };
            const resp: CtxResp<unknown> = {
              schema: CTX_SCHEMA,
              ok: false,
              rc: 124,
              verb,
              data,
              sha256: sha256Hex(canonicalJson(data)),
            };
            resolve(resp);
          });
          entry.cancel = cancel;
          w.post({ id, verb, input });
        } catch {
          pending.delete(id);
          cancel();
          resolve(
            seal(verb, 2, { errors: [{ code: "WRONG_TYPE", path: "" }] } as never) as CtxResp<unknown>,
          );
        }
      });
    },
  };
}
