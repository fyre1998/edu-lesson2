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


def test_compact_feedback_limits_and_legacy_reading():
    from backend.student_feedback import student_feedback
    from backend.ai_schemas import grading_schema
    items = [dict(key='design', label='实验设计', points=5, maximum=10, missing=False)]
    schema = grading_schema([('design', '实验设计', 10, '')], set())
    assert schema['properties']['feedback']['properties']['strengths']['items']['properties']['text']['maxLength'] == 40
    assert schema['properties']['feedback']['properties']['improvements']['items']['properties']['text']['maxLength'] == 20
    raw = dict(strengths=[dict(key='design', text='优' * 40)], improvements=[dict(key='design', text='改' * 19 + '。')])
    assert student_feedback(raw, items, compact=True)['improvements'][0]['text'] == '改' * 19 + '。'
    raw['improvements'][0]['text'] += '！'
    fallback = student_feedback(raw, items, compact=True)
    assert fallback['source'] == 'score_summary'
    assert all(len(i['text']) <= 20 for i in fallback['improvements'])
    assert '改' * 20 not in str(fallback)  # Never mechanically cut off new advice.
    historical = student_feedback(raw, items)
    assert historical['improvements'][0]['text'] == raw['improvements'][0]['text']
    raw['strengths'][0]['text'] += '优'
    raw['improvements'][0]['text'] = '请补充比较依据。'
    assert not student_feedback(raw, items, compact=True)['strengths']


def test_compact_fallback_sources_marks_and_long_labels():
    from backend.student_feedback import student_feedback
    items = [dict(key='design', label='特别长的项目名称' * 8, points=0, maximum=10, missing=True)]
    for corrected in (False, True):
        result = student_feedback({}, items, corrected=corrected, compact=True)
        assert not result['strengths']
        assert result['source'] == ('teacher_review' if corrected else 'score_summary')
        assert all(len(i['text']) <= 20 for i in result['improvements'])
        assert student_feedback(result, items)['source'] == result['source']
    items[0].update(points=10, missing=False)
    result = student_feedback({}, items, compact=True)
    assert result['improvements'] == []
    assert all(len(i['text']) <= 40 for i in result['strengths'])


def test_overlong_model_feedback_does_not_fail_scoring(env, monkeypatch):
    module, client = env
    lesson_id = start(client, monkeypatch, 3)
    student(client, 1)
    def response(request, payload):
        system = payload['messages'][0]['content']
        assert '改进建议每条最多20个字符' in system
        rubric = json.loads(system.split('量规：')[-1])
        result = {'items': [dict(key=r[0], points=1, missing=False, evidence=['field:summary'], reason='教师专用依据') for r in rubric],
                  'feedback': {'strengths': [], 'improvements': [dict(key=rubric[0][0], text='长' * 21)]}}
        return httpx.Response(200, json={'choices': [{'message': {'content': json.dumps(result)}}]})
    mock_ai(module, monkeypatch, response)
    submit(client, lesson_id, 3, {'summary': '比较尖端与琼脂的操作'})
    score = client.get(f'/api/classroom/lessons/{lesson_id}/groups?stage=3').json()[0]['scores']['stages'][2]
    assert score['status'] == 'ready' and score['total'] == 4
    assert score['feedback']['source'] == 'score_summary'
    assert all(len(i['text']) <= 20 for i in score['feedback']['improvements'])
