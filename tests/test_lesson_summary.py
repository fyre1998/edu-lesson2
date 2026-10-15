import asyncio
import json

import httpx
import pytest
from fastapi import BackgroundTasks
from sqlalchemy import text

from test_app import env, classroom_login
from test_lesson_v2 import student, submit
from test_lesson_v3 import start, scoring
from backend.lesson_summary import validate_result


def test_summary_requires_concise_deficiencies():
    import copy
    import pytest
    group = dict(group_id=1, design='只测总量', items=[], correction={})
    result = issue_summary({'groups': [group]})
    for field, cap in [('title', 22), ('detail', 50), ('suggestion', 40)]:
        invalid = copy.deepcopy(result)
        invalid['issues'][0][field] = '问' * (cap + 1)
        with pytest.raises(ValueError):
            validate_result(invalid, [group])
    for invalid in [dict(result, overview='长' * 61), dict(result, discussion=['问' * 41]),
                    dict(result, issues=result['issues'] * 9)]:
        with pytest.raises(ValueError):
            validate_result(invalid, [group])


def transport(module, monkeypatch, summarizer, grader=scoring):
    monkeypatch.setenv('AI_API_KEY', 'test')
    monkeypatch.setenv('AI_MODEL', 'mock')
    real = httpx.AsyncClient
    calls = []
    def receive(req):
        body = json.loads(req.content)
        if 'overview' in body['response_format']['json_schema']['schema']['properties']:
            payload = json.loads(body['messages'][1]['content'])
            calls.append(payload)
            answer = summarizer(payload)
        else:
            answer = grader()
        if isinstance(answer, httpx.Response):
            return answer
        return httpx.Response(200, json={'choices': [{'message': {'content': json.dumps(answer, ensure_ascii=False)}}]})
    monkeypatch.setattr(module.httpx, 'AsyncClient', lambda **kw: real(transport=httpx.MockTransport(receive), **kw))
    return calls


def issue_summary(payload):
    groups = [g for g in payload['groups'] if '只测总量' in g['design']]
    return dict(overview='部分方案未区分两侧来源。', discussion=[],
        issues=[dict(title='未区分两侧来源', detail='只测总量不能判断两侧分布差异。',
                     suggestion='点评时重点核查两侧来源是否分别保留。', group_ids=[g['group_id'] for g in groups],
                     evidence=[dict(group_id=g['group_id'], quote='只测总量') for g in groups])] if groups else [])


def test_auto_summary_latest_version_no_drafts_permissions_and_cached_reads(env, monkeypatch):
    module, c = env; lid = start(c, monkeypatch, 2)
    calls = transport(module, monkeypatch, issue_summary)
    for gid in (1, 2):
        student(c, gid)
        assert submit(c, lid, 2, {'design': '只测总量，未分向光侧和背光侧'}).status_code == 201
    assert len(calls) == 2  # Automatically runs without opening the teacher page.
    assert c.get(f'/api/classroom/lessons/{lid}/design-summary').status_code == 403
    assert c.post(f'/api/classroom/lessons/{lid}/design-summary/retry').status_code == 403
    c.put(f'/api/classroom/lessons/{lid}/stages/2/work', json={'revision': 1, 'fields': {'design': '未提交的草稿，不应纳入'}})
    classroom_login(c, teacher=True)
    url = f'/api/classroom/lessons/{lid}/design-summary'
    result = c.get(url).json()
    assert result['status'] == 'ready' and result['submitted'] == result['evaluated'] == 2
    assert result['result']['issues'][0]['group_ids'] == [1, 2]
    c.get(url); c.get(url)
    assert len(calls) == 2
    assert '未提交的草稿' not in json.dumps(calls, ensure_ascii=False)
    student(c, 1)
    latest = submit(c, lid, 2, {'design': '分别比较两侧并用野生型作参照'}, revision=1).json()['submission_id']
    classroom_login(c, teacher=True)
    result = c.get(url).json()['result']
    assert result['issues'][0]['group_ids'] == [2]
    assert next(s['version_id'] for s in result['sources'] if s['group_id'] == 1) == latest


