# U147 fail-first oracle: model and narrator announcements

Scope: C6 §6; R39. Review admission: AUSENTE; these results are an oracle receipt, not ADMIT.

## Spec interpretation and scope

The complete `.unit/SPEC.md` contains no numbered acceptance list and no Amendment sections. The A1–A5 identifiers below are local traceability labels for its MUSTs, hostile case and negative control; they do not claim to quote an absent acceptance list. The source references below are relative to the repository root.

| Case | Binding requirement and source | Exact test names |
| --- | --- | --- |
| A1 | Replace the hosted no-op with a working announcer; a model outcome changes status text. `.unit/SPEC.md:12`, `.unit/SPEC.md:13`; `hosting/src/main.ts:827`, `hosting/src/main.ts:854`. | `A1 opening Models changes connected live status text`; `A1 a confirmed model selection changes connected live status text`; `A1 resetting the model selection announces the confirmed outcome`; `A1 an unselected provider becoming offline announces its actual outcome` |
| A2 | Narrator text announces on change, not only on insertion. `.unit/SPEC.md:12`; `src/views/narrator.ts:47`. | `A2 a real ON_DEVICE model outcome announces changed narration after mounting`; `A2 a real IN_CLOUD model outcome announces changed narration after mounting`; `A2 changed rules narration announces after the previous narration was mounted` |
| A3 | Keep the inference-source label truthful. `.unit/SPEC.md:12`. | `A3 displays the actual ON_DEVICE outcome rather than the requested preference`; `A3 displays the actual IN_CLOUD outcome rather than the requested preference`; `A3 rules replaces old generated attribution with Rules summary`; `A3 generating replaces old generated attribution with Rules summary`; `A3 unknown SDK source fails closed without reading or attributing generated text` |
| A4 | Hostile: a private room with the device unavailable makes no cloud call and says so. `.unit/SPEC.md:14`. A forbidden returned cloud source cannot authorize publication. | `A4 unavailable on-device model makes no cloud-capable request and explains the fallback`; `A4 a private request reporting a forbidden cloud source never publishes or labels generated narration` |
| A5 | Negative: restore the no-op. `.unit/SPEC.md:14`. A1 detects that regression; A2 detects insertion-only narration. These instrument controls prove the same assertion distinguishes connected changes from inert output. | All A1 and A2 tests above; `A5 accepts a text mutation in an already connected live region`; `A5 rejects insertion-only populated live regions`; `A5 rejects the no-op announcer with the same announcement gate` |

The mandate is limited to the supplied `.unit/SPEC.md` and the existing announcement, narration and privacy code in this workspace.

## Gates and negative contrasts

- **Hosted outcome gate:** run the real hosted composition, AgentWall and Models sheet. Record the sheet's actual announcer payload and require that payload in a connected live text mutation. No particular status element, class, identifier, announcer implementation or new export is required. The negative is the existing no-op: callbacks execute, yet no corresponding live text changes. The separate room-policy notice does not satisfy unrelated outcome payloads.
- **Narrator change gate:** mount an initial snapshot, then render subsequent snapshots through the existing `renderNarrator` export and ordinary DOM replacement. SDK outcomes come through the real `createNarratorController` and provider registry. Observe live-region text mutations, allowing persistent regions or post-mount population. The negative is returning a new region already populated while detached. Merely finding `role="status"` on inserted text does not pass.
- **Attribution gate:** the actual SDK source controls the label; the preference alone cannot establish it. Preserve `ON_DEVICE · Gemini Nano` and `IN_CLOUD · gemini-4-hydrogen · fallback`. Rules and generating states clear stale generated attribution. Unknown source fails closed. The negative is attributing rules or an unverified response to an inference source.
- **Privacy gate:** even with `cloudAllowed: true` and the hybrid binding, a private request must use `ONLY_ON_DEVICE`, omit cloud-capable parameters, make no retry after device failure, and never use a network port. Inject `ON_DEVICE_UNAVAILABLE`; require visible rules and an intelligible device/setup explanation. The phrase “says so” does not prescribe exact error prose. Inject a forbidden `IN_CLOUD` result and require no generated publication and no reading of its response body. A cloud-enabled factory request or a cloud retry fails this gate.
- **Verification validity gate:** all test modules must load and exercise existing product exports. Import errors, absent dependencies, unhandled exceptions, observer safety-bound trips or new TypeScript diagnostics invalidate the oracle; they never count as expected red behavior.

`live.ts` is a test observer, not a product stub. Its evidence is DOM mutation evidence only. Actual screen-reader utterances, CDP and AT-SPI interoperability receipts are AUSENTE.

## Determinism and isolation

All authored files stay in `tests/unit/u147/`. Existing `tests/unit/u118/hosting.test.ts`, `hosting/src/main.ts`, `src/views/narrator.ts`, `src/app/narrator.ts` and `src/app/swarm_vm.ts` remain unchanged. `deriveSwarmViewModel` is read-only. No production stubs or new API imports are introduced.

The hosted harness follows `tests/unit/u118/hosting.test.ts` and reuses its `fixtures.ts`. Narrator fixtures reuse the existing view model from `tests/unit/u136/fixtures.ts`. Firebase and extension I/O are faked at existing boundaries; the hosted sheet/announcer and narrator controller/registry remain real. Fetch and sockets throw. All timers are fake, promise draining is finite, observer batches have a safety bound, and controllers, subscriptions, observers and timers are disposed after each test. The fake observation window is 1,000 ms [TARGET]; the observer safety bound is 1,000 batches [TARGET], not a product performance requirement.

## Out of scope

| Unit or decision | Disposition |
| --- | --- |
| U146 / U148 and named non-article card roots | Out of scope; no opaque-article pruning or card edits. |
| U150 and agent-only lifecycle / heartbeat announcements | Out of scope; the changed rules snapshot tests narration text, not Wall lifecycle comparison. |
| U152 and navigation / Models opener consolidation | Out of scope; existing opener is used without changing navigation. |
| U153 / U155 and machine-operability or persona receipts | Out of scope; no browser, desktop or capsule execution. |
| Mailbox slice:2, slice:1 default; Failed/Finished slug guards and new run_id | Out of scope; no backend or mailbox changes. |

## Recorded verification

Commands are run from the isolated project root:

- `npx vitest run tests/unit/u147`
- `npx tsc --noEmit -p .`
- `npx vitest run tests/unit/u118 tests/unit/u135 tests/unit/u52`

Oracle result: 17 tests [MEASURED], with 7 assertion failures [MEASURED] and 10 passes [MEASURED]. Exact summary: `Tests  7 failed | 10 passed (17)` [MEASURED]. All expected failures are at the connected live-text announcement assertion; no import errors occur. Hosted outcomes account for 4 failures [MEASURED]; changed narrator outcomes account for 3 failures [MEASURED].

TypeScript baseline and post-oracle checks both report 16 existing diagnostics [MEASURED], with no diagnostic in `tests/unit/u147/` [MEASURED]. Relevant existing suites passed both before and after the additions: `Test Files  23 passed (23)` and `Tests  382 passed (382)` [MEASURED].
