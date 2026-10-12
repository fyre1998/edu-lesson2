"""Teacher dictation is isolated from student transcriptions and work."""
import uuid
from pathlib import Path

import httpx
import pytest
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


@pytest.mark.parametrize(('upstream_status','status','message'), [
    (404,503,'没有可用服务'), (403,502,'拒绝了当前配置'),
    (429,503,'繁忙'), (500,502,'暂时不可用')])
def test_speech_errors_are_actionable_and_do_not_log_sensitive_payloads(env, monkeypatch, caplog,
                                                                      upstream_status,status,message):
    module, client = env
    monkeypatch.setenv('CLASSROOM_CODE','BIO-302')
    monkeypatch.setenv('CLASSROOM_TEACHER_PASSWORD','teacher-test-password')
    classroom_login(client,teacher=True)
    lid=client.post('/api/classroom/lessons',json={'flow_version':5}).json()['id']
    real_client=httpx.AsyncClient
    calls=mock_ai(module,monkeypatch,lambda req,payload:httpx.Response(upstream_status,
        json={'error':{'message':'private-upstream-details'},'user_id':'private-account-id'}))
    monkeypatch.setenv('STT_API_KEY','private-stt-key')
    monkeypatch.setenv('STT_MODEL','retired-model')
    audio=b'\x1aE\xdf\xa3'+b'private-audio-content'*20
    result=client.post('/api/classroom/transcriptions',data={'lesson_id':lid,'stage':1,'request_id':str(uuid.uuid4())},
                       files={'file':('speech.webm',audio)})
    assert result.status_code==status
    assert message in result.json()['detail']
    assert len(calls)==1
    assert f'status={upstream_status} model=retired-model format=webm' in caplog.text
    for secret in ('private-upstream-details','private-account-id','private-stt-key','private-audio-content'):
        assert secret not in caplog.text and secret not in result.text
    # A failed request must release its in-flight lock so the next recording can work.
    monkeypatch.setattr(module.httpx,'AsyncClient',real_client)
    successful=mock_ai(module,monkeypatch)
    monkeypatch.delenv('STT_MODEL',raising=False)
    result=client.post('/api/classroom/transcriptions',data={'lesson_id':lid,'stage':1,'request_id':str(uuid.uuid4())},
                       files={'file':('speech.webm',audio)})
    assert result.status_code==200
    assert successful[0][1]['model']=='qwen/qwen3-asr-1.7b'