def test_failed_summary_retries_without_changing_scores_and_corrected_scores_refresh(env, monkeypatch):
    module, c = env; lid = start(c, monkeypatch, 2); student(c, 1)
    answers = [httpx.Response(502), dict(overview='已按提交核对。', issues=[], discussion=[])]
    calls = transport(module, monkeypatch, lambda _: answers.pop(0) if answers else dict(overview='按教师复核更新。', issues=[], discussion=[]))
    vid = submit(c, lid, 2, {'design': '分别比较两侧'}).json()['submission_id']
    classroom_login(c, teacher=True)
    url = f'/api/classroom/lessons/{lid}/design-summary'
    assert c.get(url).json()['status'] == 'failed'
    assert c.get(f'/api/classroom/lessons/{lid}/groups/1/stages/2').json()['scores']['total'] == 100
    assert len(calls) == 1
    assert c.post(url + '/retry').status_code == 200
    assert c.get(url).json()['status'] == 'ready'
    assert len(calls) == 2
    c.put(f'/api/classroom/lessons/{lid}/assessments/{vid}', json={
        'points': {'treatment': 30, 'control': 30, 'conditions': 10, 'prediction': 20}, 'reason': '两侧收集方式尚不明确'})
    assert len(calls) == 3
    assert calls[-1]['groups'][0]['correction']['reason'] == '两侧收集方式尚不明确'


@pytest.mark.parametrize('flow', [3, 4, 5])
def test_summary_retained_until_new_submission_evaluated_and_replaced(env, monkeypatch, flow):
    from test_lesson_grape import start as grape_start, scoring as grape_scoring
    from test_lesson_grape_v5 import start as grape_v5_start, scoring as grape_v5_scoring
    module, c = env
    lid = {3: start, 4: grape_start, 5: grape_v5_start}[flow](c, monkeypatch, 2)
    student(c, 1)
    calls = transport(module, monkeypatch, issue_summary,
                      grader={3: scoring, 4: grape_scoring, 5: grape_v5_scoring}[flow])
    submit(c, lid, 2, {'design': '只测总量'})
    classroom_login(c, teacher=True)
    url = f'/api/classroom/lessons/{lid}/design-summary'
    previous = c.get(url).json()['result']
    jobs = []
    monkeypatch.setattr(BackgroundTasks, 'add_task', lambda self, fn, *args, **kwargs: jobs.append((fn, args, kwargs)))
    student(c, 1)
    latest = submit(c, lid, 2, {'design': '分别收集并比较两侧'}, revision=1).json()['submission_id']
    classroom_login(c, teacher=True)
    data = c.get(url).json()
    assert data['stale'] and data['result'] == previous and data['evaluated'] == 0
    # Refreshing before the only group's new assessment finishes retains the
    # stored summary, so a fresh page still has a complete result to display.
    fn, args, kwargs = jobs.pop()
    asyncio.run(fn(*args, **kwargs))
    waiting = c.get(url).json()
    assert waiting['status'] == 'waiting' and waiting['result'] == previous
    async def run():
        for fn, args, kwargs in jobs:
            await fn(*args, **kwargs)
    asyncio.run(run())
    result = c.get(url).json()
    assert result['status'] == 'ready' and result['result']['issues'] == []
    assert result['result']['sources'][0]['version_id'] == latest
    assert result['result']['generated_at']
    assert len(calls) == 2


