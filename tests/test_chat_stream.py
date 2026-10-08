import asyncio
import json
import uuid

import httpx
import pytest
from sqlalchemy import text

from backend.chat_stream import GuidancePreview, partial_guidance_text, read_completion_stream
from test_app import env
from test_lesson_v2 import start, student


@pytest.mark.parametrize('prefix', ['{"text":', '{"step":1,"mastery":"私有记录","text":', '```json\n{"text":'])
def test_partial_json_handles_split_escapes_without_exposing_metadata(prefix):
    value = '请观察。\n"你好"😀下一步？'
    encoded = json.dumps(value, ensure_ascii=True)
    for pos in range(1, len(encoded) + 1):
        preview, complete = partial_guidance_text(prefix + encoded[:pos])
        assert value.startswith(preview)
        assert complete == (pos == len(encoded))
        assert '私有' not in preview
    assert partial_guidance_text('{"mastery":{"text":"hidden"},"text":"公开。"')[0] == '公开。'


def test_preview_checks_whole_sentences_before_emitting():
    async def run():
        shown = []
        async def emit(value): shown.append(value)
        guard = lambda value: '请先提出你们自己的判断。' if '答案是' in value else value
        preview = GuidancePreview(emit, guard, structured=True)
        await preview('{"text":"请观察。答')
        assert shown == ['请观察。']
        await preview('案是隐藏答案')
        assert len(shown) == 1
        await preview('。继续输出。","step":1,"mastery":"hidden"}')
        assert shown[-1] == '请先提出你们自己的判断。'
        assert all('隐藏答案' not in value and 'hidden' not in value for value in shown)
    asyncio.run(run())


def frame(content='', reason=None, **extra):
    return ('data: ' + json.dumps({'choices': [{'index': 0, 'delta': {'content': content},
                      'finish_reason': reason}], **extra}, ensure_ascii=False) + '\n\n').encode()


class Bytes(httpx.AsyncByteStream):
    def __init__(self, parts): self.parts = parts
    async def __aiter__(self):
        for part in self.parts:
            yield part


@pytest.mark.parametrize('ending', ['success', 'eof', 'length', 'error', 'missing_stop'])
def test_upstream_protocol_requires_complete_answer(ending):
    async def run():
        pieces = [b': OPENROUTER PROCESSING\n\n',
                  b'data: {"choices":[{"delta":{"reasoning":"private"}}]}\n\n', frame('你好。')]
        if ending == 'success':
            pieces += [frame(reason='stop'), b'data: {"choices":[],"usage":{"completion_tokens":8}}\n\n', b'data: [DONE]\n\n']
        elif ending == 'length': pieces += [frame(reason='length'), b'data: [DONE]\n\n']
        elif ending == 'error': pieces += [b'data: {"error":{"message":"provider issue"}}\n\n']
        elif ending == 'missing_stop': pieces += [b'data: [DONE]\n\n']
        calls = []
        async def emit(part): calls.append(part)
        async with httpx.AsyncClient(transport=httpx.MockTransport(lambda req: httpx.Response(200, stream=Bytes(pieces)))) as client:
            operation = read_completion_stream(client, 'https://provider.invalid/chat/completions', {}, {}, emit)
            if ending == 'success': assert await operation == '你好。'
            else:
                with pytest.raises(Exception): await operation
        assert calls == ['你好。']
    asyncio.run(run())


