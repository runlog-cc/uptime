#!/usr/bin/python3
"""Fallback trigger only: probes and heartbeat originate on GitHub, never here."""
from datetime import datetime, timezone
import fcntl
import json
from pathlib import Path
import re
import subprocess

READ = ['/usr/bin/gh', 'api', 'repos/runlog-cc/uptime/actions/workflows/uptime.yml/runs?branch=main&per_page=50']
DISPATCH = ['/usr/bin/gh', 'workflow', 'run', 'uptime.yml', '--repo', 'runlog-cc/uptime', '--ref', 'main', '-f', 'mode=production', '-f', 'origin=server-timer']
TITLE = re.compile(r'^RunLog uptime · production · (server-timer|operator|github-schedule)$')
ACTIVE = {'queued', 'in_progress', 'waiting', 'pending', 'requested'}

class DispatchError(Exception):
    pass


def should_dispatch(runs, now):
    if not isinstance(runs, list) or len(runs) > 50:
        raise DispatchError('github_invalid_response')
    for run in runs:
        if not isinstance(run, dict):
            raise DispatchError('github_invalid_response')
        if run.get('head_branch') != 'main' or not TITLE.fullmatch(str(run.get('display_title', ''))):
            continue
        try:
            created = datetime.fromisoformat(run['created_at'].replace('Z', '+00:00'))
            age = (now-created).total_seconds()
            if age < -60 or run['status'] not in ACTIVE | {'completed'}:
                raise ValueError()
        except (KeyError, TypeError, ValueError):
            raise DispatchError('github_invalid_response') from None
        if age < 240 or run['status'] in ACTIVE and age < 600:
            return False
    return True


def command(argv, runner):
    try:
        result = runner(argv, capture_output=True, text=True, timeout=25, check=False)
        if result.returncode:
            raise DispatchError('github_unavailable')
        return result.stdout
    except Exception:
        raise DispatchError('github_unavailable') from None


def execute(runner=subprocess.run, now=None):
    raw = command(READ, runner)
    try:
        if len(raw) > 1024*1024:
            raise ValueError()
        runs = json.loads(raw)['workflow_runs']
    except (KeyError, TypeError, ValueError):
        raise DispatchError('github_invalid_response') from None
    if not should_dispatch(runs, now or datetime.now(timezone.utc)):
        return 'fresh_run_exists'
    command(DISPATCH, runner)
    return 'dispatched'


def locked_execute(directory=None, action=execute):
    directory = directory or Path.home()/'.local/state/runlog-uptime-dispatch'
    directory.mkdir(parents=True, mode=0o700, exist_ok=True)
    with (directory/'dispatch.lock').open('a') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return 'dispatcher_already_running'
        return action()


if __name__ == '__main__':
    try:
        print(json.dumps({'dispatcher': locked_execute()}))
    except Exception:
        # Never print gh stderr, config, exception strings or credentials.
        print(json.dumps({'dispatcher': 'failed'}))
        raise SystemExit(1)
