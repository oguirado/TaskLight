# U80 TypeScript oracle

The complete numbered acceptance map, MUST coverage, interpretations and stop rules are in
`bridge/tests/wall/u80/ORACLE.md`.

| Acceptance | Test file and names |
| --- | --- |
| A1 | `bridge.test.ts`: `A1_private_floor_denies_remote`, `A1_standard_floor_admits_remote`, `A1_declared_private_wins` |
| A2 | `bridge.test.ts`: `A2_missing_room_uses_strictest`, `A2_only_standard_admits`, `A2_floor_order_independent` |
| A3 | `bridge.test.ts`: `A3_unknown_room_denies`, `A3_unknown_room_local_opt_in_denies`, `A3_unknown_room_without_config_denies` |
| A4 | `bridge.test.ts`: `A4_local_private_opt_in_admits`, `A4_local_without_opt_in_denies` |
| A5 | `extension.test.ts`: `A5 accepts and keeps room %s`, `A5 rejects malformed room %j without forwarding`, `A5 unknown extra keys stay rejected %j` |
| A6 | `page.test.ts`: `A6 model_port carries room at rung %s`, `A6 no room means no room key` |
| A7 | `plan.test.ts`: `A7 binds task review and brief to room %s` |

A1 through A4 run the Python unittest cases through the existing native-host factory with mocked store and transport. A5 exercises the real extension relay. A6 exercises the real page model transport. A7 exercises the real plan wiring and provider chain to a fake frame channel.

No production files or future exports are introduced. Optional room inputs use structural typing to remain compilable before implementation. Assertions inspect observable frames and policy decisions rather than an unspecified new signature.

Out of scope: strategy units unrelated to U80, real Firebase or network setup, new shared-room configuration, and an agent chat suggestion generator absent from `src/agents` in this snapshot. See the main oracle for details.
