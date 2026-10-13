"""DashScope ASR for browser recordings; audio stays in memory."""
import asyncio
import json
import logging
import os
import re
import subprocess
import uuid

import imageio_ffmpeg
from fastapi import HTTPException
from websockets.asyncio.client import connect
from websockets.exceptions import InvalidStatus, WebSocketException

MODEL = 'qwen-audio-3.1-asr-flash-message'
SAMPLE_RATE = 16000
MAX_SECONDS = 95  # Allow a little recorder scheduling delay beyond the UI's 90 s.
TASK_TIMEOUT = 90
EVENT_TIMEOUT = 30
logger = logging.getLogger(__name__)
# The transport's DEBUG logs contain authorization headers and audio frames.
_wire_logger = logging.Logger('qwen-speech-wire', level=logging.CRITICAL + 1)


def connection_settings():
    region = os.getenv('DASHSCOPE_REGION', 'cn-beijing').strip() or 'cn-beijing'
    hosts = {'cn-beijing': 'dashscope.aliyuncs.com',
             'ap-southeast-1': 'dashscope-intl.aliyuncs.com'}
    if region not in hosts:
        raise HTTPException(503, '语音服务地域配置无效，请联系教师检查')
    workspace = os.getenv('DASHSCOPE_WORKSPACE_ID', '').strip()
    headers = {}
    if workspace:
        if not re.fullmatch(r'[A-Za-z0-9-]+', workspace):
            raise HTTPException(503, '语音服务业务空间配置无效，请联系教师检查')
        host = f'{workspace}.{region}.maas.aliyuncs.com'
        headers['X-DashScope-WorkSpace'] = workspace
    else:
        host = hosts[region]
    return f'wss://{host}/api-ws/v1/inference', headers


async def to_pcm(audio, fmt):
    """Decode WebM/Ogg/MP4/WAV into mono PCM16 without temporary audio files."""
    demuxer = {'webm': 'matroska', 'ogg': 'ogg', 'm4a': 'mov', 'wav': 'wav'}[fmt]
    try:
        executable = imageio_ffmpeg.get_ffmpeg_exe()
        process = await asyncio.create_subprocess_exec(
            executable, '-hide_banner', '-loglevel', 'error', '-nostdin',
            '-protocol_whitelist', 'pipe', '-f', demuxer, '-i', 'pipe:0',
            '-t', str(MAX_SECONDS + 1), '-map', '0:a:0', '-vn', '-threads', '1',
            '-ac', '1', '-ar', str(SAMPLE_RATE), '-acodec', 'pcm_s16le',
            '-f', 's16le', 'pipe:1', stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL,
            creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0)
    except (OSError, RuntimeError):
        raise HTTPException(503, '录音转换组件不可用，请联系教师检查语音服务安装') from None
    try:
        pcm, _ = await asyncio.wait_for(process.communicate(audio), timeout=20)
    except TimeoutError:
        raise HTTPException(422, '录音处理超时，请缩短录音后重试') from None
    finally:
        if process.returncode is None:
            process.kill()
            await process.wait()
    if process.returncode or len(pcm) < 32:
        raise HTTPException(422, '无法读取录音，请重新录制后重试')
    if len(pcm) > MAX_SECONDS * SAMPLE_RATE * 2:
        raise HTTPException(413, '录音时长超过限制，请在90秒内分段说话')
    return pcm


def provider_error(code):
    """Map errors without exposing upstream messages, credentials or payloads."""
    normalized = re.sub(r'[^a-z0-9]', '', str(code).lower())
    if normalized in {'401', '403', 'invalidapikey', 'unauthorized', 'forbidden',
                      'authenticationfailed', 'accessdenied'}:
        return HTTPException(502, '千问语音服务鉴权失败，请联系教师检查北京或新加坡地域的密钥及模型权限；仍可打字输入')
    if normalized in {'429', 'throttling', 'throttlingratelimit', 'toomanyrequests'}:
        return HTTPException(503, '语音服务繁忙，请稍后重试或打字输入')
    if normalized in {'404', 'modelnotfound', 'modelnotavailable'}:
        return HTTPException(503, '语音模型当前没有可用服务，请联系教师检查模型权限；仍可打字输入')
    return HTTPException(502, '千问语音服务暂时不可用，请重试或联系教师检查转写配置；仍可打字输入')


