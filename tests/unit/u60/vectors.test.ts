// @vitest-environment node
import { describe, expect, it } from "vitest";
import { foldPlan } from "../../../src/plan";
import { clone, freeze, vectors } from "./helpers";

describe("V1/V2 Stop rule 3: canonical U55 parity (integration blocked on disagreement)", () => {
  for (const c of vectors) {
    const template = Object.values(c.templates)[0];
    it(`V1 ${c.id}: exact canonical projection and rejected receipts`, () => {
      const result = foldPlan(freeze(clone(c.events)), template);
      expect(result.projection).toEqual(c.expected_projection);
      expect(result.projection.rejected).toEqual(c.expected_rejected);
      expect(c.expected_rejected).toEqual(c.expected_projection.rejected);
    });
    for (const order of ["reverse", "shuffle"] as const) {
      it(`V2 ${c.id}: ${order} preserves canonical projection`, () => {
        const input = clone(c.events);
        if (order === "reverse") input.reverse();
        else { let seed = 60; for (let i = input.length - 1; i > 0; i--) {
          seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
          const j = seed % (i + 1); [input[i], input[j]] = [input[j], input[i]];
        } }
        const before = clone(input);
        expect(foldPlan(freeze(input), template).projection).toEqual(c.expected_projection);
        expect(input).toEqual(before);
      });
    }
  }
});
