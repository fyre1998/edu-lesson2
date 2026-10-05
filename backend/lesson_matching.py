"""Durable result matching for each submitted design, with private image access."""
import asyncio
import json
import time
from types import SimpleNamespace

from fastapi import BackgroundTasks, Depends, HTTPException
from fastapi.responses import FileResponse
from sqlalchemy import ForeignKey, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column, Session

from .lesson_curricula import curriculum as curriculum_for, matching_curriculum, INQUIRY_FLOWS
from .lesson_v2 import parse_json


def install_matching(router, Base, db, identity, check_group, get_lesson, config,
                     Version, picture_parts, call_ai, assets, write_lock):
    class Match(Base):
        __tablename__ = 'lesson_design_matches'
        version_id: Mapped[str] = mapped_column(ForeignKey('lesson_work_versions.id'), primary_key=True)
        mapping_version: Mapped[str] = mapped_column(String(40))
        status: Mapped[str] = mapped_column(String(24), default='pending')
        payload: Mapped[str] = mapped_column(Text)
        result: Mapped[str] = mapped_column(Text, default='{}')
        error: Mapped[str] = mapped_column(String(200), default='')
        updated: Mapped[int] = mapped_column(Integer, default=lambda: int(time.time()))

    slots = asyncio.Semaphore(4)
    active = set()

    def queue(session, version, background):
        curriculum = curriculum_for(config(get_lesson(session, version.lesson_id))[0])
        session.add(Match(version_id=version.id, mapping_version=curriculum.MATCH_VERSION,
                          payload=json.dumps(dict(fields=json.loads(version.data),
                              file_ids=json.loads(version.file_ids), catalogue=curriculum.RESULTS), ensure_ascii=False)))
        active.add(version.id)
        background.add_task(run, session.get_bind(), version.id)

    async def run(bind, version_id):
        try:
            async with slots:
                with Session(bind) as session:
                    record = session.get(Match, version_id)
                    version = session.get(Version, version_id)
                    if not record or not version or record.status == 'ready':
                        return
                    record.status = 'processing'; record.updated = int(time.time()); session.commit()
                    try:
                        payload = json.loads(record.payload)
                        catalogue = payload['catalogue']
                        curriculum = matching_curriculum(record.mapping_version)
                        parts = [{'type': 'text', 'text': json.dumps({'fields': payload['fields']}, ensure_ascii=False)}]
                        parts += picture_parts(session, payload['file_ids'], version.lesson_id, version.group_id, 1)
                        result = (curriculum.direct_matches(payload['fields'].get('design', ''))
                                  if hasattr(curriculum, 'direct_matches') and not payload['file_ids'] else None)
                        if result is None:
                            response = await call_ai([
                                {'role': 'system', 'content': curriculum.MATCH_PROMPT + json.dumps(
                                    {key: value[0] for key, value in catalogue.items()}, ensure_ascii=False)},
                                {'role': 'user', 'content': parts},
                            ], response_schema=curriculum.MATCH_SCHEMA)
                            result = parse_json(response)
                        if hasattr(curriculum, 'direct_matches'):
                            curriculum.validate_matches(result)
                        if not isinstance(result, dict) or set(result) != {'readable', 'matches', 'questions', 'uncovered'}:
                            raise ValueError('invalid result')
                        if type(result['readable']) is not bool or not isinstance(result['matches'], list) or len(result['matches']) > 6:
                            raise ValueError('invalid matches')
                        seen = set()
                        for item in result['matches']:
                            if not isinstance(item, dict) or set(item) != {'result_id', 'excerpt'}:
                                raise ValueError('invalid match')
                            key = item['result_id']
                            if not isinstance(key, str) or key not in catalogue or key in seen:
                                raise ValueError('invalid id')
                            if not isinstance(item['excerpt'], str) or not 1 <= len(item['excerpt'].strip()) <= 500:
                                raise ValueError('invalid excerpt')
                            seen.add(key)
                        for key, maximum in [('questions', 1), ('uncovered', 6)]:
                            if (not isinstance(result[key], list) or len(result[key]) > maximum
                                    or any(not isinstance(x, str) or not x.strip() or len(x) > 240 for x in result[key])):
                                raise ValueError('invalid explanation')
                        if not result['readable'] and (result['matches'] or not result['questions']):
                            raise ValueError('unreadable content')
                        if not result['matches'] and not result['questions'] and not result['uncovered']:
                            raise ValueError('empty response')
                        record.result = json.dumps(result, ensure_ascii=False)
                        record.status = 'ready' if result['matches'] else 'needs_clarification' if result['questions'] else 'unmatched'
                        record.error = ''
                    except Exception:
                        session.rollback()
                        record = session.get(Match, version_id)
                        record.status = 'failed'
                        record.error = '实验结果匹配暂未完成，请重试；本次思路已保存。'
                    record.updated = int(time.time()); session.commit()
        finally:
            active.discard(version_id)

    def read(session, version):
        record = session.get(Match, version.id) if version else None
        if not record:
            return None
        result = json.loads(record.result)
        catalogue = json.loads(record.payload)['catalogue']
        matches = [dict(**item, label=catalogue[item['result_id']][0],
                        image=f'/api/classroom/lessons/{version.lesson_id}/matches/{version.id}/images/{item["result_id"]}')
                   for item in result.get('matches', [])]
        if hasattr(matching_curriculum(record.mapping_version), 'result_row'):
            matches = [matching_curriculum(record.mapping_version).result_row(item, catalogue) for item in result.get('matches', [])]
        return dict(version_id=version.id, revision=version.revision, status=record.status,
                    updated=record.updated, error=record.error, matches=matches,
                    questions=result.get('questions', []), uncovered=result.get('uncovered', []))

    def permitted(session, lesson_id, version_id, user, write=False):
        lesson = get_lesson(session, lesson_id, 1, write=write)
        version = session.get(Version, version_id)
        if config(lesson)[0] not in INQUIRY_FLOWS or not version or version.lesson_id != lesson_id or version.stage != 1:
            raise HTTPException(404, '匹配记录不存在')
        check_group(user, version.group_id)
        record = session.get(Match, version_id)
        if not record:
            raise HTTPException(404, '匹配记录不存在')
        return version, record

    @router.get('/lessons/{lesson_id}/matches/{version_id}/images/{result_id}')
    def image(lesson_id: str, version_id: str, result_id: str, user=Depends(identity), session=Depends(db)):
        _, record = permitted(session, lesson_id, version_id, user)
        if hasattr(matching_curriculum(record.mapping_version), 'result_row'):
            raise HTTPException(404, '本课提供百粒质量数据，没有结果图')
        if result_id not in {m['result_id'] for m in json.loads(record.result).get('matches', [])}:
            raise HTTPException(404, '本次提交没有此结果图')
        path = assets / json.loads(record.payload)['catalogue'][result_id][1]
        if not path.is_file():
            raise HTTPException(404, '参考图片缺失，请联系教师')
        return FileResponse(path, media_type='image/png', headers={'Cache-Control': 'private, no-store'})

    @router.post('/lessons/{lesson_id}/matches/{version_id}/retry')
    def retry(lesson_id: str, version_id: str, background: BackgroundTasks,
              user=Depends(identity), session=Depends(db)):
        with write_lock:
            _, record = permitted(session, lesson_id, version_id, user, write=True)
            stale = record.status in ('pending', 'processing') and int(time.time()) - record.updated >= 180
            if version_id in active or not (record.status == 'failed' or stale):
                raise HTTPException(409, '匹配已完成或正在处理；需要补充思路时请修改后再次提交')
            record.status = 'pending'; record.updated = int(time.time()); record.error = ''; session.commit()
            active.add(version_id)
            background.add_task(run, session.get_bind(), version_id)
        return {'status': 'pending'}

    return SimpleNamespace(queue=queue, read=read)
