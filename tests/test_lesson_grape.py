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


@pytest.mark.parametrize('message,expected', [
    ('仅加入CPPU', ['cppu']), ('只加 cppu', ['cppu']), ('单独施用氯吡脲', ['cppu']),
    ('加入GA3', ['ga3']), ('用ＧＡ₃处理', ['ga3']), ('赤霉素处理', ['ga3']),
    ('对照组加蒸馏水', ['water']), ('清水对照', ['water']),
    ('同一组加入GA3和CPPU', ['combined']), ('同时用CPPU与GA3处理', ['combined']),
    ('GA₃＋CPPU处理', ['combined']), ('赤霉素和氯吡脲联合处理', ['combined']),
    ('两组分别用GA3和CPPU处理', ['ga3', 'cppu']),
    ('A组：加入水；B组：加入GA3；C组：只用CPPU；D组：GA3+CPPU处理', ['water', 'ga3', 'cppu', 'combined']),
    ('第一组加水\n第二组用GA₃\n第三组使用赤霉素', ['water', 'ga3']),
])
def test_explicit_treatment_lookup(message, expected):
    result = grape.validate_matches(grape.direct_matches(message))
    assert [r['result_id'] for r in result['matches']] == expected
    assert all(r['excerpt'] for r in result['matches'])


@pytest.mark.parametrize('message', [
    '', 'CPPU', '有GA3、CPPU和水', '哪种效果好', '仅加入CPPU吗？', '不用CPPU',
    '不加GA3，只加CPPU', '不加CPPU而加GA3', '再加入CPPU', '按上面的方案加入CPPU',
    '苹果使用GA3', '用GA3和乙烯处理', '加入GA3并补充脱落酸', '施用细胞分裂素',
    '加入CPPU，为什么果粒会变大？', '加入CPPU，请给我案例', '对照组不处理',
    '加入GA3，其他组按照片处理', '使用GA3或CPPU', '加入GA30', '加入水+CPPU',
    '加入GA3，加入CPPU', '同一组加GA3；同一组加CPPU', 'A组加GA3，A组加CPPU',
])
def test_lookup_defers_ambiguous_or_unsupported_messages(message):
    assert grape.direct_matches(message) is None


def test_explicit_chat_and_submission_skip_ai_preserve_history_and_deduplicate(env, monkeypatch):
    module, c = env; lid = start(c, monkeypatch); student(c, 1)
    def unexpected(_):
        pytest.fail('Explicit treatment must not call the model')
    calls = mock(module, monkeypatch, unexpected)
    assert '225 ± 2.8 g' in chat(c, lid, '加入GA3').json()['answer']
    body = dict(lesson_id=lid, stage=1, message='仅加入CPPU', request_id=str(uuid.uuid4()))
    response = c.post('/api/classroom/chats', json=body)
    assert response.status_code == 201, response.text
    assert response.json()['answer'] == '对应处理的百粒质量：\nCPPU：300 ± 2.8 g'
    assert c.post('/api/classroom/chats', json=body).json() == response.json()
    history = c.get(f'/api/classroom/lessons/{lid}/groups?stage=1').json()[0]['chats']
    assert len(history) == 2
    assert history[-1]['answer'] == response.json()['answer']
    result = submit(c, lid, 1, {'design': '对照组用水；实验组仅加入CPPU'})
    assert result.status_code == 201, result.text
    rows = work(c, lid)['result_match']['matches']
    assert [(r['result_id'], r['mass']) for r in rows] == [('water', 170), ('cppu', 300)]
    assert calls == []


def test_photos_and_complex_treatments_still_use_ai(env, monkeypatch):
    module, c = env; lid = start(c, monkeypatch); student(c, 1)
    responses = [matching('cppu'),
                 matching(questions=['请说明葡萄各组如何处理']),
                 matching('cppu')]
    calls = mock(module, monkeypatch, lambda _: responses.pop(0))
    photo = c.post(f'/api/classroom/files?lesson_id={lid}&stage=1', files={
        'file': ('实验.png', Path('backend/lesson_assets/cells.png').read_bytes(), 'image/png')}).json()['id']
    answer = c.post('/api/classroom/chats', json=dict(lesson_id=lid, stage=1,
        message='仅加入CPPU', image_ids=[photo], request_id=str(uuid.uuid4())))
    assert answer.status_code == 201 and len(calls) == 1
    assert chat(c, lid, '苹果使用GA3').status_code == 201 and len(calls) == 2
    assert submit(c, lid, 1, {'design': '仅加入CPPU'}, files=[photo]).status_code == 201
    assert len(calls) == 3


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
    assert len(stage['stages']) == 2 and stage['content']['title'] == '实验设计与实验数据'
    assert stage['content']['prompts'] == []
    assert '案例' not in stage['content']['task'] + stage['opener']
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


def test_chat_requests_require_design_and_return_only_matched_results(env, monkeypatch):
    module, c = env; lid = start(c, monkeypatch); student(c, 1)
    replies = [matching(), matching(),
               matching('cppu', questions=['是否还加入其他药剂？']), matching()]
    calls = mock(module, monkeypatch, lambda _: replies.pop(0))
    for message in ['请给我细胞分裂素的案例', '请给我实验数据']:
        answer = chat(c, lid, message)
        assert answer.status_code == 201, answer.text
        assert answer.json()['answer'] == '请先提供本组的实验设计，写明各实验组分别用什么处理，也可拍照提交。'
    properties = calls[0]['response_format']['json_schema']['schema']['properties']
    assert set(properties) == {'readable', 'matches', 'questions', 'uncovered'}
    assert '不提供激素案例' in calls[0]['messages'][0]['content']
    answer = chat(c, lid, '加入CPPU，请给我案例')
    assert answer.status_code == 201, answer.text
    assert answer.json()['answer'] == '对应处理的百粒质量：\nCPPU：300 ± 2.8 g'
    answer = chat(c, lid, '两组分别用GA3和CPPU处理')
    assert answer.status_code == 201, answer.text
    assert '225 ± 2.8 g' in answer.json()['answer'] and '300 ± 2.8 g' in answer.json()['answer']
    assert '320' not in answer.json()['answer'] and '999' not in answer.json()['answer']
    assert answer.json()['answer'] == '对应处理的百粒质量：\nGA₃：225 ± 2.8 g\nCPPU：300 ± 2.8 g'
    answer = chat(c, lid, '再给我生长素的案例')
    assert answer.status_code == 201, answer.text
    assert '请先提供本组的实验设计' in answer.json()['answer']
    assert 'g' not in answer.json()['answer'] and '案例' not in answer.json()['answer']


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
