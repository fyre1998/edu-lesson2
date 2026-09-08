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
    cookie = client.cookies.get('session')
    assert client.post('/api/logout').status_code == 200
    client.cookies.set('session', cookie)
    assert client.get('/api/me').status_code == 401
    client.cookies.clear()
    assert client.post('/api/login', json={'username':'alice','password':'wrong-password'}).status_code == 401
    assert client.post('/api/login', json={'username':'alice','password':'correct-password-123'}).status_code == 200
    assert client.get('/api/notes').json()[0]['content'] == '新的内容'
    with module.SessionLocal() as db:
        account = db.get(module.User, 1)
        assert account.password != 'correct-password-123'
        session = db.query(module.LoginSession).first()
        assert session.token != client.cookies.get('session')


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
        token = db.get(module.LoginSession, module.digest(client.cookies.get('session')))
        token.expires = 1
        db.commit()
    assert client.get('/api/me').status_code == 401
