import json
import uuid
import asyncio
from pathlib import Path

import httpx
from sqlalchemy import text
from fastapi import BackgroundTasks

from test_app import env, classroom_login
from test_lesson_v2 import student, submit
from backend import lesson_v3 as v3


def start(c, monkeypatch, stage=1):
    monkeypatch.setenv('CLASSROOM_CODE', 'BIO-302')
    monkeypatch.setenv('CLASSROOM_TEACHER_PASSWORD', 'teacher-test-password')
    classroom_login(c, teacher=True)
    r = c.post('/api/classroom/lessons', json={'title': '两部分验收', 'flow_version': 3})
    assert r.status_code == 201, r.text
    assert r.json()['flow_version'] == 3 and r.json()['group_count'] == 8
    lid = r.json()['id']
    if stage > 1:
        assert c.patch(f'/api/classroom/lessons/{lid}', json={'stage': stage}).status_code == 200
    return lid


def matching(*ids, questions=None, uncovered=None, readable=True):
    return dict(readable=readable, matches=[dict(result_id=key, excerpt='本组对应的处理') for key in ids],
                questions=questions or [], uncovered=uncovered or [])


def scoring(parts=(10, 20, 10), control=30, readable=True, evidence='field:design'):
    points = [sum(parts), control, 10, 20]
    return dict(readable=readable, clarification='' if readable else '照片中的处理步骤看不清，请补拍。',
                treatment_parts=dict(zip(['hypothesis', 'sided_comparison', 'readout'], parts)),
                items=[dict(key=r[0], points=p, missing=False, evidence=[evidence], reason='依据本次方案的操作')
                       for r, p in zip(v3.RUBRIC[2], points)],
                feedback=dict(strengths=[dict(key='treatment', text='你们明确了琼脂的使用方式。')],
                              improvements=[] if sum(points) == 100 else [dict(key='control', text='请检查你们两组的放置方式是否对应。')]))


def mock(module, monkeypatch, handler):
    monkeypatch.setenv('AI_API_KEY', 'test')
    monkeypatch.setenv('AI_MODEL', 'mock')
    real = httpx.AsyncClient
    calls = []

    def receive(req):
        body = json.loads(req.content)
        if 'overview' in body.get('response_format', {}).get('json_schema', {}).get('schema', {}).get('properties', {}):
            return httpx.Response(200, json={'choices': [{'message': {'content': json.dumps(dict(overview='依据各组最新方案归纳', issues=[], discussion=[]))}}]})
        calls.append(body)
        assert body['response_format']['type'] == 'json_schema'
        answer = handler(body)
        if isinstance(answer, httpx.Response): return answer
        return httpx.Response(200, json={'choices': [{'message': {'content': json.dumps(answer, ensure_ascii=False)}}]})

    monkeypatch.setattr(module.httpx, 'AsyncClient', lambda **kw: real(transport=httpx.MockTransport(receive), **kw))
    return calls


def work(c, lid, stage=1, group=1):
    r = c.get(f'/api/classroom/lessons/{lid}/groups/{group}/stages/{stage}')
    assert r.status_code == 200, r.text
    return r.json()


def test_six_original_results_multiple_versions_and_access(env, monkeypatch):
    module, c = env; lid = start(c, monkeypatch); student(c, 1)
    ids = list(v3.RESULTS)
    answers = [matching(key) for key in ids] + [matching(ids[0], ids[2])]
    calls = mock(module, monkeypatch, lambda _: answers.pop(0))
    for i in range(7):
        response = submit(c, lid, 1, {'design': '切断尖端，在明确的一侧插入材料'}, revision=i)
        assert response.status_code == 201, response.text
        current = work(c, lid)
        match = current['result_match']
        assert match['version_id'] == response.json()['submission_id']
        assert match['status'] == 'ready'
        for entry in match['matches']:
            image = c.get(entry['image'])
            assert image.content == (Path('backend/lesson_assets') / v3.RESULTS[entry['result_id']][1]).read_bytes()
        assert len(current['versions']) == i + 1
        assert len(current['scores']['stages']) == 1 and current['scores']['graded'] == 0
    assert len(current['result_match']['matches']) == 2
    assert len(calls) == 7
    with module.engine.connect() as db:
        assert db.execute(text('select count(*) from lesson_design_matches')).scalar() == 7
        assert db.execute(text('select count(*) from lesson_assessments')).scalar() == 0
    previous = current['versions'][0]['result_match']['matches'][0]['image']
    assert c.get(previous).status_code == 200
    assert c.get(previous.rsplit('/', 1)[0] + '/mica_separator').status_code == 404
    student(c, 2)
    assert c.get(previous).status_code == 404
    assert c.get(f'/api/classroom/lessons/{lid}/groups/1/stages/1').status_code == 404


