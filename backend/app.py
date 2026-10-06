import asyncio
import hashlib
import hmac
import json
import logging
import os
import secrets
import time
import threading
from collections import defaultdict, deque
from contextlib import asynccontextmanager
from pathlib import Path

import httpx
from dotenv import load_dotenv
from fastapi import FastAPI, Depends, HTTPException, Request, Response, UploadFile
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field
from sqlalchemy import String, Text, Integer, ForeignKey, select, delete, func
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, sessionmaker, Session

from .database import create_database_engine

ROOT = Path(__file__).resolve().parent.parent
load_dotenv(ROOT / '.env')
DATA = Path(os.getenv('DATA_DIR', str(ROOT / 'data' / 'lesson2')))
DATA = (ROOT / DATA).resolve() if not DATA.is_absolute() else DATA.resolve()
DATA.mkdir(parents=True, exist_ok=True)
UPLOADS = DATA / 'uploads'
UPLOADS.mkdir(exist_ok=True)
URL = os.getenv('DATABASE_URL', 'sqlite:///' + (DATA / 'app.db').as_posix())
ORIGIN = os.getenv('APP_ORIGIN', 'http://127.0.0.1:8015').rstrip('/')
SESSION_COOKIE = 'lesson2_session'
BASE_PATH = os.getenv('APP_BASE_PATH', '').rstrip('/')
COOKIE_PATH = BASE_PATH or '/'
SECURE = ORIGIN.startswith('https://')
MAX_FILE = 10 * 1024 * 1024
AI_REQUEST_TIMEOUT_SECONDS = 120
ai_logger = logging.getLogger('uvicorn.error')
engine = create_database_engine(URL)
SessionLocal = sessionmaker(engine, expire_on_commit=False)


class Base(DeclarativeBase):
    pass


class User(Base):
    __tablename__ = 'users'
    id: Mapped[int] = mapped_column(primary_key=True)
    username: Mapped[str] = mapped_column(String(40), unique=True)
    password: Mapped[str] = mapped_column(String(256))


class LoginSession(Base):
    __tablename__ = 'sessions'
    token: Mapped[str] = mapped_column(String(64), primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey('users.id'), index=True)
    expires: Mapped[int] = mapped_column(Integer)


class Note(Base):
    __tablename__ = 'notes'
    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey('users.id'), index=True)
    title: Mapped[str] = mapped_column(String(120))
    content: Mapped[str] = mapped_column(Text)
    updated: Mapped[int] = mapped_column(Integer, default=lambda: int(time.time()))


class StoredFile(Base):
    __tablename__ = 'files'
    id: Mapped[str] = mapped_column(String(32), primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey('users.id'), index=True)
    name: Mapped[str] = mapped_column(String(200))
    size: Mapped[int] = mapped_column(Integer)
    created: Mapped[int] = mapped_column(Integer, default=lambda: int(time.time()))


class Chat(Base):
    __tablename__ = 'chats'
    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey('users.id'), index=True)
    question: Mapped[str] = mapped_column(Text)
    answer: Mapped[str] = mapped_column(Text)
    created: Mapped[int] = mapped_column(Integer, default=lambda: int(time.time()))


@asynccontextmanager
async def lifespan(app):
    Base.metadata.create_all(engine)
    with SessionLocal() as session:
        classroom_router.lesson_api.repair_released_results(session)
    yield


app = FastAPI(title='个人工作台', lifespan=lifespan, docs_url=None, redoc_url=None)
limits = defaultdict(deque)
limit_lock = threading.Lock()


def rate_limit(key, count, seconds):
    now = time.monotonic()
    with limit_lock:
        # Single-worker baseline; use a shared limiter before scaling to multiple workers.
        if len(limits) > 10000:
            for old in list(limits):
                if not limits[old] or now - limits[old][-1] > 3600:
                    del limits[old]
        bucket = limits[key]
        while bucket and now - bucket[0] >= seconds:
            bucket.popleft()
        if len(bucket) >= count:
            raise HTTPException(429, '操作太频繁，请稍后再试')
        bucket.append(now)


