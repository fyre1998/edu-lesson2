"""Start the isolated classroom preview independently of a terminal session."""
import json
import argparse
import os
from pathlib import Path
import socket
import subprocess
import sys
import time
from urllib.request import urlopen

PROJECT = Path(__file__).resolve().parents[1]
DATA = PROJECT / 'work' / 'four-stage-preview'
URL = 'http://127.0.0.1:8011'


def ready():
    try:
        with urlopen(URL + '/api/classroom/roster', timeout=2) as response:
            return [g['id'] for g in json.load(response)['groups']] == list(range(1, 9))
    except (OSError, ValueError, KeyError, TypeError):
        return False


def main():
    global DATA, URL
    parser = argparse.ArgumentParser(description='启动独立的本地课堂预览')
    parser.add_argument('--port', type=int, default=8011)
    args = parser.parse_args()
    if not 1024 <= args.port <= 65535:
        parser.error('端口应在1024至65535之间')
    if args.port != 8011:
        DATA = PROJECT / 'work' / f'classroom-preview-{args.port}'
    URL = f'http://127.0.0.1:{args.port}'
    with socket.socket() as sock:
        sock.settimeout(1)
        occupied = sock.connect_ex(('127.0.0.1', args.port)) == 0
    if occupied:
        if not ready():
            raise RuntimeError(f'Port {args.port} is occupied by another service.')
    else:
        DATA.mkdir(parents=True, exist_ok=True)
        env = dict(os.environ, DATA_DIR=str(DATA), DATABASE_URL='sqlite:///' + (DATA / 'app.db').as_posix(),
                   APP_ORIGIN=URL, CLASSROOM_CODE='BIO-PREVIEW', CLASSROOM_TEACHER_PASSWORD='preview-teacher-816')
        command = [sys.executable, '-m', 'uvicorn', 'backend.app:app', '--host', '127.0.0.1', '--port', str(args.port), '--log-level', 'warning']
        flags = subprocess.CREATE_NO_WINDOW | subprocess.CREATE_NEW_PROCESS_GROUP if os.name == 'nt' else 0
        with (DATA / 'preview.stdout.log').open('ab') as out, (DATA / 'preview.stderr.log').open('ab') as err:
            process = subprocess.Popen(command, cwd=PROJECT, env=env, stdin=subprocess.DEVNULL, stdout=out, stderr=err,
                                       close_fds=True, creationflags=flags, start_new_session=os.name != 'nt')
        (DATA / 'preview.pid').write_text(str(process.pid), encoding='ascii')
        for _ in range(30):
            if ready():
                break
            if process.poll() is not None:
                raise RuntimeError(f'Preview startup failed; see {DATA / "preview.stderr.log"}')
            time.sleep(0.3)
        else:
            raise RuntimeError(f'Preview did not become ready; see {DATA / "preview.stderr.log"}')
    print('Preview ready: ' + URL + '/classroom/')
    print('Class code: BIO-PREVIEW')


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
