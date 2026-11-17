# U141 terminal cleanup oracle

Source: `.unit/SPEC.md`, read in full, including the final operator decisions.
The supplied spec contains no numbered acceptance list and no Amendment section.
The case numbers below are local traceability labels, not invented spec text.
The mandate is limited to U141 and the supplied workspace corpus.

## Acceptance mapping

Generated names use `<transport>` = `hook`, `mcp`, `cli`, `mailbox` and
`<terminal>` = `failed`, `finished`; the expanded names appear below.

| Case | Binding source | Acceptance and tests |
| --- | --- | --- |
| C1 | Spec line 12, terminal parity | `test_releases_eligible_<transport>_<terminal>` exercises all four real transports and both terminal states. Pending, active and blocked owned claims are released exactly once. Other-owned, done and cancelled tasks survive; completed outcomes, evidence, text, memory and plan remain intact. |
| C2 | Spec line 13, distinct receipts | `test_distinct_cleanup_receipt_<transport>_<terminal>` requires an additional observable result component beyond the lifecycle receipt. A bare lifecycle result, copied lifecycle result or boolean alone is insufficient. |
| C3 | Spec line 13, exact replay | `test_exact_replay_<transport>_<terminal>` preserves the lifecycle Lamport identity, releases work, and adds no duplicate terminal or release event on repeated delivery. |
| C4 | Spec line 13, bootstrap parity | `test_bootstrap_policy_deployed`, `test_bootstrap_policy_alive`, `test_bootstrap_policy_failed`, `test_bootstrap_policy_finished` compare success/refusal, room creation and lifecycle persistence across every transport on absent rooms, and forbid implicit plan creation. Either consistent bootstrap policy is accepted. |
| C5 | Spec line 15, hostile old run | `test_stale_run_preserves_successor_<transport>_<terminal>` first persists the old termination, deploys a successor with a new `run_id`, and claims work both under the reused slug and another owner. Exact replay and an unseen stale terminal preserve all successor state and append nothing. |
| C6 | Spec lines 13 and 15, crash and resume | `test_crash_after_lifecycle_<transport>_<terminal>` interrupts immediately after the terminal journal fsync. `test_crash_after_release_<transport>_<terminal>` interrupts after a cleanup journal fsync. Both replay the identical event/envelope, preserve the committed prefix, finish cleanup, and append each logical terminal/release only once. |
| C7 | Spec line 15, negative implementation | `test_negative_lifecycle_only_handler_is_rejected_by_release_oracle` substitutes a real journal-backed lifecycle-only handler in memory and verifies that the same eligible-release assertion rejects it. No missing module, exception-shaped stub, expectedFailure, blanket skip or mock-only success stands in for product behavior. |
| C8 | Eligible-cleanup boundaries inherited from cited `bridge/tests/room/u133/test_cleanup.py` | `test_no_plan_stop_<transport>_<terminal>`, `test_newer_plan_stop_<transport>_<terminal>` and `test_nonterminal_preserves_work_<transport>_<state>` (`state` = `deployed`, `alive`) preserve no-plan, later plan-generation and nonterminal boundaries. The newer plan reuses `T01` without assuming U142 work admission. |

## Transport and fixture contract

- `hook`: real `bridge.room.hook.run_hook_bytes`, including input validation and deadline code. Its executable's silent exit remains unchanged and is already covered by U133; returned receipts are checked through the callable entry.
- `mcp`: real `bridge.room.mcp.main` with initialize, notification and `tools/call` JSON lines on in-memory stdin/stdout; `agent_lifecycle` reaches the real dispatcher and journal.
- `cli`: real `bridge.room.__main__.main` with `call agent_lifecycle --json`; exit status and JSON result are decoded.
- `mailbox`: real slice-one `tasklight.family/1` request publication and `bridge.room.family.main` one-shot drain, using both `agent.failed` and `agent.finished`; each matching result is decoded. `bridge/room/family.py` is not modified.
- Setup uses public dispatcher operations and the shipped `blank` template. No new `bridge/room/ext/cleanup.py` is imported or required to exist. Files outside this oracle directory are read-only.
- Each test creates and deletes a unique home inside this directory. No literal operator paths, local receipt locations, hostnames or private tool identifiers appear in the published files. Runtime evidence paths are computed from the temporary home and are removed with it.
- All clocks are fixed; sleeps, sockets and process construction are denied; OS signal/timer calls are replaced with inert fakes. Loops are finite and there is no polling, network, GUI, provider or external executor.
- Crash injection uses a `BaseException` immediately after the real fsync on the actual journal descriptor. It is never counted as a passing oracle verdict. Ordinary cases still assert cleanup after replay. An implementation committing all eligible releases atomically is acceptable: the crash need not expose an artificial partial batch.
- The crash fixture returns only its own mailbox consumer lease while unwinding. Recovery of abandoned consumer ownership is a family-channel concern; it is not confused with backend cleanup replay. The request has no completed adapter dedup record at the injected crash boundary.

