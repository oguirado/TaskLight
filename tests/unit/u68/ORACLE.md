# U68 fail-first oracle

Scope: `.unit/SPEC.md`, status R27 W3, implementation surfaces
`extension/src/agent_relay.ts` and `src/app/agent_link.ts`.
The complete supplied spec ends at A5; it contains no Amendment sections.
Only `tests/unit/u68/` is authored. Imports use existing production modules
and existing fake clock/port helpers in `tests/unit/u37c/harness.ts`.
No network, real timers, source-text assertions, or implementation stubs.

## Acceptance mapping

| Case | File | Exact test name(s) |
| --- | --- | --- |
| A1 | `hello.test.ts` | `A1 late subscriber receives cached hello before live and replay events`; `A1 cached hello seeds advertised rooms on a connected late page`; `A1 every separately subscribing page receives the announcement` |
| A2 | `hello.test.ts` | `A2 newer valid hello replaces the cached announcement`; `A2 observed native outage clears cache, including after reconnection without a new hello` |
| A3 | `continuation.test.ts` | `A3 more true emits exactly one continuation from upto for that room only`; `A3 more false emits no continuation` |
| A4 | `continuation.test.ts` | `A4 always-more relay stops at exactly 64 continuations per cycle` |
| A5 | `continuation.test.ts` | `A5 malformed completion is ignored without throwing: %j`; `A5 malformed completion does not poison a subsequent valid response` |

## Additional MUST coverage

| Requirement | Exact test name(s) |
| --- | --- |
| M1 valid cache and ordering | A1/A2 above; `M1 invalid hello cannot replace the last valid announcement: %j`; `M1 unsubscribed ports receive no live events` |
| M2 pagination and per-room flight limit | `M2 continues successive pages until the terminal response`; `M2 duplicate completion cannot create a second in-flight continuation`; `M2 rooms progress independently while another room has a continuation in flight` |
| M3 room-local bound and new cycle | A4 above; `M3 exhaustion in one room does not exhaust another room`; `M3 a new hello starts a fresh bounded sync cycle` |
| M4 lifetime guards | `M4 stopped link ignores completion and leaves no timers`; `M4 superseded port cannot trigger a continuation on the new port` |

Hostile parameter rows cover invalid hello version, room list, room name and
privacy floor; invalid sync cursor string, fraction, negative, NaN, infinity,
null and missing value; invalid/missing boolean; unknown, invalid and null room;
and invalid protocol version. Each malformed completion independently asserts
no send and no throw. A separate positive recovery case prevents a reject-all
implementation from passing the complete oracle.

## Interpretation and observability

- A4 explicitly says continuations: permit exactly 64 additional requests
  [CITED: `.unit/SPEC.md`, A4], excluding the initial request. Drive 70 replies
  [TARGET] so an unbounded implementation fails without an infinite loop.
- A new hello already initiates a fresh sync in the existing link; it defines
  the tested new-cycle boundary. Budgets must be room-local.
- Echo actual request rids in replies; duplicate the same completed reply to
  test one outstanding continuation without prescribing internal data structures.
- A continuation requests only its completed room at `upto`; other rooms retain
  their independently outstanding response and budget.
- Hello validity follows the existing relay validator. No additional agent-name
  policy, room-list limit, subscription API, or disconnect API is invented.
- `AgentRelayNative` exposes `connected()` but no disconnect notification.
  The outage test makes disconnection observable by subscribing while down,
  then checks that reconnecting without a new announcement cannot resurrect
  the cache. An outage entirely between relay calls is not observable through
  this interface; immediate notification coverage is AUSENTE.
- `AgentLink` has no exposed reject counter or reject callback. Page malformed
  frame handling is checked through sends and exceptions. The relay's existing
  `stats().rejected` is checked for invalid hello frames. Numeric page reject
  accounting is AUSENTE through the current public interface; the M2 requirement
  remains binding, without inventing a new public method for the oracle.

## Measured baseline

Run: `npx vitest run tests/unit/u68`.

```text
 Test Files  2 failed (2)
      Tests  17 failed | 19 passed (36)
```

[MEASURED] All red cases are assertion failures caused by absent cached hello
replay or absent continuation requests. No failed imports or runtime setup errors.
The outage test currently fails at recovery hello replay; after cache replay is
implemented its earlier assertions check invalidation independently.

Regression command:
`npx vitest run tests/unit/u37b tests/unit/u37c tests/unit/u38 tests/unit/u52 tests/unit/u52a tests/unit/u52b tests/unit/u61 tests/unit/u64 tests/unit/u13`.

```text
 Test Files  66 passed (66)
      Tests  928 passed (928)
```

[MEASURED] Includes extension relay/native/service-worker coverage in the existing
U13 and U37c suites. No standalone extension test suite was added.

`npx tsc --noEmit -p .` exits unsuccessfully on unrelated existing project
errors [MEASURED]; no diagnostic names `tests/unit/u68/`,
`src/app/agent_link.ts`, or `extension/src/agent_relay.ts` [MEASURED].
Project-wide clean type checking is not claimed.

## Out of scope

Plan phase projection and phase labels; batch metadata redaction; projection
retention/checkpoints; custom template delivery and required-empty memory;
MCP planning demo coverage; privacy/provider and end-to-end desktop capsules;
Firebase setup, publishing and deployment. These belong to other units and are
not U68 oracle failures. The older roadmap's dependency-graph U68 label is not
this R27 W3 late-history specification.
