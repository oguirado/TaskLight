"""Real MCP, CLI and shared-dispatch adapters; all state is caller-owned scratch."""
import io
import json
import os
import subprocess
import sys
from contextlib import redirect_stdout
from unittest.mock import patch
from bridge.room import app,mcp
from bridge.room.store import RoomError
from .support import ROOT


def call(adapter,home,tool,args):
    if adapter=='cli':
        env=dict(os.environ,CW_HOME=str(home),PYTHONDONTWRITEBYTECODE='1')
        child=subprocess.run([sys.executable,'-B','-m','bridge.room','call',tool,'--json',json.dumps(args)],
                             cwd=ROOT,env=env,capture_output=True,text=True,timeout=15)
        if child.returncode not in (0,3):
            raise RuntimeError('CLI adapter infrastructure failure, exit=%d' % child.returncode)
        if child.stderr:
            raise RuntimeError('CLI adapter unexpectedly wrote stderr')
        return json.loads(child.stdout)
    with patch.dict(os.environ,{'CW_HOME':str(home)}):
        if adapter=='dispatch':
            try:
                return app.dispatch(tool,args)
            except RoomError as error:
                return app._error_payload(error)
        if adapter=='mcp':
            output=io.StringIO()
            with redirect_stdout(output):
                mcp._handle(1,'tools/call',dict(name=tool,arguments=args))
            response=json.loads(output.getvalue())
            if 'error' in response:
                raise RuntimeError('MCP adapter infrastructure failure')
            return json.loads(response['result']['content'][0]['text'])
    raise ValueError('unknown adapter')
