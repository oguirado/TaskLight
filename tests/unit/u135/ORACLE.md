# U135 fail-first oracle

Authority: `.unit/SPEC.md`, including binding Amendments B and C. Specification status remains `DRAFT, not ADMIT`; `R39` requires runtime hybrid inference and actual SDK source attribution. Unit SDK responses are simulated and provide no production inference evidence. Actual Nano availability is AUSENTE — no inventar.

Only `createNarratorController` in `src/app/narrator.ts` and `renderNarrator` in `src/views/narrator.ts` are production exports introduced here. Both function bodies throw `new Error("U135 stub")`. All other additions live in `tests/unit/u135/`.

## Acceptance map

Parameterized names below identify every member of the named test family.

| Spec case | Test file | Test names / coverage |
| --- | --- | --- |
| A1 | `controller.test.ts` | `A1 submits gemini-4-hydrogen, PREFER_ON_DEVICE and the same closed schema to both channels`; `A1 attributes %s solely from the SDK response`; `A1 rejects unknown SDK inferenceSource %s rather than guessing from binding`. Captures both factory parameters and `generateContent`, device success, SDK-reported cloud fallback, and opaque source constants. |
| A2 | `privacy.test.ts` | `A2 private demo resolves %s to ondevice before SDK invocation`; `A2 unavailable private device settles as rules without a cloud retry`; `A2 rejects rogue IN_CLOUD for $name, without transient generated publication`; `C.M3 cloudAllowed false forbids fallback for %s`; missing-policy and mismatched-room families. No external transport is supplied. |
| A3 | `controller.test.ts` | `A3 binding %s is rules-only and identical VM stays deterministic`; `A3 exposes readable %s provider failure`; `A3 empty membership says No agents deployed`. Includes both `null` and `rules`, `NEEDS_SETUP`, and `OFFLINE`. |
| A4 | `grounding.test.ts`, `budget.test.ts`, `view.test.ts` | `A4 hostile titles are omitted while retained IDs round-trip safely inside one fence`; `A4 retained task IDs cannot break fences or create markup`; `A4 rejects %s against current and transmitted VM`; `A4 reference-validation negative control rejects a fabricated success snapshot`; `M5 known current but omitted agent cannot be cited by the model`; `A4 retained malicious strings remain text and cannot create DOM markup`. Includes `mallory`/`T99`, valid-ID swaps, task ownership, upstream relationships and owners, retained fence escapes, and XSS. |
| A5 | `races.test.ts` | `A5 %s supersedes the request and ignores its late cloud completion`; `A5 head delta %i accepts=%s with no head-only retry`; `A5 disposal suppresses all late publication`; `A5 a superseded rejection remains observed`; `M1/M6 %s invalidates a previously admitted in-flight result`. Covers room, binding ID/generation, policy, lifecycle, current task/microtask, blockers, needs-you counts, and ignored cancellation. |
| A6 | `races.test.ts`, `fixtures.ts` | `A6 immutable same-class beat bursts cause no extra inference; expiry to unknown does`; `A6 failed lifecycle outranks fresh beats in rules and rejects fabricated working`; `M1 the supplied unknown class remains unknown despite a contradictory fresh timestamp`. Every input is deeply frozen; fixture teardown asserts no transport or storage writes and no payload logging. |
| A7 | Out of scope: integration / U125 | Non-mocked initialized Firebase SDK invocation, actual inference source, and production host wiring require integration evidence. No mock, import, configured label, or rules result is represented as an A7 pass. No failing or skipped placeholder disguises this gate. |

## MUST and amendment map

| Requirement | Oracle |
| --- | --- |
| M1 | Public function-derived contract types in `fixtures.ts`; nullish context stop rules in `privacy.test.ts`; synchronous prior-room replacement and in-flight admission revocation in `races.test.ts`; subscriber publication in `controller.test.ts`. Reads the supplied VM, without deriving activity from timestamps or folding events. |
| M2 | Real `createProviderRegistry` boundary is observed through a pass-through spy; `controller.test.ts` checks the `liaison` request, gemini-4-hydrogen runtime parameters, equivalent schemas, and isolation of unrelated registry selections. |
| M3 | `privacy.test.ts` checks `firebase-ondevice` resolution, `ONLY_ON_DEVICE`, runtime absence of `inCloudParams`, `killSwitchCloud`, unsupported bindings, no private retry, and rogue cloud-source rejection. |
| M4 | `budget.test.ts` checks final UTF-8 bytes before `generateContent`, complete retained identifiers, deterministic category/codepoint omissions, `omitted_agents`, visible omission counts, non-current task omission, and pre-call `BODY_TOO_LARGE`. `grounding.test.ts` checks retained data fences and omitted hostile titles/history/evidence. |
| M5 | `grounding.test.ts` checks the closed item vocabulary, malformed JSON, additional fields, item limit, every identity/ownership/relationship, terminal lifecycle contradictions, the needs-you OR predicate, nullable references, and prompt-only category coverage. `controller.test.ts` covers grounded categories and accepted empty items. |
| M6 | `races.test.ts` checks explicit Refresh, in-flight Refresh deduplication, superseding-update coalescing, semantic changes, head-only stop rules, stale completions/rejections, disposal and same-class beats. `privacy.test.ts` checks the injected-clock timeout and late completion. |
| M7 | SDK source constants are opaque test objects; strings matching display labels are rejected. `controller.test.ts`, `privacy.test.ts` and `view.test.ts` check attribution, errors, null rules/generating source and current rules while generating. |
| M8 | `view.test.ts` checks panel/source/reason labels, text-only rendering, keyboard focus/activation, Refresh and absence of mutation/composer/terminal affordances. Local rules content covers working, blocker task/owner, unknown liveness, failed lifecycle and operator needs. Visual layout remains an integration gate. |
| B.1, C.1 | C's `policyRoom` replaces B's `room`. Required context fields accept nullish values only as rules-only stop conditions; zero head and false cloud permission remain present values. |
| B.2, C.2 | C admits `firebase-hybrid`, `firebase-ondevice`, `null` and `rules`; other IDs are `BLOCKED`. Cloud-disabled requests are device-only, with no cloud parameter object. |
| B.3, C.3 | `budget.test.ts`: UTF-8, deterministic priority/codepoint ordering, complete records, fenced `omitted_agents`, visible `Omitted: N`, and a nonempty VM fitting no record stops before a provider call. |
| B.4 | Retained agent/task fence injection, multibyte overflow and unknown-source cases; assertion-sensitivity controls for privacy and byte gates. |
| C.4 | `blocked_on` is the only accepted blocker field. Category coverage is prompt-only. Empty accepted items on nonempty waiting/finished VMs yield meaningful deterministic text. Generating snapshots expose current-room rules and null source. |
| C.5 | Head deltas at the boundary are accepted; exceeding the boundary drops completion and does not retry for a head-only change. A semantic change still refreshes. |
| C.6 | Retained-ID and valid-ID-swap coverage is local. U112 types are present in this workspace. The CSS import and production mount are U136 gates; live A7 wiring/evidence belongs to integration/U125. |

