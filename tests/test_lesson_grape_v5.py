"""10.2 curriculum, source conditions, and frozen historical-job integration."""
import asyncio
import json
import uuid
from pathlib import Path

import httpx
import pytest
from sqlalchemy import text

from test_app import env, classroom_login
from test_lesson_v2 import student, submit
from test_lesson_v3 import mock, matching, work
from test_lesson_grape import chat, scoring as old_scoring
from backend import lesson_grape_v5 as grape
from backend import lesson_grape as old


def start(c, monkeypatch, stage=1, flow=None):
    monkeypatch.setenv('CLASSROOM_CODE', 'BIO-302')
    monkeypatch.setenv('CLASSROOM_TEACHER_PASSWORD', 'teacher-test-password')
    classroom_login(c, teacher=True)
    response = c.post('/api/classroom/lessons', json={} if flow is None else {'flow_version': flow})
    assert response.status_code == 201, response.text
    assert response.json()['flow_version'] == (flow or 5)
    assert response.json()['group_count'] == 8
    lid = response.json()['id']
    if stage > 1:
        assert c.patch(f'/api/classroom/lessons/{lid}', json={'stage': stage}).status_code == 200
    return lid


def scoring(**kwargs):
    result = old_scoring(**kwargs)
    result['treatment_parts'] = dict(zip(grape.PART_LIMITS, result['treatment_parts'].values()))
    return result


@pytest.mark.parametrize('message,ids,missing', [
    ('仅加入CPPU', ['cppu'], 0),
    ('B组：GA₃', ['ga3'], 0),
    ('B组：喷施GA3（25 mg/L）；C组：使用CPPU10mg/L', ['ga3', 'cppu'], 0),
    ('B组：使用0.025g/L的GA3', ['ga3'], 0),
    ('B组：使用25000μg/mL的GA3', [], 1),
    ('B组：用GA3 50mg/L；C组：用CPPU10mg/L', ['cppu'], 1),
    ('同一组：GA3(25mg/L)+CPPU(10mg/L)', ['combined'], 0),
    ('同一组：GA3(25mg/L)+CPPU(20mg/L)', [], 1),
    ('两组分别用GA3和CPPU处理', ['ga3', 'cppu'], 0),
    ('A组：蒸馏水；B组：GA3；C组：CPPU；D组：GA3+CPPU', ['water', 'ga3', 'cppu', 'combined'], 0),
])
def test_simple_designs_use_default_conditions_and_check_explicit_concentrations(message, ids, missing):
    result = grape.direct_matches(message)
    assert result is not None
    assert [m['result_id'] for m in result['matches']] == ids
    assert len(result['uncovered']) == missing


@pytest.mark.parametrize('message', [
    '材料有GA3、CPPU和蒸馏水', '苹果喷施GA3', '把GA3喷到叶片',
    'B组：不用GA3，改用生长素', 'GA3应该用多少？',
    'A组：定期向葡萄果穗喷施适量蒸馏水\nB组：',
    'B组：用GA3处理一天就采收', '仅用GA3和生长素联合处理',
    '两组分别用GA3 50mg/L和CPPU 10mg/L处理',
])
def test_prose_and_changed_conditions_cannot_bypass_classifier(message):
    assert grape.direct_matches(message) is None


def test_default_curriculum_has_gated_current_assets_and_no_early_results(env, monkeypatch):
    _, c = env
    lid = start(c, monkeypatch)
    student(c, 8)
    stage = c.get(f'/api/classroom/lessons/{lid}/stages/1').json()
    assert len(stage['stages']) == 2
    rendered = json.dumps(stage, ensure_ascii=False)
    for phrase in ['10 mg/L', '25 mg/L', '一个生长季', '葡萄果穗']:
        assert phrase in rendered
    assert '170' not in rendered and '320' not in rendered and 'grape-relations' not in rendered
    path = f'/api/classroom/lessons/{lid}/materials/grape-relations/assets/grape-1002-hormones.png'
    assert c.get(path).status_code == 403
    assert c.get(f'/api/classroom/lessons/{lid}/teaching-guide').status_code == 403
    classroom_login(c, teacher=True)
    guide = c.get(f'/api/classroom/lessons/{lid}/teaching-guide').json()
    assert guide['version'] == grape.RUBRIC_VERSION
    assert 'significance' not in json.dumps(guide)
    c.patch(f'/api/classroom/lessons/{lid}', json={'stage': 2})
    student(c, 8)
    stage = c.get(f'/api/classroom/lessons/{lid}/stages/2').json()
    assert len(stage['content']['fields']) == 1
    for material in stage['materials']:
        for image in material['images']:
            response = c.get(image['url'])
            assert response.status_code == 200
            assert response.content == Path('backend/lesson_assets', image['url'].split('/')[-1]).read_bytes()
    assert '芽的萌发' in stage['content']['fields'][0]['placeholder']