def test_clarification_uncovered_unreadable_and_empty_validation(env, monkeypatch):
    module, c = env; lid = start(c, monkeypatch); student(c, 1)
    answers = [matching(questions=['你们准备在哪一侧插入云母片？']),
               matching(uncovered=['整段移除幼苗下部']),
               matching(readable=False, questions=['照片中文字模糊，请补拍处理位置。']),
               matching('gelatin_separator', questions=['另一处理的云母片插在哪一侧？'])]
    calls = mock(module, monkeypatch, lambda _: answers.pop(0))
    assert submit(c, lid, 1, {}).status_code == 422
    assert not calls
    for i, expected in enumerate(['needs_clarification', 'unmatched', 'needs_clarification', 'ready']):
        assert submit(c, lid, 1, {'design': '待核对的思路'}, revision=i).status_code == 201
        match = work(c, lid)['result_match']
        assert match['status'] == expected
    assert len(match['matches']) == 1 and len(match['questions']) == 1


def test_private_materials_neutral_collection_and_versioned_controls(env, monkeypatch):
    _, c = env; lid = start(c, monkeypatch)
    for body in [{'stage': 3}, {'release_results': True}, {'reveal_research': True}]:
        assert c.patch(f'/api/classroom/lessons/{lid}', json=body).status_code == 422
    guide = c.get(f'/api/classroom/lessons/{lid}/teaching-guide').json()
    assert list(guide['rubric']) == ['2'] and len(guide['matching']) == 6
    student(c, 1)
    assert c.get(f'/api/classroom/lessons/{lid}/stages/2').status_code == 403
    for material, asset in [('agar-collection', 'agar-collection.svg'), ('went-comparison', 'went.png'),
                            ('inquiry-materials', 'inquiry-result-1.png')]:
        assert c.get(f'/api/classroom/lessons/{lid}/materials/{material}/assets/{asset}').status_code == 403
    assert c.get(f'/api/classroom/lessons/{lid}/teaching-guide').status_code == 403
    classroom_login(c, teacher=True)
    c.patch(f'/api/classroom/lessons/{lid}', json={'stage': 2})
    student(c, 1)
    stage = c.get(f'/api/classroom/lessons/{lid}/stages/2').json()
    assert len(stage['stages']) == 2
    diagram = c.get(stage['materials'][-1]['images'][0]['url'])
    assert diagram.status_code == 200
    assert '生长素' not in diagram.text and '促进' not in diagram.text and '移去尖端' in diagram.text
    assert c.get(f'/api/classroom/lessons/{lid}/materials/went-comparison/assets/went.png').status_code == 403


def test_photo_only_matches_and_rejects_nonimage_submission(env, monkeypatch):
    module, c = env; lid = start(c, monkeypatch); student(c, 1)
    image = Path('backend/lesson_assets/cells.png').read_bytes()
    file = c.post(f'/api/classroom/files?lesson_id={lid}&stage=1', files={'file': ('思路.png', image, 'image/png')}).json()['id']
    calls = mock(module, monkeypatch, lambda _: matching('mica_light_side'))
    assert submit(c, lid, 1, {}, files=[file]).status_code == 201
    assert any(p['type'] == 'image_url' for p in calls[0]['messages'][1]['content'])
    file = c.post(f'/api/classroom/files?lesson_id={lid}&stage=1', files={'file': ('方案.txt', '仅供保存', 'text/plain')}).json()['id']
    assert submit(c, lid, 1, {}, revision=1, files=[file]).status_code == 422
    assert len(calls) == 1


def test_matching_failure_retry_deduplication_and_archive(env, monkeypatch):
    module, c = env; lid = start(c, monkeypatch); student(c, 1)
    responses = [httpx.Response(502), matching('mica_separator')]
    calls = mock(module, monkeypatch, lambda _: responses.pop(0))
    token = str(uuid.uuid4())
    submitted = submit(c, lid, 1, {'design': '云母片完全隔断'}, token=token)
    vid = submitted.json()['submission_id']
    assert work(c, lid)['result_match']['status'] == 'failed'
    assert submit(c, lid, 1, {'design': '云母片完全隔断'}, token=token).json()['submission_id'] == vid
    assert len(calls) == 1
    student(c, 2)
    assert c.post(f'/api/classroom/lessons/{lid}/matches/{vid}/retry').status_code == 404
    student(c, 1)
    assert c.post(f'/api/classroom/lessons/{lid}/matches/{vid}/retry').status_code == 200
    result = work(c, lid)['result_match']
    assert result['status'] == 'ready' and len(calls) == 2
    assert c.post(f'/api/classroom/lessons/{lid}/matches/{vid}/retry').status_code == 409
    classroom_login(c, teacher=True); c.patch(f'/api/classroom/lessons/{lid}', json={'status': 'archived'})
    student(c, 1)
    assert c.get(result['matches'][0]['image']).status_code == 200
    assert c.post(f'/api/classroom/lessons/{lid}/matches/{vid}/retry').status_code == 409


