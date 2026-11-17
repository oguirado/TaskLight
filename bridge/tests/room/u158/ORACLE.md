# U158 terminal work admission

Status: IMPLEMENTED WITHIN WRITE SURFACE; full-suite validation BLOCKED by
legacy fixtures outside the permitted write surface. No admission verdict is claimed.

The new tests ran before production changes: every case failed on the admission
bypass, with 25 failures and no fixture errors [MEASURED]. After implementation,
all 25 cases pass [MEASURED]. The negative control bypasses the claim guard in
memory and verifies that the same refusal oracle turns red.

Persona reproduction, verbatim:

> Persona evidence [MEASURED]: deploy `owner-b` run `admission-run`; record `failed`; add fresh task T02; `work_acquire` is refused, but `task_claim(T02)` and `microtask_set(T02.M01, active)` succeed without redeployment.

The repaired contract refuses both legacy calls with the existing work-tool
error: `not_conformant`, detail
`not_conformant: terminal agent requires a fresh deployment with a new run_id`.
MCP and CLI keep their existing error envelopes. A terminal event delivered by
the real mailbox also prevents later claims through the shared dispatcher.

The lifecycle/run identity check moves unchanged from
`bridge/room/ext/acquire.py` to `bridge/room/ext/admission.py`.
`bridge/room/app.py` routes legacy single operations through the helper. Guarded
operations retain the backend's validation, generation fence, request digest,
replay namespace, fold validation, journal ceiling and durable append primitives.
Replay precedes lifecycle admission under the journal writer lock, which remains
held through append. Deterministic competing threads exercise both writer orders:
terminal first refuses without appending; claim first commits and terminal
cleanup releases it exactly once. Unregistered agents retain their behavior;
only a fresh deployment with a new run identity re-admits terminal agents.

In this tree, `task_update` has no assignment field and `next_work` only lists
work. Their existing contracts stay unchanged. Mailbox claim delivery is
AUSENTE — no inventar: slice:1 refuses planning kinds with `bad_args`; slice:2
remains gated. These absent paths are not reported as passing transport parity.
Tool discovery schemas are unchanged.

## Verification

| Suite | Observed result |
| --- | --- |
| `bridge/tests/room/u158/` | 25 passed [MEASURED] |
| `bridge/tests/room/u142/` | 36 passed [MEASURED] |
| `bridge/tests/room/u141/` | 77 run; 8 legacy fixture errors [MEASURED] |
| `bridge/tests/room/u140/` | 29 passed [MEASURED] |
| `bridge/tests/room/u140r1/` | 18 passed [MEASURED] |
| `bridge/tests/room/u109r1/` | 10 passed [MEASURED] |
| `bridge/tests/room/u132/` | 40 passed [MEASURED] |
| `bridge/tests/room/u139/` | 14 passed [MEASURED] |
| `bridge/tests/room/u119/` | 175 passed [MEASURED] |
| Full room discovery | 1814 run; no assertion failures, 8 legacy fixture errors, 7 skipped [MEASURED] |
| Original family set, included in full discovery | 206 passed [MEASURED] |
| Added `bridge/tests/family/u143/` oracles | 74 run; 37 failures, reproduced with prior admission behavior [MEASURED] |
| Full family discovery | 280 run; 37 U143 failures [MEASURED] |
| `bridge/tests/plan/` | 614 passed [MEASURED] |
| `npx vitest run tests/unit/u87 tests/unit/u111` | 249 passed [MEASURED] |
| `npx tsc --noEmit -p .` | 16 errors in untouched TypeScript files, matching package baseline [MEASURED] |
| `bash tests/secret_scan/run.sh` | PASS [MEASURED] |
| `bash tools/secret_scan.sh` | PASS; no findings [MEASURED] |

## Legacy fixture amendments required outside the write surface

No legacy test files were amended. The affected file is
`bridge/tests/room/u141/test_terminal_cleanup.py`, factory `newer_plan_case`.
It reopens a plan, then claims using the still-terminal `exec-a` identity.
Opening a plan does not provide a fresh deployment. These methods need the
same fixture amendment:

| Transport | Terminal state | Method |
| --- | --- | --- |
| CLI | failed | `test_newer_plan_stop_cli_failed` |
| CLI | finished | `test_newer_plan_stop_cli_finished` |
| Hook | failed | `test_newer_plan_stop_hook_failed` |
| Hook | finished | `test_newer_plan_stop_hook_finished` |
| Mailbox | failed | `test_newer_plan_stop_mailbox_failed` |
| Mailbox | finished | `test_newer_plan_stop_mailbox_finished` |
| MCP | failed | `test_newer_plan_stop_mcp_failed` |
| MCP | finished | `test_newer_plan_stop_mcp_finished` |

Replace the comment immediately before the successor claim with:

```python
# A-U158: successor work needs a new deployed run after a terminal event.
self.api("agent_lifecycle", state="deployed", run_id="run-successor")
self.api("task_claim", task_id="T01")
```

This amendment was compiled and exercised in memory against the real backend:
all 8 affected cases passed [MEASURED]. The same cases also passed under the
prior unguarded behavior [MEASURED], confirming the obsolete fixture assumption.
The amendment is documented here without editing the excluded legacy file.
