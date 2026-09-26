import importlib
import sys

import httpx
import pytest
from fastapi.testclient import TestClient


@pytest.fixture
def env(tmp_path, monkeypatch):
    monkeypatch.setenv('DATABASE_URL', 'sqlite:///' + (tmp_path / 'test.db').as_posix())
    monkeypatch.setenv('DATA_DIR', str(tmp_path / 'data'))
    monkeypatch.setenv('APP_ORIGIN', 'http://testserver')
    monkeypatch.setenv('AI_API_KEY', '')
    monkeypatch.setenv('AI_MODEL', '')
    monkeypatch.setenv('ALLOW_REGISTRATION', 'true')
    sys.modules.pop('backend.app', None)
    module = importlib.import_module('backend.app')
    with TestClient(module.app, headers={'X-Workbench': '1', 'Origin': 'http://testserver'}) as client:
        yield module, client
    module.engine.dispose()


def register(client, name='alice'):
    response = client.post('/api/register', json={'username':name, 'password':'correct-password-123'})
    assert response.status_code == 201, response.text
    return response


def test_auth_persistence_logout(env):
    module, client = env
    assert client.get('/api/notes').status_code == 401
    response = register(client)
    assert 'HttpOnly' in response.headers['set-cookie']
    assert 'SameSite=strict' in response.headers['set-cookie']
    note = client.post('/api/notes', json={'title':'我的笔记','content':'持久化内容'}).json()
    assert client.put('/api/notes/' + str(note['id']), json={'title':'新标题','content':'新的内容'}).status_code == 200
    cookie = client.cookies.get('lesson2_session')
    assert client.post('/api/logout').status_code == 200
    client.cookies.set('lesson2_session', cookie)
    assert client.get('/api/me').status_code == 401
    client.cookies.clear()
    assert client.post('/api/login', json={'username':'alice','password':'wrong-password'}).status_code == 401
    assert client.post('/api/login', json={'username':'alice','password':'correct-password-123'}).status_code == 200
    assert client.get('/api/notes').json()[0]['content'] == '新的内容'
    with module.SessionLocal() as db:
        account = db.get(module.User, 1)
        assert account.password != 'correct-password-123'
        session = db.query(module.LoginSession).first()
        assert session.token != client.cookies.get('lesson2_session')


def test_user_isolation_and_file_roundtrip(env):
    module, alice = env
    register(alice)
    note = alice.post('/api/notes', json={'title':'私密','content':'alice'}).json()
    file = alice.post('/api/files', files={'file':('资料.txt', 'private data', 'text/plain')}).json()
    assert alice.get('/api/files/' + file['id']).content == b'private data'
    with TestClient(module.app, headers={'X-Workbench':'1'}) as bob:
        register(bob, 'bob')
        assert bob.get('/api/notes').json() == []
        assert bob.get('/api/files').json() == []
        assert bob.get('/api/chats').json() == []
        assert bob.put('/api/notes/' + str(note['id']), json={'title':'attack','content':''}).status_code == 404
        assert bob.delete('/api/notes/' + str(note['id'])).status_code == 404
        assert bob.get('/api/files/' + file['id']).status_code == 404
        assert bob.delete('/api/files/' + file['id']).status_code == 404
    assert alice.delete('/api/files/' + file['id']).status_code == 200
    assert alice.get('/api/files/' + file['id']).status_code == 404
    assert not (module.UPLOADS / file['id']).exists()
    assert alice.delete('/api/notes/' + str(note['id'])).status_code == 200


