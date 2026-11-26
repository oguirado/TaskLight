# Windows native messaging

Run from the project root.

```sh
python3 -m unittest discover -s bridge/tests/room/winhost -v
```

The suite sends the Chrome window argument through the host CLI and
checks that malformed, misplaced, duplicate and unknown options fail
silently. It forces the Windows platform and simulates an anonymous
pipe with separate idle, readable and closed states. POSIX pipe calls
and any read larger than the available data immediately fail the test.

The oracle checks binary mode before wire I/O, split prefixes and
bodies, multiple frames in one read, clean EOF, truncated EOF and the
partial-frame deadline. The end-to-end case checks that hello precedes
the request, then verifies the replayed room event and correlated
completion marker from the real room relay.

The pipe and binary-mode APIs are simulated. Chrome and the native
Windows APIs require a separate run on Windows.
