# U87 Vitest entry point

`contract.test.ts` runs the public Python CLI/MCP contract probes through bounded
stdlib subprocesses. It shares assertions with `bridge/tests/room/u87` because
the specification declares no new TypeScript production surface or API.

| Acceptance | Vitest test names |
| --- | --- |
| A1 | `A1 discovery, complete schemas, no writes`; `A1 CLI-only extension startup`; `A1 real module discovery and call` |
| A2 | `A2 all tools: complete payloads, journals and common dispatch spy` |
| A3 | `A3 no_plan detail`; `A3 stale_rev detail and no append` |
| A4 | `A4 syntax versus handler bad_args`; `A4 RPC envelopes` |
| A5 | `A5 schema paths and required sets` |
| A6 | `A6 hostile nested task`; `A6 traversal` |
| A7 | `A7 S0 extension startup in both orders` |
| A8 | `A8 dispatcher bypass mutation`; `A8 extension omission mutation`; `A8 nested items mutation`; `A8 stripped detail mutation`; independent checker controls |
| A9 | `A9 sanitized unexpected exception`; `A9 legacy CLI`; `A9 app import` |
| A-U87-1 | `A-U87-1 prompt list`; `A-U87-1 executor steering`; `A-U87-1 argument validation` |
| M1 I/O guard | `M1 independent app I/O checker control` |

See `bridge/tests/room/u87/ORACLE.md` for exhaustive Python test-name expansion,
mutation contrasts, prerequisite red-state interpretation, baseline evidence,
ambiguities and out-of-scope units. Each child must report executed assertions;
transport success alone never passes a test. No network or elapsed-time sleep
is part of the fixture. Subprocess deadlines bound failures.

U89 events, U90 activity implementation, U94 export, U95 documentation, S1/S2/S3
implementations and daemon/identity/cancellation changes remain out of scope.
The mandate is limited to the supplied specification and confirmed repository surfaces.