def test_chat_and_submission_share_conditions_and_show_partial_warnings(env, monkeypatch):
    module, c = env
    lid = start(c, monkeypatch)
    student(c, 1)
    calls = mock(module, monkeypatch, lambda _: pytest.fail('Simple treatments must not call AI'))
    design = 'B组：用GA3 50mg/L；C组：用CPPU10mg/L'
    reply = chat(c, lid, design)
    assert reply.status_code == 201, reply.text
    assert '300 ± 2.8 g' in reply.json()['answer'] and '225' not in reply.json()['answer']
    assert '浓度与任务单给定条件不同' in reply.json()['answer']
    assert submit(c, lid, 1, {'design': design}).status_code == 201
    result = work(c, lid)['result_match']
    assert result['status'] == 'ready'
    assert [r['result_id'] for r in result['matches']] == ['cppu']
    assert result['uncovered'] and 'significance' not in result['matches'][0]
    assert work(c, lid)['scores']['graded'] == 0 and not calls
    student(c, 2)
    assert c.get(f'/api/classroom/lessons/{lid}/groups/1/stages/1').status_code == 404


def test_photo_rules_and_mixed_results_are_used_in_both_input_paths(env, monkeypatch):
    module, c = env
    lid = start(c, monkeypatch)
    student(c, 1)
    file = c.post(f'/api/classroom/files?lesson_id={lid}&stage=1', files={
        'file': ('任务单.jpg', Path('backend/lesson_assets/grape-1002-cases.jpg').read_bytes(), 'image/jpeg')}).json()['id']
    replies = [matching(questions=['请补充本组设计']),
               matching('cppu', questions=['D组具体处理是什么？'], uncovered=['B组浓度不同'])]
    calls = mock(module, monkeypatch, lambda _: replies.pop(0))
    assert submit(c, lid, 1, {}, files=[file]).status_code == 201
    assert work(c, lid)['result_match']['status'] == 'needs_clarification'
    assert work(c, lid)['result_match']['matches'] == []
    body = dict(lesson_id=lid, stage=1, message='请根据照片识别本组设计', image_ids=[file], request_id=str(uuid.uuid4()))
    response = c.post('/api/classroom/chats', json=body)
    assert response.status_code == 201, response.text
    assert all(s in response.json()['answer'] for s in ['300 ± 2.8 g', 'D组具体处理', 'B组浓度不同'])
    for call in calls:
        assert grape.MATCH_PROMPT in call['messages'][0]['content']
        assert 'image_url' in str(call['messages'][1:])