def test_validation_and_csrf(env):
    _, client = env
    assert client.post('/api/register', json={'username':'ab','password':'short'}).status_code == 422
    register(client)
    assert client.post('/api/register', json={'username':'ALICE','password':'correct-password-123'}).status_code == 409
    assert client.post('/api/notes', headers={'Origin':'https://evil.example'}, json={'title':'bad','content':''}).status_code == 403
    assert client.post('/api/notes', headers={'X-Workbench':''}, json={'title':'bad','content':''}).status_code == 403
    assert client.post('/api/files', files={'file':('bad.html', b'<script>alert(1)</script>')}).status_code == 400
    assert client.post('/api/files', files={'file':('huge.txt', b'x' * (10 * 1024 * 1024 + 1))}).status_code == 413
    assert client.post('/api/files', content=b'x' * (12 * 1024 * 1024)).status_code == 413
    response = client.get('/')
    assert response.status_code == 200
    assert "script-src 'self'" in response.headers['content-security-policy']


def test_ai_unconfigured_and_mocked(env, monkeypatch):
    module, client = env
    register(client)
    assert client.post('/api/chats', json={'message':'你好'}).status_code == 503
    monkeypatch.setenv('AI_API_KEY', 'test-only-key')
    monkeypatch.setenv('AI_MODEL', 'test-model')
    calls = []
    real_client = httpx.AsyncClient
    def handler(request):
        calls.append(request)
        return httpx.Response(200, json={'choices':[{'message':{'content':'这是测试回复'}}]})
    monkeypatch.setattr(module.httpx, 'AsyncClient', lambda **kwargs: real_client(transport=httpx.MockTransport(handler), **kwargs))
    response = client.post('/api/chats', json={'message':'你好'})
    assert response.status_code == 201
    assert response.json()['answer'] == '这是测试回复'
    assert client.get('/api/chats').json()[0]['question'] == '你好'
    assert calls[0].headers['Authorization'] == 'Bearer test-only-key'
    with TestClient(module.app, headers={'X-Workbench':'1'}) as bob:
        register(bob, 'bob')
        assert bob.get('/api/chats').json() == []
        assert bob.post('/api/chats', json={'message':'另一位用户'}).status_code == 201
        import json
        assert len(json.loads(calls[-1].content)['messages']) == 2


def test_ai_truncated_response_is_not_saved(env, monkeypatch):
    import json
    module, client = env
    register(client)
    monkeypatch.setenv('AI_API_KEY', 'test-key')
    monkeypatch.setenv('AI_MODEL', '~deepseek/deepseek-flash-latest')
    monkeypatch.setenv('AI_MAX_TOKENS', '8192')
    monkeypatch.setenv('AI_REASONING_EFFORT', 'low')
    real_client = httpx.AsyncClient
    def handler(request):
        payload = json.loads(request.content)
        assert payload['max_tokens'] == 8192
        assert payload['reasoning'] == {'effort': 'low'}
        assert 'response_format' not in payload  # Ordinary workbench chat remains plain text.
        return httpx.Response(200, json={'choices': [{'finish_reason': 'length', 'message': {'content': '这是一段未完成的'}}]})
    monkeypatch.setattr(module.httpx, 'AsyncClient', lambda **kw: real_client(transport=httpx.MockTransport(handler), **kw))
    response = client.post('/api/chats', json={'message': '解释这个实验'})
    assert response.status_code == 502
    assert '未完整生成' in response.json()['detail']
    assert client.get('/api/chats').json() == []


def test_rate_limit_and_closed_registration(env, monkeypatch):
    module, client = env
    monkeypatch.setenv('ALLOW_REGISTRATION', 'false')
    assert client.post('/api/register', json={'username':'alice','password':'correct-password-123'}).status_code == 403
    for _ in range(10):
        assert client.post('/api/login', json={'username':'alice','password':'wrong-password'}).status_code == 401
    assert client.post('/api/login', json={'username':'alice','password':'wrong-password'}).status_code == 429


def test_expired_session(env):
    module, client = env
    register(client)
    with module.SessionLocal() as db:
        token = db.get(module.LoginSession, module.digest(client.cookies.get('lesson2_session')))
        token.expires = 1
        db.commit()
    assert client.get('/api/me').status_code == 401


def classroom_login(client, group=1, teacher=False, password='teacher-test-password'):
    names = {1: '王晓彤', 2: '孙语桐'}
    return client.post('/api/classroom/login', json={
        'role': 'teacher' if teacher else 'student', 'name': '赵老师' if teacher else names[group],
        'groupId': None if teacher else group, 'code': 'BIO-302', 'teacherPassword': password,
    })


