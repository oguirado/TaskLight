# U161 fail-first oracle

Scope: `src/plan/reducer.ts`, `src/app/agent_store.ts` and
`hosting/src/main.ts`, observed through existing public interfaces. Only this test
directory is written. Catalogue resolution, folding, domain diagnostics, room
link, sync notices, workspace guidance and Archive rendering remain real.

## Acceptance mapping

The supplied `.unit/SPEC.md` contains an unnumbered MUST paragraph and numbered
negative controls, followed by diagnosis and a reproduction appendix. It ends at
the appendix; additional final Amendment sections and a separate numbered
acceptance list are **AUSENTE — no inventar**. M labels below are local traceability
labels for its MUST clauses; N labels preserve its numbered negative controls.
The embedded A-U113 amendment governs rejected-opening expectations here.

| Case | Required observable behavior | Test names (prefixes are part of the names) |
|---|---|---|
| M1 | Every admitted generation uses its own template identity and hash | `M1/M2 closed A followed by open B retains the archive, memory and current tasks without rejections`; `M1 templates with the same id but different valid hashes keep their own phases`; `M1/M2 A to B to A preserves both archives and plan-local task numbering` |
| M2 | Closed A survives in projection and rendered Wall Archive after B opens | `M2 a previously cached closed archive survives a live opening with a different template`; `M2/M3 a live template change preserves an already visible Archive and synced workspace`; `M2/M3/N1 initial cross-template replay certifies sync and renders the closed plan in Wall Archive` |
| M3 | Valid history certifies synced without Syncing workspace or excluded Lamport notices | Both `M2/M3` hosting tests; `M3/M4/N3 clean recovery across a template change repairs a genuine gap without losing the archive` |
| M4 | Replay, recovery and reload reach the same projection | `M4/M6 cold reversed replay and duplicate delivery equal the warm projection and identities`; `M4 reload reconstructs the same cross-template projection and Archive`; `M3/M4/N3 clean recovery across a template change repairs a genuine gap without losing the archive` |
| M5 | Rejected or replayed openings cannot replace the admitted template context | `M5 rejected B opening leaves A's admitted phase and template context active`; `M5/M6 equal-Lamport id ordering admits A before the rejected B even when arrivals are reversed`; `M5/N2 invalid phase opening after closure does not consume the next generation`; `M5/N2 invalid hash opening after closure does not consume the next generation`; `M5/M6 replaying an admitted old opening under a new event id cannot switch B back to A` |
| M6 | Existing single-template/no-resolver output, ordering and replay identities remain compatible | `M6 single-template active callers preserve full output and replay identities`; `M6 single-template closed callers preserve full output and replay identities`; `M6 callers without a template resolver retain legacy fold output`; replay and equal-Lamport tests above |
| M7 | Normalized contents invalidate fold caches, including historical templates | `M7 in-place historical template constraints invalidate a warm cache at unchanged declared hash`; `M7 replacement historical template constraints invalidate a warm cache at unchanged declared hash`; `M7 equal normalized template content with reordered keys and fresh objects preserves the projection` |
| N1 | Global latest-template replay must fail the positive oracle | `N1 the positive oracle rejects the global-latest-template replay mutant`, plus the real-store and real-hosting cross-template acceptance tests |
| N2 | Genuine hash/phase violations remain domain failures and sync faults | `N2 a supplied template still rejects a genuine opening hash mismatch`; `N2 a phase valid only in the historical template remains a current-generation domain failure`; `N2 genuine phase violations retain a fold fault after terminal replay and recovery`; `N2 genuine hash violations retain a fold fault after terminal replay and recovery`; invalid-opening cases above |
| N3 | Real relay room_gap retains its excluded-range notice | `N3 a real room_gap remains visible through partial and stale completion until a complete clean recovery`; cross-template recovery case above |

## Fixture, independence and hostile cases

`history.ts` uses `autonomous-software` then `blank`, with hashes calculated from
`templates/planning/autonomous-software.json` and `templates/planning/blank.json`
and resolved by `resolveStarterTemplate`. Their phase sets differ. The first task
is cancelled before closure; the second generation reuses T01. Explicit revisions
and operation identities make the bounded history valid independently of transport.
The test reference uses existing `applyOp` one event at a time with each admitted
generation's template. Static assertions additionally pin archive contents,
current title, template, phase, task identities and accumulated memory.

