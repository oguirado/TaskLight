"""Execute the CLI module entrypoint after installing environmental fixture clocks."""
import json
import os
import runpy
import sys
from .protocol_support import deterministic

if __name__ == '__main__':
    request = json.loads(sys.stdin.read())
    tool, args = request
    sys.argv = ['bridge.room', 'call', tool, '--json', json.dumps(args)]
    with deterministic(os.environ['CW_HOME'], request):
        runpy.run_module('bridge.room', run_name='__main__', alter_sys=True)
