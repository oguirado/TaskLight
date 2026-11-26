# ORACLE U13 (thin MV3 connector; DISP_01: no AI Logic calls)

Run: `npx vitest run tests/unit/u13` (or `--project unit`). Fakes only (fake `chrome.*`, FakeClock, FakeSessionStore); no browser. State now: stubs throw, 94 fail / 18 pass (static guards and scanner controls pass on stubs by design). `tsc -p extension/tsconfig.json` is clean (local tsconfig, extends ../tsconfig.json); u13 tests type-check under the root tsconfig.

## Files
| File | Pins |
|---|---|
| router.test.ts | O1-O6, B3-B9: restart keeps queue, persist-before-ok, 512/4 MiB bounds, 65536 boundary, shapes, commit/re-lease, malformed state, notify, `peek` |
| client.test.ts | O7-O13, B10-B16: hello first/exact origin, reply filter, seq per handshake, pacing 40/s (+ sliding window), nack policy, timeouts, stop/bye |
| pins.test.ts | B18/B19: gesture, PINS_MAX 12, `toOriginPath`, bounds (title 120, text 2000), collector: unpinned never emits, snapshot needs optional per-site grant |
| port.test.ts | B20 T1: origin gate, hello -> snapshot (latest per project) -> events, ping/pong with 20 s cadence on FakeClock, reconnect after SW death |
| relay.test.ts | B22: frame cap (<= maxFrameChars, cfg within 1 MiB S5 cap), one port to hostName, read-only, errors swallowed |
| sw.test.ts | wiring: native -> storage.session -> wall; SW restart; bounded burst; sidePanel only on `open_panel` from an extension page with `userGesture===true`; pinned sources end to end |
| manifest.test.ts | O14 + B1'/B21: MV3, key, permission allow-list, no host_permissions, optional per-site hosts only, one https `externally_connectable` match, CSP, static iframe `allow="language-model"` + `src` |
| static.test.ts, scan.ts | O15: forbidden-pattern scan (+controls), import allow-list, chrome.* only in chrome_ports.ts, no console, no storage.local, `tools/secret_scan.sh` (+control) |
| harness.ts | FakeChrome (restart() = same storage.session, new lifetime), FakePort, FakeClock, evt/evtOfChars |

## Stub API delivered (`repo/extension/`)
`src/{limits,types,chrome_ports,router,client,pins,snapshot,port,sw}.ts`, `native/relay.ts`, `src/panel/panel.{html,ts}`, `manifest.json` (deliberately incomplete), `tsconfig.json`. Types and constants are real; every function throws "U13 stub".

## ORACLE decisions beyond the specs (flag if the owner disagrees)
- Q1 `Router.peek(): readonly QueuedEvent[]` added (non-leasing read, FIFO) for the T1 snapshot; `lease` returns only items not currently leased (disjoint leases).
- Q2 T1 snapshot items are `{seq: <QueuedEvent.id>, projectId, payload}` (`PortSnapshotItem`), matching U22 `src/app/types.ts` QueuedEvent, not the extension QueuedEvent of AMEND_C (conflict between the two specs). Snapshot = latest queued event per projectId, ordered by id; empty queue still answers with `items: []`. `hello` with `v !== 1` or non-string nonce is ignored. Events before `hello` are not pushed.
- Q3 `ExternalPortGate.allowedOrigins` holds manifest match patterns (`https://site.test/*`); `isOriginAllowed` matches the exact origin (scheme+host); `http://localhost/*` matches any port (S4). Undefined/"null" origin refused. Refusal = `port.disconnect()` immediately.
- Q4 Wall-side ping/reconnect belongs to U22; the extension side is tested as pong-on-ping, no SW-initiated timers, and re-snapshot after restart.
- Q5 Pins: `SourceCollector` (`snapshot.ts`) is the only producer of source events; they go through `Router.accept({projectId, payload: PinnedSourceEvent})`. `captureSnapshot` calls `permissions.contains({origins:[origin+"/*"]})` first; no grant -> `NO_HOST_PERMISSION`, no `executeScript`. `BAD_URL` for non-http(s). `tab_pinned` carries `userGesture:true`.
- Q6 Panel open: message `{t:"open_panel", userGesture, windowId?}`; allowed only if `sender.id === chrome.runtime.id`, `sender.url` starts with `chrome-extension://<id>/`, and no `sender.tab`; replies `{ok:true}` or `{ok:false, code: "NO_GESTURE"|"NOT_EXTENSION_PAGE"}`. The SW cannot verify a real gesture; the panel page must set it from a click handler.
- Q7 Imports outside `extension/` allowed: `src/app/connector` and type-only `src/app/types` (connector.ts does not export the protocol types; they live in types.ts).
- Q8 `native/relay.ts` takes `connectNative` injected and `maxFrameChars` must be 1..1,048,576 (RangeError otherwise); relay output is `Router.accept` only. Frames measured by `JSON.stringify` length.
- Q9 Manifest: `optional_host_permissions` must be non-empty (patterns not tested for breadth beyond http/https); `externally_connectable.matches` is the single prod https pattern; `content_security_policy.extension_pages` must be present.
- Q10 Not covered: real Chrome behaviour, bundler output (O15 bundle scan reduces to source scan until S3 picks a bundler), content-script code in the source tab.

