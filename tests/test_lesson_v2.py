import asyncio
import base64
import json
import uuid
from pathlib import Path

import httpx
from sqlalchemy import text

from test_app import env, classroom_login
from backend import lesson_v2 as v2


def start(c,monkeypatch,stage=1):
    monkeypatch.setenv('CLASSROOM_CODE','BIO-302');monkeypatch.setenv('CLASSROOM_TEACHER_PASSWORD','teacher-test-password')
    classroom_login(c,teacher=True)
    r=c.post('/api/classroom/lessons',json={'title':'八组课堂验收'});assert r.status_code==201,r.text
    lid=r.json()['id'];assert r.json()['group_count']==8 and r.json()['flow_version']==2
    if stage>1:assert c.patch(f'/api/classroom/lessons/{lid}',json={'stage':stage}).status_code==200
    return lid


def student(c,g):
    r=c.post('/api/classroom/login',json={'role':'student','groupId':g,'code':'BIO-302'})
    assert r.status_code==200,r.text
    assert r.json()['name']==f'第 {g} 组'


def mock_ai(module,monkeypatch,handler=None):
    monkeypatch.setenv('AI_API_KEY','test');monkeypatch.setenv('AI_MODEL','mock');monkeypatch.setenv('STT_API_KEY','test')
    calls=[];real=httpx.AsyncClient
    def receive(req):
        payload=json.loads(req.content);calls.append((str(req.url),payload))
        if not req.url.path.endswith('/audio/transcriptions'):
            assert payload['response_format']['type'] == 'json_schema'
            assert payload['response_format']['json_schema']['strict'] is True
        if handler:return handler(req,payload)
        if req.url.path.endswith('/audio/transcriptions'):return httpx.Response(200,json={'text':'我们比较拜尔与温特的实验。'})
        system=payload['messages'][0]['content']
        if '转录器' in system:answer={'sense':'光','substance':'学生写错的内容','elongation':'伸长不同','uncertain':['substance']}
        elif '评分员' in system:
            rubric=json.loads(system.split('量规：')[-1]);body=json.loads(payload['messages'][1]['content'][0]['text'])
            evidence='field:'+next(iter(body['fields']))
            answer={'items':[{'key':r[0],'points':r[2],'missing':False,'evidence':[evidence],'reason':'学生提交文字与操作对应'} for r in rubric]}
        else:answer={'text':'你们选择的对照能够排除哪一种解释？','step':2,'mastery':'学生已比较直接放置材料'}
        return httpx.Response(200,json={'choices':[{'message':{'content':json.dumps(answer,ensure_ascii=False)}}]})
    monkeypatch.setattr(module.httpx,'AsyncClient',lambda **kw:real(transport=httpx.MockTransport(receive),**kw))
    return calls


def fields(stage):
    # Exercise compatibility with earlier full worksheets, including extraction.
    return {f['key']:next(iter(f['options'])) if f['options'] else '本组根据具体处理对照提出预测与证据' for f in v2.STAGES[stage]['fields'] if f['key'] not in ('connections','confirmed','extraction_id','model_files','discussion_files','phase')}


def submit(c,lid,stage,data,revision=0,files=None,token=None):
    return c.post(f'/api/classroom/lessons/{lid}/stages/{stage}/submissions',json={'fields':data,'revision':revision,'file_ids':files or [],'request_id':token or str(uuid.uuid4())})


