"""Teacher dictation is isolated from student transcriptions and work."""
import uuid
from pathlib import Path

from sqlalchemy import text

from test_app import env, classroom_login
from test_lesson_v2 import mock_ai


def test_teacher_dictation_identity_cache_and_lesson_boundaries(env, monkeypatch):
    module, client = env
    monkeypatch.setenv('CLASSROOM_CODE', 'BIO-302')
    monkeypatch.setenv('CLASSROOM_TEACHER_PASSWORD', 'teacher-test-password')
    classroom_login(client, teacher=True)
    lesson = client.post('/api/classroom/lessons', json={'flow_version': 5}).json()
    calls = mock_ai(module, monkeypatch)
    body = {'lesson_id': lesson['id'], 'stage': '1', 'request_id': str(uuid.uuid4())}
    audio = b'\x1aE\xdf\xa3' + b'x' * 200

    def transcribe(**changes):
        return client.post('/api/classroom/transcriptions', data={**body, **changes},
                           files={'file': ('audio.webm', audio)})

    first = transcribe()
    assert first.status_code == 200, first.text
    assert transcribe().json() == first.json()
    assert len(calls) == 1
    # The same request ID used by another teacher or student cannot share a cache.
    assert client.post('/api/classroom/login', json={'role': 'teacher', 'name': '王老师',
        'code': 'BIO-302', 'teacherPassword': 'teacher-test-password'}).status_code == 200
    assert transcribe().status_code == 200 and len(calls) == 2
    classroom_login(client)
    assert transcribe().status_code == 200 and len(calls) == 3
    assert client.post('/api/classroom/login', json={'role': 'observer'}).status_code == 200
    assert transcribe().status_code == 403
    classroom_login(client, teacher=True)
    assert client.patch(f"/api/classroom/lessons/{lesson['id']}", json={'stage': 2}).status_code == 200
    assert transcribe(stage='2').status_code == 403
    assert client.patch(f"/api/classroom/lessons/{lesson['id']}", json={'status': 'archived'}).status_code == 200
    assert transcribe().status_code == 409
    assert len(calls) == 3
    with module.engine.connect() as connection:
        assert connection.execute(text('select count(*) from classroom_transcriptions')).scalar() == 3
        for table in ('classroom_files', 'classroom_chats', 'lesson_work_versions'):
            assert connection.execute(text(f'select count(*) from {table}')).scalar() == 0


def test_teacher_chart_serves_the_original_image(env):
    _, client = env
    response = client.get('/classroom/assets/grape-mass-chart.png')
    assert response.status_code == 200
    assert response.headers['content-type'] == 'image/png'
    assert response.content == Path('classroom-ai-prototype/assets/grape-mass-chart.png').read_bytes()
