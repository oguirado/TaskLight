import { densify } from "./densify";
import { rank } from "./rank";
import { pack } from "./pack";
import { measure } from "./measure";
import { check } from "./check";
import { seal } from "./envelope";
import { toLine } from "./index";

export function handleWorkerMessage(m: { id: unknown; verb: string; input: unknown }): { id: unknown; line: string } {
  try {
    if (m === null || typeof m !== "object" || typeof (m as { verb?: unknown }).verb !== "string") {
      const r = seal("check", 2, { errors: [{ code: "WRONG_TYPE", path: "verb" }] } as never);
      return { id: (m as { id?: unknown } | null)?.id ?? null, line: toLine(r) };
    }
    const verb = m.verb;
    const input = m.input;
    if (verb === "densify") return { id: m.id, line: toLine(densify(input)) };
    if (verb === "rank") return { id: m.id, line: toLine(rank(input)) };
    if (verb === "pack") return { id: m.id, line: toLine(pack(input)) };
    if (verb === "measure") return { id: m.id, line: toLine(measure(input)) };
    if (verb === "check") return { id: m.id, line: toLine(check(input)) };
    const r = seal("check", 2, { errors: [{ code: "WRONG_TYPE", path: "verb" }] } as never);
    return { id: m.id, line: toLine(r) };
  } catch {
    const r = seal("check", 2, { errors: [{ code: "WRONG_TYPE", path: "" }] } as never);
    return { id: (m as { id?: unknown } | null)?.id ?? null, line: toLine(r) };
  }
}
