"""Start lesson 2 with its own data and verify the identity of an existing server."""
import json
import argparse
import hashlib
import os
from pathlib import Path
import socket
import subprocess
import sys
import time
from urllib.request import urlopen
import webbrowser

PROJECT = Path(__file__).resolve().parents[1]
DEFAULT_PORT = 8015


def preview_settings(port):
    data = PROJECT / 'data' / ('lesson2' if port == DEFAULT_PORT else f'lesson2-{port}')
    url = f'http://127.0.0.1:{port}'
    instance = hashlib.sha256(str(data.resolve()).encode('utf-8')).hexdigest()[:24]
    return data, url, instance


def ready(url, instance):
    try:
        with urlopen(url + '/api/health', timeout=2) as response:
            status = json.load(response)
        return (isinstance(status, dict) and status.get('ok') is True
                and status.get('app') == 'lesson2_edu' and status.get('instance_id') == instance)
    except (OSError, ValueError):
        return False


def main():
    parser = argparse.ArgumentParser(description='启动第二节课的独立本地课堂')
    parser.add_argument('--port', type=int, default=DEFAULT_PORT)
    parser.add_argument('--foreground', action='store_true', help='在当前终端运行，Ctrl+C 停止')
    parser.add_argument('--open', action='store_true', help='启动成功后打开课堂网页')
    args = parser.parse_args()
    if not 1024 <= args.port <= 65535:
        parser.error('端口应在1024至65535之间')
    data, url, instance = preview_settings(args.port)
    with socket.socket() as sock:
        sock.settimeout(1)
        occupied = sock.connect_ex(('127.0.0.1', args.port)) == 0
    if occupied:
        if not ready(url, instance):
            raise RuntimeError(f'Port {args.port} belongs to another service. Lesson 2 was not started.')
    else:
        data.mkdir(parents=True, exist_ok=True)
        env = dict(os.environ, DATA_DIR=str(data), DATABASE_URL='sqlite:///' + (data / 'app.db').as_posix(),
                   APP_ORIGIN=url, APP_INSTANCE_ID=instance)
        command = [sys.executable, '-m', 'uvicorn', 'backend.app:app', '--host', '127.0.0.1', '--port', str(args.port), '--log-level', 'warning']
        if args.foreground:
            print('Lesson 2: ' + url + '/classroom/ (Ctrl+C to stop)', flush=True)
            return subprocess.call(command, cwd=PROJECT, env=env)
        flags = subprocess.CREATE_NO_WINDOW | subprocess.CREATE_NEW_PROCESS_GROUP if os.name == 'nt' else 0
        with (data / 'preview.stdout.log').open('ab') as out, (data / 'preview.stderr.log').open('ab') as err:
            process = subprocess.Popen(command, cwd=PROJECT, env=env, stdin=subprocess.DEVNULL, stdout=out, stderr=err,
                                       close_fds=True, creationflags=flags, start_new_session=os.name != 'nt')
        (data / 'preview.pid').write_text(str(process.pid), encoding='ascii')
        for _ in range(40):
            if ready(url, instance):
                break
            if process.poll() is not None:
                raise RuntimeError(f'Lesson 2 startup failed; see {data / "preview.stderr.log"}')
            time.sleep(0.3)
        else:
            raise RuntimeError(f'Lesson 2 did not become ready; see {data / "preview.stderr.log"}')
    print('Lesson 2 ready: ' + url + '/classroom/')
    print('Data: ' + str(data))
    if args.open:
        webbrowser.open(url + '/classroom/')
    return 0


if __name__ == '__main__':
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        sys.exit(0)
    except Exception as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