def test_classroom_teacher_files_and_group_isolation(env, monkeypatch):
    module, student = env
    monkeypatch.setenv('CLASSROOM_CODE', 'BIO-302')
    monkeypatch.setenv('CLASSROOM_TEACHER_PASSWORD', 'teacher-test-password')
    assert student.get('/api/classroom/groups').status_code == 401
    assert classroom_login(student).status_code == 200
    response = student.post('/api/classroom/files', files={'file': ('实验记录.txt', '真实实验数据'.encode())})
    assert response.status_code == 201
    file = response.json()
    file_url = '/api/classroom/files/' + file['id']
    assert student.get(file_url).content == '真实实验数据'.encode()
    assert student.get('/api/classroom/groups').json()[0]['files'][0]['uploader'] == '王晓彤'
    assert student.get('/api/files').status_code == 401
    with TestClient(module.app, headers={'X-Workbench': '1'}) as other:
        assert classroom_login(other, group=2).status_code == 200
        assert [g['id'] for g in other.get('/api/classroom/groups').json()] == [2]
        assert other.get(file_url).status_code == 404
        assert other.get(file_url + '?preview=true').status_code == 404
        assert classroom_login(other, teacher=True, password='wrong').status_code == 401
        assert classroom_login(other, teacher=True).status_code == 200
        data = other.get('/api/classroom/groups').json()
        assert len(data) == 6
        assert data[0]['files'][0]['id'] == file['id']
        assert other.get(file_url).content == '真实实验数据'.encode()
        assert 'attachment' in other.get(file_url).headers['content-disposition']
        token = other.cookies.get('lesson2_classroom_session')
        assert other.post('/api/classroom/logout').status_code == 200
        other.cookies.set('lesson2_classroom_session', token)
        assert other.get(file_url).status_code == 401
    # A fresh login still sees files saved by the previous session.
    student.post('/api/classroom/logout')
    assert classroom_login(student).status_code == 200
    assert student.get('/api/classroom/groups').json()[0]['files'][0]['id'] == file['id']


def test_classroom_upload_validation_and_preview(env, monkeypatch):
    _, client = env
    monkeypatch.setenv('CLASSROOM_CODE', 'BIO-302')
    classroom_login(client)
    assert client.post('/api/classroom/files', files={'file': ('bad.html', b'<script>bad</script>')}).status_code == 400
    assert client.post('/api/classroom/files', files={'file': ('empty.txt', b'')}).status_code == 400
    assert client.post('/api/classroom/files', files={'file': ('huge.txt', b'x' * (20 * 1024 * 1024 + 1))}).status_code == 413
    fake = client.post('/api/classroom/files', files={'file': ('fake.png', b'<script>bad</script>')}).json()
    assert not fake['preview']
    assert client.get('/api/classroom/files/' + fake['id'] + '?preview=true').status_code == 400
    import base64
    png = base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5XkAAAAASUVORK5CYII=')
    image = client.post('/api/classroom/files', files={'file': ('photo.png', png)}).json()
    preview = client.get('/api/classroom/files/' + image['id'] + '?preview=true')
    assert preview.content == png
    assert preview.headers['content-type'] == 'image/png'
    assert 'inline' in preview.headers['content-disposition']


