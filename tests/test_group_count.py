"""Six-group classrooms retain historical definitions and stored student work."""
import json

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import text

from test_app import env, classroom_login
from test_lesson_grape_v5 import start


def test_six_groups_are_consistent_across_login_overview_and_summary(env, monkeypatch):
    _, client = env
    assert [g['id'] for g in client.get('/api/classroom/roster').json()['groups']] == list(range(1, 7))
    lid = start(client, monkeypatch, stage=2)
    assert len(client.get(f'/api/classroom/lessons/{lid}/groups?stage=2').json()) == 6
    assert client.get(f'/api/classroom/lessons/{lid}/design-summary').json()['group_count'] == 6
    for group in (7, 8):
        assert client.get(f'/api/classroom/lessons/{lid}/groups/{group}/stages/2').status_code == 404
        assert client.post('/api/classroom/login', json={
            'role': 'student', 'groupId': group, 'code': 'BIO-302'}).status_code == 422
    assert client.post('/api/classroom/login', json={
        'role': 'student', 'groupId': 6, 'code': 'BIO-302'}).status_code == 200
    assert client.get(f'/api/classroom/lessons/{lid}/groups/6/stages/2').status_code == 200


@pytest.mark.parametrize('flow,status,expected', [(5, 'live', 6), (5, 'archived', 8), (4, 'live', 8)])
def test_startup_updates_only_live_current_lessons_and_preserves_work(env, monkeypatch, flow, status, expected):
    module, client = env
    lid = start(client, monkeypatch, flow=flow)
    with module.engine.begin() as connection:
        connection.execute(text('UPDATE lesson_definitions SET group_count=8 WHERE lesson_id=:id'), {'id': lid})
        connection.execute(text('UPDATE lesson_runs SET status=:status WHERE id=:id'), {'id': lid, 'status': status})
        connection.execute(text('INSERT INTO lesson_work (lesson_id,group_id,stage,revision,data,file_ids,updated) '
                                "VALUES (:id,8,1,2,:data,'[]',1)"),
                           {'id': lid, 'data': json.dumps({'design': '保留第八组原有记录'}, ensure_ascii=False)})
        original = connection.execute(text('SELECT * FROM lesson_work')).all()
    # Exercise the real startup path twice to verify migration is idempotent.
    for _ in range(2):
        with TestClient(module.app):
            pass
    with module.engine.connect() as connection:
        assert connection.execute(text('SELECT group_count FROM lesson_definitions WHERE lesson_id=:id'), {'id': lid}).scalar() == expected
        assert connection.execute(text('SELECT * FROM lesson_work')).all() == original
        assert connection.execute(text("SELECT count(*) FROM lesson_events WHERE kind='group_count'")).scalar() == (1 if expected == 6 else 0)
    classroom_login(client, teacher=True)
    assert len(client.get(f'/api/classroom/lessons/{lid}/groups?stage=1').json()) == expected
    if expected == 8:
        assert client.get(f'/api/classroom/lessons/{lid}/groups/8/stages/1').json()['work']['fields']['design'] == '保留第八组原有记录'
