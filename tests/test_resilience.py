"""Fault injection uses synthetic records and mock providers; no paid APIs."""
import asyncio
import json
import time
import uuid

import httpx
import pytest
from fastapi import HTTPException
from sqlalchemy import text

from backend import resilience as r
from backend.ai_schemas import GUIDANCE_SCHEMA
from test_app import env
from test_chat_stream import Bytes, frame
from test_lesson_grape_v5 import start, scoring
from test_lesson_v2 import student


def configure(monkeypatch):
    for key, value in {
        'AI_FAILOVER_ENABLED': 'true', 'STT_FAILOVER_ENABLED': 'true',
        'AI_BASE_URL': 'https://openrouter.ai/api/v1', 'AI_API_KEY': 'primary-secret',
        'AI_MODEL': 'deepseek/test', 'AI_FALLBACK_MODEL': 'qwen3.8-flash',
        'DASHSCOPE_API_KEY': 'backup-secret', 'DASHSCOPE_WORKSPACE_ID': '',
        'AI_FAILOVER_HOLD_UNTIL': '2099-01-01T09:05:00+08:00',
        'AI_FIRST_CONTENT_SECONDS': '.05', 'AI_CHAT_ATTEMPT_SECONDS': '.5',
        'AI_TASK_ATTEMPT_SECONDS': '.5', 'AI_TOTAL_SECONDS': '2',
        'STT_PRIMARY_SECONDS': '.05', 'STT_BACKUP_SECONDS': '.5', 'STT_TOTAL_SECONDS': '2',
    }.items():
        monkeypatch.setenv(key, value)


def reply(value):
    return httpx.Response(200, json={'choices': [{'finish_reason': 'stop',
                         'message': {'content': json.dumps(value, ensure_ascii=False)}}]})


ANSWER = {'text': '请说明本组的依据。', 'step': 2, 'mastery': '已提出方案'}


@pytest.mark.parametrize('failure', [401, 402, 403, 404, 408, 429, 500, 502, 503,
                                      'timeout', 'connection', 'empty', 'json', 'schema', 'length'])
def test_failover_preserves_exact_context_schema_and_key_boundaries(env, monkeypatch, failure):
    module, _ = env; configure(monkeypatch)
    requests = []; real = httpx.AsyncClient
    messages = [{'role': 'system', 'content': '本组专属教学规则'},
                {'role': 'user', 'content': '上轮选GA3'}, {'role': 'assistant', 'content': '请提供依据。'},
                {'role': 'user', 'content': [{'type': 'text', 'text': '本次的图片'},
                    {'type': 'image_url', 'image_url': {'url': 'data:image/png;base64,abc'}}]}]
    async def upstream(req):
        body = json.loads(req.content); requests.append((req, body))
        if req.url.host == 'openrouter.ai':
            if isinstance(failure, int): return httpx.Response(failure)
            if failure == 'timeout': await asyncio.sleep(1)
            if failure == 'connection': raise httpx.ConnectError('synthetic')
            if failure == 'empty': return httpx.Response(200, json={'choices': []})
            if failure == 'json': return httpx.Response(200, json={'choices': [{'finish_reason': 'stop', 'message': {'content': 'broken'}}]})
            if failure == 'schema': return reply({'text': 'missing fields'})
            if failure == 'length': return httpx.Response(200, json={'choices': [{'finish_reason': 'length', 'message': {'content': '{}'}}]})
        return reply(ANSWER)
    monkeypatch.setattr(r.httpx, 'AsyncClient', lambda **kw: real(transport=httpx.MockTransport(upstream), **kw))
    assert json.loads(asyncio.run(module.call_ai(messages, response_schema=GUIDANCE_SCHEMA))) == ANSWER
    assert len(requests) == 2
    for req, body in requests:
        assert body['messages'] == messages
        assert body['response_format']['json_schema']['schema'] == GUIDANCE_SCHEMA
    assert requests[0][0].headers['authorization'] == 'Bearer primary-secret'
    assert requests[1][0].headers['authorization'] == 'Bearer backup-secret'
    assert requests[1][1]['enable_thinking'] is False
    assert 'reasoning' not in requests[1][1] and 'provider' not in requests[1][1]
    # Provider faults persist across restart; bad generated content does not
    # incorrectly disable the route for unrelated groups.
    if failure in ('empty', 'json', 'schema', 'length'):
        assert r.available('structured', 'https://openrouter.ai/api/v1/deepseek/test')
        return
    r._circuits.clear()
    assert json.loads(asyncio.run(module.call_ai(messages, response_schema=GUIDANCE_SCHEMA))) == ANSWER
    assert len(requests) == 3 and requests[-1][0].url.host == 'dashscope.aliyuncs.com'


