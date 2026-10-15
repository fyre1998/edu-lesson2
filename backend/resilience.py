"""Bounded, sequential failover. No attempt writes classroom records or emits previews.

The deployment uses one worker. Circuit state is shared by its concurrent requests
and persisted on the existing data volume; it is not a distributed-worker lock.
"""
import asyncio
import base64
import copy
import hashlib
import io
import json
import logging
import os
from pathlib import Path
import threading
import time
import uuid
import wave
from datetime import datetime

import httpx
from fastapi import HTTPException
from jsonschema import Draft202012Validator, ValidationError

from .chat_stream import read_completion_stream
from . import qwen_speech

logger = logging.getLogger('uvicorn.error')
_lock = threading.Lock()
_circuits = {}


class InvalidModelResult(ValueError):
    pass


def enabled(kind):
    return os.getenv(kind + '_FAILOVER_ENABLED', '').lower() == 'true'


def seconds(name, default):
    try:
        value = float(os.getenv(name) or default)
        if not 0 < value <= 3600:
            raise ValueError()
        return value
    except ValueError:
        raise HTTPException(503, 'AI 备用服务的超时配置无效，请联系管理员') from None


def _path():
    return Path(os.getenv('DATA_DIR', 'data/lesson2')).resolve() / 'ai-circuits.json'


def _key(lane, route):
    return lane + ':' + hashlib.sha256(route.encode()).hexdigest()[:20]


def _state():
    path = _path()
    if path not in _circuits:
        try:
            saved = json.loads(path.read_text(encoding='utf-8'))
            _circuits[path] = {k: float(v) for k, v in saved.items() if isinstance(v, (int, float))}
        except (OSError, ValueError, TypeError, AttributeError):
            _circuits[path] = {}
    return _circuits[path]


def available(lane, route):
    with _lock:
        return _state().get(_key(lane, route), 0) <= time.time()


def trip(lane, route, *, primary):
    until = time.time() + seconds('AI_FAILOVER_COOLDOWN_SECONDS', 60)
    # Hold a failed primary through the public lesson; a failed backup gets only
    # a short cooldown so it can recover even if the primary remains unavailable.
    if primary and os.getenv('AI_FAILOVER_HOLD_UNTIL'):
        try:
            hold = datetime.fromisoformat(os.environ['AI_FAILOVER_HOLD_UNTIL'])
            if hold.tzinfo is None:
                raise ValueError()
            until = max(until, hold.timestamp())
        except ValueError:
            raise HTTPException(503, 'AI 备用服务的保持时间配置无效') from None
    with _lock:
        state = _state()
        key = _key(lane, route)
        state[key] = max(state.get(key, 0), until)
        path = _path()
        temporary = path.with_name(path.name + '.' + uuid.uuid4().hex + '.tmp')
        try:
            path.parent.mkdir(parents=True, exist_ok=True)
            temporary.write_text(json.dumps(state), encoding='utf-8')
            os.replace(temporary, path)
        except OSError:
            logger.error('ai_circuit_persistence_failed lane=%s', lane)
        finally:
            try:
                temporary.unlink(missing_ok=True)
            except OSError:
                pass


def retryable(error):
    if isinstance(error, httpx.HTTPStatusError):
        return error.response.status_code in (401, 402, 403, 404, 408, 429) or error.response.status_code >= 500
    if isinstance(error, HTTPException):
        return error.status_code in (502, 503, 504)
    return isinstance(error, (httpx.TransportError, TimeoutError, ValueError, KeyError, IndexError, TypeError, ValidationError))


async def attempt_routes(lane, routes, invoke, *, total):
    deadline = time.monotonic() + total
    request_id = uuid.uuid4().hex
    for index, (route_id, model) in enumerate(routes):
        if not available(lane, route_id):
            continue
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            break
        started = time.monotonic()
        try:
            async with asyncio.timeout(remaining):
                result = await invoke(index)
            logger.info('ai_failover %s', json.dumps(dict(request_id=request_id, lane=lane,
                attempt=index, model=model, outcome='success', elapsed_ms=round((time.monotonic()-started)*1000))))
            return result
        except asyncio.CancelledError:
            raise  # Browser cancellation must not start another paid request.
        except Exception as error:
            status = error.response.status_code if isinstance(error, httpx.HTTPStatusError) else getattr(error, 'status_code', None)
            logger.warning('ai_failover %s', json.dumps(dict(request_id=request_id, lane=lane,
                attempt=index, model=model, outcome='failure', error_type=type(error).__name__,
                status=status, elapsed_ms=round((time.monotonic()-started)*1000))))
            if isinstance(error, ValidationError):
                logger.warning('ai_schema_invalid validator=%s schema_path=%s',
                               error.validator, list(error.absolute_schema_path))
            if not retryable(error):
                raise HTTPException(502, 'AI 请求未能完成，请检查输入后重试') from None
            # Content/format failures concern this request, not provider health.
            # Do not disable a healthy route for all other classroom groups.
            if isinstance(error, (httpx.TransportError, httpx.HTTPStatusError, TimeoutError, HTTPException)):
                trip(lane, route_id, primary=index == 0)
    raise HTTPException(503, '主用和备用 AI 暂时未能完成请求，原有记录已保留，请稍后重试')