No new reducer API is assumed. Multi-template behavior is exercised through the
existing `AgentStoreOptions.templates` resolver and the production hosting entry
point. A wrapper captures the real store/link instances without replacing their
behavior. The starter-template resolver is not mocked in hosting tests. Cache tests
use controlled catalogue snapshots, modifying a historical memory constraint while
the active template and declared hashes remain unchanged. They assert observable
refolding rather than a cache layout or number of resolver calls.

Hostile coverage includes reversed arrivals, equal Lamports with distinct ids,
duplicate delivery, old opening replay identities, rejected openings, two hashes
for one template id, repeated template identities, nested in-place mutation,
object replacement, reordered keys, stale terminal request ids and partial replay.
Fake clocks and in-memory ports bound execution. AI/network adapters are inert;
fetch is forbidden. No subprocess, service, real timer, network or fixture seeding
process runs from these tests.

## Negative controls and stop rules

N1 constructs the diagnosed global-latest-template result with the existing
`foldPlan(history, B)` and demonstrates that the same positive assertions reject
it. Production acceptance tests stay red on that implementation. No product file
is patched to run the control. N2 would reject a workaround that removes template
validation or suppresses fold faults; N3 rejects suppressed or prematurely cleared
gap notices. A valid partial or stale completion cannot certify recovery.

Do not report readiness if imports fail, fixture admission fails, network is used,
the positive cross-template oracle is green on the unmodified implementation, or
new TypeScript diagnostics occur here. Existing baseline failures outside this
surface must be reported separately, never skipped or relabelled as U161 failures.

## Amendments and scope boundaries

A-U113 supersedes the old global-latest-opening interpretation for multi-plan
rooms. `tests/unit/u113/freshness.test.ts`, `tests/unit/u113/uncached-reference.ts`
and `tests/unit/u113/ORACLE.md` remain unmodified in this oracle lane; their author
amendments belong to the implementation lane. Existing `tests/unit/u60/` and
`tests/unit/u85/` files are also read-only; extensions live here.

The exact original journal and second plan_create arguments are AUSENTE. The
fixture uses the diagnosis's explicit autonomous-software/blank assumption and a
minimal deterministic history instead of requiring its incidental Lamport values.
The spec leaves a generation-aware reducer API open; no proposed API is tested.
A known catalogue id with a changed, unresolved hash is treated as the specified
genuine hash violation, and its rejected opening must not consume the next plan.
This does not prescribe behavior for an unknown template id or an unavailable
historical catalogue. Those outcomes are not specified here.

Out of scope: unrelated lifecycle/mailbox units, transport admission changes,
backend fencing, visual/browser/device receipts, public documentation revisions,
performance or timing thresholds, full-suite baseline repair and deployment.
The headless oracle makes no claim about live browser or accessibility receipts.

## Initial verification

Run with filesystem and results caches disabled and the in-memory config loader,
so runner artifacts do not write outside the assigned surface:

`npx vitest run tests/unit/u161 --no-cache --no-fsModuleCache --configLoader runner`

Observed fail-first result [MEASURED]:

```text
Test Files  2 failed (2)
     Tests  17 failed | 9 passed (26)
```

Failures are assertion failures for historical unknown_template/no_plan
rejections, missing archives, rejected-opening context, cache freshness and
persistent excluded-Lamport notices. There are no import failures or skipped
U161 cases. The preserved single-template/no-resolver behavior and negative
controls are green.

`npx tsc --noEmit -p .` reports the unchanged baseline of 16 diagnostics
[MEASURED], with no diagnostics in `tests/unit/u161` [MEASURED].

Adjacent suites run with the same cache/config-loader flags:
`npx vitest run tests/unit/u60 tests/unit/u113`.

```text
Test Files  9 passed (9)
     Tests  429 passed (429)
```

These adjacent results are [MEASURED]. Full-suite and live-browser validation are
AUSENTE; no broader acceptance is claimed.