@pytest.mark.parametrize('ending', ['eof', 'error', 'length', 'no_content', 'stall_after_content'])
def test_stream_failure_never_exposes_or_combines_partial_answers(env, monkeypatch, ending):
    module, _ = env; configure(monkeypatch); real = httpx.AsyncClient
    shown = []; calls = []
    class Failing(httpx.AsyncByteStream):
        async def __aiter__(self):
            if ending == 'no_content':
                await asyncio.sleep(1)
            else:
                yield frame('{"text":"不应出现的半截回答。')
                if ending == 'stall_after_content': await asyncio.sleep(1)
                elif ending == 'error': yield b'data: {"error":{"code":503}}\n\n'
                elif ending == 'length': yield frame(reason='length')
    def upstream(req):
        calls.append(req.url.host)
        if req.url.host == 'openrouter.ai': return httpx.Response(200, stream=Failing())
        return httpx.Response(200, stream=Bytes([frame(json.dumps(ANSWER)), frame(reason='stop'), b'data: [DONE]\n\n']))
    monkeypatch.setattr(r.httpx, 'AsyncClient', lambda **kw: real(transport=httpx.MockTransport(upstream), **kw))
    async def emit(delta): shown.append(delta)
    answer = asyncio.run(module.call_ai([{'role': 'user', 'content': 'test'}], response_schema=GUIDANCE_SCHEMA, on_delta=emit))
    assert json.loads(answer) == ANSWER and shown == []
    assert len(calls) == 2


def test_both_routes_fail_are_bounded_and_cancellation_never_retries(env, monkeypatch):
    module, _ = env; configure(monkeypatch); real = httpx.AsyncClient; calls = []
    def failure(req): calls.append(req.url.host); return httpx.Response(503)
    monkeypatch.setattr(r.httpx, 'AsyncClient', lambda **kw: real(transport=httpx.MockTransport(failure), **kw))
    with pytest.raises(HTTPException) as error: asyncio.run(module.call_ai([{'role': 'user', 'content': 'test'}]))
    assert error.value.status_code == 503 and len(calls) == 2
    with pytest.raises(HTTPException): asyncio.run(module.call_ai([{'role': 'user', 'content': 'test'}]))
    assert len(calls) == 2  # No storms when both providers are down.
    monkeypatch.setattr(r, 'available', lambda *args: True)
    async def cancel(req): calls.append(req.url.host); raise asyncio.CancelledError()
    monkeypatch.setattr(r.httpx, 'AsyncClient', lambda **kw: real(transport=httpx.MockTransport(cancel), **kw))
    with pytest.raises(asyncio.CancelledError): asyncio.run(module.call_ai([{'role': 'user', 'content': 'test'}]))
    assert len(calls) == 3


def test_bad_request_does_not_trip_or_switch_and_cooldown_expires(env, monkeypatch):
    module, _ = env; configure(monkeypatch); real = httpx.AsyncClient; calls = []
    def bad(req): calls.append(req.url.host); return httpx.Response(400)
    monkeypatch.setattr(r.httpx, 'AsyncClient', lambda **kw: real(transport=httpx.MockTransport(bad), **kw))
    with pytest.raises(HTTPException): asyncio.run(module.call_ai([{'role': 'user', 'content': 'test'}]))
    assert len(calls) == 1 and r.available('structured', 'https://openrouter.ai/api/v1/deepseek/test')
    monkeypatch.setenv('AI_FAILOVER_HOLD_UNTIL', '')
    monkeypatch.setenv('AI_FAILOVER_COOLDOWN_SECONDS', '10')
    now = time.time(); monkeypatch.setattr(r.time, 'time', lambda: now)
    r.trip('speech', 'test', primary=False)
    assert not r.available('speech', 'test')
    monkeypatch.setattr(r.time, 'time', lambda: now + 11)
    assert r.available('speech', 'test')