### Oracle amendment A1-U13 (13 Nov)
`port.test.ts` "listed origin … latest per projectId": events are evt(1,p1), evt(2,p2), evt(3,p1) so the latest per project is p2→n=2, p1→n=3; the assertion expected n=1/2 (oracle defect reported by the author). Corrected.

## Repair loop 1 (REVIEW_1; DISP_03 triage) -> `review1.test.ts`
Included (BLOCKING per DISP_03):
| Finding | Tests | Reason |
|---|---|---|
| B1 manifest (review item 2) | R1-F1 | SPEC DRIFT, not a bug: S4/S5 spikes require `nativeMessaging` + `externally_connectable`; SPEC_U13 B1 text is older and contradicted by SPEC_AMEND_C (permissions superset incl. nativeMessaging). Not tested against B1. Tests assert permissions include storage/sidePanel/nativeMessaging, are within {storage, sidePanel, tabs, scripting, nativeMessaging}, and no `<all_urls>`, `host_permissions`, `content_scripts`, broad `externally_connectable`. Spec text should be amended by the owner. |
| B7 restore consistency | R1-F3 | Duplicate/colliding ids lose data on commit (functional, DISP_03 #5). |
| B8/B4 commit vs persistence | R1-F4 | Memory ahead of storage; caller sees success (lost update). |
| B9/B10/B16 startup | R1-F5 | Entry modules sw.ts / panel.ts are empty or factory-only. SPEC_U13 names no entry-function API, so tests load the modules as the browser does (globalThis.chrome / jsdom iframe) and observe effects only. The panel->SW runtime-messaging protocol is AUSENTE in the spec: only "some runtime message/connect goes out after ack" is asserted. |
| B14/B15 lease stranding | R1-F6 | Staged leased events dropped on handshake/stop transition. |
| B15 retry identity | R1-F7 | Single throttle retry is per event; resent events get new seq. |
| DISP_03 #3/#4 unhandled rejections | R1-F8 | `sidePanel.open` reject and `lease` reject must not be unhandled. |
Skipped:
- Privacy / U08 redaction (review item 1): SPEC_U13 B6 and SPEC_AMEND_C state payloads are unredacted until U08 runs on the host, and U08 `RawEvent` is AUSENTE. The review requirement contradicts the spec ownership: SPEC GAP (redaction boundary is not assigned to U13). Existing port.test.ts pins raw payload forwarding. No test.
- Never-settling `store.set` blocking the router: no timeout constant exists in SPEC/EXT_LIMITS; testing would invent a value. SPEC GAP, no test (rejections are covered).

### Oracle amendment A2-U13 (14 Nov, for AMEND_W/U37c)
Real host frames carry `t:"event", v:1` (repo/bridge/wall/native_host.py:140). `relay.test.ts` frames now include them, so AMEND_W can route only `t==="event"` to Router (U37c J5).

### Oracle amendment A3-U13 (14 Nov)
`sw.test.ts` native frames and the relay accept-rejection frame now carry `t:"event", v:1` like real host frames (A2-U13).

## Oracle amendment A-U38
SPEC_U38 G2: `sw.ts` no longer self-starts; `sw_main.ts` is the only SW entry. `review1.test.ts` R1-F5 now imports `extension/src/sw_main` (was `sw`) and expects the same wiring (T1 listener, native port, runtime listener). `static.test.ts` is NOT amended: `chrome.*` outside `chrome_ports.ts` remains a regression.

### Oracle amendment A-U13-PF1

In `review1.test.ts`, the R1-F5 hello test dispatches the iframe's `load` event after importing the panel and before settling. The host ack and unload tests dispatch it at the same point under P5. The test DOM keeps the iframe in `loading` and never fires that event, so these tests signal readiness before checking the handshake and teardown.
