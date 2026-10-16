"""Exercise commands against real submissions and mocked AI decisions."""
import json
import uuid

import httpx
import pytest
from sqlalchemy import text

from test_app import env, classroom_login
from test_lesson_v2 import student, submit
from test_lesson_v3 import mock, work
from test_lesson_grape_v5 import start, scoring


def plan(**changes):
    return {**dict(presentation='bar', stage=1, metric='mass', group_ids=list(range(1, 7)),
                result_ids=['water', 'ga3', 'cppu', 'combined'], group_by='treatment', sort='original',
                title='各处理百粒质量', message='已汇总各组结果。', observations=[]), **changes}


def command(c, lid, instruction='汇总各组结果，绘制柱状图', stage=1, request_id=None):
    return c.post(f'/api/classroom/lessons/{lid}/teacher-analysis', json=dict(stage=stage,
        instruction=instruction, request_id=request_id or str(uuid.uuid4())))


def submit_design(c, lid, gid, design, stage=1, revision=0):
    student(c, gid)
    response = submit(c, lid, stage, {'design': design}, revision=revision)
    assert response.status_code == 201, response.text
    return response.json()


def test_ai_command_uses_latest_submissions_deduplicates_and_never_changes_student_work(env, monkeypatch):
    module, c = env
    lid = start(c, monkeypatch)
    latest = submit_design(c, lid, 1, 'B组：GA3')
    submit_design(c, lid, 1, 'C组：CPPU', revision=latest['revision'])
    submit_design(c, lid, 2, '同一组：GA3+CPPU')
    # A draft is not a submitted result.
    student(c, 3)
    assert c.put(f'/api/classroom/lessons/{lid}/stages/1/work', json={
        'revision': 0, 'fields': {'design': 'B组：GA3'}, 'file_ids': []}).status_code == 200
    classroom_login(c, teacher=True)
    calls = mock(module, monkeypatch, lambda body: plan())
    token = str(uuid.uuid4())
    response = command(c, lid, request_id=token)
    assert response.status_code == 200, response.text
    data = response.json()
    assert [r['value'] for r in data['rows']] == [170, 300, 320]
    assert data['rows'][0]['group_ids'] == [1, 2]
    assert [g['group_id'] for g in data['unavailable']] == [3, 4, 5, 6]
    assert data['stale'] is False
    assert len(calls) == 1
    payload = json.loads(calls[0]['messages'][1]['content'])
    assert payload['instruction'] == '汇总各组结果，绘制柱状图'
    assert payload['groups'][0]['design'] == 'C组：CPPU'
    assert payload['groups'][2]['design'] == ''
    assert 'source' not in response.text and 'version_id' not in response.text
    assert command(c, lid, request_id=token).json() == data
    assert len(calls) == 1
    assert command(c, lid, instruction='换个要求', request_id=token).status_code == 409
    with module.engine.connect() as conn:
        assert conn.execute(text('select count(*) from lesson_work_versions')).scalar() == 3
        assert conn.execute(text('select count(*) from classroom_chats')).scalar() == 0


def test_filter_sort_table_and_grounded_summary(env, monkeypatch):
    module, c = env
    lid = start(c, monkeypatch)
    submit_design(c, lid, 1, 'B组：GA3')
    submit_design(c, lid, 2, 'C组：CPPU')
    classroom_login(c, teacher=True)
    choice = plan(presentation='table', group_ids=[1, 2], group_by='group', sort='descending', result_ids=['ga3', 'cppu'])
    mock(module, monkeypatch, lambda body: choice)
    data = command(c, lid, instruction='列表比较第1、2组，不含对照，按质量降序').json()
    assert [r['value'] for r in data['rows']] == [300, 225]
    assert [r['group_ids'] for r in data['rows']] == [[2], [1]]
    choice.update(presentation='summary', result_ids=[], observations=[dict(group_id=1, text='采用GA3处理。', quote='B组：GA3')])
    data = command(c, lid, instruction='总结各组设计').json()
    assert data['observations'] == [dict(group_id=1, text='采用GA3处理。')]
    choice['observations'][0]['quote'] = '并不存在的实验记录'
    assert command(c, lid).status_code == 502
    choice['observations'] = []
    choice['group_ids'] = [9]
    assert command(c, lid).status_code == 502
    choice['group_ids'] = [1, 1]
    assert command(c, lid).status_code == 502