def test_six_groups_retry_chats_and_scores_exactly_once_with_context(env, monkeypatch):
    module, c = env; lid = start(c, monkeypatch, 2); configure(monkeypatch)
    monkeypatch.setenv('AI_FIRST_CONTENT_SECONDS', '2')
    monkeypatch.setenv('AI_CHAT_ATTEMPT_SECONDS', '5')
    monkeypatch.setenv('AI_TASK_ATTEMPT_SECONDS', '5')
    monkeypatch.setenv('AI_TOTAL_SECONDS', '12')
    real = httpx.AsyncClient; requests = []; failed = False
    async def upstream(req):
        body = json.loads(req.content); requests.append((req.url.host, body))
        if failed and req.url.host == 'openrouter.ai':
            await asyncio.sleep(.02)  # All six enter the failing route together.
            return httpx.Response(503)
        properties = body['response_format']['json_schema']['schema']['properties']
        if 'overview' in properties: return reply({'overview': '各组已有方案。', 'issues': [], 'discussion': []})
        if 'items' in properties: return reply(scoring())
        if body.get('stream'):
            return httpx.Response(200, stream=Bytes([frame(json.dumps(ANSWER)), frame(reason='stop'), b'data: [DONE]\n\n']))
        return reply(ANSWER)
    monkeypatch.setattr(r.httpx, 'AsyncClient', lambda **kw: real(transport=httpx.MockTransport(upstream), **kw))
    cookies = {}
    for group in range(1, 7):
        c.cookies.clear(); student(c, group); cookies[group] = dict(c.cookies)
        seed = c.post('/api/classroom/chats', json={'lesson_id': lid, 'stage': 2,
            'message': f'本组历史标记GROUP{group}', 'request_id': str(uuid.uuid4())})
        assert seed.status_code == 201, seed.text
    failed = True

    async def run():
        async def group_job(group):
            async with real(transport=httpx.ASGITransport(app=module.app), base_url='http://testserver',
                cookies=cookies[group], headers={'X-Workbench': '1', 'Origin': 'http://testserver'}) as client:
                body = {'lesson_id': lid, 'stage': 2, 'message': f'继续讨论GROUP{group}', 'request_id': str(uuid.uuid4())}
                responses = await asyncio.gather(*[client.post('/api/classroom/chats', json=body, headers={'Accept':'text/event-stream'}) for _ in range(2)])
                assert all(x.status_code in (201, 409) for x in responses)
                wires = ''.join(x.text for x in responses)
                assert 'event: text' not in wires and 'event: done' in wires
                for block in wires.split('\n\n'):
                    if block.startswith('event: error'):
                        assert json.loads(block.split('\ndata: ', 1)[1])['status'] == 409
                cached = await client.post('/api/classroom/chats', json=body)
                assert cached.status_code == 201, cached.text
                again = await client.post('/api/classroom/chats', json=body)
                assert cached.json() == again.json()
                submission = {'fields': {'design': '膨大期用GA3，成熟期适当控水，高温时减少激素处理。'},
                              'revision': 0, 'request_id': str(uuid.uuid4())}
                scores = await asyncio.gather(*[client.post(f'/api/classroom/lessons/{lid}/stages/2/submissions', json=submission) for _ in range(2)])
                assert all(x.status_code == 201 for x in scores), [x.text for x in scores]
                assert scores[0].json()['submission_id'] == scores[1].json()['submission_id']
                vid = scores[0].json()['submission_id']
                assert (await client.post(f'/api/classroom/lessons/{lid}/assessments/{vid}/retry')).status_code == 409
        await asyncio.gather(*(group_job(g) for g in range(1, 7)))
    asyncio.run(run())
    backups = [body for host, body in requests if host == 'dashscope.aliyuncs.com']
    chats = [body for body in backups if body.get('stream')]
    assert len(chats) == 6
    for body in chats:
        current = body['messages'][-1]['content']; group = current.split('GROUP')[1]
        history = json.dumps(body['messages'], ensure_ascii=False)
        assert f'历史标记GROUP{group}' in history and ANSWER['text'] in history
        assert all(f'历史标记GROUP{other}' not in history for other in range(1, 7) if str(other) != group)
    graders = [b for b in backups if 'items' in b['response_format']['json_schema']['schema']['properties']]
    assert len(graders) == 6
    with module.engine.connect() as db:
        assert db.execute(text('select count(*) from classroom_chats')).scalar() == 12
        assert db.execute(text("select count(*) from lesson_chat_requests where result='' ")).scalar() == 0
        assert db.execute(text('select count(*) from lesson_work_versions')).scalar() == 6
        assert db.execute(text("select count(*) from lesson_assessments where status='ready' ")).scalar() == 6


