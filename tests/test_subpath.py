"""Exercise the path-stripping proxy with real authentication and uploads."""
import importlib
import sys

from fastapi.testclient import TestClient
from starlette.responses import JSONResponse


def test_proxy_subpath_preserves_login_uploads_and_first_lesson_cookie(tmp_path, monkeypatch):
    monkeypatch.setenv('DATABASE_URL', 'sqlite:///' + (tmp_path / 'subpath.db').as_posix())
    monkeypatch.setenv('DATA_DIR', str(tmp_path / 'files'))
    monkeypatch.setenv('APP_ORIGIN', 'https://lsclass.top')
    monkeypatch.setenv('APP_BASE_PATH', '/lesson')
    monkeypatch.setenv('CLASSROOM_CODE', 'lesson2-test')
    monkeypatch.setenv('AI_API_KEY', '')
    sys.modules.pop('backend.app', None)
    module = importlib.import_module('backend.app')
    original_requests = []

    async def proxy(scope, receive, send):
        if scope['type'] == 'http':
            scope = dict(scope)
            if not scope['path'].startswith('/lesson/'):
                original_requests.append(dict(scope['headers']))
                await JSONResponse({'app': 'first-lesson'})(scope, receive, send)
                return
            scope['path'] = scope['path'][len('/lesson'):]
            scope['raw_path'] = scope['raw_path'][len(b'/lesson'):]
        await module.app(scope, receive, send)

    try:
        with TestClient(proxy, base_url='https://lsclass.top',
                        headers={'X-Workbench': '1', 'Origin': 'https://lsclass.top'}) as client:
            client.cookies.set('classroom_session', 'first-lesson-token', domain='lsclass.top', path='/')
            landing = client.get('/lesson/')
            assert landing.status_code == 200 and 'lesson.js' in landing.text
            assert client.get('/lesson/api/health').json()['app'] == 'lesson2_edu'
            assert 'blob:' in landing.headers['content-security-policy']
            for path in ['paths.js', 'lesson.js', 'lesson.css', 'teacher-chart.js', 'teacher-chart.css',
                         'assets/grape-mass-chart.png', 'workspace/', 'workspace/paths.js']:
                assert client.get('/lesson/' + path).status_code == 200
            login = client.post('/lesson/api/classroom/login', json={
                'role': 'student', 'groupId': 1, 'code': 'lesson2-test',
            })
            assert login.status_code == 200
            assert 'Path=/lesson' in login.headers['set-cookie']
            assert 'Secure' in login.headers['set-cookie']
            assert client.get('/lesson/api/classroom/me').status_code == 200
            content = b'x' * (600 * 1024)
            upload = client.post('/lesson/api/classroom/files', files={'file': ('test.txt', content, 'text/plain')})
            assert upload.status_code == 201, upload.text
            file_id = upload.json()['id']
            assert client.get('/lesson/api/classroom/files/' + file_id).content == content
            assert client.get('/api/health').json()['app'] == 'first-lesson'
            assert b'lesson2_classroom_session' not in original_requests[-1].get(b'cookie', b'')
            assert client.post('/lesson/api/classroom/logout').status_code == 200
            assert client.get('/lesson/api/classroom/me').status_code == 401
            assert client.cookies.get('classroom_session') == 'first-lesson-token'
    finally:
        module.engine.dispose()
