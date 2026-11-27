# U72 fail-first oracle

Status: R27 W3, wave B. Source: `.unit/SPEC.md`, fully read through Acceptance A5. Amendment sections and exported helper names/signatures: AUSENTE — no inventar. This oracle introduces the following explicit interface assumptions for author handoff; they are not claimed as quoted spec signatures.

| Helper | Contract |
| --- | --- |
| `parseStylesheetImports(source)` | Passive JavaScript source string to ordered stylesheet basenames from hosting-style side-effect imports. |
| `chromeCandidates(platform, env)` | Platform string and environment object to ordered executable paths. `CHROME` precedes command-priority PATH candidates; directory order breaks ties. macOS app bundles follow PATH. No filesystem probing or process launch. |
| `summaryExitCode(summary, options = {})` | Success returns zero, otherwise one. `options.noMcp` ignores `planV2` and `memory`. Legacy non-null question receipts count as successful question evidence. Missing required evidence fails. |

Every stub body throws `new Error("U72 stub")`. Runtime tests assert desired results, never assert that the stub throws. Static tests independently fail on current source defects; they are not artificially gated behind stubs.

| Acceptance | Test names / location | Negative contrast |
| --- | --- | --- |
| A1 | `A1 actual hosting imports preserve the complete stylesheet order`, `M1 derives order from source rather than a frozen list`, `M1 Vite reads hosting main imports and uses the pure helper` | Reordered fixture, empty source, unrelated imports, hostile source that must remain passive. |
| A2 | `A2 wall stylesheet does not paint the task progress track` | Unscoped background and shorthand/comma bypass fail the checker; scoped selector passes. |
| A3 | `A3 %s CHROME wins before every PATH browser`, `A3 linux PATH ordering with no override`, `A3 darwin standard app bundles follow PATH candidates` | Empty PATH yields no Linux candidates; shell metacharacters stay literal. |
| A4 | `A4 complete truth table mask %i`, `A4 absent or false required result %s cannot pass`, `A4 no-mcp ignores optional checks %s`, `A4 no-mcp still requires %s`, `A4 legacy question receipt remains a successful question` | Exhaustive boolean combinations; missing evidence never passes the default gate. |
| A5 | `A5 obsolete drift copy is absent`, `A5 task Chat is opened before selecting input and sending` | Missing Chat control or wrong order fails. |

| Additional MUST | Coverage |
| --- | --- |
| M1 | Actual `hosting/src/main.ts` plus source-order fixtures and `tools/demo/vite.demo.config.ts` wiring. |
| M2 | Static selector matching in `styles/wall.css`; no stylesheet or production change permitted. |
| M3 | Current `src/agentsui/index.ts` and `src/views/index.ts` labels; neither label table is exported, so the fallback constant branch applies. |
| M4 | Chat control before input before send; DOM or CDP click accepted. |
| M5 | Static checks for MCP module, demo CW_HOME, required tool names, template and payload markers, screenshots, Memory interaction and summary wiring. Pure gate tests cover default and `--no-mcp`. |
| M6 | Pure ordering tests and static discovery/error wiring. macOS bundle priority beyond PATH is unspecified, so no intra-bundle ordering is imposed. |
| M7 | New steps, flags and screenshots documented; confirmed fixed claims excluded from Known gaps. |
| M8 | Only `tools/demo/demo_lib.mjs` is imported for pure tests; executable demo is never imported. |

## Limits and out-of-scope cases

`strategy/R27/W1_D3_old_demo_gaps.md` is absent in this workspace. The supplied context's confirmed fixed history-seeding, installer import, hosting stylesheet and wall-user claims are used only to reject stale README assertions. The later handshake race remains distinct; this oracle does not declare replay globally fixed. U38 remains integrated PROVISIONAL; its historical integration does not prove runtime behavior.

Browser rendering, exact MCP call execution/order/three-task payload, screenshot content, real browser discovery/existence and process cleanup require runtime verification by the implementation owner. Static presence checks are necessary evidence only, not proof of those behaviors. No new MCP client API or transport helper contract is invented to simulate them.

Service-worker duplicate startup, empty-phase projection, batch metadata redaction, replay handshake/paging, retention checkpoints, custom-template metadata and required empty Memory sections belong to other units. Their BLOCKING/DEBT findings in the context are not U72 oracle failures. Firebase setup, Nano runtime, App Check, deployment and submission are outside this surface.

No network, subprocesses, real clocks, ports, browser startup, host identity or external environment are used by these tests. Only test files and the permitted throwing stub are written. Existing suites are left unchanged. The mandate is scoped to `.unit/SPEC.md`, the supplied context and cited workspace source files.

## Verification

The new oracle reports `Tests  67 failed | 3 passed (70)` [MEASURED]. All 55 pure-helper cases fail on `U72 stub` [MEASURED]; 12 static checks expose current defects and 3 static checker controls pass [MEASURED]. No import or collection error remains.

`npx tsc --noEmit -p .` reports existing diagnostics outside U72 and no diagnostic in the new files [MEASURED]. Existing unit suites, excluding U72, report `Tests  1 failed | 9077 passed | 1 skipped (9079)` [MEASURED]. The failure is `tests/unit/zz_r27probe/probe.test.ts` / `probe real MCP events`: its required `R27_EVENTS` environment input is absent. No existing file was edited and the pure stubs are imported only by U72 tests.

## XPLAT_DEMO compatibility coverage

Run `node --test tools/demo/xplat.test.mjs` alongside this suite. The new tests
live under `tools/demo/`, within the flight's write surface. They check
Windows PATH and program directory discovery, the Windows launcher,
the extension key and ID, demo wiring, direct-directory enumeration, and
cleanup of owned children. A stale stop token and an unrelated child serve
as negative controls. The pre-change run failed all seven added tests
[MEASURED]. The existing U72 assertions and pins still apply. The MCP process
uses the selected Python interpreter and the demo's `CW_HOME`.

The existing suite passed all 73 tests before and after the portability
change [MEASURED].
