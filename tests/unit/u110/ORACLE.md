# U110 TypeScript boundary oracle

Binding scope: Amendment C5, `src/agents/types.ts:23` (`RoomEvent`) only.
Implementation acceptance lives in `bridge/tests/room/u110/`; its `ORACLE.md`
contains the full A1–A7 mapping, interpretation and stop rules.

| Spec acceptance | TypeScript coverage / Python owner |
| --- | --- |
| A1 | OUT_OF_SCOPE for TypeScript: `Protocol.test_a1_*` |
| A2 | `retains message identity, address, reference and typed evidence`; Python `Protocol.test_a2_*` owns transport/runtime checks |
| A3 | `represents all four coordination acts without narrowing legacy RoomEvent acts`; Python `References` owns validation and status |
| A4 | `carries literal hostile text without requiring lifecycle or planning fields`; Python `Protocol.test_a4_*` owns passivity and refusals |
| A5 | `keeps optional message fields optional and evidence values textual`; Python `Validation` owns runtime limits, paths and digests |
| A6 | OUT_OF_SCOPE for TypeScript: Python `Durability.test_a6_*` and `test_c4_*` |
| A7 | OUT_OF_SCOPE for TypeScript: Python `Durability.test_a7_*` |

These existing types are expected green. Their assertions do not claim that
`room_send` is implemented or accepts every legacy `RoomEvent` act. Python's
actual `NotImplementedError("U110 stub")` supplies the fail-first signal.
No TS API, lifecycle behavior, browser rendering or provider behavior is added.
The mandate is limited to the supplied specification and `RoomEvent` boundary.