async def _event(socket, task_id):
    data = json.loads(await asyncio.wait_for(socket.recv(), timeout=EVENT_TIMEOUT))
    if not isinstance(data, dict) or not isinstance(data.get('header'), dict):
        raise ValueError('Invalid speech event')
    header = data['header']
    if header.get('task_id') != task_id:
        raise ValueError('Unexpected speech task')
    if header.get('event') == 'task-failed':
        logger.warning('DashScope speech task failed')
        raise provider_error(header.get('error_code', ''))
    return data


async def transcribe(audio, fmt, api_key, model=MODEL):
    url, headers = connection_settings()
    headers['Authorization'] = 'Bearer ' + api_key
    pcm = await to_pcm(audio, fmt)
    task_id = uuid.uuid4().hex
    try:
        async with asyncio.timeout(TASK_TIMEOUT):
            async with connect(url, additional_headers=headers, open_timeout=15,
                               close_timeout=3, max_size=1024 * 1024,
                               logger=_wire_logger) as socket:
                await socket.send(json.dumps({
                    'header': {'action': 'run-task', 'task_id': task_id, 'streaming': 'duplex'},
                    'payload': {'task_group': 'audio', 'task': 'asr', 'function': 'recognition',
                                'model': model, 'parameters': {'format': 'pcm', 'sample_rate': SAMPLE_RATE,
                                    'intermediate_result_enabled': False, 'disfluency_removal_enabled': False},
                                'input': {}}}))
                if (await _event(socket, task_id))['header'].get('event') != 'task-started':
                    raise ValueError('Speech task did not start')

                async def send_audio():
                    # Each frame contains 100 ms of PCM; yield so results are drained concurrently.
                    for offset in range(0, len(pcm), 3200):
                        await socket.send(pcm[offset:offset + 3200])
                        await asyncio.sleep(0)
                    await socket.send(json.dumps({
                        'header': {'action': 'finish-task', 'task_id': task_id, 'streaming': 'duplex'},
                        'payload': {'input': {}}}))

                async def receive_text():
                    sentences = {}
                    while True:
                        event = await _event(socket, task_id)
                        kind = event['header'].get('event')
                        if kind == 'task-finished':
                            return ''.join(sentences[key] for key in sorted(sentences))
                        if kind != 'result-generated':
                            continue
                        payload = event.get('payload')
                        output = payload.get('output') if isinstance(payload, dict) else None
                        sentence = output.get('sentence') if isinstance(output, dict) else None
                        if not isinstance(sentence, dict):
                            raise ValueError('Invalid speech result')
                        if sentence.get('heartbeat') or sentence.get('sentence_end') is not True:
                            continue
                        number, text = sentence.get('sentence_id'), sentence.get('text')
                        if type(number) is not int or number < 1 or not isinstance(text, str):
                            raise ValueError('Invalid speech sentence')
                        sentences[number] = text
                        if sum(map(len, sentences.values())) > 12000:
                            raise HTTPException(422, '语音文字过长，请分段说话')

                tasks = [asyncio.create_task(send_audio()), asyncio.create_task(receive_text())]
                try:
                    _, text = await asyncio.gather(*tasks)
                    return text
                finally:
                    for task in tasks:
                        task.cancel()
                    await asyncio.gather(*tasks, return_exceptions=True)
    except InvalidStatus as error:
        logger.warning('DashScope speech handshake rejected: status=%s', error.response.status_code)
        raise provider_error(error.response.status_code) from None
    except TimeoutError:
        raise HTTPException(504, '语音识别超时，请重试或打字输入') from None
    except (WebSocketException, OSError, ValueError, TypeError):
        raise HTTPException(502, '语音转写连接失败，请重试或打字输入') from None
