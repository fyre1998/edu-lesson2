"""An anonymous observer sees the live classroom but cannot operate it."""
from fastapi import BackgroundTasks
from sqlalchemy import text

from test_app import env, classroom_login


def teacher(client, monkeypatch):
    monkeypatch.setenv('CLASSROOM_CODE', 'BIO-302')
    monkeypatch.setenv('CLASSROOM_TEACHER_PASSWORD', 'teacher-test-password')
    assert classroom_login(client, teacher=True).status_code == 200


def observe(client):
    response = client.post('/api/classroom/login', json={'role': 'observer'})
    assert response.status_code == 200, response.text
    assert response.json()['role'] == 'observer'
    assert response.json()['name'] == '课堂观察'
    assert response.json()['groupId'] is None
    assert 'HttpOnly' in response.headers['set-cookie']


def database_state(module):
    with module.engine.connect() as connection:
        names = connection.execute(text("SELECT name FROM sqlite_master WHERE type='table'")).scalars()
        return {name: connection.execute(text(f'SELECT * FROM "{name}" ORDER BY rowid')).all()
                for name in names if name != 'classroom_sessions'}


def test_observer_login_needs_no_credentials_and_cannot_gain_teacher_access(env, monkeypatch):
    _, client = env
    monkeypatch.delenv('CLASSROOM_TEACHER_PASSWORD', raising=False)
    observe(client)
    assert client.get('/api/classroom/me').json()['role'] == 'observer'
    assert client.get('/api/classroom/lessons').json() == []
    assert client.get('/api/classroom/groups').status_code == 403
    assert client.get('/api/me').status_code == 401
    assert client.post('/api/classroom/login', json={'role': 'teacher', 'name': '赵老师'}).status_code == 401
    assert client.post('/api/classroom/login', json={'role': 'student', 'groupId': 1}).status_code == 401
    assert client.get('/api/classroom/me').json()['role'] == 'observer'
    assert client.post('/api/classroom/logout').status_code == 200
    assert client.get('/api/classroom/me').status_code == 401


def test_observer_reads_teacher_details_and_current_files_without_generating_summary(env, monkeypatch):
    module, client = env
    teacher(client, monkeypatch)
    lesson = client.post('/api/classroom/lessons', json={}).json()
    lid = lesson['id']
    stage = max(lesson.get('scored_stages', [2]))
    assert client.patch(f'/api/classroom/lessons/{lid}', json={'stage': stage}).status_code == 200
    assert client.post('/api/classroom/login', json={'role': 'student', 'groupId': 2, 'code': 'BIO-302'}).status_code == 200
    image = client.post(f'/api/classroom/files?lesson_id={lid}&stage={stage}', files={'file': ('设计.png', b'\x89PNG\r\n\x1a\nimage')}).json()
    submitted = client.post(f'/api/classroom/lessons/{lid}/stages/{stage}/submissions', json={
        'fields': {'design': '比较实验组与对照组，保持其他条件相同'}, 'revision': 0,
        'file_ids': [image['id']], 'request_id': 'observer-test-submit'})
    assert submitted.status_code == 201, submitted.text
    teacher(client, monkeypatch)
    reads = [f'/lessons/{lid}/stages/{stage}', f'/lessons/{lid}/groups?stage={stage}',
             f'/lessons/{lid}/groups/2/stages/{stage}', f'/lessons/{lid}/events', f'/lessons/{lid}/teaching-guide']
    expected = {}
    for route in reads:
        response = client.get('/api/classroom' + route)
        assert response.status_code == 200, response.text
        expected[route] = response.json()
    tasks = []
    monkeypatch.setattr(BackgroundTasks, 'add_task', lambda self, *args, **kwargs: tasks.append(args))
    with module.engine.begin() as connection:
        # Force a missing summary to exercise the GET path that normally enqueues work.
        connection.execute(text('DELETE FROM lesson_design_summaries'))
    observe(client)
    before = database_state(module)
    for route in reads:
        response = client.get('/api/classroom' + route)
        assert response.status_code == 200, (route, response.text)
        assert response.json() == expected[route]
    assert len(client.get(f'/api/classroom/lessons/{lid}/groups?stage={stage}').json()) == 6
    for group in range(1, 7):
        assert client.get(f'/api/classroom/lessons/{lid}/groups/{group}/stages/{stage}').status_code == 200
    assert client.get('/api/classroom/files/' + image['id'] + '?preview=true').status_code == 200
    response = client.get(f'/api/classroom/lessons/{lid}/design-summary')
    assert response.status_code == 200, response.text
    assert not tasks
    assert database_state(module) == before
    teacher(client, monkeypatch)
    assert client.get(f'/api/classroom/lessons/{lid}/design-summary').status_code == 200
    assert tasks, 'Teachers must still be able to refresh a stale summary'


