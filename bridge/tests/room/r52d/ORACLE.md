# R52D public resume oracle

The binding row in `.unit/SPEC.md` has unnumbered acceptance clauses. The
numbers below follow their order. The numbered acceptance list and final
Amendment sections referenced in the assignment are AUSENTE in that file.

| Case | Acceptance clause | Test in `test_resume_workflow.py` |
| --- | --- | --- |
| 1 | Document the public resume and decision transcript and exercise it through the room dispatcher. | `test_orchestrator_guide_documents_public_resume_and_decide_transcript`, `test_resume_replays_clipped_completions_and_matches_retry`, `test_recorded_evidence_controls_decisions_and_export_opening` |
| 2 | Save separate snapshot and waiter cursors with processed obligations and the pending attempt identity. Resume a clipped capture from its returned cursor without losing its omitted Lamport group. | `test_resume_replays_clipped_completions_and_matches_retry` |
| 3 | Match the terminal by agent and run. Using the head skips the pending retry and completions. Matching the agent alone selects an earlier attempt. A run ID alone can also match another agent. | `test_resume_replays_clipped_completions_and_matches_retry` |
| 4 | Verify the terminal's recorded evidence with `artifact_read` before `ADMIT`. Record `HOLD` after a digest mismatch, absent file, or missing terminal output. | `test_recorded_evidence_controls_decisions_and_export_opening` |
| 5 | Export through `room_export` with `what: integration` and the selected `opened_lamport`. Exclude results and decisions from the other opening even when the task ID is reused. | `test_recorded_evidence_controls_decisions_and_export_opening` |

`test_timeout_leaves_missing_terminal_pending` distinguishes a waiter timeout
from a recorded resultless terminal. The test leaves the lane pending and
recovers the later terminal from the saved waiter cursor.

The dispatcher exercises the live journal and public payloads. The checkpoint
is caller-owned fixture state. Its representation is a fixture choice. Byte
pressure clips a real snapshot and a tail-only change invalidates a recorded
artifact even for a one-byte read. The fixture uses a virtual clock, blocks
network and process launches, and bounds dispatch execution. The guide
assertion checks public operation names and required concepts without fixing
headings or transcript syntax. The runtime assertions exercise the behavior
and negative controls independently of the guide's presentation.

The baseline is expected to fail on the missing workflow in
`docs/ORCHESTRATOR.md`. The public cursor, artifact, decision, and export
operations already support the behavior exercised by the transcript.

## Out of scope

- R52W journal integrity and sanitized read failures, tested in
  `bridge/tests/room/r52w`. R52G protected completion admission is tested in
  `bridge/tests/room/r52g`.
- R52A and C8b import authority. This workflow uses the binding row's explicit
  import `HOLD` branch. Journaled unit decisions and the integration log
  confer no import authority.
- Worker launch custody, external process exit verification, board rendering,
  cross-family review, and the common wave-exit gate.

```sh
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s bridge/tests/room/r52d -t .
```
