import json
import uuid
from pathlib import Path

import httpx
import pytest

from test_app import env, classroom_login
from test_lesson_v2 import student, submit
from test_lesson_v3 import mock, matching, work
from backend import lesson_grape as grape


def start(c, monkeypatch, stage=1):
    monkeypatch.setenv('CLASSROOM_CODE', 'BIO-302')
    monkeypatch.setenv('CLASSROOM_TEACHER_PASSWORD', 'teacher-test-password')
    classroom_login(c, teacher=True)
    r = c.post('/api/classroom/lessons', json={})
    assert r.status_code == 201, r.text
    assert r.json()['flow_version'] == 4 and r.json()['group_count'] == 8
    lid = r.json()['id']
    if stage > 1:
        assert c.patch(f'/api/classroom/lessons/{lid}', json={'stage': stage}).status_code == 200
    return lid


def chat(c, lid, message, stage=1):
    return c.post('/api/classroom/chats', json=dict(lesson_id=lid, stage=stage,
        message=message, request_id=str(uuid.uuid4())))


def scoring(readable=True, evidence='field:design', points=(10, 15, 15), control=20):
    return dict(readable=readable, clarification='' if readable else '照片中手写内容不清，请补拍。',
        treatment_parts=dict(zip(grape.PART_LIMITS, points)),
        items=[dict(key=r[0], points=p, missing=False, evidence=[evidence], reason='本组提出分阶段处理，但缺少品质权衡依据。')
               for r, p in zip(grape.RUBRIC[2], [sum(points), control, 10, 20])],
        feedback=dict(strengths=[dict(key='treatment', text='你们将建议分成了不同阶段。')],
                      improvements=[dict(key='control', text='请补充一个品质指标作为取舍依据。')]))


def test_default_grape_stages_and_no_early_data(env, monkeypatch):
    _, c = env; lid = start(c, monkeypatch); student(c, 8)
    stage = c.get(f'/api/classroom/lessons/{lid}/stages/1').json()
    assert len(stage['stages']) == 2 and '案例' in stage['content']['title']
    assert '170' not in json.dumps(stage) and '320' not in json.dumps(stage)
    assert c.get(f'/api/classroom/lessons/{lid}/stages/2').status_code == 403
    assert c.get(f'/api/classroom/lessons/{lid}/teaching-guide').status_code == 403
    assert submit(c, lid, 1, {}).status_code == 422
    assert [s['stage'] for s in work(c, lid, group=8)['scores']['stages']] == [2]


def test_only_matched_masses_are_server_values_and_history_is_preserved(env, monkeypatch):
    module, c = env; lid = start(c, monkeypatch); student(c, 1)
    answers = [matching('water', 'ga3'), matching('combined', uncovered=['生长素处理'])]
    calls = mock(module, monkeypatch, lambda _: answers.pop(0))
    for revision in range(2):
        assert submit(c, lid, 1, {'design': '本组按任务设计不同处理'}, revision=revision).status_code == 201
    current = work(c, lid)
    old = current['versions'][0]['result_match']['matches']
    assert [(r['mass'], r['uncertainty']) for r in old] == [(170, 5.7), (225, 2.8)]
    assert len(current['result_match']['matches']) == 1
    assert current['result_match']['matches'][0]['mass'] == 320
    assert 'image' not in current['result_match']['matches'][0]
    assert current['result_match']['uncovered'] == ['生长素处理']
    assert current['scores']['graded'] == 0
    assert '不要求浓度' in calls[0]['messages'][0]['content']
    student(c, 2)
    assert c.get(f'/api/classroom/lessons/{lid}/groups/1/stages/1').status_code == 404


