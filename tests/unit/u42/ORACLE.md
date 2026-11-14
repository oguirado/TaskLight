# U42 oracle (TaskLight demo polish)

Run: `nice npx vitest run --project unit tests/unit/u42` and the viewpoint Python suite (`bridge/tests/viewpoint/test_u42_labels.py`).

| Item | Tests |
|---|---|
| 1 capsule labels (observer) | `bridge/tests/viewpoint/test_u42_labels.py` (Capsules, Concurrency, McpTitles) |
| 2 human close summary, raw code in step detail | `taskvm.test.ts` classifyClose + "card summary is human" |
| 3 Next line | `taskvm.test.ts` "Next line" |
| 4 chat drawer closed by default | `wall_ui.test.ts` "chat drawer" |
| 5 boot buttons hidden in placeholder mode | `boot_placeholder.test.ts`, `boot_controls.test.ts` (real config) |
| 6 rail running counter | `wall_ui.test.ts` "rail running counter", `taskvm.test.ts` in-progress status |

Amended existing assertions carry "Oracle amendment A-U42" notes: u34 taskvm, u38 v4/v6, viewpoint test_observer.
