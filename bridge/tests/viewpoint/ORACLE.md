# U40 oracle (ViewPoint -> room observer)

Run from `repo/`:
`python3 -I -c "import sys,unittest;sys.path.insert(0,'.');unittest.main(module=None,argv=['x','discover','-s','bridge/tests/viewpoint','-t','.'])"`

Synthetic run dirs only (`support.RunBuilder`, temp CW_HOME and runs root); the real `/dev/shm/vqa-cu` is never touched.

| Spec item | Tests |
|---|---|
| mapping (plan/step, slug, title, label, redaction, room) | Mapping |
| action.text never copied | Mapping.test_action_text_never_in_any_event, test_receipt_text_marker_not_leaked, Cli.test_once_posts_and_exits_0 |
| ordering (mtime then name), additions-only plans | Ordering |
| receipts -> done/blocked, outcome cap/redact | Receipts |
| report -> close, rc != 0 blocks active | Report |
| 12-step cap + "more steps not shown" | StepCap |
| .rgb never opened (open/os.open patched) | HardRules.test_rgb_never_opened |
| no writes under root (snapshot) | HardRules.test_no_writes_under_root |
| size cap 256 KiB, symlinks, malformed JSON, poll never raises | HardRules |
| cursor 0600, restart idempotency, corrupt cursor primes | Cursor |
| CLI --once/--prime, counters-only stderr, SIGINT/SIGTERM exit 0 | Cli |

Assumptions: verification status read from `verification.status`, reason from `verification.reason`; stats() returns a dict; the poll-failure test injects `post` raising and expects `errors` >= 1 and return 0.

## Oracle amendment A-U42 (capsule labels)

SPEC change (U42 demo polish): the agent slug is `<capsule>-agent` (capsule inferred from the goal, then the target name:
chatgpt/openai -> ChatGPT, gemini -> Gemini, wikipedia -> Wikipedia, arxiv -> arXiv, else ViewPoint), with `-2`, `-3` for
overlapping runs of the same capsule; the plan title is `<Capsule> · <goal>` (a goal tagged `[<Capsule>]` is kept as is).
Amended assertions in `test_observer.py`: `Mapping.test_first_intent_posts_plan_and_step_active` (agent/title),
`Mapping.test_label_and_title_capped_and_redacted` (title prefix), `Mapping.test_agent_slug_safe_chars` (slug),
`Ordering.test_two_runs_two_agents` (slugs). New tests: `test_u42_labels.py`.