async def call_ai(messages, *, origin, json_output=False, response_schema=None,
                  on_delta=None, max_tokens=None, response_validator=None):
    try:
        budget = int(os.getenv('AI_MAX_TOKENS') or 8192) if max_tokens is None else max_tokens
        if type(budget) is not int or not 256 <= budget <= 32768:
            raise ValueError()
    except ValueError:
        raise HTTPException(503, 'AI 输出额度配置无效') from None
    # This adapter intentionally supports one tested, independent fallback only.
    fallback_base, _ = qwen_speech.connection_settings()
    fallback_base = fallback_base.replace('wss://', 'https://').split('/api-ws/')[0] + '/compatible-mode/v1'
    primary = (os.getenv('AI_BASE_URL', 'https://openrouter.ai/api/v1').rstrip('/'),
               os.getenv('AI_API_KEY', ''), os.getenv('AI_MODEL', ''))
    backup = (fallback_base, os.getenv('DASHSCOPE_API_KEY', ''),
              os.getenv('AI_FALLBACK_MODEL', 'qwen3.8-flash'))
    routes = [(base + '/' + model, model) for base, _, model in (primary, backup)]
    # Snapshot once. A retry receives identical system instructions, images and
    # history; failed output is never appended to this snapshot.
    snapshot = copy.deepcopy(messages)
    validator = Draft202012Validator(response_schema) if response_schema is not None else None
    lane = 'chat' if on_delta is not None else 'structured'
    attempt_timeout = seconds('AI_CHAT_ATTEMPT_SECONDS' if on_delta is not None else 'AI_TASK_ATTEMPT_SECONDS',
                              25 if on_delta is not None else 40)

    async def request_once(index, *, format_retry=False):
        base, key, model = (primary, backup)[index]
        if not key or not model:
            raise HTTPException(503, 'AI 服务未配置')
        payload = dict(model=model, messages=copy.deepcopy(snapshot), max_tokens=budget, temperature=0)
        if index == 0:
            effort = os.getenv('AI_REASONING_EFFORT', '').strip()
            if effort:
                payload['reasoning'] = {'effort': effort}
            if httpx.URL(base).host == 'openrouter.ai':
                payload['provider'] = {'require_parameters': True, 'allow_fallbacks': True}
                if os.getenv('AI_PROVIDER_SORT'):
                    payload['provider']['sort'] = os.environ['AI_PROVIDER_SORT']
        else:
            payload['enable_thinking'] = False
        if validator:
            payload['response_format'] = {'type': 'json_schema', 'json_schema': {
                'name': 'classroom_response', 'strict': True, 'schema': response_schema}}
            if format_retry:
                payload['messages'].insert(1, {'role': 'system', 'content':
                    '保持前述教学规则与原始证据。仅输出一个完全符合以下 JSON Schema 的对象；'
                    '不得增加字段，枚举值逐字使用指定值，注意数组数量和字符串长度限制。'
                    '证据引文必须逐字摘自本次输入，不能改写或编造；不确定的结论不要输出。'
                    '不要输出 Markdown。JSON Schema：' + json.dumps(response_schema, ensure_ascii=False)})
        elif json_output:
            payload['response_format'] = {'type': 'json_object'}
        headers = {'Authorization': 'Bearer ' + key}
        if index == 0:
            headers.update({'HTTP-Referer': origin, 'X-OpenRouter-Title': 'Zhiban Classroom'})
        # Streaming upstream permits a first-content deadline. Buffer every byte:
        # only the caller's final, domain-validated result will reach the browser.
        first_content = asyncio.Event()
        async def collect(delta):
            first_content.set()
        async with asyncio.timeout(attempt_timeout):
            async with httpx.AsyncClient(timeout=httpx.Timeout(attempt_timeout, connect=4)) as client:
                if on_delta is not None:
                    task = asyncio.create_task(read_completion_stream(client, base + '/chat/completions', headers, payload, collect))
                    waiter = asyncio.create_task(first_content.wait())
                    try:
                        done, _ = await asyncio.wait({task, waiter}, timeout=seconds('AI_FIRST_CONTENT_SECONDS', 10), return_when=asyncio.FIRST_COMPLETED)
                        if not done:
                            raise TimeoutError('no content')
                        answer = await task
                    finally:
                        task.cancel(); waiter.cancel()
                        await asyncio.gather(task, waiter, return_exceptions=True)
                else:
                    response = await client.post(base + '/chat/completions', headers=headers, json=payload)
                    response.raise_for_status()
                    data = response.json()
                    choice = data['choices'][0]
                    if choice.get('finish_reason') != 'stop':
                        raise ValueError('incomplete completion')
                    answer = choice['message']['content']
        if not isinstance(answer, str) or not answer.strip():
            raise ValueError('empty completion')
        if validator:
            validator.validate(json.loads(answer))
        elif json_output:
            if not isinstance(json.loads(answer), dict):
                raise ValueError('invalid JSON object')
        if response_validator is not None:
            try:
                response_validator(answer)
            except (ValueError, TypeError, KeyError, IndexError):
                raise InvalidModelResult('domain validation failed') from None
        return answer

    async def invoke(index):
        try:
            return await request_once(index)
        except (ValidationError, json.JSONDecodeError, InvalidModelResult):
            if index == 0:
                raise
            # One bounded formatting repair on the final route, within the same
            # total deadline. Never send the failed answer back as conversation.
            logger.warning('ai_format_retry model=%s', backup[2])
            return await request_once(index, format_retry=True)

    return await attempt_routes(lane, routes, invoke,
                                total=seconds('AI_TOTAL_SECONDS', 85))