@app.middleware('http')
async def protection(request, call_next):
    if request.method not in ('GET', 'HEAD', 'OPTIONS'):
        if request.headers.get('origin') not in (None, ORIGIN):
            return JSONResponse({'detail': '请求来源不受信任'}, 403)
        if request.headers.get('x-workbench') != '1':
            return JSONResponse({'detail': '缺少请求校验标记'}, 403)
        # Bound the body before multipart parsing can spool it to disk.
        limit = (21 * 1024 * 1024 if request.url.path == '/api/classroom/files'
                 else 11 * 1024 * 1024 if request.url.path in ('/api/files','/api/classroom/transcriptions') else 512 * 1024)
        body = bytearray()
        async for chunk in request.stream():
            if len(body) + len(chunk) > limit:
                return JSONResponse({'detail': '提交内容过大'}, 413)
            body.extend(chunk)
        request._body = bytes(body)
    response = await call_next(request)
    response.headers['X-Content-Type-Options'] = 'nosniff'
    response.headers['Referrer-Policy'] = 'same-origin'
    response.headers['Content-Security-Policy'] = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'"
    if request.url.path.startswith('/classroom') or (BASE_PATH and not request.url.path.startswith(('/api/', '/workspace'))):
        response.headers['Content-Security-Policy'] = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'"
    if request.url.path.startswith('/api/'):
        response.headers['Cache-Control'] = 'no-store'
    return response


def db():
    with SessionLocal() as session:
        yield session


def digest(token):
    return hashlib.sha256(token.encode()).hexdigest()


def current_user(request: Request, session: Session = Depends(db)):
    login = session.get(LoginSession, digest(request.cookies.get(SESSION_COOKIE, '')))
    if not login or login.expires <= time.time():
        raise HTTPException(401, '请先登录')
    return session.get(User, login.user_id)


def password_hash(password, salt=None):
    salt = salt or secrets.token_hex(16)
    value = hashlib.scrypt(password.encode(), salt=bytes.fromhex(salt), n=16384, r=8, p=1).hex()
    return salt + ':' + value


class Credentials(BaseModel):
    username: str = Field(min_length=3, max_length=40, pattern=r'^[a-zA-Z0-9_\-]+$')
    password: str = Field(min_length=10, max_length=128)


def login_cookie(user, request, response, session):
    previous = request.cookies.get(SESSION_COOKIE)
    if previous:
        session.execute(delete(LoginSession).where(LoginSession.token == digest(previous)))
    session.execute(delete(LoginSession).where(LoginSession.expires < int(time.time())))
    token = secrets.token_urlsafe(32)
    session.add(LoginSession(token=digest(token), user_id=user.id, expires=int(time.time()) + 604800))
    session.commit()
    response.set_cookie(SESSION_COOKIE, token, max_age=604800, httponly=True, secure=SECURE, samesite='strict', path=COOKIE_PATH)
    return {'id': user.id, 'username': user.username}


@app.post('/api/register', status_code=201)
def register(body: Credentials, request: Request, response: Response, session: Session = Depends(db)):
    if os.getenv('ALLOW_REGISTRATION', 'true').lower() != 'true':
        raise HTTPException(403, '暂未开放注册')
    rate_limit(('register', request.client.host), 10, 3600)
    user = User(username=body.username.lower(), password=password_hash(body.password))
    session.add(user)
    try:
        session.commit()
    except IntegrityError:
        session.rollback()
        raise HTTPException(409, '用户名已被使用')
    return login_cookie(user, request, response, session)


@app.post('/api/login')
def login(body: Credentials, request: Request, response: Response, session: Session = Depends(db)):
    rate_limit(('login-ip', request.client.host), 30, 900)
    rate_limit(('login-name', body.username.lower()), 10, 900)
    user = session.scalar(select(User).where(User.username == body.username.lower()))
    expected = user.password if user else password_hash('dummy-password', '00' * 16)
    valid = hmac.compare_digest(password_hash(body.password, expected.split(':')[0]), expected)
    if not user or not valid:
        raise HTTPException(401, '用户名或密码不正确')
    return login_cookie(user, request, response, session)