## Resolved ambiguities and scope boundaries

1. The source has neither numbered acceptance cases nor amendments: C1-C8 above map its actual clauses without inventing additional requirements.
2. No cleanup receipt key, identity format, status vocabulary or storage scheme is specified. Tests preserve the shipped lifecycle `{ok, lamport}` receipt and require a distinct additional component without selecting a field name or hashing algorithm. Completion/replay is independently verified from persisted work and journal events.
3. The source requires one bootstrap rule but does not choose creation versus refusal. The tests accept either policy when applied consistently for each lifecycle state, including rejected absent-room terminations.
4. "Eligible" follows the cited U133 public release behavior: owned pending/active/blocked work from the terminal's plan/run/claim; done/cancelled and another owner's work are excluded. Active microtasks return to pending; completed records survive.
5. The negative control deliberately uses the existing `bridge/room/ext/lifecycle.py` persistence seam `_commit`; only this mutation fixture depends on that legacy primitive. No production cleanup interface, helper module or algorithm is prescribed. The negative implementation is an in-memory replacement of `agent_lifecycle` that persists its lifecycle operation through the existing real lifecycle persistence primitive and returns the lifecycle receipt, omitting cleanup. It alters no product source.
6. The final operator decisions about terminal-slug work refusal belong to U142 (`bridge/room/ext/acquire.py`), not U141. New work admission, mismatched-beat results and atomic backend generation fencing (U140) are out of scope. The U141 tests do retain cleanup's existing plan/claim safety boundaries.
7. U139 durable throttled no-op identity is a prerequisite, not a new U141 acceptance failure. Mailbox slice-two enablement/admissions (U143), frontend containers, persona scoring, visual runs, live harness launch and production ADMIT are also out of scope. A passing executable fixture makes no admission claim.

## Verification

Run from the repository root, with bytecode writes disabled:

```sh
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s bridge/tests/room/u141 -t .
```

Observed on the unmodified product tree: **77 tests, 36 red, 41 green,
zero errors and zero skips [MEASURED]**. Exit status: `1` [MEASURED].
Every red test ended in the expected `AssertionError`; failure test identities were
checked against the missing-behavior matrix. No red result comes from imports,
fixture setup, abandoned consumer ownership or another unit's admission.

Exact unittest summary [MEASURED]:

```text
Ran 77 tests in 21.589s

FAILED (failures=36)
```

| Missing behavior | Assertion failures [MEASURED] |
| --- | --- |
| Absent-room bootstrap parity across lifecycle states | 4 |
| Distinct cleanup receipt on both terminal states and all transports | 8 |
| MCP/CLI/mailbox eligible release, completed replay and post-lifecycle-crash replay | 18 |
| MCP/CLI/mailbox never reach a durable cleanup-release crash boundary | 6 |

Preserved hook cleanup/replay/crash checks, stale-successor and newer-plan safety,
no-plan and nonterminal stop checks, and the lifecycle-only negative control are
green [MEASURED]. The negative control passes because the release oracle rejects
its missing cleanup, not because the mutated product meets the contract.

Relevant unchanged suites were also run with stdlib unittest. Their temporary
homes were redirected into this owned directory in memory, with bytecode writes
disabled; no existing test file was edited.

| Existing suite | Tests [MEASURED] | Exact verdict [MEASURED] |
| --- | --- | --- |
| `bridge/tests/room/u132` | 40 | `OK` |
| `bridge/tests/room/u133` | 81 | `OK (skipped=4)` |
| `bridge/tests/room/u139` | 14 | `OK` |
| `bridge/tests/family` | 206 | `OK` |