def test_scoring_current_submission_only_components_history_and_teacher_correction(env, monkeypatch):
    module, c = env; lid = start(c, monkeypatch, 2); student(c, 1)
    responses = [scoring((10, 0, 10)), scoring(), scoring((0, 20, 10), control=0)]
    # Even if the model supplies an inconsistent 40, the server adds the components.
    responses[0]['items'][0]['points'] = 40
    calls = mock(module, monkeypatch, lambda _: responses.pop(0))
    for i, score in enumerate([80, 100, 60]):
        r = submit(c, lid, 2, {'design': ['检验突变体推测但未分别比较两侧，观察伸长', '比较野生型和突变体两侧琼脂在相同受体上的作用，其余相同，说明不同结果的判断', '目标未明确，无有效参照'][i]}, revision=i)
        assert r.status_code == 201, r.text
        current = work(c, lid, 2)
        assert current['scores']['total'] == score
        assert current['scores']['stages'][0]['version_id'] == r.json()['submission_id']
    assert [v['assessment']['total'] for v in current['versions']] == [80, 100, 60]
    for call in calls:
        payload = json.loads(call['messages'][1]['content'][0]['text'])
        assert payload['student_messages'] == []
        assert '不因缺少样本量、重复次数或具体时长扣分' in call['messages'][0]['content']
    assert all('reason' not in item for item in current['scores']['stages'][0]['items'])
    classroom_login(c, teacher=True)
    vid = current['versions'][-1]['id']
    response = c.put(f'/api/classroom/lessons/{lid}/assessments/{vid}', json={
        'points': {'treatment': 20, 'control': 10, 'conditions': 10, 'prediction': 10}, 'reason': '按原图复核'})
    assert response.status_code == 200, response.text
    current = work(c, lid, 2)
    assert current['scores']['total'] == 50 and current['versions'][-1]['assessment']['status'] == 'corrected'


def test_unreadable_photo_requests_clarification_without_zero_grade_and_retry_failure(env, monkeypatch):
    module, c = env; lid = start(c, monkeypatch, 2); student(c, 1)
    file = c.post(f'/api/classroom/files?lesson_id={lid}&stage=2', files={
        'file': ('模糊.png', Path('backend/lesson_assets/cells.png').read_bytes(), 'image/png')}).json()['id']
    responses = [scoring(readable=False, evidence='file:' + file), httpx.Response(502), scoring()]
    mock(module, monkeypatch, lambda _: responses.pop(0))
    assert submit(c, lid, 2, {}, files=[file]).status_code == 201
    current = work(c, lid, 2)
    entry = current['scores']['stages'][0]
    assert entry['status'] == 'needs_clarification' and entry['total'] is None and current['scores']['graded'] == 0
    assert '补拍' in entry['clarification']
    assert submit(c, lid, 2, {'design': '文字补充'}, revision=1).status_code == 201
    vid = work(c, lid, 2)['versions'][-1]['id']
    assert c.post(f'/api/classroom/lessons/{lid}/assessments/{vid}/retry').status_code == 200
    assert work(c, lid, 2)['scores']['total'] == 100


def test_v3_chat_allows_agar_and_keeps_structured_guidance(env, monkeypatch):
    module, c = env; lid = start(c, monkeypatch, 2); student(c, 1)
    calls = mock(module, monkeypatch, lambda _: dict(text='请比较两组琼脂的处理有什么不同？', step=2, mastery='学生提出了琼脂处理'))
    body = dict(lesson_id=lid, stage=2, message='请检查琼脂对照', request_id=str(uuid.uuid4()))
    first = c.post('/api/classroom/chats', json=body)
    assert first.status_code == 201, first.text
    assert '琼脂' in first.json()['answer']
    assert c.post('/api/classroom/chats', json=body).json() == first.json()
    assert len(calls) == 1