@app.post('/api/logout')
def logout(request: Request, response: Response, session: Session = Depends(db)):
    session.execute(delete(LoginSession).where(LoginSession.token == digest(request.cookies.get(SESSION_COOKIE, ''))))
    session.commit()
    response.delete_cookie(SESSION_COOKIE, path=COOKIE_PATH)
    return {'ok': True}


@app.get('/api/me')
def me(user=Depends(current_user)):
    return {'id': user.id, 'username': user.username, 'ai_ready': bool(os.getenv('AI_API_KEY') and os.getenv('AI_MODEL'))}


class NoteInput(BaseModel):
    title: str = Field(min_length=1, max_length=120)
    content: str = Field(max_length=100000)


def owned(session, model, key, user):
    record = session.get(model, key)
    if not record or record.user_id != user.id:
        raise HTTPException(404, '内容不存在')
    return record


@app.get('/api/notes')
def notes(user=Depends(current_user), session: Session = Depends(db)):
    return session.scalars(select(Note).where(Note.user_id == user.id).order_by(Note.updated.desc(), Note.id.desc())).all()


@app.post('/api/notes', status_code=201)
def create_note(body: NoteInput, user=Depends(current_user), session: Session = Depends(db)):
    note = Note(user_id=user.id, **body.model_dump())
    session.add(note)
    session.commit()
    return note


@app.put('/api/notes/{note_id}')
def update_note(note_id: int, body: NoteInput, user=Depends(current_user), session: Session = Depends(db)):
    note = owned(session, Note, note_id, user)
    note.title, note.content, note.updated = body.title, body.content, int(time.time())
    session.commit()
    return note


@app.delete('/api/notes/{note_id}')
def delete_note(note_id: int, user=Depends(current_user), session: Session = Depends(db)):
    session.delete(owned(session, Note, note_id, user))
    session.commit()
    return {'ok': True}


@app.get('/api/files')
def files(user=Depends(current_user), session: Session = Depends(db)):
    return session.scalars(select(StoredFile).where(StoredFile.user_id == user.id).order_by(StoredFile.created.desc())).all()


@app.post('/api/files', status_code=201)
async def upload(file: UploadFile, user=Depends(current_user), session: Session = Depends(db)):
    rate_limit(('upload', user.id), 30, 3600)
    if session.scalar(select(func.count()).select_from(StoredFile).where(StoredFile.user_id == user.id)) >= 100:
        raise HTTPException(409, '每个账号最多保存 100 个文件，请先整理已有文件')
    name = Path((file.filename or 'file').replace('\\', '/')).name[:200]
    if Path(name).suffix.lower() not in {'.pdf', '.docx', '.xlsx', '.csv', '.txt', '.md', '.png', '.jpg', '.jpeg'}:
        raise HTTPException(400, '支持 PDF、DOCX、XLSX、CSV、TXT、MD、PNG、JPG 文件')
    key, size = secrets.token_hex(16), 0
    path = UPLOADS / key
    try:
        with path.open('xb') as out:
            while chunk := await file.read(64 * 1024):
                size += len(chunk)
                if size > MAX_FILE:
                    raise HTTPException(413, '文件不能超过 10 MB')
                out.write(chunk)
        record = StoredFile(id=key, user_id=user.id, name=name, size=size)
        session.add(record)
        session.commit()
        return record
    except Exception:
        session.rollback()
        path.unlink(missing_ok=True)
        raise
    finally:
        await file.close()


@app.get('/api/files/{file_id}')
def download(file_id: str, user=Depends(current_user), session: Session = Depends(db)):
    record = owned(session, StoredFile, file_id, user)
    if not (UPLOADS / record.id).is_file():
        raise HTTPException(404, '文件内容缺失')
    return FileResponse(UPLOADS / record.id, filename=record.name, media_type='application/octet-stream')


