import { describe, expect, it } from "vitest";
import { assertCommand, assertHistory, assertPhaseLabels, assertScoped, COMMAND, EXPECTED, MALFORMED_ROOM,
  memory } from "./oracle";
import type { Memory } from "./oracle";

// Fixtures at the public observation boundary, independent of the missing product behavior.
// No production module is patched and no import failure counts as a detected mutant.
function labelled(current: string, filter: string): HTMLElement {
  const root = document.createElement("section");
  for (const value of [`Current phase: ${current}`, `Phase filter: ${filter}`]) {
    const label = document.createElement("p"); label.textContent = value; root.append(label);
  }
  return root;
}
function exportObservation(command?: string): HTMLElement {
  const root = document.createElement("section"), label = document.createElement("p");
  label.textContent = command === undefined ? "Command unavailable" : "Memory export command"; root.append(label);
  if (command !== undefined) { const code = document.createElement("code"); code.textContent = command; root.append(code); }
  return root;
}
function detected(run: () => void, expectedMessage: RegExp): void {
  let caught: unknown;
  try { run(); } catch (error) { caught = error; }
  expect(caught, "the calibrated oracle must detect the mutant").toBeInstanceOf(Error);
  expect((caught as Error).name, "infrastructure exceptions are never detection").toBe("AssertionError");
  expect((caught as Error).message).toMatch(expectedMessage);
}

describe("U126 A7 independently calibrated boundary mutants", () => {
  it("A7 final-value-only history is detected by the same A1 assertion", () => {
    expect(() => assertHistory(EXPECTED)).not.toThrow();
    const finalValueOnly = [EXPECTED[0]!];
    detected(() => assertHistory(finalValueOnly), /retained accepted versions/);
  });
  it("A7 using the selected filter as the current phase is detected by the same A5 assertion", () => {
    expect(() => assertPhaseLabels(labelled("Discovery", "Build"))).not.toThrow();
    detected(() => assertPhaseLabels(labelled("Build", "Build")), /visible current-phase label/);
  });
  it("A7 skipped M4 slug validation is detected by the same invalid-command assertion", () => {
    expect(() => assertCommand(exportObservation(), undefined)).not.toThrow();
    expect(() => assertCommand(exportObservation(COMMAND), COMMAND)).not.toThrow();
    const unsafe = COMMAND.replace('"demo"', JSON.stringify(MALFORMED_ROOM));
    detected(() => assertCommand(exportObservation(unsafe), undefined), /must not produce executable text/);
  });
  it("A7 unscoped room history is detected by the same selected-room assertion", () => {
    expect(() => assertScoped(memory({ goal: EXPECTED }), "demo", EXPECTED)).not.toThrow();
    const leaked: Memory = memory({ goal: EXPECTED, other: [{ rev: 30, by: "alice", ts: 30, text: "secret" }] });
    detected(() => assertScoped(leaked, "demo", EXPECTED), /secret/);
  });
  it("A7 broken mutant infrastructure is explicitly rejected instead of counted as detection", () => {
    expect(() => detected(() => { throw new TypeError("broken setup"); }, /setup/)).toThrow(/AssertionError/);
  });
});
