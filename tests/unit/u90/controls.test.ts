import { expect, it } from "vitest";
import { requireClaimOnlyIdle, requireOwnerRejection } from "./support";

it("A7 calibration: ownership assertion fails on the deliberately bypassed fold", () => {
  expect(() => requireOwnerRejection((projection) => ({ ok: true, projection, replayed: false }))).toThrow(/expected true to be false/);
});

it("A7 calibration: idle assertion fails on the task-status-only working helper", () => {
  expect(() => requireClaimOnlyIdle(() => "working")).toThrow(/expected 'working' to be 'idle'/);
});