@app.delete('/api/files/{file_id}')
def delete_file(file_id: str, user=Depends(current_user), session: Session = Depends(db)):
    record = owned(session, StoredFile, file_id, user)
    session.delete(record)
    session.commit()
    (UPLOADS / record.id).unlink(missing_ok=True)
    return {'ok': True}


class ChatInput(BaseModel):
    message: str = Field(min_length=1, max_length=12000)


async def call_ai(messages, *, json_output=False, response_schema=None):
    key, model = os.getenv('AI_API_KEY'), os.getenv('AI_MODEL')
    if not key or not model:
        raise HTTPException(503, 'AI 尚未配置，请联系教师或管理员')
    try:
        max_tokens = int(os.getenv('AI_MAX_TOKENS') or '8192')
        if not 256 <= max_tokens <= 32768:
            raise ValueError()
    except ValueError:
        raise HTTPException(503, 'AI 输出额度配置无效，请联系管理员') from None
    payload = {'model': model, 'messages': messages, 'max_tokens': max_tokens}
    effort = os.getenv('AI_REASONING_EFFORT', '').strip()
    if effort:
        if effort not in ('none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'):
            raise HTTPException(503, 'AI 推理强度配置无效，请联系管理员')
        payload['reasoning'] = {'effort': effort}
    if json_output:
        payload['response_format'] = {'type': 'json_object'}
    base_url = os.getenv('AI_BASE_URL', 'https://openrouter.ai/api/v1').rstrip('/')
    if response_schema is not None:
        payload['response_format'] = {'type': 'json_schema', 'json_schema': {
            'name': 'classroom_response', 'strict': True, 'schema': response_schema}}
    if httpx.URL(base_url).host == 'openrouter.ai':
        provider = {'require_parameters': True} if response_schema is not None else {}
        provider_sort = os.getenv('AI_PROVIDER_SORT', '').strip()
        if provider_sort:
            if provider_sort not in ('throughput', 'latency', 'price'):
                raise HTTPException(503, 'AI 服务路由配置无效，请联系管理员')
            provider['sort'] = provider_sort
        if provider:
            payload['provider'] = provider
    started = time.monotonic()
    diagnostic = {'requested_model': model, 'max_tokens': max_tokens, 'reasoning_effort': effort or 'default',
                  'format': payload.get('response_format', {}).get('type', 'text'), 'outcome': 'error'}
    try:
        # httpx read timeout resets on every chunk; enforce a total deadline too.
        async with asyncio.timeout(AI_REQUEST_TIMEOUT_SECONDS):
            async with httpx.AsyncClient(timeout=120) as client:
                upstream = await client.post(base_url + '/chat/completions',
                    headers={'Authorization': 'Bearer ' + key, 'HTTP-Referer': ORIGIN, 'X-OpenRouter-Title': 'Zhiban Classroom'},
                    json=payload)
        diagnostic['http_status'] = upstream.status_code
        upstream.raise_for_status()
        data = upstream.json()
        if not isinstance(data, dict):
            raise ValueError('invalid response')
        for field in ('id', 'model', 'provider'):
            if isinstance(data.get(field), str):
                diagnostic[field] = data[field][:160]
        usage = data.get('usage')
        if isinstance(usage, dict):
            for field in ('prompt_tokens', 'completion_tokens', 'total_tokens'):
                if type(usage.get(field)) is int:
                    diagnostic[field] = usage[field]
            details = usage.get('completion_tokens_details')
            if isinstance(details, dict) and type(details.get('reasoning_tokens')) is int:
                diagnostic['reasoning_tokens'] = details['reasoning_tokens']
        choice = data['choices'][0]
        if not isinstance(choice, dict):
            raise ValueError('invalid choice')
        finish_reason = choice.get('finish_reason')
        if isinstance(finish_reason, str):
            diagnostic['finish_reason'] = finish_reason[:80]
        if finish_reason == 'length':
            diagnostic['outcome'] = 'truncated'
            raise HTTPException(502, 'AI 回复未完整生成，请重试或联系教师调整输出额度')
        answer = choice['message']['content']
        if not isinstance(answer, str) or not answer.strip():
            raise ValueError('empty answer')
        diagnostic['outcome'] = 'success'
        return answer
    except httpx.HTTPStatusError as error:
        diagnostic['outcome'] = 'upstream_error'
        detail = {401: 'AI 服务密钥无效，请联系管理员', 402: 'AI 服务余额不足，请联系管理员',
                  403: 'AI 服务拒绝访问，请联系管理员检查权限', 404: 'AI 模型不可用，请联系管理员检查模型配置',
                  429: 'AI 服务繁忙，请稍后重试'}.get(error.response.status_code, 'AI 服务暂时无法响应，请稍后重试')
        raise HTTPException(502, detail) from None
    except (httpx.TimeoutException, TimeoutError):
        diagnostic['outcome'] = 'timeout'
        raise HTTPException(504, 'AI 回复超时，请稍后重试') from None
    except (httpx.HTTPError, KeyError, IndexError, ValueError, TypeError):
        diagnostic['outcome'] = 'invalid_response'
        raise HTTPException(502, 'AI 服务暂时无法响应，请稍后重试') from None
    except asyncio.CancelledError:
        diagnostic['outcome'] = 'cancelled'
        raise
    finally:
        diagnostic['elapsed_ms'] = round((time.monotonic() - started) * 1000)
        # Log metadata only, never students' messages, images, model text or keys.
        ai_logger.info('ai_request %s', json.dumps(diagnostic, ensure_ascii=False))