def test_classroom_real_ai_protocol_and_history(env, monkeypatch):
    import json
    module, client = env
    monkeypatch.setenv('CLASSROOM_CODE', 'BIO-302')
    classroom_login(client)
    assert client.post('/api/classroom/chats', json={'message': '你好'}).status_code == 503
    monkeypatch.setenv('AI_API_KEY', 'test-secret-not-for-browser')
    monkeypatch.setenv('AI_MODEL', 'qwen/qwen3.8-max-0902')
    monkeypatch.setenv('AI_BASE_URL', 'https://openrouter.ai/api/v1')
    calls = []
    real_client = httpx.AsyncClient
    def handler(request):
        calls.append(request)
        return httpx.Response(200, json={'choices': [{'message': {'content': '请列出观察到的现象。'}}]})
    monkeypatch.setattr(module.httpx, 'AsyncClient', lambda **kw: real_client(transport=httpx.MockTransport(handler), **kw))
    assert client.post('/api/classroom/chats', json={'message': '酵母菌为什么产生气体？'}).status_code == 201
    assert client.post('/api/classroom/chats', json={'message': '接下来呢？'}).status_code == 201
    assert str(calls[0].url) == 'https://openrouter.ai/api/v1/chat/completions'
    assert calls[0].headers['authorization'] == 'Bearer test-secret-not-for-browser'
    body = json.loads(calls[1].content)
    assert body['model'] == 'qwen/qwen3.8-max-0902'
    assert len(body['messages']) == 4
    assert len(client.get('/api/classroom/groups').json()[0]['chat']) == 4
    assert 'test-secret' not in client.get('/api/classroom/me').text
    with TestClient(module.app, headers={'X-Workbench': '1'}) as other:
        classroom_login(other, group=2)
        assert other.post('/api/classroom/chats', json={'message': '另一组的问题'}).status_code == 201
        assert len(json.loads(calls[-1].content)['messages']) == 2


@pytest.mark.parametrize('status', [401, 402, 404, 429, 500])
def test_classroom_upstream_failure_does_not_save_or_leak(env, monkeypatch, status):
    module, client = env
    monkeypatch.setenv('CLASSROOM_CODE', 'BIO-302')
    monkeypatch.setenv('AI_API_KEY', 'private-test-key')
    monkeypatch.setenv('AI_MODEL', 'test-model')
    classroom_login(client)
    real_client = httpx.AsyncClient
    transport = httpx.MockTransport(lambda request: httpx.Response(status, json={'error': 'private-test-key'}))
    monkeypatch.setattr(module.httpx, 'AsyncClient', lambda **kw: real_client(transport=transport, **kw))
    response = client.post('/api/classroom/chats', json={'message': '测试失败'})
    assert response.status_code == 502
    assert 'private-test-key' not in response.text
    assert client.get('/api/classroom/groups').json()[0]['chat'] == []


def test_classroom_frontend_and_teacher_not_configured(env, monkeypatch):
    _, client = env
    monkeypatch.setenv('CLASSROOM_CODE', 'BIO-302')
    monkeypatch.setenv('CLASSROOM_TEACHER_PASSWORD', '')
    assert classroom_login(client, teacher=True).status_code == 503
    page = client.get('/classroom/')
    assert page.status_code == 200
    assert 'teacherFileList' in page.text
    assert 'teacherPassword' in page.text
    assert client.get('/classroom/app-v2.js').status_code == 200


def upload_test_image(client, name='实验照片.png'):
    import base64
    png = base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5XkAAAAASUVORK5CYII=')
    response = client.post('/api/classroom/files', files={'file': (name, png)})
    assert response.status_code == 201
    return response.json(), png


