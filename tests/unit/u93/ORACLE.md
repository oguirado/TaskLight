# U93 fail-first oracle

Status: oracle frozen before implementation; STRATEGY_v10, pre-freeze Wave B,
lane B3. Integration is HOLD until M1 passes. The governing corpus is
`.unit/SPEC.md`, including its final Amendment B-U93 and frozen S1 seam.
The earlier privacy finding is superseded by U80 room-floor enforcement.

Only `tests/unit/u93/`, `src/app/liaison.ts` and
`src/agentsui/liaison_panel.ts` are authored here. Both new runtime exports
throw `new Error("U93 stub")`; neither implements product behavior.

## Public test seam and ambiguity decisions

The spec fixes `mountLiaisonPanel(container, deps)`, `LiaisonResult`,
`DraftStorage`, the controller input and `setDraft(text: string): void` /
`getDraft(): string`. It does not name the controller factory, its methods,
panel dependency fields, storage method, or return handle. The oracle uses
`createLiaisonController`, the typed interfaces in `src/app/liaison.ts`,
`refresh` / `destroy` on the panel, and a structural S1 composer containing
only those draft methods. These names form a test adapter ABI, not a demand
for any internal architecture. A later implementation may adapt its public
API without changing the assertions. No concrete thread container, prompt
format, JSON key ordering, executor implementation or timeout is prescribed.

`DraftStorage.setItem` accepts the native Storage shape and synchronous or
asynchronous completion. The amended default key is
`tasklight.liaison.v1:${room}:${task_id}`; its JSON value must contain exactly
the pending `{human:{id,text},cursor}`. A task override takes precedence over
its room default; removing it restores that default. A missing binding uses
the factory default, while `providerId:null` intentionally disables inference.

The final closed-object amendment defines operation-shaped rejection through
extra keys, including `op`, `ruling`, and model-authored `attribution`. Text
that merely contains hostile instructions remains passive text. Boundaries
use ASCII to avoid inventing Unicode counting semantics. Input rules can be
embedded literally or losslessly encoded in a structured prompt. References
must name actual input-history IDs; no additional uniqueness rule is imposed.

`source:"rules"` is the oracle adapter's deterministic-fallback marker; the
visible chip is exactly `Rules`. `admission` and `reason` carry trusted policy
and fallback explanations for presentation; their wording is unconstrained.
An unreported model is displayed as `AUSENTE`, without inferring its identity.
Buttons use native keyboard semantics with visible accessible names. Reduced
motion is checked with the real `styles/model_selector.css`, applying its
reduced-motion rules explicitly because the test DOM does not evaluate media
preferences. This is a DOM/CSS contract, not pixel-level browser verification.

## Numbered acceptance mapping

Parameterized names below expand to their concrete cases in the test runner.

| Acceptance | File and test names | Gate and rejecting contrast |
| --- | --- | --- |
| A1 | `providers.test.ts`: `A1 independent liaison group selects remote-test and leaves drift on local-test`; `A1 unset liaison group retains firebase-hybrid factory default`; `A1/M2 Firebase liaison uses schema-constrained text rather than Hybrid.run`; `A1/M2 extending liaison leaves existing drift text behavior compatible`. `services.test.ts`: `A1/M2 public registry preserves independent liaison and drift selections`; `A1/M2 composed Firebase text passes the same closed-output schema to both model channels`. `controller.test.ts`: `A1/M4 preserves rules verbatim and forwards room, schema and only the latest history window`. | Independent selections, factory default, real fake-port inference, schema passed to both Firebase channels. Removing liaison recognition must select/block incorrectly and fail; forwarding an unknown TaskId to Hybrid.run must fail. |
| A2 | `providers.test.ts`: `A2 $name: pure denial, resolved chain and actual call agree`; feature-gate table; `A2 private on-device failure ends in Rules without a cloud or remote attempt`; `A2 kill switch is rechecked before Firebase fallback`. `controller.test.ts`: `A2 missing or unknown host floor %s blocks before inference`. | Every privacy row has denial and admitted-provider controls. Denials include `REMOTE_FOR_PRIVATE`, `CLOUD_PROVIDER_FOR_PRIVATE`, `LOCAL_PRIVATE_NOT_ALLOWED`, `LOCAL_NOT_LOOPBACK`, `LOCAL_ENDPOINT_DISABLED`, `REMOTE_ENDPOINT_DISABLED`, `REMOTE_FOR_SHARED`, and registry `blocked:"policy"`. Bypassing privacy must cause a forbidden call and fail. |
| A3 | `providers.test.ts`: `A3 unknown liaiosn remains a screenshot-equivalent task`, A1 independent selection, A2 matrix and admitted-provider inference assertions. | The typo retains `REMOTE_FOR_SCREENSHOT`; removing liaison from the allowlist fails A1, bypassing its private gate fails A2, disabling all inference fails positive controls. The typo regression is intentionally green before U93 implementation. |
| A4 | `providers.test.ts`: `A4 remote failure attributes the Firebase IN_CLOUD answer to its actual answering provider`. `controller.test.ts`: all-unavailable Rules and missing-reported-model tests. `panel.test.ts`: trusted-source table, remote-to-Firebase, absent-actual-model and model-authored-provider-claims tests. | Compare trusted answerer, chip, model, privacy admission and fallback reason. Substituting selected-provider metadata, guessing a model, changing original fallback text, or trusting model-authored source fails. |
| A5 | `controller.test.ts`: `A5 persistence precedes inference and stores only the pending human input and cursor`, synchronous/asynchronous storage-failure table, pending asynchronous write, localStorage isolation, provider-swap retention, null binding. `providers.test.ts`: room default/task override and null-vs-undefined tests. `panel.test.ts`: PERSIST_FAILED and unavailable-state direct-access tests. | Persistence must finish before inference. Storage rejection is `PERSIST_FAILED` with no inference/post. Swaps preserve draft/history/cursor. Empty liaison still permits explicit direct Send and Plan/Memory. |
| A6 | `controller.test.ts`: valid-kind table; `A6 rejects %s with SCHEMA_REJECT and a reason`; maximum and minimum boundary tests; `A6 provider %s is a stop result, never a Rules draft`. `providers.test.ts`: hostile-human private-floor test. `panel.test.ts`: hostile supplied/generated/metadata rendering, SCHEMA_REJECT display and no-mutation tests. | Malformed JSON, arrays/null/scalars, missing/extra keys, invalid kind/text/refs, forged IDs, ownership/completion/ruling payloads and authored attribution reject. Valid hostile text stays literal; no element/handler is created. Loosening the validator or interpreting human policy directives must fail. |
| A7 | `controller.test.ts`: `A7 exposes starting then ready with textual reasons`; `A7 pause is local suspension and prevents inference until resumed`; `A7 destroy aborts inference and never converts late failure to Rules`; `A7 latest request wins when an older response arrives after the newer one`; `A7 Amendment TOCTOU: %s change aborts before late output or fallback`. `providers.test.ts`: real-chain context/generation/destroy table. `panel.test.ts`: Draft/Summary/Clarify, Use draft, explicit Send/Escalate, unavailable escalation, fallback/swap/timer/teardown, changed-selection, inert-handle, state table, keyboard, focus restoration, reduced motion and integrated pagehide tests. | Non-send actions never post. Only Use draft changes S1 draft. Human Send delegates once to selected-task delivery; explicit Escalate invokes only the host callback. Aborted or superseded requests cannot fall back or publish stale output/attribution. Removing abort/generation checks must fail. |
| A8 | `panel.test.ts`: `A8 injected selected context resolves exactly its S1 handle and keeps all conversations distinct`; `A8 absent handle visibly reports HOLD and cannot use a draft`. M9 verification below. | Injected binding must use the selected room/task and its handle. Missing live host bindings keep integration HOLD, never authorize a Surface escape. |