@pytest.mark.parametrize('failure', ['provider', 'invalid_evidence'])
def test_processing_and_failed_summary_keep_last_complete_result_until_retry(env, monkeypatch, failure):
    module, c = env; lid = start(c, monkeypatch, 2); student(c, 1)
    processing = []
    answers = []
    def summarize(payload):
        with module.engine.connect() as db:
            status, saved = db.execute(text(
                'SELECT status, result FROM lesson_design_summaries WHERE lesson_id=:lid'), {'lid': lid}).one()
            processing.append((status, json.loads(saved)))
        return answers.pop(0) if answers else issue_summary(payload)
    calls = transport(module, monkeypatch, summarize)
    submit(c, lid, 2, {'design': '只测总量'})
    classroom_login(c, teacher=True)
    url = f'/api/classroom/lessons/{lid}/design-summary'
    previous = c.get(url).json()['result']
    invalid = issue_summary({'groups': [dict(group_id=1, design='只测总量')]})
    invalid['issues'][0]['evidence'][0]['quote'] = '没有出现过的原文'
    answers.append(httpx.Response(502) if failure == 'provider' else invalid)
    student(c, 1)
    latest = submit(c, lid, 2, {'design': '分别收集并比较两侧'}, revision=1).json()['submission_id']
    classroom_login(c, teacher=True)
    failed = c.get(url).json()
    assert processing[-1] == ('processing', previous)
    assert failed['status'] == 'failed' and failed['result'] == previous
    assert c.get(url).json()['result'] == previous
    assert len(calls) == 2
    assert c.post(url + '/retry').status_code == 200
    assert processing[-1] == ('processing', previous)
    result = c.get(url).json()
    assert result['status'] == 'ready' and result['result']['issues'] == []
    assert result['result']['sources'][0]['version_id'] == latest
    assert len(calls) == 3


def test_summary_prompt_version_change_replaces_cached_verbose_result(env, monkeypatch):
    from backend import lesson_summary
    module, c = env; lid = start(c, monkeypatch, 2); student(c, 1)
    calls = transport(module, monkeypatch, issue_summary)
    submit(c, lid, 2, {'design': '只测总量'})
    classroom_login(c, teacher=True)
    url = f'/api/classroom/lessons/{lid}/design-summary'
    previous = c.get(url).json()
    assert previous['status'] == 'ready'
    monkeypatch.setattr(lesson_summary, 'SUMMARY_VERSION', 'new-teacher-deficiencies')
    stale = c.get(url).json()
    assert stale['stale'] and stale['result'] == previous['result']
    assert c.get(url).json()['status'] == 'ready'
    assert len(calls) == 2


def test_summary_rejects_invented_group_or_quote():
    import pytest
    group = dict(group_id=1, design='只测总量', items=[], correction={})
    result = issue_summary({'groups': [group]})
    validate_result(result, [group])
    result['issues'][0]['evidence'][0]['quote'] = '学生没有说过的话'
    with pytest.raises(ValueError): validate_result(result, [group])
    result = issue_summary({'groups': [group]}); result['issues'][0]['group_ids'] = [8]
    with pytest.raises(ValueError): validate_result(result, [group])