def test_new_grading_history_summary_and_guidance(env, monkeypatch):
    module, c = env
    lid = start(c, monkeypatch, 2)
    student(c, 1)
    replies = [scoring(), scoring(readable=False), scoring(control=30),
               dict(text='请核对芽萌发建议的证据。', step=2, mastery='已区分种子与芽')]
    calls = mock(module, monkeypatch, lambda _: replies.pop(0))
    for revision in range(3):
        assert submit(c, lid, 2, {'design': '按芽萌发、膨大、成熟提出方案和跟踪调整'}, revision=revision).status_code == 201
        if revision == 1:
            assert work(c, lid, 2)['scores']['stages'][0]['retained_score']['total'] == 90
    history = work(c, lid, 2)['scores']['stages'][0]['history']
    assert [h['total'] for h in history] == [90, 100]
    assert grape.SCORING_RULES in calls[0]['messages'][0]['content']
    assert set(calls[0]['response_format']['json_schema']['schema']['properties']['treatment_parts']['properties']) == set(grape.PART_LIMITS)
    assert chat(c, lid, '我们的萌芽建议有证据吗？', stage=2).json()['answer'] == '请核对芽萌发建议的证据。'
    assert '芽的萌发' in calls[-1]['messages'][0]['content']
    classroom_login(c, teacher=True)
    summary = c.get(f'/api/classroom/lessons/{lid}/design-summary').json()
    assert summary['evaluated'] == 1 and summary['status'] == 'ready'
    version = history[-1]['version_id']
    assert c.put(f'/api/classroom/lessons/{lid}/assessments/{version}', json={
        'points': {'treatment': 35, 'control': 30, 'conditions': 10, 'prediction': 20}, 'reason': '依据本次方案复核'}).status_code == 200
    assert work(c, lid, 2)['scores']['total'] == 95


@pytest.mark.parametrize('flow,curriculum,grade', [(4, old, old_scoring), (5, grape, scoring)])
def test_failed_historical_jobs_retry_with_their_own_curriculum(env, monkeypatch, flow, curriculum, grade):
    module, c = env
    lid = start(c, monkeypatch, flow=flow)
    student(c, 1)
    replies = [httpx.Response(502), matching('ga3'), httpx.Response(502), grade()]
    calls = mock(module, monkeypatch, lambda _: replies.pop(0))
    submit(c, lid, 1, {'design': '本组设计见描述'})
    version = work(c, lid)['versions'][-1]['id']
    assert work(c, lid)['result_match']['status'] == 'failed'
    assert c.post(f'/api/classroom/lessons/{lid}/matches/{version}/retry').status_code == 200
    result = work(c, lid)['result_match']['matches'][0]
    assert result['mass'] == 225 and ('significance' in result) == (flow == 4)
    assert curriculum.MATCH_PROMPT in calls[1]['messages'][0]['content']
    classroom_login(c, teacher=True); c.patch(f'/api/classroom/lessons/{lid}', json={'stage': 2}); student(c, 1)
    submit(c, lid, 2, {'design': '本组分阶段方案'})
    version = work(c, lid, 2)['versions'][-1]['id']
    assert work(c, lid, 2)['scores']['stages'][0]['status'] == 'failed'
    assert c.post(f'/api/classroom/lessons/{lid}/assessments/{version}/retry').status_code == 200
    assert work(c, lid, 2)['scores']['total'] == 90
    assert curriculum.SCORING_RULES in calls[-1]['messages'][0]['content']
    with module.engine.connect() as db:
        assert db.execute(text('SELECT rubric_version FROM lesson_assessments WHERE version_id=:id'), {'id': version}).scalar() == curriculum.RUBRIC_VERSION


def test_eight_groups_keep_separate_v5_results(env, monkeypatch):
    module, c = env
    lid = start(c, monkeypatch)
    cookies = []
    for group in range(1, 9):
        c.cookies.clear(); student(c, group); cookies.append(dict(c.cookies))
    monkeypatch.setenv('AI_API_KEY', 'unused')
    monkeypatch.setenv('AI_MODEL', 'unused')
    async def submit_one(group):
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=module.app), base_url='http://testserver',
                                    headers={'X-Workbench': '1', 'Origin': 'http://testserver'}, cookies=cookies[group-1]) as client:
            response = await client.post(f'/api/classroom/lessons/{lid}/stages/1/submissions', json={
                'fields': {'design': 'B组：GA3'}, 'revision': 0, 'request_id': str(uuid.uuid4())})
            assert response.status_code == 201, response.text
            data = (await client.get(f'/api/classroom/lessons/{lid}/groups/{group}/stages/1')).json()
            assert data['result_match']['matches'][0]['mass'] == 225
            return data['result_match']['version_id']
    async def run():
        return await asyncio.gather(*(submit_one(group) for group in range(1, 9)))
    assert len(set(c.portal.call(run))) == 8
