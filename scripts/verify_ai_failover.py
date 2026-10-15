"""Manual paid acceptance: synthetic fixtures, disposable DB, six real clients.

Run in the deployment image with its environment, never against classroom data.
--force-backup injects primary failures only inside this isolated Python process.
"""
import argparse
import asyncio
import base64
import json
import os
from pathlib import Path
import sys
import tempfile
import time
import uuid

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import httpx
from fastapi import HTTPException
from fastapi.testclient import TestClient
from sqlalchemy import text


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--fixtures', required=True)
    parser.add_argument('--output', required=True)
    parser.add_argument('--force-backup', action='store_true')
    args = parser.parse_args()
    fixtures = json.loads(Path(args.fixtures).read_text(encoding='utf-8'))
    report = {'force_backup': args.force_backup, 'checks': [], 'upstream': []}
    with tempfile.TemporaryDirectory(prefix='lesson2-failover-acceptance-') as directory:
        os.environ.update(DATA_DIR=directory, DATABASE_URL='sqlite:///' + directory + '/test.db',
            APP_ORIGIN='http://testserver', APP_BASE_PATH='', CLASSROOM_CODE='RESILIENCE-TEST',
            CLASSROOM_TEACHER_PASSWORD=uuid.uuid4().hex, AI_FAILOVER_ENABLED='true', STT_FAILOVER_ENABLED='true')
        from backend.app import app, engine
        from backend import qwen_speech
        original_send = httpx.AsyncClient.send
        async def measured(self, request, *a, **kw):
            is_chat = request.url.path.endswith('/chat/completions')
            is_speech = request.url.path.endswith('/audio/transcriptions')
            if is_chat or is_speech:
                body = json.loads(request.content)
                if args.force_backup and is_chat and request.url.host == 'openrouter.ai':
                    report['upstream'].append({'model': body.get('model'), 'injected': 503})
                    return httpx.Response(503, request=request)
                started = time.monotonic()
                response = await original_send(self, request, *a, **kw)
                report['upstream'].append({'model':body.get('model'), 'host':request.url.host,
                    'status':response.status_code, 'header_seconds':round(time.monotonic()-started, 3)})
                return response
            return await original_send(self, request, *a, **kw)
        httpx.AsyncClient.send = measured
        if args.force_backup:
            async def failed_speech(*a, **kw): raise HTTPException(504, 'Synthetic primary outage')
            qwen_speech.transcribe = failed_speech
        headers = {'X-Workbench':'1', 'Origin':'http://testserver'}
        with TestClient(app, headers=headers) as teacher:
            response = teacher.post('/api/classroom/login', json={'role':'teacher', 'name':'赵老师',
                'code':'RESILIENCE-TEST', 'teacherPassword':os.environ['CLASSROOM_TEACHER_PASSWORD']})
            assert response.status_code == 200, response.text
            response = teacher.post('/api/classroom/lessons', json={'flow_version':5})
            assert response.status_code == 201, response.text
            lid = response.json()['id']; assert response.json()['group_count'] == 6
            teacher_cookie = dict(teacher.cookies)

            async def stage_one():
                async def group_job(group):
                    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://testserver', headers=headers, timeout=180) as client:
                        response = await client.post('/api/classroom/login', json={'role':'student','groupId':group,'code':'RESILIENCE-TEST'})
                        assert response.status_code == 200
                        cookie = dict(client.cookies)
                        up = await client.post(f'/api/classroom/files?lesson_id={lid}&stage=1',
                            files={'file': ('synthetic-design.jpg', base64.b64decode(fixtures['image']), 'image/jpeg')})
                        assert up.status_code == 201, up.text
                        body = {'fields': {'design':''}, 'file_ids':[up.json()['id']], 'revision':0, 'request_id':str(uuid.uuid4())}
                        started = time.monotonic()
                        first = await client.post(f'/api/classroom/lessons/{lid}/stages/1/submissions', json=body)
                        assert first.status_code == 201, first.text
                        again = await client.post(f'/api/classroom/lessons/{lid}/stages/1/submissions', json=body)
                        assert first.json()['submission_id'] == again.json()['submission_id']
                        work = (await client.get(f'/api/classroom/lessons/{lid}/groups/{group}/stages/1')).json()
                        matched = work['result_match']
                        assert matched['status'] == 'ready', matched
                        assert {m['result_id'] for m in matched['matches']} == {'water','ga3','cppu','combined'}, matched
                        report['checks'].append({'group':group, 'check':'photo_matching_and_replay', 'seconds':round(time.monotonic()-started,2), 'ok':True})
                        started = time.monotonic()
                        data = {'lesson_id':lid,'stage':1,'request_id':str(uuid.uuid4())}
                        files = {'file':('synthetic.webm',base64.b64decode(fixtures['audio']))}
                        speech = await client.post('/api/classroom/transcriptions', data=data, files=files)
                        assert speech.status_code == 200, speech.text
                        assert all(word in speech.json()['text'] for word in ['葡萄','百粒质量','柱状图']), speech.text
                        repeated = await client.post('/api/classroom/transcriptions', data=data, files=files)
                        assert repeated.json() == speech.json()
                        report['checks'].append({'group':group,'check':'speech_and_replay','seconds':round(time.monotonic()-started,2),'ok':True})
                        return cookie
                return await asyncio.gather(*(group_job(g) for g in range(1,7)))
            cookies = asyncio.run(stage_one())
            teacher.cookies.clear(); teacher.cookies.update(teacher_cookie)
            assert teacher.patch(f'/api/classroom/lessons/{lid}', json={'stage':2}).status_code == 200

            async def stage_two():
                async def job(group):
                    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app),base_url='http://testserver',headers=headers,cookies=cookies[group-1],timeout=180) as client:
                        async def chat(message):
                            body={'lesson_id':lid,'stage':2,'message':message,'request_id':str(uuid.uuid4())}
                            first=await client.post('/api/classroom/chats',json=body,headers={'Accept':'text/event-stream'})
                            assert first.status_code==201 and 'event: done' in first.text and 'event: error' not in first.text,first.text
                            assert 'event: text' not in first.text
                            cached=await client.post('/api/classroom/chats',json=body)
                            assert cached.status_code==201,cached.text
                            again=await client.post('/api/classroom/chats',json=body)
                            assert cached.json()==again.json()
                            return cached.json()['answer']
                        started=time.monotonic()
                        await chat(f'本组方案代号是葡萄{group}号，膨大阶段选择GA3处理。请记住本组选择，并给一个需要考虑的问题。')
                        follow=await chat('请简短复述本组刚才选择的激素，不要改成其他激素，再提出一个问题。')
                        assert any(word in follow for word in ['GA3','GA₃','赤霉素']),follow
                        report['checks'].append({'group':group,'check':'two_turn_chat_context_and_replay','seconds':round(time.monotonic()-started,2),'ok':True})
                        design='膨大阶段使用GA3促进果实细胞伸长，也可用CPPU促进细胞分裂；成熟阶段适量乙烯促进成熟，适当控制赤霉素以免延迟成熟。高温时减少或暂停激素处理，长途运输时延后乙烯处理，低温时先改善温度并小范围验证。膨大期适当供水、合理施肥，成熟期加强光照、通风与温度管理，兼顾产量和品质。'
                        body={'fields':{'design':design},'revision':0,'request_id':str(uuid.uuid4())}
                        started=time.monotonic()
                        first=await client.post(f'/api/classroom/lessons/{lid}/stages/2/submissions',json=body)
                        assert first.status_code==201,first.text
                        repeated=await client.post(f'/api/classroom/lessons/{lid}/stages/2/submissions',json=body)
                        vid=first.json()['submission_id']; assert repeated.json()['submission_id']==vid
                        with engine.connect() as db:
                            row=db.execute(text('select status,result from lesson_assessments where version_id=:v'),{'v':vid}).one()
                        assert row.status=='ready',row.status
                        score=json.loads(row.result)
                        assert len(score['items'])==4 and all(i['evidence'] for i in score['items'])
                        total=sum(i['points'] for i in score['items'])
                        assert 70<=total<=100,score
                        report['checks'].append({'group':group,'check':'score_and_replay','seconds':round(time.monotonic()-started,2),'total':total,'ok':True})
                await asyncio.gather(*(job(g) for g in range(1,7)))
            asyncio.run(stage_two())
            teacher.cookies.clear();teacher.cookies.update(teacher_cookie)
            summary=teacher.get(f'/api/classroom/lessons/{lid}/design-summary').json()
            assert summary['status']=='ready' and summary['evaluated']==6,summary
            assert len(summary['result']['sources'])==6,summary
            with engine.connect() as db:
                counts={name:db.execute(text('select count(*) from '+name)).scalar() for name in
                    ['classroom_chats','lesson_work_versions','lesson_assessments','classroom_transcriptions']}
            assert counts=={'classroom_chats':12,'lesson_work_versions':12,'lesson_assessments':6,'classroom_transcriptions':6},counts
            report.update(ok=True,counts=counts,summary_groups=summary['evaluated'])
        engine.dispose()
    Path(args.output).write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')
    print(json.dumps(report,ensure_ascii=True),flush=True)


if __name__=='__main__': main()
