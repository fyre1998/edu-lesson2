"""Streaming transport and guarded previews for classroom conversations."""
import asyncio
import json
import logging
import re

import anyio
from fastapi import HTTPException
from fastapi.responses import StreamingResponse


async def read_completion_stream(client, url, headers, payload, on_delta, diagnostic=None):
    chunks = []
    finished = False
    async with client.stream('POST', url, headers=headers, json={**payload, 'stream': True}) as response:
        response.raise_for_status()
        data_lines = []
        async for line in response.aiter_lines():
            if line.startswith('data:'):
                data_lines.append(line[5:].lstrip(' '))
            elif not line and data_lines:
                raw = '\n'.join(data_lines)
                data_lines.clear()
                if raw == '[DONE]':
                    if not finished or not ''.join(chunks).strip():
                        raise ValueError('incomplete AI stream')
                    return ''.join(chunks)
                data = json.loads(raw)
                if not isinstance(data, dict) or data.get('error'):
                    raise HTTPException(502, 'AI 回复中断，请重试')
                if diagnostic is not None:
                    for field in ('id', 'model', 'provider'):
                        if isinstance(data.get(field), str):
                            diagnostic[field] = data[field][:160]
                    usage = data.get('usage')
                    if isinstance(usage, dict):
                        for field in ('prompt_tokens', 'completion_tokens', 'total_tokens'):
                            if type(usage.get(field)) is int:
                                diagnostic[field] = usage[field]
                for choice in data.get('choices', []):
                    if choice.get('index', 0) != 0:
                        continue
                    reason = choice.get('finish_reason')
                    if reason:
                        if diagnostic is not None:
                            diagnostic['finish_reason'] = reason
                        if reason == 'length':
                            raise HTTPException(502, 'AI 回复未完整生成，请重试或联系教师调整输出额度')
                        if reason != 'stop':
                            raise HTTPException(502, 'AI 回复中断，请重试')
                        finished = True
                    # Reasoning and provider metadata must never reach students.
                    content = (choice.get('delta') or {}).get('content')
                    if content is not None and not isinstance(content, str):
                        raise ValueError('invalid AI stream content')
                    if content:
                        chunks.append(content)
                        await on_delta(content)
    raise HTTPException(502, 'AI 回复连接中断，请重试')


def partial_guidance_text(raw):
    """Read only the top-level text string, including an unfinished JSON string."""
    raw = raw.lstrip()
    if raw.startswith('```'):
        if '\n' not in raw:
            return '', False
        raw = raw.split('\n', 1)[1].lstrip()
    if not raw.startswith('{'):
        return '', False
    decoder = json.JSONDecoder()
    pos = 1
    try:
        while True:
            while pos < len(raw) and raw[pos].isspace():
                pos += 1
            key, pos = decoder.raw_decode(raw, pos)
            if not isinstance(key, str):
                return '', False
            while pos < len(raw) and raw[pos].isspace():
                pos += 1
            if raw[pos] != ':':
                return '', False
            pos += 1
            while pos < len(raw) and raw[pos].isspace():
                pos += 1
            if key == 'text':
                if raw[pos] != '"':
                    return '', False
                start = pos
                pos += 1
                safe_end = pos
                complete = False
                while pos < len(raw):
                    if raw[pos] == '"':
                        complete = True
                        break
                    if raw[pos] == '\\':
                        size = 6 if raw[pos:pos + 2] == '\\u' else 2
                        if pos + size > len(raw):
                            break
                        pos += size
                    else:
                        pos += 1
                    safe_end = pos
                text = json.loads(raw[start:safe_end] + '"')
                # A Unicode surrogate pair may be split between upstream chunks.
                if text and 0xD800 <= ord(text[-1]) <= 0xDBFF:
                    text = text[:-1]
                return text, complete
            _, pos = decoder.raw_decode(raw, pos)
            while pos < len(raw) and raw[pos].isspace():
                pos += 1
            if raw[pos] != ',':
                return '', False
            pos += 1
    except (ValueError, IndexError):
        return '', False


class GuidancePreview:
    def __init__(self, emit, guard, *, structured):
        self.emit, self.guard, self.structured = emit, guard, structured
        self.raw = self.shown = ''
        self.blocked = False

    async def __call__(self, delta):
        self.raw += delta
        if self.blocked:
            return
        text, complete = partial_guidance_text(self.raw) if self.structured else (self.raw, False)
        if not complete:
            boundaries = list(re.finditer(r'[。！？!?\n]', text))
            if not boundaries:
                return
            text = text[:boundaries[-1].end()]
        if not text or text == self.shown:
            return
        guarded = self.guard(text)
        if guarded != text:
            self.blocked = True
        self.shown = guarded
        await self.emit(guarded)


def chat_stream_response(process):
    async def events():
        queue = asyncio.Queue(maxsize=32)

        async def emit(text):
            await queue.put(('text', {'text': text}))

        async def run():
            try:
                await queue.put(('done', await process(emit)))
            except HTTPException as error:
                await queue.put(('error', {'detail': error.detail, 'status': error.status_code}))
            except Exception:
                logging.getLogger(__name__).exception('classroom_chat_stream_failed')
                await queue.put(('error', {'detail': 'AI 回复暂未完成，请重试', 'status': 500}))

        worker = asyncio.create_task(run())
        try:
            yield ': connected\n\n'
            while True:
                try:
                    kind, data = await asyncio.wait_for(queue.get(), timeout=10)
                except TimeoutError:
                    yield ': keep-alive\n\n'
                    continue
                yield f'event: {kind}\ndata: {json.dumps(data, ensure_ascii=True)}\n\n'
                if kind in ('done', 'error'):
                    break
        finally:
            worker.cancel()
            # Starlette cancels its task group on disconnect. Still await the
            # request's rollback/lock cleanup before the DB dependency closes.
            with anyio.CancelScope(shield=True):
                await asyncio.gather(worker, return_exceptions=True)

    return StreamingResponse(events(), status_code=201, media_type='text/event-stream',
                             headers={'Cache-Control': 'no-cache, no-transform', 'X-Accel-Buffering': 'no'})
