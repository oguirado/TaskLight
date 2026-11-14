# ORACLE U22 (hosted wall: boot, App Check, auth, connector, CSP, embed)

Run: `npx vitest run tests/unit/u22`. Fakes only (DI ports, fake clock, fake chrome.runtime); no network. Expected state now: stubs throw / files missing, so tests FAIL. `tsc` is clean for src/app and tests/unit/u22.

## Files and what they pin
| File | Pins |
|---|---|
| boot.test.ts | O1-O8: order, prod/dev provider, guards (B2-B4), limited-use forwarding (B6), auth (B7), device model once per page (B8), failure states, token never in states/console |
| config.test.ts | placeholder guard, `isLocalDevOrigin`, `readHostEnv`, real `setDebugFlag` writes `self.FIREBASE_APPCHECK_DEBUG_TOKEN` at runtime, `renderHostState` banner (`role="alert"` names code) |
| connector.test.ts | O9-O12 + B9-B14 (postMessage T2 path) |
| wall_port.test.ts | T1 port: hello/nonce, resync, bounded queue, reconnect, snapshot resend, ping cadence (A6/A7), NOT_LISTED, retries |
| availability.test.ts | B25 probe |
| static.test.ts | UUID/debug-token scans of src/app + hosting + dist, firebase_ports sole importer, CSP meta + `hosting/headers.json`, iframe `allow` contract, README, O13 hostile-env prod build |

## Required deliverables (writer)
`src/app/`: `firebase-config.public.ts` (guards implemented; placeholders already provided), `appcheck.ts`, `boot.ts`, `connector.ts`, `wall_port.ts`, `availability.ts`, `firebase_ports.ts`, `ui.ts`, `index.ts`. `hosting/`: `index.html` (CSP meta, module script, embed comment), `vite.config.ts` (root hosting, outDir dist), `headers.json`, `README_HOSTING.md`, entry module(s).

## ORACLE decisions beyond the spec (flag if the spec owner disagrees)
- Q1 AUTH_FAILED: spec says "local-only, AI continues" but `HostState` has no such variant. Oracle adds `{kind:"degraded", reason:"AUTH_FAILED", appCheck, deviceModel}`; `create` is still called once.
- Q2 `CONFIG_INVALID`: prod + placeholder/empty/missing required key (apiKey, authDomain, projectId, appId) or placeholder reCAPTCHA key -> blocked before ANY port call. Dev tolerates placeholders.
- Q3 Extra exports: `boot.ts: onGoogleSignIn(trusted)`, `resetBootStateForTests()`; `index.ts: readHostEnv`; `ui.ts: renderHostState`; `appcheck.ts: isLocalDevOrigin`; `createFirebasePorts()`; `types.ts: Clock, RuntimePort, QueuedEvent, DeviceModelState, WallPortStats`.
- Q4 Wall port (AMEND_C leaves details open): `raw` passed to `onEvent` = `JSON.stringify({t:"event",v:1,seq,projectId,payload})` for snapshot items and live events; `nonce` is an optional injected generator (default must be unique per port, e.g. `crypto.randomUUID`); snapshot with non-matching nonce ignored; events while resyncing queue up to `WALL_QUEUE_MAX=256` [TARGET], oldest dropped, `stats().queueDropped` counts, queue discarded on disconnect; `connect` throwing = `NOT_LISTED` (no retry); `RECONNECT_MAX` = retries after the first connect (51 connects total) and a link resets the budget; reconnect retry delay is exactly `RECONNECT_RETRY_MS`, never synchronous; pings every 20 s counted from link.
- Q5 Connector: per-origin sessions; re-`hello` restarts seq; nacked/foreign messages do not consume the 50/s budget; window is (now-1000, now]; JSON.stringify failures (cycle, BigInt) are nacked, never thrown; `nack.seq` present for event nacks (NO_HANDSHAKE, SEQ_NOT_MONOTONIC, THROTTLED).
- Q6 CSP: the "required endpoints" allowlist lives in `tests/unit/u22/static.ts` (`CSP_ALLOWED`, `CSP_MUST_HAVE`); `script-src` may add only `https://www.google.com/recaptcha/`, `https://www.gstatic.com/recaptcha/`, `https://apis.google.com` (reCAPTCHA Enterprise and Auth popup cannot work with literal `'self'` only). `frame-ancestors` is delivered via `hosting/headers.json` (Firebase Hosting `headers` array, `source:"**"`), values `chrome-extension://<EXT_ID>` or 32 [a-p] chars; spec marks the header syntax AUSENTE, this is the oracle's proposal.
- Q7 `probeAvailability`: missing `LanguageModel` global -> `unavailable`; throw/reject/unrecognised value -> `unknown`; never calls `create()`.
- Q8 O13: build runs with `VITE_APPCHECK_DEBUG_TOKEN` and `FIREBASE_APPCHECK_DEBUG_TOKEN` set to a planted UUID; the prod bundle must not contain it (so `import.meta.env` must not be passed whole into the prod bundle). Needs ~1-3 min; the Vite config path is fixed to `hosting/vite.config.ts` run from `repo/`.
- Q9 Dist UUID scan is restricted to UUIDs within ~100 chars of `debug|token|appcheck` to avoid SDK false positives; src/app and hosting sources forbid any UUID.
- Q10 Not covered: real reCAPTCHA/App Check behaviour, O15 (live G13), iframe `create()` (D-1), U08 normalise wiring, Remote Config kill switch rendering (B16).