def test_eight_groups_four_stages_all_artifacts_and_scores(env,monkeypatch):
    module,c=env;lid=start(c,monkeypatch);mock_ai(module,monkeypatch)
    teacher_cookie=dict(c.cookies);cookies={}
    for g in range(1,9):
        c.cookies.clear();student(c,g);cookies[g]=dict(c.cookies)
    image=Path('backend/lesson_assets/cells.png').read_bytes()
    for stage in range(1,5):
        c.cookies.clear();c.cookies.update(teacher_cookie)
        assert c.patch(f'/api/classroom/lessons/{lid}',json={'stage':stage}).status_code==200
        for g in range(1,9):
            c.cookies.clear();c.cookies.update(cookies[g]);data=fields(stage);attached=[]
            if stage==4:
                up=c.post(f'/api/classroom/files?lesson_id={lid}&stage=4',files={'file':('模型.png',image,'image/png')});assert up.status_code==201
                attached=[up.json()['id']]
                ext=c.post(f'/api/classroom/lessons/{lid}/model-extractions',json={'revision':0,'file_ids':attached});assert ext.status_code==200,ext.text
                assert ext.json()['substance']=='学生写错的内容'
                data.update(sense='光',substance='学生核对后的文字',elongation='伸长不同',extraction_id=ext.json()['id'],confirmed='true',connections=json.dumps([{'scientist':'darwin','target':'node1'},{'scientist':'went','target':'arrow1'}]))
            r=submit(c,lid,stage,data,files=attached);assert r.status_code==201,r.text
            group=c.get(f'/api/classroom/lessons/{lid}/groups?stage={stage}').json()
            assert len(group)==1 and group[0]['id']==g
            score=group[0]['scores']['stages'][stage-1]
            assert score['status']=='ready',score
            assert all('reason' not in i and 'evidence' not in i for i in score['items'])
        c.cookies.clear();c.cookies.update(teacher_cookie)
        rows=c.get(f'/api/classroom/lessons/{lid}/groups?stage={stage}').json()
        assert len(rows)==8 and all(r['status']=='已提交' for r in rows)
        if stage==1:
            assert c.patch(f'/api/classroom/lessons/{lid}',json={'release_results':True}).status_code==200
            assigned=c.get(f'/api/classroom/lessons/{lid}/groups?stage=1').json();counts=[sum(g['assignment']['variant']==v for g in assigned) for v in range(3)]
            assert max(counts)-min(counts)<=1
    assert all(r['scores']['total']==100 for r in rows)
    with module.engine.connect() as db:
        assert db.execute(text('select count(*) from lesson_work_versions')).scalar()==32
        assert db.execute(text('select count(*) from lesson_model_extractions')).scalar()==8
        assert db.execute(text('select count(*) from lesson_assessments')).scalar()==32
        assert len(json.loads(db.execute(text('select payload from lesson_assessments limit 1')).scalar())['rubric_snapshot'])==3


def test_stage_gates_prompts_and_chat_deduplication(env,monkeypatch):
    module,c=env;lid=start(c,monkeypatch,2);calls=mock_ai(module,monkeypatch)
    assert c.patch(f'/api/classroom/lessons/{lid}',json={'reveal_research':True}).status_code==422
    assert c.patch(f'/api/classroom/lessons/{lid}',json={'stage':5}).status_code==422
    student(c,8)
    assert c.get(f'/api/classroom/lessons/{lid}/materials/went-comparison/assets/went.png').status_code==403
    content=c.get(f'/api/classroom/lessons/{lid}/stages/2').json()
    assert len(content['stages'])==4 and 'research-results' not in str(content['materials'])
    assert c.get(f'/api/classroom/lessons/{lid}/teaching-guide').status_code==403
    body={'lesson_id':lid,'stage':2,'message':'请检查我们的预测','request_id':str(uuid.uuid4())}
    a=c.post('/api/classroom/chats',json=body);b=c.post('/api/classroom/chats',json=body)
    assert a.status_code==b.status_code==201 and a.json()==b.json() and len(calls)==1
    assert '绝对不能公布历史结果' in calls[0][1]['messages'][0]['content']
    assert c.post('/api/classroom/chats',json={**body,'message':'改了'}).status_code==409
    classroom_login(c,teacher=True);c.patch(f'/api/classroom/lessons/{lid}',json={'stage':3});student(c,8)
    r=c.post('/api/classroom/chats',json={**body,'stage':3});assert r.status_code==201
    prompt=calls[-1][1]['messages'][0]['content']
    assert '教学目标（仅供你把握' in prompt and '现在从第一轮开始' not in prompt
    with module.engine.connect() as db:assert db.execute(text('select step from lesson_guidance_progress where stage=3')).scalar()==2


