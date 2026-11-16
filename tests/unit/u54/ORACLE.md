# U54 oracle (fail-first)

Targets: `src/reconcile/{types,reconciler}.ts`, `src/sync/{types,engine}.ts`, `src/router/route.ts`, `src/agents/{types,index}.ts`, `src/agentsui/types.ts`, `src/ledger/{rows,types}.ts`. Spec: `specs/SPEC_U54.md` (U46 names: `LOCAL_SERVER`, `REMOTE_PROVIDER`). New source values are plain strings cast at the call site, so the suite compiles (`tsc` clean for `tests/unit/u54`) and runs before U46/U54 land.
Files: `harness.ts` (u10 fakes + `ExtLedger` with `incExternal`, `OldLedger` without), `reconciler.test.ts` (O1 O2 O3 O8), `sync.test.ts` (O4, uses u14 harness), `router.test.ts` (O5, u39 `ev`), `drift.test.ts` (O6, u34 `contract`), `rows.test.ts` (O7), `static.test.ts` (frozen type literals, O8 enum equality).

Result on current code: 153 tests, 96 red, 57 green (regressions). Per file red/green: reconciler 23/36, sync 19/7, router 11/9, drift 18/2, rows 20/3, static 5/0.
Green by design: 24 O8 matrix cases (3 tiers x 4 modes x ON_DEVICE/IN_CLOUD), unknown-source-is-malformed, old-origin digests, LOCAL_RULES, old router tiers, device/cloud drift, IN_CLOUD under device floor, null source.

## Judgement calls (confirm or amend)
- J1 Negative O2 cases (blocked => store unchanged) pass today only because external values are rejected as malformed. Each therefore first runs a control (same source, standard tier, permitted mode) that must publish; the control is red today. Same pattern for O5 unknown source, O6 non-`true` flags, O3 throwing incExternal.
- J2 Mode/task setup: private uses `PREFER_IN_CLOUD` request (forced to ONLY_ON_DEVICE by the reconciler); screenshot uses `mode_screenshot=PREFER_IN_CLOUD`; ONLY_ON_DEVICE uses `mode_status`. `IN_CLOUD` on screenshot / ONLY_ON_DEVICE standard stays published (spec blocks only external there).
- J3 Tier-promotion hooks: inside `incExternal` (PREFER_IN_CLOUD) and inside `inc('fallbacks')` (PREFER_ON_DEVICE, external source). The external count made before the promotion is not asserted.
- J4 Throwing `incExternal` drops the result like `ledgerOrBlock` (no CAS). Spec says "same throw-drops semantics"; pinned.
- J5 `PREFER_ON_DEVICE` + external increments `fallbacks` (also for a port without incExternal).
- J6 Sync: bad origin is `DIGEST_BAD_ORIGIN` even with ghost/private project ids (check precedes meta reads); `LOCAL_RULES` keeps `DIGEST_LOCAL_ORIGIN`; REMOTE_PROVIDER + private project keeps `DIGEST_HAS_PRIVATE`; shared via revVector only, needs_you only, or mixed with standard all give `DIGEST_REMOTE_SHARED`. Origin `null`, `5`, `{}`, `""`, `'LOCAL_SERVER '` also bad.
- J7 Router: `privacy_cloud` abstain keeps `stage: 'nano'` (as for IN_CLOUD today); a bad source with an off-enum label gives `nano_unavailable` (source checked first, as at `:175`).
- J8 Drift: only `allowExternal === true` unlocks (not truthy); unknown/non-string sources fall back with or without the flag; the fallback equals the rules verdict for a bad port answer.
- J9 Rows: `inference_source` strings `on_device`, `in_cloud`, `local_server`, `OTHER` under a device floor give `NON_DEVICE_UNDER_DEVICE_FLOOR` ("any other value"). External without any device floor is not a violation.
- J10 Static tests read source text (cwd = repo) for type literals; the reconcile==`INFERENCE_SOURCE` equality needs U46's enums as well (red until both land).

## Not pinned (spec ambiguity)
- Row with `inference_source` absent/`undefined` under a device floor (spec: "null/ON_DEVICE skip; any other value" -> literal reading flags it).
- Digest naming both a private and a shared project with REMOTE_PROVIDER (HAS_PRIVATE vs REMOTE_SHARED order).
- Whether a blocked external job (sourceBlocked) must leave retry intent vs requeue; both unobservable here.
- Mutant checks to run against the implementation: drop the `external && screenshot` clause, drop `REMOTE_PROVIDER && shared`, count external as `in_cloud`, accept truthy `allowExternal`; each must turn a test red.

## A-U54r1 (repair loop 1, Sol HOLD)
File `repair1.test.ts`: 23 tests, 13 red / 10 green (controls) on the pre-repair code.
- Reconciler (6: 3 red): a newer non-private observation updates `projectTier` (private stays sticky). standard -> shared (newer rev, other task, or reentrant inside `incExternal`) then REMOTE_PROVIDER -> not published, no counter. Controls: standard -> standard REMOTE_PROVIDER and standard -> shared LOCAL_SERVER publish; private -> standard keeps IN_CLOUD blocked.
- Sync (17: 10 red): queued digests re-check current meta before and inside the write txn (after its reads), same rules as `putDigest`. Promotion to private drops ALL origins, old ones included (a private project never gets a digest brief); meta removed -> dropped; REMOTE_PROVIDER + promotion to shared -> dropped. Controls: unchanged standard writes all 4 origins; ON_DEVICE / IN_CLOUD / LOCAL_SERVER + shared still written. No existing old-source test expectation changed (checked u14: no digest test mutates tiers after enqueue).
- Drop reporting: the engine has no per-job refusal channel after enqueue; an invalidated digest leaves the outbox like `wrote:false` (no counter, `notify()`), with the internal code DIGEST_HAS_PRIVATE / DIGEST_REMOTE_SHARED.

## A-U54r2 (repair loop 2, Sol HOLD)
File `repair2.test.ts`: 8 tests, 3 red / 5 green on the loop-1 code; 8/8 green after the fix.
- Red: status rev 1 standard in flight, summary rev 3 shared, status rev 2 standard, REMOTE_PROVIDER resolves -> no successful CAS, no `remote_provider` counter (also with rev 2 re-observed); equal revision standard rev 3 after shared rev 3 does not loosen.
- Controls (green): standard rev 4 after shared rev 3 replaces shared -> REMOTE_PROVIDER publishes and counts; equal-rev standard -> shared tightens (blocks REMOTE_PROVIDER); LOCAL_SERVER still publishes under shared; private at rev 2 below governing rev 3 still promotes (IN_CLOUD blocked); unregister/register clears the governing revision.
- Equal-revision rule (judgement): at the governing project revision a non-private observation may tighten (standard -> shared) but never loosen; order-independent and fail-safe. Revisions are per project (observe does not scope revisions by incarnation); state cleared on unregister and dispose with `projectTier`.
