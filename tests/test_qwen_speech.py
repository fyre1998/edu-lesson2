"""Exercise real audio conversion and a local DashScope-compatible WebSocket."""
import asyncio
import io
import json
import math
import struct
import subprocess
import uuid
import wave

import imageio_ffmpeg
import pytest
from fastapi import HTTPException
from websockets.asyncio.server import serve

from backend import qwen_speech as qwen
from test_app import env, classroom_login


def recording(seconds=0.2):
    output = io.BytesIO()
    with wave.open(output, 'wb') as audio:
        audio.setnchannels(2)
        audio.setsampwidth(2)
        audio.setframerate(48000)
        samples = [int(8000 * math.sin(2 * math.pi * 440 * i / 48000))
                   for i in range(int(seconds * 48000))]
        audio.writeframes(b''.join(struct.pack('<hh', sample, sample) for sample in samples))
    return output.getvalue()


@pytest.mark.parametrize(('fmt', 'options'), [
    ('wav', []), ('webm', ['-c:a', 'libopus', '-f', 'webm']),
    ('ogg', ['-c:a', 'libopus', '-f', 'ogg']),
    ('m4a', ['-c:a', 'aac', '-f', 'mp4', '-movflags', 'frag_keyframe+empty_moov']),
])
def test_real_browser_formats_become_mono_16khz_pcm(fmt, options):
    audio = recording()
    if options:
        audio = subprocess.run([imageio_ffmpeg.get_ffmpeg_exe(), '-hide_banner', '-loglevel', 'error',
                                '-i', 'pipe:0', *options, 'pipe:1'], input=audio,
                               capture_output=True, check=True, timeout=10).stdout
    pcm = asyncio.run(qwen.to_pcm(audio, fmt))
    # 200 ms, one channel, 16,000 samples/s, two bytes/sample (AAC adds padding).
    assert 6000 <= len(pcm) <= 9000
    assert not pcm.startswith(b'RIFF')
    values = struct.unpack('<' + 'h' * (len(pcm) // 2), pcm)
    assert max(values) > 5000 and min(values) < -5000


def test_corrupt_and_overlong_audio_are_rejected_before_upload(monkeypatch):
    with pytest.raises(HTTPException) as error:
        asyncio.run(qwen.to_pcm(b'RIFF' + b'broken' * 100, 'wav'))
    assert error.value.status_code == 422
    monkeypatch.setattr(qwen, 'MAX_SECONDS', 0.1)
    with pytest.raises(HTTPException) as error:
        asyncio.run(qwen.to_pcm(recording(), 'wav'))
    assert error.value.status_code == 413


def event(task_id, name, **payload):
    return json.dumps({'header': {'task_id': task_id, 'event': name}, 'payload': payload})


def result(task_id, number, text, final=True, **extra):
    return event(task_id, 'result-generated', output={'sentence': {
        'sentence_id': number, 'text': text, 'sentence_end': final, **extra}})


def test_websocket_handshake_binary_audio_and_final_sentence_revisions(monkeypatch):
    async def scenario():
        received = bytearray()
        requests = []

        async def upstream(socket):
            requests.append(dict(socket.request.headers))
            start = json.loads(await socket.recv())
            requests.append(start)
            task_id = start['header']['task_id']
            # Audio must wait for the task-started acknowledgment.
            with pytest.raises(TimeoutError):
                await asyncio.wait_for(socket.recv(), 0.03)
            await socket.send(event(task_id, 'task-started'))
            await socket.send(result(task_id, 1, '不应拼接的中间结果', final=False))
            await socket.send(result(task_id, 0, '心跳内容', heartbeat=True))
            while True:
                frame = await socket.recv()
                if isinstance(frame, bytes):
                    assert len(frame) <= 3200
                    received.extend(frame)
                    continue
                finish = json.loads(frame)
                assert finish['header'] == {'task_id': task_id, 'action': 'finish-task', 'streaming': 'duplex'}
                assert finish['payload'] == {'input': {}}
                break
            await socket.send(result(task_id, 2, '赤霉素促进生长。'))
            await socket.send(result(task_id, 1, '旧文本'))
            await socket.send(result(task_id, 1, '生长素与'))
            await socket.send(event(task_id, 'task-finished'))

        async with serve(upstream, '127.0.0.1', 0) as server:
            port = server.sockets[0].getsockname()[1]
            monkeypatch.setattr(qwen, 'connection_settings', lambda: (f'ws://127.0.0.1:{port}', {}))
            text = await qwen.transcribe(recording(), 'wav', 'test-secret')
        assert text == '生长素与赤霉素促进生长。'
        assert len(received) == 6400
        assert requests[0]['authorization'] == 'Bearer test-secret'
        payload = requests[1]['payload']
        assert payload['model'] == 'qwen-audio-3.1-asr-flash-message'
        assert payload['parameters']['format'] == 'pcm'
        assert payload['parameters']['sample_rate'] == 16000
        assert payload['parameters']['disfluency_removal_enabled'] is False

    asyncio.run(scenario())


@pytest.mark.parametrize('failure', ['denied', 'timeout', 'disconnect', 'malformed'])
def test_websocket_failures_never_return_partial_text_or_sensitive_details(monkeypatch, caplog, failure):
    async def scenario():
        async def upstream(socket):
            start = json.loads(await socket.recv())
            task_id = start['header']['task_id']
            if failure == 'denied':
                await socket.send(json.dumps({'header': {'task_id': task_id, 'event': 'task-failed',
                    'error_code': 'InvalidApiKey', 'error_message': 'private-upstream-details'}}))
                return
            await socket.send(event(task_id, 'task-started'))
            if failure == 'malformed':
                await socket.send(json.dumps(['private-upstream-details']))
                return
            await socket.send(result(task_id, 1, '尚未完整的文字'))
            if failure == 'timeout':
                await asyncio.sleep(0.2)

        monkeypatch.setattr(qwen, 'EVENT_TIMEOUT', 0.07)
        async with serve(upstream, '127.0.0.1', 0) as server:
            port = server.sockets[0].getsockname()[1]
            monkeypatch.setattr(qwen, 'connection_settings', lambda: (f'ws://127.0.0.1:{port}', {}))
            with pytest.raises(HTTPException) as error:
                await qwen.transcribe(recording(), 'wav', 'private-api-key')
        assert error.value.status_code == (504 if failure == 'timeout' else 502)
        assert 'private-api-key' not in caplog.text + error.value.detail
        assert 'private-upstream-details' not in caplog.text + error.value.detail
        assert '尚未完整的文字' not in error.value.detail

    asyncio.run(scenario())


def test_cancelling_transcription_closes_websocket(monkeypatch):
    async def scenario():
        started, closed = asyncio.Event(), asyncio.Event()

        async def upstream(socket):
            start = json.loads(await socket.recv())
            await socket.send(event(start['header']['task_id'], 'task-started'))
            await socket.recv()
            started.set()
            await socket.wait_closed()
            closed.set()

        async with serve(upstream, '127.0.0.1', 0) as server:
            port = server.sockets[0].getsockname()[1]
            monkeypatch.setattr(qwen, 'connection_settings', lambda: (f'ws://127.0.0.1:{port}', {}))
            task = asyncio.create_task(qwen.transcribe(recording(), 'wav', 'test-key'))
            await asyncio.wait_for(started.wait(), 5)
            task.cancel()
            with pytest.raises(asyncio.CancelledError):
                await task
            await asyncio.wait_for(closed.wait(), 5)

    asyncio.run(scenario())


@pytest.mark.parametrize(('region', 'workspace', 'host'), [
    ('cn-beijing', '', 'dashscope.aliyuncs.com'),
    ('ap-southeast-1', '', 'dashscope-intl.aliyuncs.com'),
    ('cn-beijing', 'workspace-123', 'workspace-123.cn-beijing.maas.aliyuncs.com'),
])
def test_credentials_only_go_to_official_region_endpoints(monkeypatch, region, workspace, host):
    monkeypatch.setenv('DASHSCOPE_REGION', region)
    monkeypatch.setenv('DASHSCOPE_WORKSPACE_ID', workspace)
    url, headers = qwen.connection_settings()
    assert url == f'wss://{host}/api-ws/v1/inference'
    assert headers == ({'X-DashScope-WorkSpace': workspace} if workspace else {})
    monkeypatch.setenv('DASHSCOPE_WORKSPACE_ID', 'host.example/path')
    with pytest.raises(HTTPException):
        qwen.connection_settings()


def test_qwen_route_credentials_idempotency_and_failure_recovery(env, monkeypatch):
    _, client = env
    monkeypatch.setenv('CLASSROOM_CODE', 'BIO-302')
    monkeypatch.setenv('CLASSROOM_TEACHER_PASSWORD', 'teacher-test-password')
    classroom_login(client, teacher=True)
    lid = client.post('/api/classroom/lessons', json={'flow_version': 5}).json()['id']
    monkeypatch.setenv('STT_PROVIDER', 'dashscope')
    monkeypatch.setenv('AI_API_KEY', 'must-not-be-used')
    calls = []
    fail = False

    async def recognize(audio, fmt, key, model):
        calls.append((fmt, key, model))
        if fail:
            raise HTTPException(504, '语音识别超时')
        return ' 生长素与赤霉素。 '

    monkeypatch.setattr(qwen, 'transcribe', recognize)
    body = {'lesson_id': lid, 'stage': 1, 'request_id': str(uuid.uuid4())}

    def post():
        return client.post('/api/classroom/transcriptions', data=body,
                           files={'file': ('speech.wav', recording())})

    # The AI provider's key must never be used for DashScope authentication.
    assert post().status_code == 503 and not calls
    monkeypatch.setenv('DASHSCOPE_API_KEY', 'dashscope-test-key')
    first = post()
    assert first.status_code == 200, first.text
    assert first.json()['text'] == '生长素与赤霉素。'
    assert post().json() == first.json()
    assert calls == [('wav', 'dashscope-test-key', qwen.MODEL)]
    body['request_id'] = str(uuid.uuid4())
    fail = True
    assert post().status_code == 504
    fail = False
    assert post().status_code == 200  # Failure released the group's in-flight lock.
    # A qwen-audio model selects the official route even without an explicit provider.
    monkeypatch.setenv('STT_PROVIDER', '')
    monkeypatch.setenv('STT_MODEL', qwen.MODEL)
    body['request_id'] = str(uuid.uuid4())
    classroom_login(client)
    assert post().status_code == 200
    assert len(calls) == 4
