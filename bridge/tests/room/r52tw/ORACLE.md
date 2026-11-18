# R52TW waiter oracle

The registered `wait_agents` call runs against a journal seeded through
`agent_lifecycle`. In the fault case, a regular file temporarily replaces the
local template directory, so scanning that path raises `NotADirectoryError`
under any user privileges. The test verifies the filesystem fault and restores
the directory while the waiter is still pending. The readable control follows
the same schedule.

The terminal check publishes a completion after recovery and compares the
full reply, including the inherited parent and exact cursor. Both calls must
deliver before the original deadline. The idle check leaves completion
unpublished and verifies the exact empty reply and the original monotonic
deadline, with a scheduler allowance. The waiter and clock run without mocks.

```sh
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s bridge/tests/room/r52tw -t .
```