async def transcribe(audio, fmt, api_key, model):
    # Validate/decode once before attempting any provider. Invalid recordings do
    # not trip a circuit. WAV is accepted by more fallback providers than WebM.
    pcm = await qwen_speech.to_pcm(audio, fmt)
    output = io.BytesIO()
    with wave.open(output, 'wb') as wav:
        wav.setnchannels(1); wav.setsampwidth(2); wav.setframerate(qwen_speech.SAMPLE_RATE)
        wav.writeframes(pcm)
    wav_audio = output.getvalue()
    backup_model = os.getenv('STT_FALLBACK_MODEL', 'qwen/qwen3-asr-0.6b')
    base = os.getenv('STT_FALLBACK_BASE_URL', 'https://openrouter.ai/api/v1').rstrip('/')
    backup_key = os.getenv('STT_FALLBACK_API_KEY') or os.getenv('AI_API_KEY', '')
    routes = [('dashscope/' + model, model), (base + '/' + backup_model, backup_model)]
    # Allow processing time for longer recordings without making short utterances
    # wait the old 90-second timeout before switching.
    duration = len(pcm) / (qwen_speech.SAMPLE_RATE * 2)
    primary_timeout = min(30, seconds('STT_PRIMARY_SECONDS', 10) + duration * .15)

    async def recognize_once(index):
        if index == 0:
            if not api_key:
                raise HTTPException(503, '语音主服务未配置')
            async with asyncio.timeout(primary_timeout):
                text = await qwen_speech.transcribe(wav_audio, 'wav', api_key, model)
        else:
            if not backup_key:
                raise HTTPException(503, '语音备用服务未配置')
            timeout = seconds('STT_BACKUP_SECONDS', 30)
            async with asyncio.timeout(timeout):
                async with httpx.AsyncClient(timeout=httpx.Timeout(timeout, connect=4)) as client:
                    response = await client.post(base + '/audio/transcriptions',
                        headers={'Authorization': 'Bearer ' + backup_key}, json={
                            'model': backup_model, 'language': 'zh', 'response_format': 'json',
                            'input_audio': {'data': base64.b64encode(wav_audio).decode(), 'format': 'wav'}})
                    response.raise_for_status()
                    text = response.json()['text']
        if not isinstance(text, str) or not text.strip() or len(text) > 12000:
            raise ValueError('invalid transcription')
        return text.strip()

    async def invoke(index):
        try:
            return await recognize_once(index)
        except Exception as error:
            # A fresh request can reach another upstream. One retry only, still
            # inside the total deadline, without a second transcription record.
            transient = isinstance(error, (httpx.TransportError, TimeoutError)) or (
                isinstance(error, httpx.HTTPStatusError) and
                (error.response.status_code in (408, 429) or error.response.status_code >= 500))
            if index == 0 or not transient:
                raise
            logger.warning('speech_backup_retry model=%s', backup_model)
            return await recognize_once(index)

    return await attempt_routes('speech', routes, invoke, total=seconds('STT_TOTAL_SECONDS', 65))
