"""An AI request may outlive logout, fail, or be cancelled without locking a group."""
import asyncio
import json
import uuid

import httpx
import pytest
from sqlalchemy import text

from test_app import env
from test_lesson_v2 import start, student


@pytest.mark.parametrize('outcome', ['success', 'truncated', 'upstream_error', 'timeout', 'cancelled'])
def test_logout_during_chat_always_releases_group_and_allows_retry(env, monkeypatch, outcome):
    module, c = env; lid = start(c, monkeypatch); student(c, 1)
    cookies = dict(c.cookies)
    body = dict(lesson_id=lid, stage=1, message='请检查本组的设计', request_id=str(uuid.uuid4()))
    monkeypatch.setenv('AI_API_KEY', 'test-only-key')
    monkeypatch.setenv('AI_MODEL', 'mock')
    real = httpx.AsyncClient

    async def run():
        started, release = asyncio.Event(), asyncio.Event()
        calls = 0

        async def upstream(request):
            nonlocal calls
            calls += 1
            if calls == 1:
                started.set()
                await release.wait()
                if outcome == 'truncated':
                    return httpx.Response(200, json={'choices': [{'finish_reason': 'length', 'message': {'content': ''}}]})
                if outcome == 'upstream_error':
                    return httpx.Response(503, json={'error': 'temporary'})
                if outcome == 'timeout':
                    raise httpx.ReadTimeout('test timeout', request=request)
            answer = {'text': '请说明对照处理。', 'step': 1, 'mastery': ''}
            return httpx.Response(200, json={'choices': [{'message': {'content': json.dumps(answer)}}]})

        monkeypatch.setattr(module.httpx, 'AsyncClient', lambda **kw: real(transport=httpx.MockTransport(upstream), **kw))
        headers = {'X-Workbench': '1', 'Origin': 'http://testserver'}
        async with real(transport=httpx.ASGITransport(app=module.app, raise_app_exceptions=False),
                        base_url='http://testserver', headers=headers, cookies=cookies) as old_client, \
                   real(transport=httpx.ASGITransport(app=module.app, raise_app_exceptions=False),
                        base_url='http://testserver', headers=headers, cookies=cookies) as new_client:
            pending = asyncio.create_task(old_client.post('/api/classroom/chats', json=body))
            try:
                await asyncio.wait_for(started.wait(), 5)
                assert (await new_client.post('/api/classroom/logout')).status_code == 200
                assert (await old_client.get('/api/classroom/me')).status_code == 401
                login = await new_client.post('/api/classroom/login', json={'role': 'student', 'groupId': 1, 'code': 'BIO-302'})
                assert login.status_code == 200
                blocked = await new_client.post('/api/classroom/chats', json={**body, 'request_id': str(uuid.uuid4())})
                assert blocked.status_code == 409
                if outcome == 'cancelled':
                    pending.cancel()
                    with pytest.raises(asyncio.CancelledError):
                        await pending
                else:
                    release.set()
                    response = await asyncio.wait_for(pending, 5)
                    assert response.status_code == {'success': 201, 'truncated': 502, 'upstream_error': 502, 'timeout': 504}[outcome], response.text
                retry = await new_client.post('/api/classroom/chats', json=body)
                assert retry.status_code == 201, retry.text
                assert (await new_client.post('/api/classroom/chats', json=body)).json() == retry.json()
                assert calls == (1 if outcome == 'success' else 2)
                # A fresh request also succeeds; a cached retry alone cannot prove unlock.
                fresh = await new_client.post('/api/classroom/chats', json={**body, 'request_id': str(uuid.uuid4())})
                assert fresh.status_code == 201, fresh.text
            finally:
                release.set()
                if not pending.done():
                    pending.cancel()
                    await asyncio.gather(pending, return_exceptions=True)

    asyncio.run(run())
    with module.engine.connect() as db:
        assert db.execute(text('SELECT count(*) FROM lesson_chat_requests WHERE length(result) = 0')).scalar() == 0
        assert db.execute(text('SELECT count(*) FROM classroom_chats')).scalar() == 2
