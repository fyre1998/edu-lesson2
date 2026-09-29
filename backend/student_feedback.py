"""Bounded student advice; historical assessments retain their original text."""

FEEDBACK_LIMITS = {'strengths': 40, 'improvements': 20}


def score_summary(items, *, corrected=False):
    strengths = []
    for item in items:
        if item.get('points') == item['maximum'] and not item.get('missing'):
            text = f'“{item["label"]}”已达到评分要求。'
            strengths.append({'key': item['key'], 'text': text if len(text) <= 40 else '本项已达到评分要求。'})
    incomplete = [i for i in items if i.get('points') is not None and i['points'] < i['maximum']]
    incomplete.sort(key=lambda i: bool(i.get('missing')))
    improvements = []
    for item in incomplete[:1]:
        text = f'请补充“{item["label"]}”。' if item.get('missing') else f'请核对“{item["label"]}”的依据。'
        if len(text) > 20:
            text = '请补充本项作答。' if item.get('missing') else '请补充本项的操作或证据。'
        improvements.append({'key': item['key'], 'text': text})
    return {'strengths': strengths, 'improvements': improvements,
            'source': 'teacher_review' if corrected else 'score_summary'}


def student_feedback(raw, items, *, corrected=False, compact=False):
    """Enforce new limits at generation, but accept historical text up to 240 chars.

    Feedback is checked against validated marks, never copied from teacher reasons.
    An unusable new suggestion falls back to an explicitly labelled score summary;
    generated and fallback text are not mixed under an inaccurate AI source label.
    """
    if corrected:
        return score_summary(items, corrected=True)
    by_key = {item['key']: item for item in items}
    feedback = raw if isinstance(raw, dict) else {}
    result = {'strengths': [], 'improvements': []}
    for category in result:
        entries = feedback.get(category, [])
        if not isinstance(entries, list):
            continue
        seen = set()
        limit = FEEDBACK_LIMITS[category] if compact else 240
        for entry in entries:
            if not isinstance(entry, dict) or not isinstance(entry.get('key'), str):
                continue
            item = by_key.get(entry['key'])
            value = entry.get('text')
            if not item or not isinstance(value, str) or not 0 < len(value.strip()) <= limit:
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
    needs_advice = any(i.get('points') is not None and i['points'] < i['maximum'] for i in items)
    if not any(result.values()) or (compact and needs_advice and not result['improvements']):
        return score_summary(items)
    result['source'] = feedback.get('source') if feedback.get('source') in ('score_summary', 'teacher_review') else 'ai'
    return result
