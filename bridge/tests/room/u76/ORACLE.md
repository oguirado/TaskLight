# U76 stdlib MCP oracle

Authoritative acceptance-to-test mapping, MUST coverage, ambiguity resolutions,
A-U76a legacy amendments and measured verification results:
`tests/unit/u76/ORACLE.md`.

Run from the repository root:

```sh
python3 -B -m unittest discover -s bridge/tests/room/u76 -v
```

`test_contract.py` contains 28 stdlib cases [MEASURED]. Initial result:
`FAILED (failures=17)` [MEASURED], with no unittest errors [MEASURED].
`tests/unit/u76/bridge.test.ts` exposes each case to the combined Vitest command.
Temporary repository copies and room data are created beneath this directory and
cleaned up after each case. Product modules are real copies, not behavioral stubs.
