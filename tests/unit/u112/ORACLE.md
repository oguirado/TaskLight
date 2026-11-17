# U112 fail-first oracle

Authority: `.unit/SPEC.md`, read in full including binding Amendment B. Status remains
`STRATEGY_v11`, `W1/D8`, size `M`, proposed, not `ADMIT` [CITED]. The specification
identifies source baseline `I0` as `4528625acafa5e435c4b34b6d1fd6adfacee6dd3` [CITED].
The isolated workspace has no Git metadata; this oracle does not independently
certify that commit identity.

## Acceptance mapping

Names below are literal test names or parameterized name templates. Paths are
relative to the repository root; all named test files are in `tests/unit/u112/`.

| Case | Test file and names | Gate |
| --- | --- | --- |
| A1 | `vm.test.ts`: `A1 fixed fixture selects T01, retains T04, reports 1/2, and exposes its upstream owner`; `M1 uses the supplied projection without replaying contradictory history`; `M3 membership never comes from authors, recipients, claims, or beats`; `M3 deduplicates assignees and registration keys with UTF-16 agent and task ordering`; `M3 selection: $name`; `M3 selects the first active microtask by UTF-16 ID, not array position`; `M3 no active child means null micro selection and selected-task counts only`; `M3 preserves rollup values rather than reconstructing progress from visible agents`. `view.test.ts`: `A1 renders exactly the fixed-fixture cards with task, microtask, progress, state and cross-task blocker`. | Exact membership, selection, progress, blocker ownership, immutable inputs and repeatability; no event-derived phantom agents. |
| A2 | `freshness.test.ts`: `A2 beat age %i is Working through the inclusive boundary`; `A2 stale structurally valid beat is retained as evidence but cannot show Working`; `A2 rejects $name and keeps absent last-beat evidence null`; `A2 disconnected active work is unknown with no refresh but retains valid beat evidence`; `A2 rederivation at refresh_at_ms expires freshness without new events or timers`; `M5 last beat is latest valid selected-task evidence, including non-active microtasks`; `M5 another owned task's beat cannot lend liveness to the selected task`; `M5 selects earliest active-beat expiry across Working agents only`; `Amendment B disconnect removes all scheduled refreshes`. `activity_seam.test.ts`: `M5 delegates activity with undefined micro, injected clock and connected=%s`; `Amendment B removes $name live before calling deriveActivity without mutating input`; `M5 unselected registered agent is idle without fabricating a task for deriveActivity`. | Inclusive freshness, structural validation, owner scope, separate last-beat evidence, pre-sanitization, the required activity seam, and connected Working-only refreshes. |
| A3 | `vm.test.ts`: `A3 %s upstream remains an unsatisfied dependency`; `A3 %s upstream satisfies dependency without inventing completion`; `A3 distinguishes missing and unassigned upstreams across all unfinished owned tasks`; `Amendment B excludes %s owned tasks from waiting_on`; `M5 $name`. `view.test.ts`: `A3 shows distinct missing and unassigned upstreams with downstream identifiers`; `A3 renders explicit blocked_reason verbatim on any owned task`. | All unfinished owned tasks contribute unsatisfied dependencies; only done/cancelled upstreams satisfy them; cancelled/done/blocked/waiting activity precedence remains authoritative. |
| A4 | `questions.test.ts`: `A4 distinct addressed question IDs count once on duplicate delivery`; `A4 an addressee's ack alone does not clear a question`; `A4 addressee answer referencing its ack clears the question`; `A4 direct addressee answer clears the question`; `A4 wrong-author answer through an ack leaves the question unanswered`; `A4 foreign-room answer through an ack leaves the question unanswered`; `A4 a chain crossing a foreign-room intermediary cannot clear the question`; `A4 dangling references leave the question unanswered`; `Amendment B %s is never a clearing act`; `A4 cyclic references terminate without clearing an unrelated question`; `A4 self-reference terminates without clearing a question`; `A4 finite indirect reference chain is followed without a shallow arbitrary cutoff`; `A4 history arrival order does not change a resolvable chain`; remaining `M7` and `Amendment B` tests in that file. | Distinct addressed question IDs, same-room reference chains and addressee-authored answers only; no phantom membership, cross-room shadowing, negative counts or prototype-key confusion. |
| A5 | `vm.test.ts`: `A5 empty inputs yield empty agents, null progress and no refresh`; `A5 registration-only rows have no work regardless of projection %#`; `A5 lifecycle %s survives independently of task activity`; `M4 preserves each optional registration field without synthesizing the others %#`; `A5 W1 task owners have no invented registration`; `Amendment B treats __proto__ and constructor as own identifiers without prototype pollution`. `view.test.ts`: all tests in `A5 renderer registration and empty state`. | Null evidence remains null; registration-only cards remain visible without work; optional fields survive independently; empty registration means the exact unregistered guidance. |
| A6 | `view.test.ts`: `A6 hostile %s stays literal without executable elements or handlers`; `Amendment B __proto__ identity and blocked reason remain literal text`; `A6 has no message input, composer, chat, reply or terminal action`. `purity.test.ts`: `M1 derives frozen inputs without transport, storage, providers, history folding or timers`; `A6 render and click/Enter interactions never use transport, storage, providers or timers`; `M1 disconnection neither cancels projected tasks nor writes server state`. | Hostile content remains text; DOM and interaction paths stay read-only. Boundary spies throw on transport, provider, storage or history-replay calls. |
| A7 | `freshness.test.ts`: `A7 the same A2 assertions reject an any-beat-means-Working mutant`. Pre-stub missing-module run, stub failure audit, regression run and TypeScript comparison below. | Missing modules are a failure, every new runtime case fails with the requested stub error, existing regressions stay green, and no new diagnostic is introduced. |

