"""Bounded two-server integration races; no sleeps or network listeners."""
from concurrent.futures import ThreadPoolExecutor
import json
import subprocess
import sys
import threading

from .. import support
from . import test_mcp_v2 as oracle


class ModuleClient(support.McpClient):
    """Run the actual module entry point, sharing only the on-disk room."""
    def __init__(self, home):
        self.proc = subprocess.Popen(
            [sys.executable, '-m', 'bridge.room.mcp'], cwd=str(oracle.ROOT),
            env=dict(support.clean_env(home), PYTHONDONTWRITEBYTECODE='1'),
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        self.buf = b''
        self.next_id = 1


class RaceOracle(oracle.ContractCase):
    def race(self, name):
        self.create()
        if name == 'memory_set':
            initial = self.ok('memory_set', dict(room='oracle',agent='alice',section='notes',text='Initial',base_rev=0))
            revision = initial['rev']
        else:
            revision = self.first()['rev']
        clients = [ModuleClient(self.home) for _ in range(2)]
        for client in clients:
            self.addCleanup(client.close)
            self.assertIn('result', client.initialize())
        before = self.log_bytes()
        barrier = threading.Barrier(2)

        def request(index):
            args = dict(room='oracle',agent=('alice','bob')[index],base_rev=revision)
            if name == 'memory_set':
                args.update(section='notes',text=('Left','Right')[index])
            else:
                args['task_id'] = 'T01'
                if name == 'task_update':
                    args['title'] = ('Left','Right')[index]
            barrier.wait(timeout=3)
            return clients[index].request('tools/call', {'name':name,'arguments':args},timeout=3)

        with ThreadPoolExecutor(max_workers=2) as pool:
            futures = [pool.submit(request, index) for index in range(2)]
            replies = [future.result(timeout=5) for future in futures]
        for reply in replies:
            self.assertNotIn('error', reply, 'race requires implemented v2 tool')
        results = [reply['result'] for reply in replies]
        wins = [r for r in results if r.get('isError') is False]
        losses = [r for r in results if r.get('isError') is True]
        self.assertEqual((len(wins),len(losses)), (1,1))
        winner = self.decode(wins[0])
        self.assertEqual(set(winner), {'untrusted'})
        self.assertGreater(winner['untrusted']['rev'], revision)
        loser = self.decode(losses[0])
        self.assertIs(loser['ok'], False)
        allowed = {'stale_rev','claimed_by_other'} if name=='task_claim' else {'stale_rev'}
        self.assertIn(loser['code'], allowed)
        raw = self.log_bytes()
        self.assertTrue(raw.startswith(before))
        added = raw[len(before):].splitlines()
        self.assertEqual(len(added), 1, 'loser wrote an event or winner split its write')
        events = self.events()  # strict JSON parsing, including every appended line
        lamports = [e['lamport'] for e in events]
        self.assertEqual(lamports, sorted(set(lamports)))
        self.assertEqual(len({e['id'] for e in events}), len(events))
        projections = []
        for client in clients:
            reply = client.request('tools/call', {'name':'plan_get','arguments':{'room':'oracle'}},timeout=3)
            self.assertIn('result', reply)
            self.assertIs(reply['result']['isError'], False)
            projections.append(self.decode(reply['result']))
        self.assertEqual(projections[0], projections[1], 'servers folded the same log differently')
        self.assertEqual(projections[0], {'untrusted':self.projection()})
        if name == 'memory_set':
            self.assertIn(self.ok('memory_get', {'room':'oracle'})['sections']['notes']['text'], ('Left','Right'))
        elif name == 'task_claim':
            self.assertIn(self.first()['assignee'], ('alice','bob'))
        else:
            self.assertIn(self.first()['title'], ('Left','Right'))

    def test_11_two_process_task_update(self):
        self.race('task_update')

    def test_11_two_process_memory_set(self):
        self.race('memory_set')

    def test_11_two_process_task_claim(self):
        self.race('task_claim')


if __name__ == '__main__':
    import unittest
    unittest.main()
