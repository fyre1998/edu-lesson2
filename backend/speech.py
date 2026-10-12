"""Authenticated short-utterance transcription; audio is never archived."""
import asyncio
import base64
import hashlib
import json
import logging
import os
import time

import httpx
from fastapi import Depends, Form, HTTPException, UploadFile
from sqlalchemy import Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column

logger = logging.getLogger(__name__)
DEFAULT_STT_MODEL = 'qwen/qwen3-asr-1.7b'


def install_speech(router, Base, db, identity, lesson_api, rate_limit):
    class Transcription(Base):
        __tablename__ = 'classroom_transcriptions'
        key: Mapped[str] = mapped_column(String(64), primary_key=True)
        fingerprint: Mapped[str] = mapped_column(String(64))
        text: Mapped[str] = mapped_column(Text, default='')
        created: Mapped[int] = mapped_column(Integer, default=lambda:int(time.time()))

    running=set()
    slots=asyncio.Semaphore(8)

    @router.post('/transcriptions')
    async def transcribe(file:UploadFile,lesson_id:str=Form(...),stage:int=Form(...),request_id:str=Form(...),
                         user=Depends(identity),session=Depends(db)):
        if user.role not in ('student','teacher'):raise HTTPException(403,'请使用小组或教师身份录音')
        lesson=lesson_api.get(session,lesson_id,stage,write=True)
        if user.role=='teacher':
            if lesson_api.config(lesson)[0] not in (4,5) or stage!=1:
                raise HTTPException(403,'教师语音输入仅用于葡萄实验的第一环节')
            speaker=f'teacher:{user.name}'
        else:
            lesson_api.group_exists(lesson,user.group_id)
            speaker=user.group_id
        if not 8<=len(request_id)<=80:raise HTTPException(422,'录音请求编号无效')
        try: audio=await file.read(10*1024*1024+1)
        finally: await file.close()
        if len(audio)>10*1024*1024:raise HTTPException(413,'录音不能超过10 MB')
        if len(audio)<32:raise HTTPException(400,'录音为空或过短，请重新录音')
        fmt=('webm' if audio.startswith(b'\x1aE\xdf\xa3') else 'ogg' if audio.startswith(b'OggS') else
             'wav' if audio.startswith(b'RIFF') and audio[8:12]==b'WAVE' else 'm4a' if audio[4:8]==b'ftyp' else None)
        if not fmt:raise HTTPException(400,'录音格式不支持，请使用浏览器录音')
        key=hashlib.sha256(f'{lesson_id}:{speaker}:{stage}:{request_id}'.encode()).hexdigest()
        fingerprint=hashlib.sha256(audio).hexdigest()
        existing=session.get(Transcription,key)
        if existing:
            if existing.fingerprint!=fingerprint:raise HTTPException(409,'录音编号已用于其他内容')
            return {'text':existing.text,'request_id':request_id}
        if speaker in running:raise HTTPException(409,'还有一段语音正在转写，请稍候')
        api_key=os.getenv('STT_API_KEY') or os.getenv('AI_API_KEY')
        if not api_key:raise HTTPException(503,'语音转写尚未配置，仍可打字输入')
        rate_limit(('classroom-stt',speaker),80,3600)
        running.add(speaker)
        model=os.getenv('STT_MODEL') or DEFAULT_STT_MODEL
        try:
            async with slots:
                async with httpx.AsyncClient(timeout=70) as client:
                    reply=await client.post((os.getenv('STT_BASE_URL') or os.getenv('AI_BASE_URL','https://openrouter.ai/api/v1')).rstrip('/')+'/audio/transcriptions',
                        headers={'Authorization':'Bearer '+api_key},json={'model':model,
                            'language':'zh','input_audio':{'data':base64.b64encode(audio).decode(),'format':fmt},'response_format':'json'})
                if reply.status_code>=400:
                    # Log routing diagnostics only, never audio, keys, or upstream response bodies.
                    logger.warning('Speech provider rejected transcription: status=%s model=%s format=%s',reply.status_code,model,fmt)
                if reply.status_code in (401,403):raise HTTPException(502,'语音服务拒绝了当前配置，请联系教师检查转写模型与密钥；仍可打字输入')
                if reply.status_code==404:raise HTTPException(503,'语音模型当前没有可用服务，请联系教师更新转写配置；仍可打字输入')
                if reply.status_code==429:raise HTTPException(503,'语音服务繁忙，请稍后重试或打字输入')
                if reply.status_code>=400:raise HTTPException(502,'语音服务暂时不可用，请重试或打字输入')
                text=reply.json().get('text','')
                if not isinstance(text,str) or not text.strip():raise HTTPException(422,'没有识别到说话内容，请靠近麦克风重试')
                if len(text)>12000:raise HTTPException(422,'语音文字过长，请分段说话')
                session.expire_all();lesson_api.get(session,lesson_id,stage,write=True)
                session.add(Transcription(key=key,fingerprint=fingerprint,text=text.strip()));session.commit()
                return {'text':text.strip(),'request_id':request_id}
        except (httpx.HTTPError,ValueError,TypeError):raise HTTPException(502,'语音转写连接失败，请重试或打字输入') from None
        finally:running.discard(speaker)
