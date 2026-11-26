# XPLAT_PROC process oracles

Run `python3 -m unittest discover -s bridge/tests/room/fixc_a -t .`.

- `WindowsProcessTests` injects the Windows process boundary and rejects calls to the POSIX wait and group APIs. The cases require suspended process-group launch, job attachment and closure, stop and timeout tree termination, exit-code preservation, and cleanup after attach or wait failure.
- The wave cases require a targeted console break and job termination when console delivery fails or the wrapper fails to exit after notification. Forwarding the POSIX signal directly fails the console-break assertion.
- `MacProcessTests` disables `waitid`. A simulated exit event must keep the leader waitable until group signals have been sent. A process that exits before registration must retain its exit status without receiving a signal.
