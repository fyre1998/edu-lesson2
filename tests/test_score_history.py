import asyncio

import pytest
from fastapi import BackgroundTasks
from sqlalchemy import text

from test_app import env, classroom_login
from test_lesson_v2 import start as start_v2, student, submit, fields, mock_ai
from test_lesson_v3 import start as start_v3, mock, scoring
from test_lesson_grape import start as start_v4, scoring as grape_scoring
from test_lesson_grape_v5 import start as start_v5, scoring as grape_v5_scoring


@pytest.mark.parametrize('flow', [2, 3, 4, 5])
@pytest.mark.parametrize('reviewed', [False, True])
def test_pending_scores_keep_complete_feedback_until_replacement(env, monkeypatch, flow, reviewed):
    module, c = env
    stage = 1 if flow == 2 else 2
    lid = {2: start_v2, 3: start_v3, 4: start_v4, 5: start_v5}[flow](c, monkeypatch, stage)
    if flow == 2:
        mock_ai(module, monkeypatch)
    elif flow == 3:
        responses = [scoring(), scoring((0, 20, 10), control=0)]
        mock(module, monkeypatch, lambda _: responses.pop(0))
    else:
        grader = grape_scoring if flow == 4 else grape_v5_scoring
        responses = [grader(), grader()]
        mock(module, monkeypatch, lambda _: responses.pop(0))
    student(c, 1)
    data = fields(stage) if flow == 2 else {'design': '分别比较突变体两侧，并设置野生型对照'}
    first = submit(c, lid, stage, data).json()['submission_id']
    # A reviewed zero is still a completed mark and must survive new submissions.
    if reviewed:
        classroom_login(c, teacher=True)
        points = {2: {'light_site': 0, 'bend_site': 0, 'design': 0},
                  3: {'treatment': 30, 'control': 20, 'conditions': 10, 'prediction': 20},
                  4: {'treatment': 30, 'control': 20, 'conditions': 10, 'prediction': 20},
                  5: {'treatment': 30, 'adaptation': 10, 'effect': 20, 'environment': 20}}[flow]
        assert c.put(f'/api/classroom/lessons/{lid}/assessments/{first}', json={
            'points': points, 'reason': '核对本组原图后修分'}).status_code == 200
    student(c, 1)
    work_url = f'/api/classroom/lessons/{lid}/groups/1/stages/{stage}'
    stage_index = stage - 1 if flow == 2 else 0
    previous_score = c.get(work_url).json()['scores']['stages'][stage_index]
    previous = previous_score['total']
    queued = []
    monkeypatch.setattr(BackgroundTasks, 'add_task', lambda self, fn, *args, **kw: queued.append((fn, args, kw)))
    second = submit(c, lid, stage, data, revision=1).json()['submission_id']
    for state in ['pending', 'processing', 'failed', 'needs_clarification']:
        with module.engine.begin() as db:
            db.execute(text('update lesson_assessments set status=:state where version_id=:id'),
                       {'state': state, 'id': second})
        student(c, 1)  # A fresh login also retains complete, versioned feedback.
        current = c.get(work_url).json()['scores']
        entry = current['stages'][stage_index]
        assert entry['version_id'] == second and entry['status'] == state
        assert entry['total'] is None and entry['feedback'] is None
        assert current['total'] == previous and current['graded'] == 1
        assert entry['retained_score']['version_id'] == first
        assert entry['retained_score']['total'] == previous
        retained = entry['retained_score']
        assert retained['feedback'] == previous_score['feedback']
        assert retained['items'] == previous_score['items']
        assert retained['submission_number'] == 1
        assert entry['history'] == [{k: retained[k] for k in entry['history'][0]}]
        assert entry['history'][0]['status'] == ('corrected' if reviewed else 'ready')
        assert not {'feedback', 'items', 'correction'} & entry['history'][0].keys()
        assert not {'correction', 'error', 'rubric_version'} & retained.keys()
        assert all(not {'reason', 'evidence', 'ai_points'} & item.keys() for item in retained['items'])
        assert c.get(f'/api/classroom/lessons/{lid}/groups?stage={stage}').json()[0]['scores'] == current
    async def finish():
        for fn, args, kw in queued:
            await fn(*args, **kw)
    asyncio.run(finish())
    student(c, 1)  # New login and fresh reads must return the durable history.
    current = c.get(work_url).json()['scores']
    entry = current['stages'][stage_index]
    new_score = {2: 20, 3: 60, 4: 90, 5: 90}[flow]
    assert entry['status'] == 'ready' and entry['retained_score'] is None
    assert current['total'] == new_score
    assert [h['total'] for h in entry['history']] == [previous, new_score]
    assert [h['submission_number'] for h in entry['history']] == [1, 2]
    student(c, 2)
    assert c.get(work_url).status_code == 404
    other = c.get(f'/api/classroom/lessons/{lid}/groups?stage={stage}').json()[0]['scores']
    assert all(not s['history'] and s['retained_score'] is None for s in other['stages'])


def test_old_task_scores_remain_in_history_but_do_not_count_for_new_task(env, monkeypatch):
    module, c = env
    lid = start_v3(c, monkeypatch, 2)
    mock(module, monkeypatch, lambda _: scoring())
    student(c, 1)
    first = submit(c, lid, 2, {'design': '旧任务方案'}).json()['submission_id']
    with module.engine.begin() as db:
        db.execute(text('update lesson_assessments set rubric_version=:rubric where version_id=:id'),
                   {'rubric': 'legacy-went-task', 'id': first})
    monkeypatch.setattr(BackgroundTasks, 'add_task', lambda *args, **kw: None)
    submit(c, lid, 2, {'design': '突变体的新方案'}, revision=1)
    current = c.get(f'/api/classroom/lessons/{lid}/groups/1/stages/2').json()['scores']
    entry = current['stages'][0]
    assert entry['history'][0]['total'] == 100 and entry['history'][0]['previous_task']
    assert entry['retained_score'] is None and current['graded'] == 0
