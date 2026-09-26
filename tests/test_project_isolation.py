"""Regression checks for running the copied lesson alongside lesson 1."""
import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import threading

import pytest

from test_app import env, register
from scripts import start_classroom_preview as preview


def test_lesson2_login_and_logout_preserve_lesson1_cookies(env, monkeypatch):
    _, client = env
    client.cookies.set('session', 'lesson1-personal', domain='testserver.local', path='/')
    client.cookies.set('classroom_session', 'lesson1-classroom', domain='testserver.local', path='/')
    assert client.get('/api/me').status_code == 401
    assert client.get('/api/classroom/me').status_code == 401

    register(client)
    assert client.cookies.get('lesson2_session')
    monkeypatch.setenv('CLASSROOM_CODE', 'test-lesson2')
    login = client.post('/api/classroom/login', json={
        'role': 'student', 'groupId': 1, 'code': 'test-lesson2',
    })
    assert login.status_code == 200
    assert client.cookies.get('lesson2_classroom_session')
    assert client.get('/api/me').status_code == 200
    assert client.get('/api/classroom/me').status_code == 200

    assert client.post('/api/logout').status_code == 200
    assert client.post('/api/classroom/logout').status_code == 200
    assert client.cookies.get('session') == 'lesson1-personal'
    assert client.cookies.get('classroom_session') == 'lesson1-classroom'
    assert not client.cookies.get('lesson2_session')
    assert not client.cookies.get('lesson2_classroom_session')


@pytest.mark.parametrize('status', [
    {'ok': True},
    {'ok': True, 'app': 'lesson2_edu', 'instance_id': 'another-directory'},
])
def test_launcher_refuses_another_classroom_on_the_port(tmp_path, monkeypatch, status):
    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.end_headers()
            self.wfile.write(json.dumps(status).encode())

        def log_message(self, *args):
            pass

    server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        monkeypatch.setattr(preview, 'PROJECT', tmp_path)
        monkeypatch.setattr('sys.argv', ['preview', '--port', str(server.server_port)])
        with pytest.raises(RuntimeError, match='belongs to another service'):
            preview.main()
        assert not (tmp_path / 'data').exists()
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)


def test_health_identifies_the_running_project(env, monkeypatch):
    _, client = env
    monkeypatch.setenv('APP_INSTANCE_ID', 'lesson2-test-instance')
    assert client.get('/api/health').json() == {
        'ok': True, 'app': 'lesson2_edu', 'instance_id': 'lesson2-test-instance',
    }
