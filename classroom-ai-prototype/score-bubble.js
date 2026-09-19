/* Persistent student feedback, always tied to a specific submitted version. */
function resetScoreBubble() {
  show('#studentScoreBubble', false);
  $('#studentScore').replaceChildren();
  delete $('#studentScoreBubble').dataset.context;
  delete $('#studentScoreBubble').dataset.result;
  delete $('#studentScoreBubble').dataset.snapshot;
}
function setScoreBubbleExpanded(expanded) {
  const bubble = $('#studentScoreBubble');
  bubble.classList.toggle('is-collapsed', !expanded);
  $('#scoreBubbleToggle').setAttribute('aria-expanded', String(expanded));
  $('#scoreBubbleToggle').setAttribute('aria-label', expanded ? '收起评分与反馈' : '展开评分与反馈');
  $('#scoreBubbleToggleText').textContent = expanded ? '收起' : '展开';
  show('#studentScore', expanded);
  show('#scoreBubbleActions', expanded && bubble.dataset.editable === 'true');
}
function studentFeedbackHTML(score) {
  const feedback = score.feedback;
  if (!feedback) return '';
  const list = entries => entries.map(i => `<li>${esc(i.text)}</li>`).join('');
  return `${feedback.source === 'score_summary' ? '<p class="fine">这份记录暂无详细 AI 评语，以下为按得分整理的提示；再次提交后可获得具体反馈。</p>' : feedback.source === 'teacher_review' ? '<p class="fine">分数已由教师复核，以下提示按复核后的分数整理。</p>' : ''}
    ${feedback.strengths.length ? `<section class="feedback-strengths"><h3>做得好的地方</h3><ul>${list(feedback.strengths)}</ul></section>` : '<p class="fine">先完善下面这一小步，让你们的思路更清楚。</p>'}
    ${feedback.improvements.length ? `<section class="feedback-improvements"><h3>这次先改 ${Math.min(feedback.improvements.length, 2)} 点</h3><ol>${list(feedback.improvements.slice(0, 2))}</ol></section>` : '<p class="feedback-complete">本次提交已达到本环节要求，保留这些有依据的表达。</p>'}`;
}
function renderStudentScore(scores) {
  const bubble = $('#studentScoreBubble');
  if (!S.user || isTeacher() || !S.lesson || S.lesson.flow_version !== 2 || !scores) {
    resetScoreBubble(); return;
  }
  let score = scores.stages.find(s => s.stage === S.stage);
  if (!score) { resetScoreBubble(); return; }
  const latest = S.work?.versions?.at(-1);
  // A newly submitted version can arrive before the next scores poll.
  // Never show the previous version's feedback as the new assessment.
  if (latest?.id && latest.id !== score.version_id && latest.revision > (score.revision || 0)) {
    score = {...score, version_id:latest.id, revision:latest.revision, total:null, items:[], feedback:null,
      status:latest.fields.phase === 'model' ? 'model_submitted' : 'pending'};
  }
  const context = `${S.user.groupId}:${S.lesson.id}:${S.stage}`;
  const completed = ['ready', 'corrected'].includes(score.status);
  const result = completed ? JSON.stringify([score.version_id, score.status, score.total, score.feedback]) : '';
  if (bubble.dataset.context !== context) {
    bubble.dataset.context = context;
    bubble.dataset.result = '';
    setScoreBubbleExpanded(completed);
  }
  if (result && bubble.dataset.result !== result) setScoreBubbleExpanded(true);
  bubble.dataset.result = result;
  bubble.dataset.editable = String(completed && S.lesson.status === 'live');
  show('#scoreBubbleActions', bubble.dataset.editable === 'true' && !bubble.classList.contains('is-collapsed'));
  show('#studentScoreBubble', true);
  $('#scoreBubbleStage').textContent = `环节 ${S.stage} · ${scoreStatus[score.status] || score.status}`;
  $('#scoreBubblePoints').textContent = `${score.total ?? '—'} / ${score.maximum}`;
  const draftChanged = completed && (S.edit !== S.savedEdit || S.work?.work.revision > score.revision);
  const snapshot = JSON.stringify([context, score, scores.total, scores.graded, draftChanged, S.lesson.status]);
  if (bubble.dataset.snapshot === snapshot) return;
  const messages = {
    unsubmitted:'提交本组成果后，分数和评价会一直留在这里。',
    model_submitted:'模型图已保存。完成姓名放置与讨论后，提交完整成果即可评分。',
    pending:'成果已收到，正在排队评分。完成后会自动展示反馈。',
    processing:'AI 正在阅读你们的成果，评分与反馈即将出现在这里。',
    failed:'成果已保存，评分暂未完成。请老师在观察台点击“重试评分”，无需重复提交。'
  };
  const visibleScores = scores.stages.map(s => s.stage === S.stage ? score : s);
  const total = visibleScores.some(s => s.total !== null) ? visibleScores.reduce((n,s) => n + (s.total || 0), 0) : '—';
  $('#studentScore').innerHTML = `<div class="bubble-total">本组累计 <strong>${total} / 100</strong></div>
    ${completed ? `<p class="feedback-version">${draftChanged ? '已修改，待再次提交。以下仍是上次提交的评价。' : '针对本环节最新提交的评价'}</p>${studentFeedbackHTML(score)}
      <details class="feedback-breakdown"><summary>查看分项得分</summary>${score.items.map(i => `<div class="score-item"><span>${esc(i.label)}</span><strong>${i.points ?? '—'} / ${i.maximum}</strong></div>`).join('')}</details>
      ${S.lesson.status === 'live' ? '<p class="fine feedback-footnote">改好后再次提交，即可获得新评分；每次提交都会保留。</p>' : '<p class="fine">本课已归档，可查看评价与历次成果。</p>'}` : `<p class="feedback-waiting" role="status">${messages[score.status] || '正在同步评分…'}</p>`}`;
  bubble.dataset.snapshot = snapshot;
}
function reviseScoredWork() {
  if (busy()) return toast('请先等待当前上传、提交或回复完成。');
  if (!S.lesson || S.lesson.status !== 'live' || isTeacher()) return;
  setScoreBubbleExpanded(false);
  const key = S.groups.find(g => g.id === S.user.groupId)?.scores?.stages.find(s => s.stage === S.stage)?.feedback?.improvements[0]?.key;
  const fields = $$('[data-field]').filter(el => !el.disabled && el.type !== 'hidden');
  const target = fields.find(el => el.dataset.field === key) || fields[0];
  (target || $('#submitButton')).scrollIntoView({block:'center', behavior:'smooth'});
  target?.focus({preventScroll:true});
}
function installScoreBubble() {
  $('#scoreBubbleToggle').addEventListener('click', () => {
    setScoreBubbleExpanded($('#studentScoreBubble').classList.contains('is-collapsed'));
  });
  $('#scoreRevise').addEventListener('click', reviseScoredWork);
  $('#scoreBubbleMove').addEventListener('click', () => {
    const bubble = $('#studentScoreBubble'), left = !bubble.classList.contains('is-left');
    bubble.classList.toggle('is-left', left);
    $('#scoreBubbleMove').textContent = left ? '移到右侧' : '移到左侧';
  });
}