def test_october_6_assessments_recover_from_cached_waiting_without_rescoring(env, monkeypatch):
    from backend import lesson_grape_v5 as grape, lesson_grape_history as history
    from backend.lesson_summary import grape_summary_prompt
    from test_lesson_grape_v5 import start as grape_start, scoring as grape_scoring

    module, c = env
    lid = grape_start(c, monkeypatch, 2)
    calls = transport(module, monkeypatch, issue_summary, grader=grape_scoring)
    for gid in range(1, 7):
        student(c, gid)
        assert submit(c, lid, 2, {'design': '只测总量，特殊情境下的调整待补充'}).status_code == 201
    # Reproduce the live class: every latest assessment predates the worksheet update.
    historical = grape_scoring()
    historical['treatment_parts'] = dict(history.PART_LIMITS)
    with module.engine.begin() as db:
        db.execute(text('UPDATE lesson_assessments SET rubric_version=:rubric, result=:result'),
                   dict(rubric='grape-plan-20261006', result=json.dumps(historical, ensure_ascii=False)))
        saved = db.execute(text('SELECT * FROM lesson_assessments ORDER BY version_id')).all()
    classroom_login(c, teacher=True)
    url = f'/api/classroom/lessons/{lid}/design-summary'
    with monkeypatch.context() as old_filter:
        old_filter.setattr(grape, 'SUMMARY_RUBRIC_VERSIONS', (grape.RUBRIC_VERSION,))
        c.get(url)
        waiting = c.get(url).json()
        assert waiting['status'] == 'waiting' and waiting['evaluated'] == 0
        assert waiting['result'] is None
        assert all(g['status'] == 'previous_task' for g in waiting['groups'])
    previous_calls = len(calls)
    pending = c.get(url).json()
    assert pending['status'] == 'pending' and pending['evaluated'] == 6
    recovered = c.get(url).json()
    assert recovered['status'] == 'ready' and recovered['submitted'] == recovered['evaluated'] == 6
    assert [s['group_id'] for s in recovered['result']['sources']] == list(range(1, 7))
    assert recovered['result']['issues'][0]['group_ids'] == list(range(1, 7))
    assert len(calls) == previous_calls + 1
    assert '旧评价中仅因缺少葡萄芽萌发阶段而提出的扣分或建议不纳入汇总' in grape_summary_prompt(5)
    with module.engine.connect() as db:
        assert db.execute(text('SELECT * FROM lesson_assessments ORDER BY version_id')).all() == saved


def test_mutant_task_prompt_and_legacy_assessment_retry(env, monkeypatch):
    from backend import lesson_v3 as v3
    module, c = env; lid = start(c, monkeypatch, 2)
    stage = c.get(f'/api/classroom/lessons/{lid}/stages/2').json()
    assert '突变体' in stage['content']['question'] and '不同结果' in stage['content']['task']
    assert '不能把复现温特' in v3.guide(2)
    assert '不提前提供完整温特' not in v3.guide(2)
    assert '不提前提供完整温特' in v3.guide(1)
    assert list(v3.score_schema(v3.RUBRIC[2], ['field:design'])['properties']['treatment_parts']['properties']) == ['hypothesis', 'sided_comparison', 'readout']
    student(c, 1)
    jobs = []
    monkeypatch.setattr(BackgroundTasks, 'add_task', lambda self, fn, *args, **kwargs: jobs.append((fn, args, kwargs)))
    vid = submit(c, lid, 2, {'design': '旧版偏放琼脂方案'}).json()['submission_id']
    with module.engine.begin() as db:
        db.execute(text("UPDATE lesson_assessments SET rubric_version='auxin-2x8-1' WHERE version_id=:v"), {'v': vid})
    real = httpx.AsyncClient
    def receive(req):
        body = json.loads(req.content)
        assert '仅中央放置时lateral_placement必须为0' in body['messages'][0]['content']
        answer = scoring(); answer['treatment_parts'] = dict(removed_tip=10, decapitated_seedling=10, lateral_placement=20)
        return httpx.Response(200, json={'choices': [{'message': {'content': json.dumps(answer)}}]})
    monkeypatch.setenv('AI_API_KEY', 'test'); monkeypatch.setenv('AI_MODEL', 'mock')
    monkeypatch.setattr(module.httpx, 'AsyncClient', lambda **kw: real(transport=httpx.MockTransport(receive), **kw))
    async def run():
        fn, args, kwargs = jobs[0]; await fn(*args, **kwargs)
    asyncio.run(run())
    work = c.get(f'/api/classroom/lessons/{lid}/groups/1/stages/2').json()
    assert work['scores']['graded'] == 0
    assert work['scores']['stages'][0]['status'] == 'previous_task'
    assert work['versions'][0]['assessment']['total'] == 100
    classroom_login(c, teacher=True)
    data = c.get(f'/api/classroom/lessons/{lid}/design-summary').json()
    assert data['evaluated'] == 0 and data['groups'][0]['status'] == 'previous_task'
