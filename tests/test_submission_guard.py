"""Both lesson 2 activities block resubmission while their feedback is running."""
import uuid
from concurrent.futures import ThreadPoolExecutor

import pytest
from fastapi import BackgroundTasks
from fastapi.testclient import TestClient
from sqlalchemy import text

from test_app import env
from test_lesson_v2 import student, submit
from test_lesson_grape_v5 import start
from test_lesson_v3 import work


@pytest.mark.parametrize('stage', [1, 2])
@pytest.mark.parametrize('status,blocked', [
    ('pending', True), ('processing', True), ('ready', False),
    ('failed', False), ('needs_clarification', False),
])
def test_feedback_blocks_new_submissions_but_preserves_drafts_and_request_retries(env, monkeypatch, stage, status, blocked):
    module, client = env
    lid = start(client, monkeypatch, stage)
    jobs = []
    monkeypatch.setattr(BackgroundTasks, 'add_task', lambda self, fn, *args, **kw: jobs.append((fn, args, kw)))
    student(client, 1)
    token = str(uuid.uuid4())
    first = submit(client, lid, stage, {'design': '第一版方案'}, token=token)
    assert first.status_code == 201, first.text
    vid = first.json()['submission_id']
    table = 'lesson_design_matches' if stage == 1 else 'lesson_assessments'
    with module.engine.begin() as db:
        db.execute(text(f'update {table} set status=:status where version_id=:id'), {'status': status, 'id': vid})
    assert bool(work(client, lid, stage)['submission_wait']) == blocked
    repeated = submit(client, lid, stage, {'design': '第一版方案'}, token=token)
    assert repeated.status_code == 201 and repeated.json()['submission_id'] == vid
    assert len(jobs) == 1
    draft = client.put(f'/api/classroom/lessons/{lid}/stages/{stage}/work',
                       json={'fields': {'design': '修改中的草稿'}, 'revision': 1})
    assert draft.status_code == 200
    second = submit(client, lid, stage, {'design': '第二版方案'}, revision=2)
    assert second.status_code == (409 if blocked else 201), second.text
    assert len(jobs) == (1 if blocked else 2)
    snapshot = work(client, lid, stage)
    assert len(snapshot['versions']) == (1 if blocked else 2)
    if blocked:
        assert '完成后可再次提交' in second.json()['detail']
        assert snapshot['work']['fields']['design'] == '修改中的草稿'
        assert snapshot['work']['revision'] == 2


@pytest.mark.parametrize('stage', [1, 2])
def test_concurrent_same_group_submissions_create_one_job_without_blocking_other_groups(env, monkeypatch, stage):
    module, client = env
    lid = start(client, monkeypatch, stage)
    jobs = []
    monkeypatch.setattr(BackgroundTasks, 'add_task', lambda self, fn, *args, **kw: jobs.append((fn, args, kw)))

    def send(group):
        with TestClient(module.app, headers={'X-Workbench': '1', 'Origin': 'http://testserver'}) as other:
            student(other, group)
            return submit(other, lid, stage, {'design': '本组实验方案'}).status_code

    with ThreadPoolExecutor(max_workers=2) as pool:
        statuses = list(pool.map(send, [1, 1]))
    assert sorted(statuses) == [201, 409]
    assert len(jobs) == 1
    assert send(2) == 201
    assert len(jobs) == 2