def test_score_failure_retry_override_and_new_version(env,monkeypatch):
    module,c=env;lid=start(c,monkeypatch);student(c,7)
    data=fields(1);token=str(uuid.uuid4());r=submit(c,lid,1,data,token=token);assert r.status_code==201
    assert submit(c,lid,1,data,token=token).json()['submission_id']==r.json()['submission_id']
    row=c.get(f'/api/classroom/lessons/{lid}/groups?stage=1').json()[0]
    assert row['scores']['stages'][0]['status']=='failed' and row['scores']['stages'][0]['total'] is None
    assert c.put(f"/api/classroom/lessons/{lid}/assessments/{r.json()['submission_id']}",json={'points':{},'reason':'改分'}).status_code==403
    classroom_login(c,teacher=True);mock_ai(module,monkeypatch)
    url=f"/api/classroom/lessons/{lid}/assessments/{r.json()['submission_id']}"
    assert c.post(url+'/retry').status_code==200
    correction={k:0 for k,_,_,_ in v2.RUBRIC[1]}
    assert c.put(url,json={'points':correction,'reason':'教师检查发现对照不成立'}).status_code==200
    row=c.get(f'/api/classroom/lessons/{lid}/groups?stage=1').json()[6]
    assert row['scores']['total']==0 and row['scores']['stages'][0]['items'][0]['ai_points']==4
    student(c,7);data['comparison']='本组修订了对照';new=submit(c,lid,1,data,revision=1);assert new.status_code==201
    row=c.get(f'/api/classroom/lessons/{lid}/groups?stage=1').json()[0]
    assert row['scores']['total']==20 and row['scores']['stages'][0]['version_id']==new.json()['submission_id']


def test_model_provenance_conflicts_and_bad_connections(env,monkeypatch):
    module,c=env;lid=start(c,monkeypatch,4);mock_ai(module,monkeypatch);student(c,1)
    img=Path('backend/lesson_assets/cells.png').read_bytes()
    fid=c.post(f'/api/classroom/files?lesson_id={lid}&stage=4',files={'file':('模型.png',img)}).json()['id']
    ext=c.post(f'/api/classroom/lessons/{lid}/model-extractions',json={'revision':0,'file_ids':[fid]}).json()
    data=fields(4);data.update(confirmed='true',extraction_id=ext['id'],connections='[{"scientist":"darwin","target":"node1"}]')
    assert submit(c,lid,4,data).status_code==422
    student(c,2);assert submit(c,lid,4,data,files=[fid]).status_code==404
    student(c,1);data['connections']='[{"scientist":"x","target":"node1"}]'
    assert submit(c,lid,4,data,files=[fid]).status_code==422
    assert c.post(f'/api/classroom/lessons/{lid}/model-extractions',json={'revision':1,'file_ids':[fid]}).status_code==409


def test_optional_fields_empty_and_partial_submissions(env,monkeypatch):
    module,c=env;lid=start(c,monkeypatch,4);calls=mock_ai(module,monkeypatch);student(c,1)
    for stage in range(1,5):
        content=c.get(f'/api/classroom/lessons/{lid}/stages/{stage}').json()['content']
        assert all(not f['required'] for f in content['fields'])
        data={} if stage!=4 else dict(model_files='[]',discussion_files='[]',connections='[]',phase='discussion')
        r=submit(c,lid,stage,data);assert r.status_code==201,r.text
        score=c.get(f'/api/classroom/lessons/{lid}/groups?stage={stage}').json()[0]['scores']['stages'][stage-1]
        assert score['status']=='ready' and score['total']==0
        assert all(i['missing'] and i['points']==0 for i in score['items'])
    assert not calls  # Blank submissions need neither a model nor an API key.
    r=submit(c,lid,1,{'light_site':'尖端'},revision=1);assert r.status_code==201,r.text
    score=c.get(f'/api/classroom/lessons/{lid}/groups?stage=1').json()[0]['scores']['stages'][0]
    assert score['total']==4
    assert {i['key']:i['points'] for i in score['items']}=={'light_site':4,'bend_site':0,'design':0}