def test_classroom_image_ai_payload_history_and_teacher_view(env, monkeypatch):
    import base64
    import json
    module, client = env
    monkeypatch.setenv('CLASSROOM_CODE', 'BIO-302')
    monkeypatch.setenv('CLASSROOM_TEACHER_PASSWORD', 'teacher-test-password')
    monkeypatch.setenv('AI_API_KEY', 'test-key')
    monkeypatch.setenv('AI_MODEL', 'qwen/qwen3.8-max-0902')
    classroom_login(client)
    image, png = upload_test_image(client)
    unused, _ = upload_test_image(client, '未选择的图片.png')
    calls = []
    real_client = httpx.AsyncClient
    def handler(request):
        calls.append(json.loads(request.content))
        return httpx.Response(200, json={'choices': [{'message': {'content': '图片分析结果'}}]})
    monkeypatch.setattr(module.httpx, 'AsyncClient', lambda **kw: real_client(transport=httpx.MockTransport(handler), **kw))
    response = client.post('/api/classroom/chats', json={'message': '', 'image_ids': [image['id']]})
    assert response.status_code == 201
    assert response.json()['images'][0]['id'] == image['id']
    parts = calls[0]['messages'][-1]['content']
    images = [part for part in parts if part['type'] == 'image_url']
    assert len(images) == 1
    assert images[0]['image_url']['url'] == 'data:image/png;base64,' + base64.b64encode(png).decode()
    assert client.post('/api/classroom/chats', json={'message': '这张图说明什么？'}).status_code == 201
    assert any(part['type'] == 'image_url' for part in calls[-1]['messages'][1]['content'])
    assert '未选择的图片' not in json.dumps(calls, ensure_ascii=False)
    classroom_login(client, teacher=True)
    messages = client.get('/api/classroom/groups').json()[0]['chat']
    assert messages[0]['images'][0]['id'] == image['id']
    assert client.get('/api/classroom/files/' + image['id'] + '?preview=true').content == png
    classroom_login(client, group=2)
    assert client.post('/api/classroom/chats', json={'message': '你好'}).status_code == 201
    assert len(calls[-1]['messages']) == 2
    assert isinstance(calls[-1]['messages'][-1]['content'], str)


def test_classroom_image_ai_rejects_invalid_attachments(env, monkeypatch):
    module, client = env
    monkeypatch.setenv('CLASSROOM_CODE', 'BIO-302')
    classroom_login(client)
    image, _ = upload_test_image(client)
    doc = client.post('/api/classroom/files', files={'file': ('记录.txt', b'text')}).json()
    assert client.post('/api/classroom/chats', json={'message': ' '}).status_code == 422
    assert client.post('/api/classroom/chats', json={'image_ids': [doc['id']]}).status_code == 400
    assert client.post('/api/classroom/chats', json={'image_ids': [image['id']] * 2}).status_code == 422
    assert client.post('/api/classroom/chats', json={'image_ids': [image['id']] * 5}).status_code == 422
    with TestClient(module.app, headers={'X-Workbench': '1'}) as other:
        classroom_login(other, group=2)
        assert other.post('/api/classroom/chats', json={'image_ids': [image['id']]}).status_code == 404
    (module.UPLOADS / image['id']).unlink()
    assert client.post('/api/classroom/chats', json={'image_ids': [image['id']]}).status_code == 404


def test_classroom_image_total_size_limit(env, monkeypatch):
    module, client = env
    monkeypatch.setenv('CLASSROOM_CODE', 'BIO-302')
    classroom_login(client)
    first, _ = upload_test_image(client)
    second, _ = upload_test_image(client, '另一张.png')
    with (module.UPLOADS / first['id']).open('ab') as file:
        file.truncate(20 * 1024 * 1024)
    response = client.post('/api/classroom/chats', json={'image_ids': [first['id'], second['id']]})
    assert response.status_code == 413


def test_classroom_failed_image_request_does_not_create_attachment_record(env, monkeypatch):
    module, client = env
    monkeypatch.setenv('CLASSROOM_CODE', 'BIO-302')
    monkeypatch.setenv('AI_API_KEY', 'test-key')
    monkeypatch.setenv('AI_MODEL', 'test-model')
    classroom_login(client)
    image, _ = upload_test_image(client)
    real_client = httpx.AsyncClient
    monkeypatch.setattr(module.httpx, 'AsyncClient', lambda **kw: real_client(
        transport=httpx.MockTransport(lambda request: httpx.Response(500)), **kw))
    assert client.post('/api/classroom/chats', json={'image_ids': [image['id']]}).status_code == 502
    with module.engine.connect() as connection:
        from sqlalchemy import text
        assert connection.execute(text('SELECT count(*) FROM classroom_chat_images')).scalar() == 0
    group = client.get('/api/classroom/groups').json()[0]
    assert group['chat'] == []
    assert group['files'][0]['id'] == image['id']