def test_chat_can_refer_to_each_preserved_result_after_new_submissions(env, monkeypatch):
    module, c = env; lid = start(c, monkeypatch); student(c, 1)
    answers = [matching('gelatin_separator'), matching('mica_light_side'),
               dict(text='请比较两次处理的不同。', step=1, mastery='比较两轮实验')]
    calls = mock(module, monkeypatch, lambda _: answers.pop(0))
    assert submit(c, lid, 1, {'design': '明胶隔层'}).status_code == 201
    first = work(c, lid)['versions'][0]
    assert submit(c, lid, 1, {'design': '向光侧插入云母片'}, revision=1).status_code == 201
    body = dict(lesson_id=lid, stage=1, message='比较第一轮和第二轮实验', request_id=str(uuid.uuid4()))
    response = c.post('/api/classroom/chats', json=body)
    assert response.status_code == 201, response.text
    context = calls[-1]['messages'][0]['content']
    assert '本组历次提交的结果图匹配记录' in context
    assert 'gelatin_separator' in context and 'mica_light_side' in context
    assert first['id'] in context
    student(c, 1)
    current = work(c, lid)
    assert current['versions'][0] == first
    assert len(current['versions']) == 2
    assert c.get(first['result_match']['matches'][0]['image']).status_code == 200
    chats = c.get(f'/api/classroom/lessons/{lid}/groups?stage=1').json()[0]['chats']
    assert chats[0]['created'] == response.json()['created']


def test_late_jobs_never_replace_latest_submission(env, monkeypatch):
    module, c = env; lid = start(c, monkeypatch); student(c, 1)
    queued = []
    monkeypatch.setattr(BackgroundTasks, 'add_task', lambda self, fn, *args, **kw: queued.append((fn, args, kw)))
    responses = [matching('mica_light_side'), matching('gelatin_separator'), scoring(), scoring((10, 0, 10))]
    mock(module, monkeypatch, lambda _: responses.pop(0))
    assert submit(c, lid, 1, {'design': '明胶隔层'}).status_code == 201
    latest = submit(c, lid, 1, {'design': '向光侧插入云母片'}, revision=1).json()['submission_id']
    async def backwards():
        for fn, args, kw in reversed(queued): await fn(*args, **kw)
    asyncio.run(backwards()); queued.clear()
    current = work(c, lid)
    assert current['result_match']['version_id'] == latest
    assert current['result_match']['matches'][0]['result_id'] == 'mica_light_side'
    classroom_login(c, teacher=True); c.patch(f'/api/classroom/lessons/{lid}', json={'stage': 2}); student(c, 1)
    submit(c, lid, 2, {'design': '中央放置'})
    latest = submit(c, lid, 2, {'design': '偏放，并设有效对照'}, revision=1).json()['submission_id']
    asyncio.run(backwards())
    current = work(c, lid, 2)
    assert current['scores']['stages'][0]['version_id'] == latest
    assert current['scores']['total'] == 100
    assert current['versions'][0]['assessment']['total'] == 80


def test_eight_groups_submit_concurrently(env, monkeypatch):
    module, c = env; lid = start(c, monkeypatch)
    cookies = []
    for group in range(1, 9):
        c.cookies.clear()
        student(c, group); cookies.append(dict(c.cookies))
    real_client = httpx.AsyncClient
    calls = mock(module, monkeypatch, lambda _: matching('mica_separator'))
    async def submit_group(group):
        async with real_client(transport=httpx.ASGITransport(app=module.app), base_url='http://testserver',
                               headers={'X-Workbench': '1', 'Origin': 'http://testserver'}, cookies=cookies[group-1]) as client:
            r = await client.post(f'/api/classroom/lessons/{lid}/stages/1/submissions', json={
                'fields': {'design': '用云母片完全隔断尖端与下部'}, 'revision': 0, 'request_id': str(uuid.uuid4())})
            assert r.status_code == 201, r.text
            data = (await client.get(f'/api/classroom/lessons/{lid}/groups/{group}/stages/1')).json()
            assert data['result_match']['status'] == 'ready'
            return data['result_match']['version_id']
    async def run(): return await asyncio.gather(*(submit_group(group) for group in range(1, 9)), return_exceptions=True)
    results = c.portal.call(run)
    assert not any(isinstance(result, BaseException) for result in results), repr(results)
    assert len(set(results)) == 8
    assert len(calls) == 8


def test_invalid_model_result_and_out_of_range_grade_are_retryable(env, monkeypatch):
    module, c = env; lid = start(c, monkeypatch); student(c, 1)
    invalid = matching('gelatin_separator'); invalid['matches'][0]['result_id'] = '../../went.png'
    responses = [invalid, scoring((10, 10, 100))]
    mock(module, monkeypatch, lambda _: responses.pop(0))
    submit(c, lid, 1, {'design': '明胶隔层'})
    assert work(c, lid)['result_match']['status'] == 'failed'
    classroom_login(c, teacher=True); c.patch(f'/api/classroom/lessons/{lid}', json={'stage': 2}); student(c, 1)
    submit(c, lid, 2, {'design': '偏放琼脂'})
    assert work(c, lid, 2)['scores']['stages'][0]['status'] == 'failed'