def test_six_speech_requests_fallback_and_replay_without_new_transcription(env, monkeypatch):
    module, c = env; lid = start(c, monkeypatch); configure(monkeypatch)
    monkeypatch.setenv('STT_PROVIDER', 'dashscope'); monkeypatch.setenv('STT_MODEL', 'qwen-primary')
    calls = []; real = httpx.AsyncClient
    async def pcm(audio, fmt): return b'\x00\x00' * 1600
    async def broken(*args): await asyncio.sleep(.02); raise HTTPException(504, 'test timeout')
    monkeypatch.setattr(r.qwen_speech, 'to_pcm', pcm)
    monkeypatch.setattr(r.qwen_speech, 'transcribe', broken)
    async def upstream(req):
        body = json.loads(req.content); calls.append(body)
        assert req.headers['authorization'] == 'Bearer primary-secret'
        assert body['model'] == 'qwen/qwen3-asr-0.6b' and body['input_audio']['format'] == 'wav'
        return httpx.Response(200, json={'text': '葡萄百粒质量'})
    monkeypatch.setattr(r.httpx, 'AsyncClient', lambda **kw: real(transport=httpx.MockTransport(upstream), **kw))
    cookies = {}
    for g in range(1, 7): c.cookies.clear(); student(c, g); cookies[g] = dict(c.cookies)
    async def run():
        async def job(group):
            async with real(transport=httpx.ASGITransport(app=module.app), base_url='http://testserver',
                cookies=cookies[group], headers={'X-Workbench':'1','Origin':'http://testserver'}) as client:
                data = {'lesson_id': lid, 'stage': 1, 'request_id': str(uuid.uuid4())}
                files = {'file': ('test.wav', b'RIFF0000WAVE' + b'0'*100)}
                first = await client.post('/api/classroom/transcriptions', data=data, files=files)
                assert first.status_code == 200, first.text
                assert (await client.post('/api/classroom/transcriptions', data=data, files=files)).json() == first.json()
                bad = {'file': ('test.wav', b'RIFF0000WAVE' + b'1'*100)}
                assert (await client.post('/api/classroom/transcriptions', data=data, files=bad)).status_code == 409
        await asyncio.gather(*(job(g) for g in range(1, 7)))
    asyncio.run(run())
    assert len(calls) == 6
    with module.engine.connect() as db:
        assert db.execute(text('select count(*) from classroom_transcriptions')).scalar() == 6


def test_failed_and_cancelled_chat_can_retry_same_id_without_losing_history(env, monkeypatch):
    module, c = env; lid = start(c, monkeypatch, 2); configure(monkeypatch); student(c, 1)
    real = httpx.AsyncClient; mode = 'fail'; started = None
    async def upstream(req):
        if mode == 'cancel':
            started.set(); await asyncio.sleep(10)
        if mode == 'fail': return httpx.Response(503)
        return reply(ANSWER)
    monkeypatch.setattr(r.httpx, 'AsyncClient', lambda **kw: real(transport=httpx.MockTransport(upstream), **kw))
    body = {'lesson_id':lid,'stage':2,'message':'需要保留的问题','request_id':str(uuid.uuid4())}
    failed = c.post('/api/classroom/chats', json=body)
    assert failed.status_code == 503
    with module.engine.connect() as db:
        assert db.execute(text('select count(*) from classroom_chats')).scalar() == 0
        assert db.execute(text('select count(*) from lesson_chat_requests')).scalar() == 0
    monkeypatch.setattr(r, 'available', lambda *args: True)
    mode = 'cancel'
    async def run():
        nonlocal started
        started = asyncio.Event()
        async with real(transport=httpx.ASGITransport(app=module.app),base_url='http://testserver',
                        cookies=dict(c.cookies),headers={'X-Workbench':'1','Origin':'http://testserver'}) as client:
            operation = asyncio.create_task(client.post('/api/classroom/chats',json=body))
            await started.wait();operation.cancel()
            with pytest.raises(asyncio.CancelledError): await operation
    asyncio.run(run())
    mode = 'success'
    result = c.post('/api/classroom/chats',json=body)
    assert result.status_code == 201,result.text
    assert c.post('/api/classroom/chats',json=body).json() == result.json()
    with module.engine.connect() as db:
        assert db.execute(text('select count(*) from classroom_chats')).scalar() == 1
        assert db.execute(text('select count(*) from lesson_chat_requests')).scalar() == 1