def test_observer_cannot_write_through_any_classroom_endpoint(env, monkeypatch):
    module, client = env
    teacher(client, monkeypatch)
    lesson = client.post('/api/classroom/lessons', json={}).json()
    observe(client)
    before = database_state(module)
    checked = []
    for route in module.classroom_router.routes:
        if route.name in ('login', 'logout'):
            continue
        for method in route.methods & {'POST', 'PUT', 'PATCH', 'DELETE'}:
            path = route.path.replace('{lesson_id}', lesson['id']).replace('{stage}', '1').replace('{version_id}', 'some-version')
            response = client.request(method, path, json={})
            assert response.status_code == 403, (method, path, response.text)
            assert '课堂观察只能查看' in response.text
            checked.append((method, path))
    assert len(checked) >= 10
    assert database_state(module) == before


def test_observer_cannot_read_old_lessons_legacy_files_or_switch_stages(env, monkeypatch):
    _, client = env
    teacher(client, monkeypatch)
    old = client.post('/api/classroom/lessons', json={'flow_version': 1}).json()['id']
    assert client.post('/api/classroom/login', json={'role': 'student', 'groupId': 1, 'code': 'BIO-302'}).status_code == 200
    old_file = client.post(f'/api/classroom/files?lesson_id={old}&stage=1', files={'file': ('old.txt', b'old lesson')}).json()['id']
    legacy_file = client.post('/api/classroom/files', files={'file': ('legacy.txt', b'legacy')}).json()['id']
    teacher(client, monkeypatch)
    assert client.patch(f'/api/classroom/lessons/{old}', json={'status': 'archived'}).status_code == 200
    current = client.post('/api/classroom/lessons', json={'flow_version': 3}).json()['id']
    assert client.patch(f'/api/classroom/lessons/{current}', json={'stage': 2}).status_code == 200
    observe(client)
    assert [r['id'] for r in client.get('/api/classroom/lessons').json()] == [current]
    for route in [f'/lessons/{old}/stages/1', f'/lessons/{old}/groups?stage=1',
                  f'/lessons/{old}/groups/1/stages/1', f'/lessons/{old}/events',
                  f'/lessons/{old}/teaching-guide', f'/lessons/{old}/design-summary',
                  f'/lessons/{old}/materials/navigation/assets/old.png',
                  f'/lessons/{old}/matches/old-version/images/old-result',
                  f'/files/{old_file}', f'/files/{legacy_file}?preview=true']:
        assert client.get('/api/classroom' + route).status_code == 404, route
    for route in [f'/lessons/{current}/stages/1', f'/lessons/{current}/groups?stage=1',
                  f'/lessons/{current}/groups/1/stages/1']:
        assert client.get('/api/classroom' + route).status_code == 403, route
    assert client.get(f'/api/classroom/lessons/{current}/stages/2').status_code == 200
    teacher(client, monkeypatch)
    assert client.patch(f'/api/classroom/lessons/{current}', json={'stage': 1}).status_code == 200
    observe(client)
    assert client.get(f'/api/classroom/lessons/{current}/stages/1').status_code == 200
    assert client.get(f'/api/classroom/lessons/{current}/stages/2').status_code == 403
    teacher(client, monkeypatch)
    assert client.patch(f'/api/classroom/lessons/{current}', json={'status': 'archived'}).status_code == 200
    observe(client)
    assert client.get('/api/classroom/lessons').json() == []
    assert client.get(f'/api/classroom/lessons/{current}/groups?stage=1').status_code == 404
