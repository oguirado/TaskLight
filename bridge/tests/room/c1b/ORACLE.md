# C1b supervisor oracle

Source: SPEC_C1b in `.unit/SPEC.md`, read in full. Amendment sections:
AUSENTE. The numbered acceptance surface is M1-M7; there is no separate
numbered acceptance list in the supplied spec.

The suite calls the public `python3 -m bridge.room run` entry. It does not
import the missing supervisor module, create production stubs, or require a
future supervisor function name. Real child programs are small local Python
programs. Their stdout-ready pipe provides the signal barrier. No network,
sleep-based synchronization, elapsed-time assertion, or real heartbeat timer
is used. Subprocess and pipe timeouts only bound a broken test's execution.
Scratch storage is created and removed inside this test directory.

## Acceptance map

All test names below are methods; module paths are relative to this directory.

| Case | Required behavior | Tests |
|---|---|---|
| M1 | No shell; unchanged binary stdin/stdout/stderr; literal child arguments; child exit code | `test_run.ProcessOracle.test_m1_binary_stdin_stdout_stderr_pass_through_without_supervisor_output`, `test_m1_argv_remains_literal_after_the_separator`, `test_m1_m2_nonzero_exit_2`, `test_m1_m2_nonzero_exit_7`, `test_m1_m2_nonzero_exit_23`, `test_m1_m2_nonzero_exit_255`; `test_virtual.ClockOracle.assert_supervised` checks the no-shell boundary for every virtual case |
| M1 | Signal exit mapping and the child's actual caught-signal exit outcome | `test_run.ProcessOracle.test_m1_m2_m3_sigint_self`, `test_m1_m2_m3_sigterm_self`, `test_m1_m2_m3_sigint_forwarded`, `test_m1_m2_m3_sigterm_forwarded`, `test_m1_m2_m3_sigint_caught`, `test_m1_m2_m3_sigterm_caught` |
| M1 | Optional parent flags reach lifecycle metadata with child identity intact | `test_virtual.ClockOracle.test_m1_parent_fields_reach_deployment_transport` |
| M2 | Deployment is committed before the child starts; supplied identity/harness; fresh per-invocation run identity | `test_run.ProcessOracle.test_m2_deployed_is_visible_before_the_real_child_starts`, `test_m2_explicit_run_id_and_harness_are_preserved`, `test_m2_generated_run_ids_are_fresh_for_repeated_invocations` |
| M2 | Default and endpoint heartbeat schedules; beats stop when the child exits | `test_virtual.ClockOracle.test_m2_default_beat_is_fifteen_virtual_seconds`, `test_m2_minimum_beat_is_two_virtual_seconds`, `test_m2_maximum_beat_is_three_hundred_virtual_seconds`; every virtual case also drains pending synthetic callbacks after return |
| M2 | Successful terminal state; failed exit/signal states and exact reasons | `test_run.ProcessOracle.test_m1_binary_stdin_stdout_stderr_pass_through_without_supervisor_output`, all `test_m1_m2_nonzero_exit_*` and `test_m1_m2_m3_*` cases above; `test_virtual.ClockOracle.test_m2_nonzero_exit_has_one_terminal_event_after_heartbeats` |
| M3 | Forward supervisor SIGINT/SIGTERM and still write the terminal event | `test_run.ProcessOracle.test_m1_m2_m3_sigint_forwarded`, `test_m1_m2_m3_sigterm_forwarded`, `test_m1_m2_m3_sigint_caught`, `test_m1_m2_m3_sigterm_caught` |
| M3 | Storage failure never prevents child launch or substitutes its outcome; report lifecycle loss once | `test_run.ProcessOracle.test_m3_unwritable_room_preserves_exit_0`, `test_m3_unwritable_room_preserves_exit_29`; `test_virtual.ClockOracle.test_m3_write_loss_at_deployment`, `test_m3_write_loss_at_heartbeats`, `test_m3_write_loss_at_termination`, `test_m3_write_loss_at_all_writes_nonzero` |
| M4 | Bad arguments return the specified refusal before launch or storage writes | Every `test_run.ArgumentOracle` case in the rejection table; `test_legacy.BootstrapOracle.test_m4_valid_slug_boundary_is_accepted` supplies a positive slug boundary |
| M5 | No command, output, or environment data enters any room file or lifecycle payload | `test_run.ProcessOracle.test_m5_journal_never_contains_argv_output_or_environment`; `test_virtual.ClockOracle.test_m5_transport_contains_only_lifecycle_metadata` |
| M6 | Bootstrap missing storage; preserve existing history; create no plan | `test_run.ProcessOracle.test_m6_missing_home_and_room_are_created_without_a_plan`, `test_m6_existing_room_history_is_preserved`; `test_legacy.BootstrapOracle.test_m6_preserved_lifecycle_call_bootstraps_a_missing_room` pins the existing A-U141b prerequisite |
| M7 | Codex and generic executable examples in the designated documentation | `test_docs.DocumentationOracle.test_m7_codex_exec_example`, `test_m7_generic_command_example`, reading `docs/HEADLESS.md` and `docs/HARNESS_HOOKS.md` together |

## Rejection cases

Each method below has the prefix `test_run.ArgumentOracle.test_m4_`.
Every rejection must leave both its child marker and its storage root absent.
Each first proves a valid run works in separate scratch storage, so an unknown
command refusal cannot masquerade as successful argument validation.