def test_picture_model_checkpoint_placements_and_discussion_upload(env,monkeypatch):
    module,c=env;lid=start(c,monkeypatch,4);mock_ai(module,monkeypatch);student(c,1)
    image=Path('backend/lesson_assets/cells.png').read_bytes()
    upload=lambda name:c.post(f'/api/classroom/files?lesson_id={lid}&stage=4',files={'file':(name,image,'image/png')}).json()['id']
    model=upload('模型.png');answer=upload('讨论答案.png')
    data=dict(model_files=json.dumps([model]),discussion_files='[]',connections='[]',phase='model')
    link=dict(scientist='darwin',file_id=model,x=.25,y=.5)
    premature=submit(c,lid,4,{**data,'connections':json.dumps([link])},files=[model])
    assert premature.status_code==422
    first=submit(c,lid,4,data,files=[model]);assert first.status_code==201,first.text
    score=c.get(f'/api/classroom/lessons/{lid}/groups?stage=4').json()[0]
    assert score['status']=='模型已提交，待讨论' and score['scores']['stages'][3]['status']=='model_submitted'
    with module.engine.connect() as db:
        assert db.execute(text('select count(*) from lesson_assessments')).scalar()==0
    data.update(phase='discussion',connections=json.dumps([link]),discussion_files=json.dumps([answer]))
    final=submit(c,lid,4,data,revision=1,files=[model,answer]);assert final.status_code==201,final.text
    work=c.get(f'/api/classroom/lessons/{lid}/groups/1/stages/4').json()
    assert len(work['versions'])==2 and json.loads(work['work']['fields']['connections'])==[link]
    assert work['work']['file_ids']==[model,answer]
    assert c.get(f'/api/classroom/lessons/{lid}/groups?stage=4').json()[0]['scores']['stages'][3]['total']==30
    invalid={**data,'connections':json.dumps([{**link,'x':1.1}])}
    assert submit(c,lid,4,invalid,revision=2,files=[model,answer]).status_code==422
    student(c,2)
    assert submit(c,lid,4,data,files=[model,answer]).status_code==404


def test_discussion_only_skips_optional_model_and_names(env,monkeypatch):
    module,c=env;lid=start(c,monkeypatch,4);mock_ai(module,monkeypatch);student(c,1)
    data=dict(model_files='[]',discussion_files='[]',connections='[]',phase='discussion',discussion='本组讨论了三种实验思路未达预期的结果，分别检查处理有效性和模型联系。')
    r=submit(c,lid,4,data);assert r.status_code==201,r.text
    score=c.get(f'/api/classroom/lessons/{lid}/groups?stage=4').json()[0]['scores']['stages'][3]
    assert score['total']==12
    assert {i['key']:i['points'] for i in score['items']}['model']==0
    assert {i['key']:i['points'] for i in score['items']}['connections']==0


def test_teacher_matches_design_without_old_treatment_field(env,monkeypatch):
    module,c=env;lid=start(c,monkeypatch);mock_ai(module,monkeypatch);student(c,1)
    assert submit(c,lid,1,{'design':'顶端遮光，设置其他条件相同的未遮光对照，观察生长和弯曲。'}).status_code==201
    classroom_login(c,teacher=True)
    assert c.patch(f'/api/classroom/lessons/{lid}',json={'release_results':True}).status_code==200
    r=c.post(f'/api/classroom/lessons/{lid}/assignments',json={'group_id':1,'treatment':'tip_shade','variant':0,'reason':'教师已核对方案中的遮光部位'})
    assert r.status_code==200,r.text