@app.get('/api/chats')
def chats(user=Depends(current_user), session: Session = Depends(db)):
    return session.scalars(select(Chat).where(Chat.user_id == user.id).order_by(Chat.id.desc()).limit(50)).all()[::-1]


@app.post('/api/chats', status_code=201)
async def ask(body: ChatInput, user=Depends(current_user), session: Session = Depends(db)):
    key, model = os.getenv('AI_API_KEY'), os.getenv('AI_MODEL')
    if not key or not model:
        raise HTTPException(503, 'AI 尚未配置，请在服务器 .env 中设置 AI_API_KEY、AI_BASE_URL 和 AI_MODEL 后重启')
    rate_limit(('ai', user.id), 20, 3600)
    history = session.scalars(select(Chat).where(Chat.user_id == user.id).order_by(Chat.id.desc()).limit(5)).all()[::-1]
    messages = [{'role': 'system', 'content': '你是一位中文助手。准确、清晰地回答问题。'}]
    for item in history:
        messages.extend([{'role': 'user', 'content': item.question}, {'role': 'assistant', 'content': item.answer[:12000]}])
    messages.append({'role': 'user', 'content': body.message})
    answer = await call_ai(messages)
    record = Chat(user_id=user.id, question=body.message, answer=answer)
    session.add(record)
    session.commit()
    return record


@app.get('/api/health')
def health(session: Session = Depends(db)):
    session.execute(select(1))
    return {'ok': True, 'app': 'lesson2_edu', 'instance_id': os.getenv('APP_INSTANCE_ID', '')}


from .classroom import build_router

classroom_router = build_router(Base, db, digest, rate_limit, call_ai, SECURE, UPLOADS, COOKIE_PATH)
app.include_router(classroom_router)


@app.get('/paths.js', include_in_schema=False)
@app.get('/workspace/paths.js', include_in_schema=False)
def public_paths():
    return FileResponse(ROOT / 'classroom-ai-prototype' / 'paths.js', media_type='text/javascript')


app.mount('/classroom', StaticFiles(directory=ROOT / 'classroom-ai-prototype', html=True), name='classroom')
if BASE_PATH:
    app.mount('/workspace', StaticFiles(directory=ROOT / 'frontend', html=True), name='frontend')
    app.mount('/', StaticFiles(directory=ROOT / 'classroom-ai-prototype', html=True), name='classroom-home')
else:
    app.mount('/', StaticFiles(directory=ROOT / 'frontend', html=True), name='frontend')
