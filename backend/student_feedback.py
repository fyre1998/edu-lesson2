"""Student-facing, bounded advice, separate from the teacher's grading reasons."""


def student_feedback(raw, items, *, corrected=False):
    """Also support saved assessments from before feedback was generated.

    Never derive student text from teacher-only reasons or rubric anchors. Filter
    model feedback against the validated scores, including enforced blank items.
    """
    by_key = {item['key']: item for item in items}
    feedback = raw if isinstance(raw, dict) and not corrected else {}
    result = {'strengths': [], 'improvements': []}
    for category in result:
        entries = feedback.get(category, [])
        if not isinstance(entries, list):
            continue
        seen = set()
        for entry in entries:
            if not isinstance(entry, dict) or not isinstance(entry.get('key'), str):
                continue
            item = by_key.get(entry['key'])
            value = entry.get('text')
            if not item or not isinstance(value, str) or not 0 < len(value.strip()) <= 240:
                continue
            points = item.get('points')
            if points is None:
                continue
            if category == 'strengths' and (points <= 0 or item.get('missing')):
                continue
            if category == 'improvements' and points >= item['maximum']:
                continue
            value = value.strip()
            if value in seen:
                continue
            seen.add(value)
            result[category].append({'key': item['key'], 'text': value})
            if category == 'improvements' and len(result[category]) == 2:
                break
    generated = bool(result['strengths'] or result['improvements']) and feedback.get('source') != 'score_summary'
    # Score-only summaries are explicitly labelled, never claimed as AI analysis.
    if not result['strengths']:
        result['strengths'] = [
            {'key': i['key'], 'text': f'“{i["label"]}”已达到本项评分要求，可以保留。'}
            for i in items if i.get('points') == i['maximum'] and not i.get('missing')
        ]
    if not result['improvements']:
        incomplete = [i for i in items if i.get('points') is not None and i['points'] < i['maximum']]
        # Work on attempted answers first; blank optional tasks are not mandatory.
        incomplete.sort(key=lambda i: bool(i.get('missing')))
        result['improvements'] = [
            {'key': i['key'], 'text': (
                f'“{i["label"]}”还未作答。如果想继续完善，可以先选这一项写出你们的想法。'
                if i.get('missing') else
                f'这次先检查“{i["label"]}”：补上一条支持你们判断的具体操作或证据，再提交。')}
            for i in incomplete[:1]
        ]
    result['source'] = 'teacher_review' if corrected else 'ai' if generated else 'score_summary'
    return result