@pytest.mark.parametrize('outcome', ['success', 'disconnect', 'error', 'length'])
def test_chat_stream_is_visible_before_completion_and_recovers(env, monkeypatch, outcome):
    module, client = env
    lid = start(client, monkeypatch)
    student(client, 1)
    body = dict(lesson_id=lid, stage=1, message='请帮我们检查对照处理', request_id=str(uuid.uuid4()))
    monkeypatch.setenv('AI_API_KEY', 'test')
    monkeypatch.setenv('AI_MODEL', 'mock')
    real = httpx.AsyncClient
    answer = {'text': '请先说出本组的预测。你们准备如何设置对照？', 'step': 1, 'mastery': 'private'}
    calls = []

    async def run():
        first_text, release, disconnect = asyncio.Event(), asyncio.Event(), asyncio.Event()
        sent = []

        class Gated(httpx.AsyncByteStream):
            async def __aiter__(self):
                yield frame('{"text":"请先说出本组的预测。')
                await release.wait()
                if outcome == 'error':
                    yield b'data: {"error":{"message":"test"}}\n\n'
                elif outcome == 'length':
                    yield frame(reason='length')
                else:
                    yield frame('你们准备如何设置对照？","step":1,"mastery":"private"}')
                    yield frame(reason='stop')
                    yield b'data: [DONE]\n\n'

        def upstream(request):
            payload = json.loads(request.content)
            calls.append(payload)
            if payload.get('stream'):
                return httpx.Response(200, stream=Gated())
            return httpx.Response(200, json={'choices': [{'message': {'content': json.dumps(answer)}}]})

        monkeypatch.setattr(module.httpx, 'AsyncClient', lambda **kw: real(transport=httpx.MockTransport(upstream), **kw))
        request = client.build_request('POST', '/api/classroom/chats', json=body, headers={'Accept': 'text/event-stream'})
        scope = {'type': 'http', 'asgi': {'version': '3.0', 'spec_version': '2.3'},
                 'http_version': '1.1', 'method': 'POST', 'scheme': 'http',
                 'path': '/api/classroom/chats', 'raw_path': b'/api/classroom/chats', 'query_string': b'',
                 'root_path': '', 'headers': [(k.lower(), v) for k, v in request.headers.raw],
                 'client': ('127.0.0.1', 40000), 'server': ('testserver', 80)}
        delivered = False
        async def receive():
            nonlocal delivered
            if not delivered:
                delivered = True
                return {'type': 'http.request', 'body': request.content, 'more_body': False}
            await disconnect.wait()
            return {'type': 'http.disconnect'}

        async def send(event):
            sent.append(event)
            if event['type'] == 'http.response.body' and b'event: text' in event.get('body', b''):
                first_text.set()

        operation = asyncio.create_task(module.app(scope, receive, send))
        try:
            await asyncio.wait_for(first_text.wait(), 5)
            assert not operation.done()  # The model is still waiting at release.
            with module.engine.connect() as db:
                assert db.execute(text('select count(*) from classroom_chats')).scalar() == 0
            work_url = f'/api/classroom/lessons/{lid}/groups/1/stages/1'
            snapshot = await asyncio.to_thread(client.get, work_url)
            assert snapshot.json()['submission_wait'] == '等待 AI 回复…'
            submission = await asyncio.to_thread(client.post,
                f'/api/classroom/lessons/{lid}/stages/1/submissions',
                json={'fields': {}, 'revision': 0, 'request_id': str(uuid.uuid4())})
            assert submission.status_code == 409
            assert '等待 AI 回复' in submission.json()['detail']
            if outcome == 'disconnect': disconnect.set()
            else: release.set()
            await asyncio.wait_for(operation, 5)
            wire = b''.join(event.get('body', b'') for event in sent)
            assert b'private' not in wire
            assert (b'event: done' in wire) == (outcome == 'success')
            if outcome in ('error', 'length'): assert b'event: error' in wire
        finally:
            release.set()
            operation.cancel()
            await asyncio.gather(operation, return_exceptions=True)

    asyncio.run(run())
    retry = client.post('/api/classroom/chats', json=body)
    assert client.get(f'/api/classroom/lessons/{lid}/groups/1/stages/1').json()['submission_wait'] == ''
    assert retry.status_code == 201, retry.text
    cached = client.post('/api/classroom/chats', json=body, headers={'Accept': 'text/event-stream'})
    assert cached.json() == retry.json()
    assert len(calls) == (1 if outcome == 'success' else 2)
    with module.engine.connect() as db:
        assert db.execute(text('select count(*) from classroom_chats')).scalar() == 1
        assert db.execute(text("select count(*) from lesson_chat_requests where result = ''")).scalar() == 0


def test_streaming_grape_results_wait_for_validated_numbers(env, monkeypatch):
    from test_lesson_grape_v5 import start as grape_start
    module, client = env
    lid = grape_start(client, monkeypatch)
    student(client, 1)
    response = client.post('/api/classroom/chats', headers={'Accept': 'text/event-stream'}, json={
        'lesson_id': lid, 'stage': 1, 'message': 'C组：用CPPU10mg/L', 'request_id': str(uuid.uuid4())})
    assert response.status_code == 201
    assert 'event: text' not in response.text  # No unvalidated experiment JSON.
    block = next(b for b in response.text.split('\n\n') if b.startswith('event: done'))
    result = json.loads(block.split('\ndata: ', 1)[1])
    assert '300 ± 2.8 g' in result['answer'] and '170 ± 5.7 g' in result['answer']