## Additional MUST coverage

| Requirement | Test file and names |
| --- | --- |
| M2 exact exported readonly contract | `contract.test.ts`: `M2 freezes exact readonly exports and derivation/render signatures`. Compile-time assertions check `SwarmRegistration`, `SwarmAgentVM`, `SwarmViewModel`, `deriveSwarmViewModel` and `renderSwarmView`. |
| M7 count copy | `view.test.ts`: `M7 renders loaded-history count with its exact scope label and no question content`; `M7 renders zero unanswered questions truthfully`. |
| M8 vocabulary, evidence and supplied document | `view.test.ts`: `M8 maps %s to the existing literal label %s`; `M8 renders observed beat age rather than an absence placeholder`; `M8 renders missing evidence as No beat observed`; `M8 uses the supplied Document rather than the ambient document`. |

## Binding interpretations

| Issue | Resolution |
| --- | --- |
| Amendment B uses shorthand `live.by`, `ts` and `lamport`, while cited source uses microtask liveness. | Use the actual `PlanMicrotask.live` shape in `src/plan/types.ts`: `agent`, `run_id`, `beat_ts`, `beat_lamport`. There is no invented `PlanTask.live` field. Require a positive safe integer Lamport per Amendment B. |
| Valid run ID versus merely nonempty text. | Use the existing `deriveActivity` contract in `src/app/activity.ts`: ASCII letters, digits, underscore or hyphen, nonempty and bounded by its existing validator. Spaces, trailing newline, non-string values and oversized IDs do not establish activity. |
| Stale evidence versus sanitized activity. | Strip stale, future, foreign-owner or structurally invalid live records from the task passed to `deriveActivity`. A stale structurally valid, non-future, owner-matching record still supplies last-beat evidence on the selected task. Future and invalid records do not. |
| More than one fresh active microtask. | `refresh_at_ms` is the earliest fresh active beat expiry among selected tasks of Working agents while connected, including the inclusive-boundary offset; later beats may remain fresh after that rederivation. Other owned tasks, done children, blocked cards and idle cards do not schedule it. |
| Question-chain details and U110 M4. | The text of U110 M4 is AUSENTE in the supplied corpus. Apply U112's explicit rule: only an answer by the addressed agent can clear a question through same-room references; ack is an intermediate link, never a clearing act. No extra timestamp, delivery-order or reference-depth policy is invented. |
| Registration copy versus lifecycle authority. | Preserve optional fields independently. Empty strings/undefined across all registration fields mean unregistered. A lifecycle value remains visible independently of activity. No lifecycle precedence is inferred. |
| Open presentation choices. | No prescribed CSS class, element nesting, beat-age unit or capitalization of lifecycle labels. Tests use visible text and observable DOM behavior. The renderer receives independent frozen view-model fixtures, without relying on derivation internals. |

