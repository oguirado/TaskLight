"""U40 CLI: python3 -m bridge.viewpoint watch ..."""
import argparse
import signal
import sys
import time

from bridge.viewpoint.observer import DEFAULT_ROOT, ViewpointObserver


class _Stop(Exception):
    pass


def _handler(signum, frame):
    raise _Stop()


def main(argv=None):
    av = list(sys.argv[1:] if argv is None else argv)
    if not av or av[0] != "watch":
        print("usage: watch [--root PATH] [--room NAME] [--interval S] [--once] [--prime]", file=sys.stderr)
        return 2
    ap = argparse.ArgumentParser(prog="bridge.viewpoint watch")
    ap.add_argument("--root", default=DEFAULT_ROOT)
    ap.add_argument("--room", default="viewpoint")
    ap.add_argument("--interval", type=float, default=0.5)
    ap.add_argument("--once", action="store_true")
    ap.add_argument("--prime", action="store_true")
    args = ap.parse_args(av[1:])

    obs = ViewpointObserver(args.root, args.room)

    def log(n):
        s = obs.stats()
        print(
            "viewpoint: events=%d runs=%d steps=%d skipped_large=%d skipped_nonjson=%d errors=%d"
            % (n, s["runs"], s["steps"], s["skipped_large"], s["skipped_nonjson"], s["errors"]),
            file=sys.stderr,
            flush=True,
        )

    try:
        signal.signal(signal.SIGINT, _handler)
        signal.signal(signal.SIGTERM, _handler)
    except (ValueError, AttributeError):
        pass

    try:
        if args.prime:
            obs.prime()
            log(0)
            if args.once:
                return 0
        if args.once:
            n = obs.poll()
            log(n)
            return 0
        interval = args.interval if args.interval and args.interval > 0 else 0.5
        while True:
            n = obs.poll()
            log(n)
            time.sleep(interval)
    except _Stop:
        return 0
    except KeyboardInterrupt:
        return 0


if __name__ == "__main__":
    sys.exit(main())
