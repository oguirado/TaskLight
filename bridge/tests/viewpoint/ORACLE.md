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

## Oracle amendment A-U42b (capsule set, URL inference, bare-goal default)

SPEC change (ViewPoint operator decision): capsules are arXiv, Gemini (page deepmind.google/models/gemini/), GitHub and
Wikipedia; ChatGPT/OpenAI are no longer capsules. Plan B capsule MDN (mdn, developer.mozilla.org), plan C Hugging Face
(hugging face, huggingface.co; slug `hugging-face-agent`). Inference order: goal text, then target names (keywords as whole
words, first named wins), then url/href/host/origin/domain fields of the run's intent/dispatch/receipt/report JSON
(host suffix match: arxiv.org, deepmind.google, gemini.google.com, github.com, wikipedia.org, developer.mozilla.org,
huggingface.co). No match: title is the bare `<goal>` and the agent is `viewpoint-agent` (`-2`, `-3` on overlap), never a
fixed or wrong capsule. Amended: `test_observer.py` `Mapping.test_label_and_title_capped_and_redacted` (bare-goal title);
`test_u42_labels.py` GOALS and ChatGPT cases rewritten to GitHub, `test_unknown_capsule_is_bare_goal`, new classes
`PlanBC`, `UrlCapsules`, `StopSignal` (live finding: SIGTERM during poll() was swallowed; `_Stop` is now a BaseException),
`ReportOnlyRun` (live finding: a run with only report.json posted a close under the slug of the previous finished run and
overwrote its verdict; a run that never posted a plan now posts nothing).

## Oracle amendment A-U43 (one card per capsule with cooperative agents, C6)

Live finding (03:24 take, `shots/live_best4_c6.png`): with agents posting through the context-wall MCP, arXiv showed two
cards (agent `arxiv-agent` + observer `viewpoint-agent` "Search term or terms") and Wikipedia showed one mixed card
(the observer's "Wikipedia · Search Wikipedia" plan replaced the agent's "[Wikipedia] Search Google DeepMind" plan on
the shared slug `wikipedia-agent`). SPEC change: a run is skipped silently (stats `merged_skipped`, also on the stderr
counter line) when a cooperative agent `<site>-agent` (not `viewpoint-agent*`, not an event this observer posted, not a
plan titled "<Capsule> · ...") was active in the room (plan or step) within 120 s before the run's first intent and its
latest plan shares a content word (>= 3 letters, minus UI stopwords) with the run's goal, target names or typed text.
Unknown-capsule runs consider any such agent; known-capsule runs only that capsule's agent id. Typed text is compared in
memory and never posted. New tests: `test_u43_merge.py`. `--viewpoint --no-observer` (run_tasklight) removes the
observer entirely for cooperative-only takes.