## Scope boundaries and unverified gates

| Owner/surface | Disposition |
| --- | --- |
| U118 mounting, navigation, Tab/Enter navigation and automatic rederivation scheduling | Out of scope. The unit oracle verifies the returned deadline and direct rederivation, not rail wiring or a running wall. |
| U128 live question delivery, `ext/events.py` | Out of scope. This source is AUSENTE in the workspace. Counts are tested only against supplied loaded `RoomEvent` history. |
| U132 lifecycle storage; U135 narration; U136 grouping, lifecycle precedence and task-detail activation | Out of scope; no storage, narration, grouping or activation implementation is introduced. |
| U115 `swarm-vm-derive` hardening benchmark | Out of scope. Numeric latency budget: AUSENTE — no inventar. No benchmark latency, fixture receipt or timing pass is claimed. |
| `styles/swarm.css`, themes, wrapping, reduced motion and capsule viewport/zoom evidence | U112 production styling obligation remains unverified by these DOM unit tests. Layout and visual behavior require the capsule after U118 mounting. No shared stylesheet is modified, and no DOM result is promoted to a visual pass. |
| Fresh-clone integration and ADMIT | Unverified. Historical R30 F15/F16 references are not fresh evidence. No ADMIT claim. |

## Verification evidence

Before adding the throwing stubs, the initial oracle failed to resolve both
`src/app/swarm_vm.ts` and `src/views/swarm.ts` [MEASURED]. Its exact summary was:

```text
 Test Files  6 failed (6)
      Tests  no tests
```

This is a recorded missing-module failure, not a pass. The final oracle adds
explicit activity-seam coverage and contains 145 runtime cases [MEASURED].
Against the permitted throwing stubs, every case fails with `U112 stub`, with
no unrelated failure, pass or skip [MEASURED]:

```text
 Test Files  7 failed (7)
      Tests  145 failed (145)
```

The controlled negative mutation corrupts liveness to Working for any present
beat, including stale/future/foreign-owner records, and applies the same A2
assertions. It does not edit product source. With the stubs it stops at
`U112 stub`; empirical mutation rejection awaits the real implementation.

Existing unit suites passed before and after these additions [MEASURED]:

```text
 Test Files  332 passed (332)
      Tests  10297 passed | 9 skipped (10306)
```

`npx tsc --noEmit -p .` reports the same pre-existing 16 diagnostics before and
after, with byte-identical diagnostic output [MEASURED]. No diagnostic names
`tests/unit/u112/`, `src/app/swarm_vm.ts` or `src/views/swarm.ts` [MEASURED].
The global typecheck is not described as green.

## Reproduction and stop rules

Run from the repository root:

```sh
npx vitest run tests/unit/u112 --no-cache --maxWorkers=2
npx vitest run --project unit --exclude 'tests/unit/u112/**' --no-cache --maxWorkers=2
npx tsc --noEmit -p .
```

`--no-cache` avoids repository cache artifacts. Tests inject the clock and use
Vitest fake timers with fixed finite fixtures; the unit boundary does not use
network services, live ports, providers or real-time waits. Interaction guards
reject forbidden I/O, history folding and newly scheduled timers. Stub runs
must fail through `U112 stub`, not missing exports, import resolution, fixture
construction, type errors or failing assertions. A correctness failure blocks
acceptance. Missing evidence never becomes a pass, and unrelated pre-existing
type errors do not authorize editing outside the permitted surface.

This oracle is limited to the supplied `.unit/SPEC.md` and cited code inspected
inside the isolated workspace.