## Repair loop 1
File: `review1.test.ts` (REVIEW_1.md, HOLD). Scope = DISP_03 BLOCKING classes 1-5 only. Not run against the candidate by the oracle author beyond the red/green check recorded by the orchestrator.

| Finding | Tests (describe) | Notes |
|---|---|---|
| Prod wiring (B1) | R1-1 | Imports `hosting/src/main.ts` in prod mode with `firebase/app`, `firebase/app-check`, `firebase/auth`, `firebase/ai` faked and `FIREBASE_PUBLIC_CONFIG` replaced by real values; no factory name is assumed. The `getAI` check assumes `HybridPort.create` builds the U06 factory (spec R5). |
| Controls B7/B8, identity, progress | R1-2 | jsdom `click()` is untrusted, so the test pins that the control passes the event's own `isTrusted` (spy on `boot.ts` exports), never a literal `true`. Identity/progress are pinned at boot API level: Google success -> `ready` uid `g-1`, `isAnonymous:false`; progress values appear in emitted state JSON (field name left open). Control labels are matched by `/google/i` and `/device|model|download/i`. |
| B16 | R1-3 | Replay/stale content present before the render (any markup) must survive `booting` -> `blocked`, or be re-rendered with text matching `replay` and `stale`. |
| Stalls | R1-4 | Fake timers; 120 s is the ceiling for any single wait (implementation may time out sooner). Auth listener must be unsubscribed. |
| Races | R1-5 | Late boot A cannot touch boot B; device model is once per page load across boots. |
| wall_port | R1-6 | No throw from hello/ping/onEvent failures; a missing snapshot must lead to a new connect or `unreachable` within 120 s. |
| Connector (REVIEW 7) | R1-7 | Commit-after-success for handshake and sequence. |

Skipped (DISP_03 non-blocking or no testable contract): hostile/Proxy/getter inputs; `IngestSink` no-op in `main.ts` (no observable U08 contract named in the spec, so only the prod Firebase and boot wiring are pinned); exact line coordinates (AUSENTE); `tsc` errors outside the surface; test-gaming remark.

### Oracle amendment A3-U22 (14 Nov)
Boundary test: `src/app/agent_drift.ts` (U37b) may call `generateContent` on a handle produced by the U06 model factory; it must still never call getAI/getGenerativeModel nor import firebase/ai.