| Suffix | Input rejected |
|---|---|
| `missing_separator` | Missing mandatory child-command separator |
| `missing_command` | Separator with no executable |
| `missing_room` | Missing room identity |
| `missing_agent` | Missing agent identity |
| `empty_room` | Empty room slug |
| `room_traversal` | Parent-directory traversal in room slug |
| `uppercase_room` | Invalid room character |
| `long_room` | Room slug beyond the existing schema bound |
| `empty_agent` | Empty agent slug |
| `agent_traversal` | Parent-directory traversal in agent slug |
| `uppercase_agent` | Invalid agent character |
| `long_agent` | Agent slug beyond the existing schema bound |
| `beat_below_minimum` | Beat below the inclusive minimum |
| `beat_zero` | Zero beat |
| `beat_negative` | Negative beat |
| `beat_above_maximum` | Beat above the inclusive maximum |
| `beat_nan` | Non-finite beat |
| `beat_infinite` | Non-finite beat |
| `beat_not_numeric` | Non-numeric beat |
| `parent_without_run` | Parent without parent-run |
| `parent_run_without_parent` | Parent-run without parent |
| `invalid_parent_slug` | Invalid parent agent slug |
| `invalid_parent_run` | Invalid parent run identity |
| `invalid_run_id` | Invalid child run identity |

## Negative controls and stop rules

| Control | Assertion that rejects it |
|---|---|
| Swallow the child's nonzero exit | `test_m1_m2_nonzero_exit_23` compares the actual supervisor exit with the child's requested exit; the child-output marker also prevents a CLI refusal from passing |
| Omit the terminal event after supervisor SIGTERM | `test_m1_m2_m3_sigterm_forwarded` requires deployment, exactly one terminal state, and the signal reason after the child-ready barrier |
| Write child argv to the room | `test_m5_journal_never_contains_argv_output_or_environment` scans all room files for a literal argv sentinel and rejects extra lifecycle payload fields |
| Continue heartbeats after exit | Every virtual case drains pending callbacks after return and checks that lifecycle attempts do not increase; cadence cases reject beats after the synthetic child death |
| Abort on room failure | Real unavailable-storage cases require the child marker/output and original exit; virtual deployment, beat, terminal and repeated-write failures require continued supervision |
| Accept malformed arguments after side effects | Every rejection case requires its storage root and child marker to remain absent |

The exit-swallowing, missing-terminal and argv-disclosure assertions were also
exercised with injected observations and rejected their negative controls
[MEASURED]. This is assertion-level validation, not a claim that a supervisor
implementation or source mutant exists on the baseline.

## Scope and ambiguity decisions

- Parent flags are treated as a pair in either direction. Parent agent and run
  syntax reuse the existing agent/run contracts. The parent transport case
  substitutes the already-existing lifecycle admission boundary, allowing C1b
  to be tested before C2 admission exists. It requires the parent link on
  deployment and preserves any repeated parent metadata without demanding
  repetition on every beat.
- C2 schema changes, cycle/self-parent admission, unresolved-parent inventory,
  cross-language replay, browser behavior and tree ordering are OUT OF SCOPE.
  C1 native harness event adapters and hidden sub-agent discovery are also
  OUT OF SCOPE. Their absence is not a C1b failure.
- Heartbeat default/minimum/maximum are as specified in M2 [CITED]. Virtual
  scenarios observe the existing lifecycle admission boundary. The existing
  handler's beat coalescing in `bridge/plan/fold.py` remains a preserved
  prerequisite; C1b must submit every due beat, without demanding changes to
  that other unit's journal/replay policy.
- Virtual tests replace stdlib process/time boundaries, support timed process
  waits, sleep, event waits and scheduled timer callbacks, and impose no
  supervisor callable name. Real-process tests independently cover spawning,
  streams, journal contents, bootstrap, exit status and signal forwarding.
- An immediate alive event is permitted. The mandatory subsequent heartbeat
  deadlines and cessation after exit are checked. Successful-exit reason,
  generated-ID encoding beyond the existing syntax, unspecified default
  harness, and documentation flag order are not prescribed.
- Documentation examples are checked across the designated guides together;
  the spec does not require duplicate examples in each guide.
- U163 output redaction (`bridge/tests/room/u163/`) is a separate, pending
  oracle in this snapshot and is
  OUT OF SCOPE; its baseline red status is excluded from C1b acceptance totals.
- Fractional beat policy, executable-not-found status, permanent-write-failure
  recovery/retries, and externally killing the supervisor with an uncatchable
  signal have no specified acceptance behavior: AUSENTE. No new policy is
  invented for them. Failure diagnostics must identify lifecycle loss once;
  their full wording is not pinned.

## Reproduction

From the repository root, with stdlib unittest only:

```sh
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s bridge/tests/room/c1b -t .
```

The baseline must be red because the public CLI lacks `run` and the guides
lack its examples. Import errors, missing-module errors and fixture failures
are not acceptable evidence. The preserved lifecycle-bootstrap case may be
green. No production code, external service, credentials or model is required.

## Measured baseline

The final C1b discovery contains 58 tests [MEASURED]: 57 assertion failures
[MEASURED], one preserved-bootstrap pass [MEASURED], and zero errors [MEASURED].
No import or fixture errors occurred. Exact unittest summary [MEASURED]:

```text
Ran 58 tests in 1.825s

FAILED (failures=57)
```

Existing non-U163 room cases were checked in disjoint partitions: 1,818 cases
[MEASURED], with seven skips [MEASURED]. After relocating verification-only
multiprocessing scratch files into this directory, all non-skipped cases
passed [MEASURED]; the relocated barrier cases were rechecked separately.
The pending U163 oracle is excluded, as declared above. Original repository
files were verified unchanged [MEASURED].
