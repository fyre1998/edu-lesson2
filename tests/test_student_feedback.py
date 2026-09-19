import json

import httpx
from sqlalchemy import text

from test_app import env, classroom_login
from test_lesson_v2 import start, student, submit, mock_ai


def test_feedback_is_specific_limited_persistent_and_versioned(env, monkeypatch):
    module, client = env
    lesson_id = start(client, monkeypatch, 3)
    student(client, 1)

    def response(request, payload):
        system = payload['messages'][0]['content']
        assert '全次只选最值得先改的1至2点' in system
        schema = payload['response_format']['json_schema']['schema']
        assert schema['properties']['feedback']['properties']['improvements']['maxItems'] == 2
        rubric = json.loads(system.split('量规：')[-1])
        body = json.loads(payload['messages'][1]['content'][0]['text'])
        revised = '修订' in body['fields']['summary']
        result = {
            'items': [dict(key=r[0], points=r[2] if revised else 1, missing=False,
                           evidence=['field:summary'], reason='教师专用完整扣分分析') for r in rubric],
            'feedback': {
                'strengths': [dict(key=r[0], text=f'具体优点{i}') for i, r in enumerate(rubric)],
                # Deliberately violate the requested schema to exercise the server cap.
                'improvements': [] if revised else [dict(key=r[0], text=f'先修改问题{i}') for i, r in enumerate(rubric)]
            }
        }
        return httpx.Response(200, json={'choices': [{'message': {'content': json.dumps(result)}}]})

    mock_ai(module, monkeypatch, response)
    first = submit(client, lesson_id, 3, {'summary': '比较了尖端与琼脂的操作'}).json()
    url = f'/api/classroom/lessons/{lesson_id}/groups?stage=3'
    score = client.get(url).json()[0]['scores']['stages'][2]
    assert score['status'] == 'ready' and score['total'] == 4
    assert len(score['feedback']['strengths']) == 4  # No one-or-two limit on praise.
    assert [i['text'] for i in score['feedback']['improvements']] == ['先修改问题0', '先修改问题1']
    assert '教师专用' not in json.dumps(score, ensure_ascii=False)
    assert score == client.get(url).json()[0]['scores']['stages'][2]
    student(client, 2)
    assert client.get(url).json()[0]['scores']['stages'][2]['feedback'] is None
    student(client, 1)
    second = submit(client, lesson_id, 3, {'summary': '修订后补上证据联系'}, revision=1).json()
    score = client.get(url).json()[0]['scores']['stages'][2]
    assert score['version_id'] == second['submission_id'] != first['submission_id']
    assert score['total'] == 20 and score['feedback']['improvements'] == []
    with module.engine.connect() as db:
        old = json.loads(db.execute(text('select result from lesson_assessments where version_id=:v'),
                                    {'v': first['submission_id']}).scalar())
        assert len(old['feedback']['improvements']) == 2


def test_old_blank_and_corrected_scores_have_safe_fallbacks(env, monkeypatch):
    module, client = env
    lesson_id = start(client, monkeypatch)
    student(client, 1)
    blank = submit(client, lesson_id, 1, {}).json()
    url = f'/api/classroom/lessons/{lesson_id}/groups?stage=1'
    score = client.get(url).json()[0]['scores']['stages'][0]
    assert score['feedback']['strengths'] == []
    assert len(score['feedback']['improvements']) == 1
    assert score['feedback']['source'] == 'score_summary'
    mock_ai(module, monkeypatch)
    submitted = submit(client, lesson_id, 1, {'light_site': '尖端'}, revision=1).json()
    score = client.get(url).json()[0]['scores']['stages'][0]
    assert len(score['feedback']['strengths']) == 1  # No praise for forced-zero blanks.
    assert len(score['feedback']['improvements']) <= 2
    with module.engine.begin() as db:
        legacy = json.loads(db.execute(text('select result from lesson_assessments where version_id=:v'),
                                       {'v': submitted['submission_id']}).scalar())
        legacy.pop('feedback')
        db.execute(text('update lesson_assessments set result=:r where version_id=:v'),
                   {'r': json.dumps(legacy), 'v': submitted['submission_id']})
    score = client.get(url).json()[0]['scores']['stages'][0]
    assert score['feedback']['source'] == 'score_summary'
    classroom_login(client, teacher=True)
    assert client.put(f"/api/classroom/lessons/{lesson_id}/assessments/{submitted['submission_id']}",
                      json={'points': {'light_site': 0, 'bend_site': 0, 'design': 0}, 'reason': '教师后台复核说明'}).status_code == 200
    student(client, 1)
    score = client.get(url).json()[0]['scores']['stages'][0]
    assert score['total'] == 0 and score['status'] == 'corrected'
    assert score['feedback']['source'] == 'teacher_review' and not score['feedback']['strengths']
    assert '教师后台复核说明' not in json.dumps(score, ensure_ascii=False)