@pytest.mark.parametrize('failure', ['timeout','blank','provider'])
def test_speech_timeout_and_empty_result_switch_but_bad_audio_does_not(env, monkeypatch, failure):
    _, _ = env; configure(monkeypatch); real=httpx.AsyncClient; calls=[]
    async def pcm(*args): return b'\x00\x00'*1600
    async def primary(*args):
        if failure=='timeout': await asyncio.sleep(1)
        if failure=='blank': return ''
        raise HTTPException(503,'synthetic provider failure')
    def backup(req): calls.append(req.url.host);return httpx.Response(200,json={'text':'葡萄'})
    monkeypatch.setattr(r.qwen_speech,'to_pcm',pcm)
    monkeypatch.setattr(r.qwen_speech,'transcribe',primary)
    monkeypatch.setattr(r.httpx,'AsyncClient',lambda **kw:real(transport=httpx.MockTransport(backup),**kw))
    assert asyncio.run(r.transcribe(b'test','wav','backup-secret','primary'))=='葡萄'
    assert len(calls)==1
    async def invalid(*args): raise HTTPException(422,'bad recording')
    monkeypatch.setattr(r.qwen_speech,'to_pcm',invalid)
    with pytest.raises(HTTPException) as error: asyncio.run(r.transcribe(b'bad','wav','backup-secret','primary'))
    assert error.value.status_code==422 and len(calls)==1


def test_backup_format_repair_is_bounded_and_never_includes_failed_output(env, monkeypatch):
    module,_=env;configure(monkeypatch);real=httpx.AsyncClient;calls=[]
    original=[{'role':'system','content':'课堂规则'},{'role':'user','content':'保留问题和上下文'}]
    def upstream(req):
        body=json.loads(req.content);calls.append(body)
        if req.url.host=='openrouter.ai':return httpx.Response(503)
        if len(calls)==2:return reply({'text':'FAILED_PARTIAL_DO_NOT_REUSE'})
        assert body['messages'][0]==original[0] and body['messages'][-1]==original[-1]
        assert 'FAILED_PARTIAL_DO_NOT_REUSE' not in json.dumps(body)
        assert 'JSON Schema' in body['messages'][1]['content']
        return reply(ANSWER)
    monkeypatch.setattr(r.httpx,'AsyncClient',lambda **kw:real(transport=httpx.MockTransport(upstream),**kw))
    assert json.loads(asyncio.run(module.call_ai(original,response_schema=GUIDANCE_SCHEMA)))==ANSWER
    assert len(calls)==3


def test_speech_backup_retries_transient_error_once_with_identical_audio(env, monkeypatch):
    _,_=env;configure(monkeypatch);real=httpx.AsyncClient;calls=[]
    async def pcm(*args):return b'\x00\x00'*1600
    async def primary(*args):raise HTTPException(503,'primary down')
    def upstream(req):
        calls.append(json.loads(req.content))
        return httpx.Response(503) if len(calls)==1 else httpx.Response(200,json={'text':'葡萄'})
    monkeypatch.setattr(r.qwen_speech,'to_pcm',pcm);monkeypatch.setattr(r.qwen_speech,'transcribe',primary)
    monkeypatch.setattr(r.httpx,'AsyncClient',lambda **kw:real(transport=httpx.MockTransport(upstream),**kw))
    assert asyncio.run(r.transcribe(b'audio','wav','backup-secret','primary'))=='葡萄'
    assert len(calls)==2 and calls[0]==calls[1]


def test_grounding_validation_can_switch_and_repair_before_any_result_is_returned(env,monkeypatch):
    module,_=env;configure(monkeypatch);real=httpx.AsyncClient;calls=[]
    def upstream(req):
        calls.append(json.loads(req.content))
        answer=dict(ANSWER,text='unsupported evidence') if len(calls)<3 else ANSWER
        return reply(answer)
    def validate(answer):
        if json.loads(answer)['text']!=ANSWER['text']:raise ValueError('ungrounded evidence')
    monkeypatch.setattr(r.httpx,'AsyncClient',lambda **kw:real(transport=httpx.MockTransport(upstream),**kw))
    answer=asyncio.run(module.call_ai([{'role':'system','content':'use original evidence'},
        {'role':'user','content':'original input'}],response_schema=GUIDANCE_SCHEMA,response_validator=validate))
    assert json.loads(answer)==ANSWER and len(calls)==3
    assert r.available('structured','https://openrouter.ai/api/v1/deepseek/test')