def test_cases_and_results_work_in_chat_without_fabricated_values(env, monkeypatch):
    module, c = env; lid = start(c, monkeypatch); student(c, 1)
    replies = [dict(**matching(), case_ids=['cytokinin'], text='虚构数值999克'),
               dict(**matching('ga3', 'cppu', questions=['是否还加入其他药剂？']), case_ids=[], text='应该返回999克')]
    calls = mock(module, monkeypatch, lambda _: replies.pop(0))
    answer = chat(c, lid, '请给我细胞分裂素的案例')
    assert answer.status_code == 201, answer.text
    assert grape.CASES['cytokinin'][1] in answer.json()['answer']
    assert '999' not in answer.json()['answer'] and '生长素案例' not in answer.json()['answer']
    answer = chat(c, lid, '两组分别用GA3和CPPU处理')
    assert answer.status_code == 201, answer.text
    assert '225 ± 2.8 g' in answer.json()['answer'] and '300 ± 2.8 g' in answer.json()['answer']
    assert '320' not in answer.json()['answer'] and '999' not in answer.json()['answer']
    assert answer.json()['answer'] == '对应处理的百粒质量：\nGA₃：225 ± 2.8 g\nCPPU：300 ± 2.8 g'
    assert 'case_ids' in calls[0]['response_format']['json_schema']['schema']['properties']


def test_unknown_and_unreadable_treatments_do_not_gain_results(env, monkeypatch):
    module, c = env; lid = start(c, monkeypatch); student(c, 1)
    responses = [matching(uncovered=['苹果施用GA3']), matching(questions=['请补拍处理文字'], readable=False)]
    mock(module, monkeypatch, lambda _: responses.pop(0))
    assert submit(c, lid, 1, {'design': '苹果施用GA3'}).status_code == 201
    assert work(c, lid)['result_match']['status'] == 'unmatched'
    assert submit(c, lid, 1, {'design': '处理字迹不清'}, revision=1).status_code == 201
    assert work(c, lid)['result_match']['status'] == 'needs_clarification'
    assert work(c, lid)['result_match']['matches'] == []


def test_photo_grading_uses_grape_rubric_and_preserves_previous_score(env, monkeypatch):
    module, c = env; lid = start(c, monkeypatch, 2); student(c, 1)
    file = c.post(f'/api/classroom/files?lesson_id={lid}&stage=2', files={
        'file': ('方案.png', Path('backend/lesson_assets/cells.png').read_bytes(), 'image/png')}).json()['id']
    replies = [scoring(evidence='file:'+file), scoring(readable=False, evidence='file:'+file), scoring(control=30)]
    calls = mock(module, monkeypatch, lambda _: replies.pop(0))
    assert submit(c, lid, 2, {}, files=[file]).status_code == 201
    first = work(c, lid, 2)
    assert first['scores']['total'] == 90
    assert first['versions'][0]['assessment']['feedback']['strengths']
    assert len(first['versions'][0]['assessment']['feedback']['improvements']) <= 2
    assert submit(c, lid, 2, {}, files=[file], revision=1).status_code == 201
    score = work(c, lid, 2)['scores']['stages'][0]
    assert score['status'] == 'needs_clarification' and score['total'] is None
    assert score['retained_score']['total'] == 90
    assert submit(c, lid, 2, {'design': '分阶段建议、证据、品质权衡及调整'}, revision=2).status_code == 201
    score = work(c, lid, 2)['scores']['stages'][0]
    assert score['total'] == 100 and [h['total'] for h in score['history']] == [90, 100]
    assert '葡萄增产方案' in calls[0]['messages'][0]['content']
    assert 'image_url' in str(calls[0]['messages'][1]['content'])
    assert json.loads(calls[0]['messages'][1]['content'][0]['text'])['student_messages'] == []
    classroom_login(c, teacher=True)
    summary = c.get(f'/api/classroom/lessons/{lid}/design-summary').json()
    assert summary['status'] == 'ready' and summary['evaluated'] == 1


@pytest.mark.parametrize('bad', [dict(matches=[dict(result_id='water', excerpt='对照', mass=999)]),
                                 dict(matches=[dict(result_id='fake', excerpt='不存在')])])
def test_model_cannot_add_masses_or_unknown_result_ids(bad):
    with pytest.raises(ValueError):
        grape.validate_matches(dict(**matching(), **{}) | bad)