## Hardening and scope

`narrator-context-budget` uses the required agents/tasks/microtasks fixture, Unicode, hostile retained fields, pre-invocation byte checks, deterministic omissions, and zero-write and payload-log traps. All clocks and SDK ports are in memory, network entry points are trapped, asynchronous draining is bounded, and no real timer is advanced. Repeated beats and stale results use ignored-abort deferred promises.

The negative controls apply the same acceptance assertions to forbidden cloud parameters, a fabricated successful narration and an oversized UTF-8 prompt that passes a character-count check. They demonstrate assertion sensitivity without editing product code. The behavioral rejection tests fail if the corresponding privacy, reference or budget gate is bypassed. No production mutant run is claimed while the controller remains a stub.

The mounted fresh-clone wall, rail navigation, real Refresh wiring, screenshot hashes, viewport/zoom clipping, dark theme, wrapping and reduced-motion appearance require the U136 capsule and are out of scope for these DOM unit tests. No capsule, benchmark, load measurement or production inference is run here. `styles/narrator.css` and its import are not edited by this oracle.

Read-only interfaces consulted: `src/app/swarm_vm.ts`, `src/providers/registry.ts`, `src/providers/types.ts`, `src/ai/types.ts`, `src/ai/firebase.ts`, `src/privacy/policy.ts`, `src/app/liaison.ts`, `src/app/model_services.ts`, `src/app/agent_drift.ts`, `src/app/activity.ts`, and `src/plan/types.ts`. The cited `specs/SPEC_U112.md` is AUSENTE in this workspace; the actual exported VM types determine fixture shape.

## Resolutions and verification limits

- C supersedes earlier conflicting rules: `policyRoom`, the expanded binding allowlist, prompt-only category coverage, C's trimming order and no head-only stale retry.
- The spec fixes function names rather than supporting type-export names. Tests derive input/controller/snapshot types from `createNarratorController`; they do not require extra product exports. The renderer returns a DOM root, following the neighboring renderer convention. Refresh's return value and subscription-return conventions are not asserted.
- Model mode and source assertions use factory-provided constants. The cloud-fallback fixture models an SDK fallback response, without implementing a separate application cloud retry.
- Existing `HybridParamsShape` requires `inCloudParams`, and `firebaseFactory` currently dereferences it unconditionally. C still requires that object's runtime absence for device-only calls. Injected-factory tests enforce C; compatibility with the initialized production adapter remains the integration/U125 gate, without editing the shared adapter.
- Human error wording, fixed-template punctuation, DOM classes/tags apart from the semantic button, and internal scheduling are deliberately open. A timeout may report `TIMEOUT` or the existing registry's `FIREBASE_FAILED` timeout result. Forbidden-source and fabricated-reference reasons remain exact.
- Existing suites and TypeScript already have failures outside this surface. Their unchanged baseline is reported separately from intentional U135 failures; it is not counted as U135 failure or declared green.

## Observed fail-first verification

| Check | Observed result |
| --- | --- |
| U135 Vitest | `Test Files  6 failed (6)`; `Tests  134 failed (134)` [MEASURED]. All failures are `U135 stub`; no passing U135 test [MEASURED]. |
| Existing unit suites, excluding U135 | `Test Files  21 failed | 337 passed (358)`; `Tests  165 failed | 10942 passed | 9 skipped (11116)` [MEASURED], identical before and after the additions. |
| `npx tsc --noEmit -p .` | Existing diagnostics: 16 [MEASURED]. Diagnostics in the added files: 0 [MEASURED]. The project command remains nonzero because of baseline errors. |

The oracle is limited to the supplied specification and the workspace interfaces listed above.
