# R52PV checked-read equivalence

Seed the proof through `store.read_checked` at a cursor covering the interior
rows. After each change, call `read_checked` at that cursor in the warm process
and in a fresh interpreter, using the same journal and validation settings.
Check the entire reply, including order and the malformed count, or the exact
`RoomError` code and message. Check the journal bytes around both reads.

The in-place rewrite followed by an append must expose a row promoted above
the cursor in physical order. A malformed rewrite, an invalid row after
truncate and regrow, and a foreign row after atomic replacement must fail
even below the cursor. Lowering Python's integer digit limit must reject a
formerly accepted prefix without changing the journal. The valid control
checks recent reads before and after a historical read.

A different warm and fresh reply is the regression signal. Each case also
checks the expected reply independently of the comparison. The tests use
the public reader and actual filesystem operations.

```sh
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s bridge/tests/room/r52pv -t .
```
