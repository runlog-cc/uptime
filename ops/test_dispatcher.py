import importlib.util
import json
from pathlib import Path
import subprocess
import unittest
from datetime import datetime, timezone, timedelta

spec = importlib.util.spec_from_file_location('dispatcher', Path(__file__).with_name('dispatcher.py'))
module = importlib.util.module_from_spec(spec)
try:
    spec.loader.exec_module(module)
except FileNotFoundError:
    module = None

NOW = datetime(2026, 10, 22, 8, tzinfo=timezone.utc)
def run(age, mode='production', status='completed', source='server-timer'):
    return {'display_title': f'RunLog uptime · {mode} · {source}', 'created_at': (NOW-timedelta(seconds=age)).isoformat(), 'status': status, 'head_branch': 'main'}

class DispatcherTests(unittest.TestCase):
    def setUp(self):
        self.assertIsNotNone(module, 'dispatcher implementation missing')
    def test_recent_production_deduplicates_but_drill_does_not(self):
        self.assertFalse(module.should_dispatch([run(239)], NOW))
        self.assertTrue(module.should_dispatch([run(10, 'drill-fail')], NOW))
        self.assertTrue(module.should_dispatch([run(240)], NOW))
    def test_active_runs_block_only_until_bounded_hang_threshold(self):
        self.assertFalse(module.should_dispatch([run(599, status='in_progress')], NOW))
        self.assertTrue(module.should_dispatch([run(600, status='in_progress')], NOW))
        self.assertFalse(module.should_dispatch([run(300, status='queued')], NOW))
    def test_known_production_origins_and_branch_filter(self):
        for origin in ['server-timer', 'operator', 'github-schedule']:
            self.assertFalse(module.should_dispatch([run(10, source=origin)], NOW))
        other = run(10); other['head_branch'] = 'other'
        self.assertTrue(module.should_dispatch([other], NOW))
    def test_dispatch_argv_fixed_and_no_shell(self):
        calls = []
        def runner(argv, **kwargs):
            calls.append((argv, kwargs))
            return subprocess.CompletedProcess(argv, 0, json.dumps({'workflow_runs': []}) if len(calls)==1 else '', '')
        self.assertEqual(module.execute(runner, NOW), 'dispatched')
        self.assertEqual(calls[1][0], ['/usr/bin/gh','workflow','run','uptime.yml','--repo','runlog-cc/uptime','--ref','main','-f','mode=production','-f','origin=server-timer'])
        for _, options in calls:
            self.assertNotIn('shell', options)
            self.assertLessEqual(options['timeout'], 30)
    def test_gh_failures_and_bad_json_are_generic_and_never_dispatch(self):
        for failure in [subprocess.TimeoutExpired('secret', 1), RuntimeError('token-secret')]:
            def runner(*args, **kwargs):
                raise failure
            with self.assertRaisesRegex(module.DispatchError, '^github_unavailable$'):
                module.execute(runner, NOW)
        for body in ['token-secret', '{}', '{"workflow_runs":null}']:
            with self.assertRaisesRegex(module.DispatchError, '^github_invalid_response$'):
                module.execute(lambda *a, **kw: subprocess.CompletedProcess(a, 0, body, 'token-secret'), NOW)
        with self.assertRaisesRegex(module.DispatchError, '^github_unavailable$'):
            module.execute(lambda *a, **kw: subprocess.CompletedProcess(a, 1, 'token-secret', 'token-secret'), NOW)
    def test_recent_run_skips_dispatch_and_unknown_status_rejected(self):
        calls=[]
        def runner(*args, **kwargs):
            calls.append(args)
            return subprocess.CompletedProcess(args, 0, json.dumps({'workflow_runs':[run(10)]}), '')
        self.assertEqual(module.execute(runner, NOW), 'fresh_run_exists')
        self.assertEqual(len(calls), 1)
        with self.assertRaises(module.DispatchError):
            module.should_dispatch([run(10, status='surprise')], NOW)


class LockTests(unittest.TestCase):
    def test_concurrent_dispatch_is_skipped_and_lock_released(self):
        import tempfile
        with tempfile.TemporaryDirectory() as path:
            directory = Path(path)
            nested = []
            def first():
                nested.append(module.locked_execute(directory, lambda: 'must_not_run'))
                return 'first'
            self.assertEqual(module.locked_execute(directory, first), 'first')
            self.assertEqual(nested, ['dispatcher_already_running'])
            self.assertEqual(module.locked_execute(directory, lambda: 'released'), 'released')

if __name__ == '__main__':
    unittest.main()