## Upstream boundaries and HOLD

`hosting/src/main.ts:429` mounts `startAgentWall`. Its returned interface in
`src/app/agent_wall.ts` exposes `refresh` and `destroy`, with no
`getChatHandle`. `src/agentsui/types.ts` has not yet acquired S1 draft methods.
Room-floor feeds exist at `hosting/src/main.ts:403` and `:409`, but a selected
task/context/handle mount binding is absent. Accordingly the actual host M1
mount is HOLD, not a fabricated passing integration test and not a U93
failure. The injected positive/negative mount tests cover the U93 side only.

U85 context plumbing, U86's actual destroyed-handle implementation, U92
delivery receipts/ownership, U99 generation migration, and U104 typed
`room_send`, executor acknowledgements/pause/interrupt are out of scope.
The inert-handle test supplies an S1-conforming fake and checks consumption;
it does not certify U86. Existing delivery receipts are left in the existing
executor DOM. No Read claim is introduced. Tests never mount the whole host,
scrape its composer, add another executor composer or exercise a real service.

## Verification and baseline

Run `npx vitest run tests/unit/u93` and `npx tsc --noEmit -p .` from the
repository root. Fixtures use fake clocks, finite microtask flushing, fake
provider/extension ports, deferred replies and a throwing fetch sentinel;
no network or real application timers are used. The oracle's new exports
must fail at `Error: U93 stub`, not import/collection/type errors. Tests for
existing policy behavior may already pass. No U93 case is skipped to hide
a failure.

The spec cites 9360 baseline tests, 16 TypeScript diagnostics and 22 existing
tool contracts [CITED]. The isolated workspace's pre-edit unit run instead
has 9399 passed, 80 failed and 2 skipped [MEASURED], with failures confined
to pre-existing U86, U87 and U88 oracles. These are upstream/out-of-scope
failures, not attributed to U93. Its TypeScript baseline is 16 diagnostics
[MEASURED]. Re-running existing suites must preserve their outcomes, and
the TypeScript check must add no diagnostic in authored files. A content
digest excluding the allowed write set audits other project files. Existing
suites regenerate ignored `hosting/dist/` assets, so a whole-tree digest is
not a source-only seal. Authored edits and source modification times are
also checked. Secret scans must stay clean. Python/tool-contract gates
are checked separately; pre-existing failures are reported without editing
their implementation or expanding this unit's authority.

Observed verification: the requested Vitest command has 131 failures at
`Error: U93 stub` and one passing existing-policy regression, for 132 tests
[MEASURED]. The TypeScript command retains 16 baseline diagnostics, with no
diagnostic in authored files [MEASURED]. Existing unit outcomes remain
9399 passed, 80 failed and 2 skipped [MEASURED]. Both secret-scan commands
pass with no findings [MEASURED].

Python package-level verification is not wholly green. The `plan` suite has
12 pre-existing U88 failures and `setup` has one existing readiness failure
[MEASURED]. `room` and `wall` exceeded the bounded verification budget;
`plan_demo` collected no tests, so it is not certified. `ctx`, `install`,
`models`, `viewpoint`, `wall_host_room`, and `wall_room` pass. These unresolved
baseline/tool-contract gates remain M9 HOLD; no implementation outside the
allowed authoring surface is changed to force a pass. Ignored build assets
were regenerated by existing suites; the source edit set stays bounded.

This oracle is scoped exclusively to the provided U93 corpus and the cited
workspace seams.
