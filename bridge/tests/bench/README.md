# Python benchmark adapters

See [the benchmark guide](../../../tests/bench/README.md) for commands, admission requirements,
fixtures, timing boundaries, unavailable adapters and report semantics.

- `fixtures.py`: seeded synthetic journals, bounded streams, future reservations and isolated `CW_HOME`.
- `adapters.py`: real Python fold, dispatcher cursors, CAP atomicity, synchronized writers and native TS subprocesses.
- `harness.py`: quiet-window, exclusive lock, telemetry gates, correctness, paired observations and nearest-rank reports.
- `run.py`: complete registry, separate optimization targets, hashed JSON and Markdown output.
- `test_fixtures.py` and `test_harness.py`: correctness and deliberately broken implementations.

Verification exercises adapters without publishing timing baselines. Authoritative observations require a separate grant.