def test_transcription_auth_formats_limit_and_idempotency(env,monkeypatch):
    module,c=env;lid=start(c,monkeypatch);calls=mock_ai(module,monkeypatch)
    body={'lesson_id':lid,'stage':'1','request_id':str(uuid.uuid4())};audio=b'\x1aE\xdf\xa3'+b'x'*200
    assert c.post('/api/classroom/transcriptions',data=body,files={'file':('audio.webm',audio)}).status_code==403
    student(c,8)
    a=c.post('/api/classroom/transcriptions',data=body,files={'file':('audio.webm',audio)})
    b=c.post('/api/classroom/transcriptions',data=body,files={'file':('audio.webm',audio)})
    assert a.status_code==b.status_code==200 and a.json()==b.json() and len(calls)==1
    assert calls[0][1]['language']=='zh' and base64.b64decode(calls[0][1]['input_audio']['data'])==audio
    assert c.post('/api/classroom/transcriptions',data=body,files={'file':('audio.webm',audio+b'y')}).status_code==409
    assert c.post('/api/classroom/transcriptions',data={**body,'stage':'3'},files={'file':('audio.webm',audio)}).status_code==403
    assert c.post('/api/classroom/transcriptions',data=body,files={'file':('audio.webm',b'not audio'*50)}).status_code==400
    assert c.post('/api/classroom/transcriptions',data=body,files={'file':('audio.webm',audio+b'0'*(10*1024*1024))}).status_code==413
    with module.engine.connect() as db:
        assert db.execute(text('select count(*) from classroom_files')).scalar()==0
        assert db.execute(text('select count(*) from classroom_transcriptions')).scalar()==1


def test_eight_concurrent_transcriptions_and_one_inflight_per_group(env,monkeypatch):
    module,c=env;lid=start(c,monkeypatch);cookies=[]
    for g in range(1,9):
        c.cookies.clear();student(c,g);cookies.append(dict(c.cookies))
    real=httpx.AsyncClient;monkeypatch.setenv('STT_API_KEY','test')
    async def run():
        release=asyncio.Event();ready=asyncio.Event();active=0;peak=0
        async def upstream(req):
            nonlocal active,peak
            active+=1;peak=max(peak,active)
            if active==8:ready.set()
            await release.wait();active-=1
            return httpx.Response(200,json={'text':'波森·詹森与拜尔'})
        monkeypatch.setattr(module.httpx,'AsyncClient',lambda **kw:real(transport=httpx.MockTransport(upstream),**kw))
        async def send(index):
            async with real(transport=httpx.ASGITransport(app=module.app),base_url='http://testserver',headers={'X-Workbench':'1','Origin':'http://testserver'},cookies=cookies[index]) as client:
                return await client.post('/api/classroom/transcriptions',data={'lesson_id':lid,'stage':1,'request_id':str(uuid.uuid4())},files={'file':('audio.webm',b'\x1aE\xdf\xa3'+b'x'*100)})
        tasks=[asyncio.create_task(send(g)) for g in range(8)]
        try:
            await asyncio.wait_for(ready.wait(),5)
            duplicate=await send(0);assert duplicate.status_code==409
        finally:release.set()
        responses=await asyncio.gather(*tasks)
        assert peak==8 and all(r.status_code==200 for r in responses)
    asyncio.run(run())
    with module.engine.connect() as db:assert db.execute(text('select count(*) from classroom_transcriptions')).scalar()==8


def test_late_model_extraction_cannot_overwrite_newer_revision(env,monkeypatch):
    module,c=env;lid=start(c,monkeypatch,4);student(c,1)
    data=fields(4);data['connections']='[]'
    r=c.put(f'/api/classroom/lessons/{lid}/stages/4/work',json={'revision':0,'fields':data,'file_ids':[]});assert r.status_code==200,r.text
    img=Path('backend/lesson_assets/cells.png').read_bytes()
    fid=c.post(f'/api/classroom/files?lesson_id={lid}&stage=4',files={'file':('模型.png',img)}).json()['id']
    def during(req,payload):
        with module.engine.begin() as conn:conn.execute(text('update lesson_work set revision=2 where lesson_id=:lid'),{'lid':lid})
        return httpx.Response(200,json={'choices':[{'message':{'content':json.dumps({'sense':'光','substance':'','elongation':'','uncertain':[]})}}]})
    mock_ai(module,monkeypatch,during)
    assert c.post(f'/api/classroom/lessons/{lid}/model-extractions',json={'revision':1,'file_ids':[fid]}).status_code==409
    with module.engine.connect() as db:
        assert db.execute(text('select count(*) from lesson_model_extractions')).scalar()==0
        assert db.execute(text('select revision from lesson_work')).scalar()==2