def test_scores_include_zero_and_teacher_corrections_but_never_old_pending_scores(env, monkeypatch):
    module, c = env
    lid = start(c, monkeypatch, stage=2)
    choice = scoring()
    mock(module, monkeypatch, lambda body: choice)
    submit_design(c, lid, 1, '膨大阶段采用适量赤霉素。', stage=2)
    choice = scoring(points=(0, 0), adaptation=0, effect=0, environment=0)
    submit_design(c, lid, 2, '所有阶段都不作任何说明。', stage=2)
    classroom_login(c, teacher=True)
    latest = work(c, lid, stage=2, group=1)
    version = latest['versions'][-1]['id']
    classroom_login(c, teacher=True)
    correction = c.put(f'/api/classroom/lessons/{lid}/assessments/{version}', json={
        'points': {'treatment': 35, 'adaptation': 20, 'effect': 20, 'environment': 20}, 'reason': '复核已写明高温时调整施用。'})
    assert correction.status_code == 200, correction.text
    choice = plan(stage=2, metric='total', group_by='group', sort='descending')
    response = command(c, lid, stage=2, instruction='按总分降序绘制柱状图')
    assert response.status_code == 200, response.text
    assert [r['value'] for r in response.json()['rows']] == [95, 0]
    # A newer pending submission must not inherit the earlier score in this summary.
    with module.engine.begin() as conn:
        conn.execute(text("update lesson_assessments set status='processing' where version_id=:v"), {'v': version})
        conn.execute(text("update lesson_assessments set correction='{}' where version_id=:v"), {'v': version})
    response = command(c, lid, stage=2)
    assert [r['value'] for r in response.json()['rows']] == [0]


def test_empty_results_and_unsupported_instruction_do_not_invent_a_chart(env, monkeypatch):
    module, c = env
    lid = start(c, monkeypatch)
    choice = plan()
    mock(module, monkeypatch, lambda body: choice)
    response = command(c, lid)
    assert response.status_code == 200, response.text
    assert response.json()['rows'] == []
    choice.update(presentation='clarify', message='目前支持百粒质量、评分的柱状图与表格，以及方案文字汇总。')
    response = command(c, lid, instruction='画一个不存在的指标饼图')
    assert response.json()['presentation'] == 'clarify'
    assert response.json()['rows'] == []


def test_authorization_stages_archive_and_invalid_input(env, monkeypatch):
    module, c = env
    lid = start(c, monkeypatch)
    calls = mock(module, monkeypatch, lambda body: plan())
    assert command(c, lid, stage=2).status_code == 403
    assert command(c, lid, instruction='   ').status_code == 422
    assert command(c, lid, instruction='字' * 2001).status_code == 422
    student(c, 1)
    assert command(c, lid).status_code == 403
    c.post('/api/classroom/login', json={'role': 'observer'})
    assert command(c, lid).status_code == 403
    classroom_login(c, teacher=True)
    c.patch(f'/api/classroom/lessons/{lid}', json={'status': 'archived'})
    assert command(c, lid).status_code == 409
    assert not calls


def test_ai_failure_releases_lock_and_can_retry(env, monkeypatch):
    module, c = env
    lid = start(c, monkeypatch)
    answer = httpx.Response(503, json={'error': 'unavailable'})
    mock(module, monkeypatch, lambda body: answer)
    token = str(uuid.uuid4())
    assert command(c, lid, request_id=token).status_code == 502
    answer = plan()
    assert command(c, lid, request_id=token).status_code == 200