The existing U133 integration skips remain unchanged and are not acceptance
receipts. Aggregate content hashes of `bridge/room`, the existing suites above,
and `.unit` matched before and after verification [MEASURED]. Only this unit's
new oracle files were retained. No production ADMIT or visual receipt is claimed.


## Expanded test names

- `test_bootstrap_policy_alive`
- `test_bootstrap_policy_deployed`
- `test_bootstrap_policy_failed`
- `test_bootstrap_policy_finished`
- `test_crash_after_lifecycle_cli_failed`
- `test_crash_after_lifecycle_cli_finished`
- `test_crash_after_lifecycle_hook_failed`
- `test_crash_after_lifecycle_hook_finished`
- `test_crash_after_lifecycle_mailbox_failed`
- `test_crash_after_lifecycle_mailbox_finished`
- `test_crash_after_lifecycle_mcp_failed`
- `test_crash_after_lifecycle_mcp_finished`
- `test_crash_after_release_cli_failed`
- `test_crash_after_release_cli_finished`
- `test_crash_after_release_hook_failed`
- `test_crash_after_release_hook_finished`
- `test_crash_after_release_mailbox_failed`
- `test_crash_after_release_mailbox_finished`
- `test_crash_after_release_mcp_failed`
- `test_crash_after_release_mcp_finished`
- `test_distinct_cleanup_receipt_cli_failed`
- `test_distinct_cleanup_receipt_cli_finished`
- `test_distinct_cleanup_receipt_hook_failed`
- `test_distinct_cleanup_receipt_hook_finished`
- `test_distinct_cleanup_receipt_mailbox_failed`
- `test_distinct_cleanup_receipt_mailbox_finished`
- `test_distinct_cleanup_receipt_mcp_failed`
- `test_distinct_cleanup_receipt_mcp_finished`
- `test_exact_replay_cli_failed`
- `test_exact_replay_cli_finished`
- `test_exact_replay_hook_failed`
- `test_exact_replay_hook_finished`
- `test_exact_replay_mailbox_failed`
- `test_exact_replay_mailbox_finished`
- `test_exact_replay_mcp_failed`
- `test_exact_replay_mcp_finished`
- `test_negative_lifecycle_only_handler_is_rejected_by_release_oracle`
- `test_newer_plan_stop_cli_failed`
- `test_newer_plan_stop_cli_finished`
- `test_newer_plan_stop_hook_failed`
- `test_newer_plan_stop_hook_finished`
- `test_newer_plan_stop_mailbox_failed`
- `test_newer_plan_stop_mailbox_finished`
- `test_newer_plan_stop_mcp_failed`
- `test_newer_plan_stop_mcp_finished`
- `test_no_plan_stop_cli_failed`
- `test_no_plan_stop_cli_finished`
- `test_no_plan_stop_hook_failed`
- `test_no_plan_stop_hook_finished`
- `test_no_plan_stop_mailbox_failed`
- `test_no_plan_stop_mailbox_finished`
- `test_no_plan_stop_mcp_failed`
- `test_no_plan_stop_mcp_finished`
- `test_nonterminal_preserves_work_cli_alive`
- `test_nonterminal_preserves_work_cli_deployed`
- `test_nonterminal_preserves_work_hook_alive`
- `test_nonterminal_preserves_work_hook_deployed`
- `test_nonterminal_preserves_work_mailbox_alive`
- `test_nonterminal_preserves_work_mailbox_deployed`
- `test_nonterminal_preserves_work_mcp_alive`
- `test_nonterminal_preserves_work_mcp_deployed`
- `test_releases_eligible_cli_failed`
- `test_releases_eligible_cli_finished`
- `test_releases_eligible_hook_failed`
- `test_releases_eligible_hook_finished`
- `test_releases_eligible_mailbox_failed`
- `test_releases_eligible_mailbox_finished`
- `test_releases_eligible_mcp_failed`
- `test_releases_eligible_mcp_finished`
- `test_stale_run_preserves_successor_cli_failed`
- `test_stale_run_preserves_successor_cli_finished`
- `test_stale_run_preserves_successor_hook_failed`
- `test_stale_run_preserves_successor_hook_finished`
- `test_stale_run_preserves_successor_mailbox_failed`
- `test_stale_run_preserves_successor_mailbox_finished`
- `test_stale_run_preserves_successor_mcp_failed`
- `test_stale_run_preserves_successor_mcp_finished`
