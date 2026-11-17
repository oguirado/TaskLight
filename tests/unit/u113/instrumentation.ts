import { vi } from "vitest";
import * as Agents from "../../../src/agents";
import * as Plan from "../../../src/plan";

// Observe full reducers and sorting of event records, never private cache fields.
// Template canonicalization may sort string keys and is intentionally permitted.
export function observeWork() {
  const planFold = vi.spyOn(Plan, "foldPlan");
  const stateFold = vi.spyOn(Agents, "foldRoomWithStats");
  const nativeSort = Array.prototype.sort;
  let historySorts = 0;
  const eventLike = (value: unknown): boolean => {
    if (value === null || typeof value !== "object") return false;
    const record = value as Record<string, unknown>;
    if (typeof record["id"] === "string" && typeof record["lamport"] === "number" && typeof record["act"] === "string") return true;
    // A decorated sort still sorts history; ignore unrelated object/string sorts.
    for (const entry of Object.values(record)) {
      if (entry !== null && typeof entry === "object") {
        const event = entry as Record<string, unknown>;
        if (typeof event["id"] === "string" && typeof event["lamport"] === "number" && typeof event["act"] === "string") return true;
      }
    }
    return false;
  };
  vi.spyOn(Array.prototype, "sort").mockImplementation(function (
    this: unknown[], compare?: (a: unknown, b: unknown) => number,
  ) {
    if (this.some(eventLike)) historySorts++;
    return nativeSort.call(this, compare);
  });
  return {
    planFold, stateFold,
    snapshot: () => ({ planFolds: planFold.mock.calls.length, stateFolds: stateFold.mock.calls.length, historySorts }),
  };
}
