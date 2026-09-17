'use strict';
const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const stamp = t => t ? new Date(t * 1000).toLocaleString('zh-CN', {month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'}) : '';
const S = {user:null, roster:null, role:'student', lessons:[], lesson:null, stage:1, content:null, groups:[], group:1,
  work:null, material:null, edit:0, savedEdit:0, loading:false, syncing:false, uploading:false, sending:false,
  pending:null, images:new Map(), seq:0, lastTeacherStage:1, saveChain:Promise.resolve(), draftTimer:null, submitAttempt:null};
let toastTimer;
function toast(text) { $('#toast').textContent=text; $('#toast').classList.remove('hidden'); clearTimeout(toastTimer); toastTimer=setTimeout(()=>$('#toast').classList.add('hidden'),6000); }
function show(id, visible) { $(id).classList.toggle('hidden',!visible); }
function isTeacher() { return S.user?.role==='teacher'; }
function base() { return '/lessons/'+encodeURIComponent(S.lesson.id); }
function draftKey() { return `auxin:${S.user.groupId}:${S.lesson.id}:${S.stage}`; }
function busy() { return S.uploading || S.sending || S.loading || S.submitting || S.extracting; }
async function api(path, options={}) {
  const headers={'X-Workbench':'1'};
  if(options.body && !(options.body instanceof FormData)) { headers['Content-Type']='application/json'; options.body=JSON.stringify(options.body); }
  const response=await fetch('/api/classroom'+path,{...options,headers,cache:'no-store'});
  const data=await response.json().catch(()=>({}));
  if(!response.ok) { if(response.status===401 && path!=='/login') reset(); const e=new Error(typeof data.detail==='string'?data.detail:'请求未完成，请检查输入或网络后重试'); e.status=response.status; throw e; }
  return data;
}
function reset() {
  globalThis.lessonVoice?.cancel();
  S.seq++; S.user=null; S.lesson=null; S.content=null; S.work=null; S.pending=null; S.images.clear();
  S.edit=S.savedEdit=0; clearTimeout(S.draftTimer); camera?.close();
  $$('dialog[open]').forEach(d=>d.close());
  $('#app').classList.remove('student-view');
  show('#loginScreen',true); show('#app',false); $('#teacherPassword').value='';
  $('#workFields').replaceChildren(); $('#chatMessages').replaceChildren(); $('#groupDetail').replaceChildren();
}
function names() {
  const list=S.role==='teacher'?S.roster.teachers:(S.roster.groups.find(g=>g.id===Number($('#loginGroup').value))?.members||[]);
  show('#nameField',S.role==='teacher');
  $('#loginName').innerHTML=list.map(n=>`<option>${esc(n)}</option>`).join('');
}
async function activate(user) {
  S.user=user; S.seq++; S.group=user.groupId||1; S.pending=null; S.images.clear();
  $('#app').classList.toggle('student-view',user.role==='student');
  show('#loginScreen',false); show('#app',true); $('#teacherPassword').value='';
  $('#identityLabel').textContent=isTeacher()?`${user.name} · 教师`:`第 ${user.groupId} 组`;
  setAI(true);
  await loadLessons();
}
function lessonOptions() {
  $('#lessonSelect').innerHTML=S.lessons.map(l=>`<option value="${esc(l.id)}">${esc(l.title)}${l.status==='archived'?' · 已归档':''}</option>`).join('');
  if(S.lesson) $('#lessonSelect').value=S.lesson.id;
}
async function loadLessons(preferred) {
  S.lessons=await api('/lessons');
  S.lesson=S.lessons.find(l=>l.id===preferred)||S.lessons.find(l=>l.status==='live')||S.lessons[0]||null;
  lessonOptions(); show('#emptyState',!S.lesson); show('#lessonSurface',!!S.lesson);
  if(!S.lesson) {
    $('#stageNav').innerHTML='';
    $('#emptyState').innerHTML=isTeacher()?'<p class="eyebrow">开始一次新的研究</p><h1>蓝光怎样引起菜豆向光生长？</h1><p class="muted">建立课次后，各组就能进入第一个探究环节。</p><label>课次名称<input id="newLessonTitle" maxlength="80" value="生长素探究课"></label><button class="primary" id="createLessonButton">创建课次</button>':'<p class="eyebrow">已加入小组</p><h1>等待老师开始本次探究</h1><p class="muted">老师创建课次后，页面会自动更新。</p>';
    return;
  }
  S.lastTeacherStage=S.lesson.stage;
  if(isTeacher()&&S.group>S.lesson.group_count)S.group=1;
  await loadStage(S.lesson.stage);
}
async function loadStage(stage) {
  globalThis.lessonVoice?.cancel(); S.modelNotice=''; S.selectedScientist=null;
  const seq=++S.seq, lessonId=S.lesson.id; S.loading=true; S.pending=null; S.images.clear(); S.submitAttempt=null;
  try {
    const content=await api(`/lessons/${lessonId}/stages/${stage}`);
    const [groups,work]=await Promise.all([api(`/lessons/${lessonId}/groups?stage=${stage}`),
      api(`/lessons/${lessonId}/groups/${isTeacher()?S.group:S.user.groupId}/stages/${stage}`)]);
    if(seq!==S.seq || !S.user) return;
    S.stage=stage; S.content=content; S.lesson=content.lesson; S.groups=groups; S.work=work; S.edit=S.savedEdit=0;
    S.material=content.materials.find(m=>m.stage===stage)?.id||content.materials[0]?.id;
    S.uploadTarget=null;
    renderFrame();
    if(isTeacher()) { renderTeacher(); await refreshEvents(); }
    else { renderStudent(); restoreLocalDraft(); }
    renderChat(); renderScores(); $('#syncStatus').textContent='已同步 · '+new Date().toLocaleTimeString('zh-CN');
  } catch(e) { toast(e.message); throw e; }
  finally { if(seq===S.seq) { S.loading=false; if(S.content&&S.user)renderChat(); } }
}
function renderFrame() {
  const {content,stages}=S.content;
  $('#questionTitle').textContent=content.question;
  show('#lessonReadOnly',S.lesson.status==='archived');
  $('#groupBadge').textContent=isTeacher()?'教师观察台':`第 ${S.user.groupId} 组`;
  $('#stageNav').innerHTML=stages.map(s=>`<button class="stage-button ${s.id===S.stage?'active':''}" data-stage="${s.id}" ${!s.open?'disabled':''} ${s.id===S.stage?'aria-current="step"':''}><span class="step-no">${s.id}</span><span><span class="stage-name">${esc(s.title)}</span><small>${s.open?`${s.minutes} 分钟${s.id===S.lesson.stage?' · 当前':''}`:'等待教师开放'}</small></span></button>`).join('');
  show('#studentWorkspace',!isTeacher()); show('#teacherWorkspace',isTeacher()); show('#teacherControls',isTeacher());
  show('#lessonMaterials',!isTeacher());
  if(isTeacher()) {
    const live=S.lesson.status==='live';
    $('#teacherControls').innerHTML=`<p>${live?`全班当前：${S.lesson.stage}. ${esc(stages[S.lesson.stage-1].title)}`:'本课已归档，成果与记录保留'}</p><div class="actions">${live?`<label class="sr-only" for="teacherStage">开放环节</label><select id="teacherStage" style="width:auto">${stages.map(s=>`<option value="${s.id}" ${s.id===S.lesson.stage?'selected':''}>${s.id}. ${esc(s.title)}</option>`).join('')}</select><button id="openStage" class="primary">切换并开放</button>${S.lesson.unlocked>=S.lesson.assignment_stage?`<button id="releaseResults" ${S.lesson.release_results?'disabled':''}>${S.lesson.release_results?'预期结果已开放':'分发预期结果'}</button>`:''}${(S.lesson.flow_version!==2&&S.lesson.unlocked>=3)?`<button id="revealResearch" ${S.lesson.reveal_research?'disabled':''}>${S.lesson.reveal_research?'历史结果已开放':'开放历史结果'}</button>`:''}<button id="archiveLesson">归档本课</button>`:'<button id="newLessonButton" class="primary">开始新课</button>'}<button id="presentButton">并排投屏</button></div>`;
  }
}
function materialHTML(m) {
  return `<span class="kind">${esc(m.kind)}</span><h3 class="material-title">${esc(m.title)}</h3>${m.images.map(i=>`<figure class="material-figure" data-material-id="${esc(m.id)}"><a href="${esc(i.url)}" target="_blank" rel="noopener"><img src="${esc(i.url)}" alt="${esc(i.caption)}" loading="lazy"></a><figcaption>${esc(i.caption)}</figcaption></figure>`).join('')}${m.paragraphs.map(p=>`<p class="material-text">${esc(p)}</p>`).join('')}${m.rows?`<table class="material-table"><thead><tr><th>处理</th><th>材料</th><th>结果</th></tr></thead><tbody>${m.rows.map(row=>`<tr>${row.map(c=>`<td>${esc(c)}</td>`).join('')}</tr>`).join('')}</tbody></table>`:''}<p class="material-source">来源：${esc(m.source)}</p>`;
}
function renderMaterials() {
  $('#materialTabs').innerHTML=S.content.materials.map(m=>`<button id="tab-${esc(m.id)}" role="tab" aria-selected="${S.material===m.id}" aria-controls="materialBody" class="${S.material===m.id?'active':''}" data-material="${esc(m.id)}">${esc(m.title.split('：')[0])}</button>`).join('');
  const m=S.content.materials.find(m=>m.id===S.material);
  $('#materialBody').innerHTML=m?materialHTML(m):'<p>本环节暂无材料。</p>';
  $('#materialBody').setAttribute('role','tabpanel'); if(m) $('#materialBody').setAttribute('aria-labelledby','tab-'+m.id);
}
function renderStudent() {
  renderMaterials();
  $('#submissionTask').textContent=S.content.content.task+' 所有项目均为选填，未作答的对应项目不计分。';
  $('#modelTools')?.remove();
  $('#workFields').innerHTML='<section id="modelTools" class="hidden"></section>'+S.content.content.fields.map(fieldHTML).join('');
  $('#workFields').classList.toggle('location-fields',S.lesson.flow_version===2&&S.stage===1);
  show('#generalAttachments',!isModel());
  $('#saveStatus').textContent=S.work.work.updated?'已保存 · '+stamp(S.work.work.updated):'草稿自动保存';
  renderExtras();
}
function assignmentHTML(a) {
  return a?`<div class="assignment"><span class="kind hypothetical">${esc(a.kind)}</span><h3>${esc(a.treatment_label)}</h3><a href="${esc(a.image)}" target="_blank" rel="noopener"><img src="${esc(a.image)}?v=${a.variant}" alt="假设情境：${esc(a.label)}"></a><p><strong>${esc(a.label)}</strong></p><p>${esc(a.control)}</p><p>${esc(a.boundary)}</p></div>`:'';
}
function renderExtras() {
  const w=S.work, archived=S.lesson.status!=='live';
  $('#assignmentArea').innerHTML=w.assignment?assignmentHTML(w.assignment):S.stage===(S.lesson.assignment_stage||2)?`<p class="notice">${w.versions.length?(!w.work.fields.treatment||w.work.fields.treatment==='custom'?'实验设计已提交，等待教师核对并分发假设结果。':S.lesson.release_results?'等待结果匹配；如修改了方案，请先提交最新版本。':'实验设计已提交，等待教师分发假设结果。'):'请先提交实验设计。'}</p>`:'';
  $$('[data-field]').forEach(el=>el.disabled=archived || S.submitting || (!!w.assignment && ['treatment','design','prediction'].includes(el.dataset.field)));
  $$('[data-voice-field]').forEach(b=>b.disabled=archived||S.submitting||$('#field-'+b.dataset.voiceField)?.disabled);
  if(w.assignment) $('#assignmentArea').insertAdjacentHTML('beforeend',S.lesson.flow_version===2?'<p class="fine">原始实验设计已保留，可在对话中讨论结果与修改意见。</p>':'<p class="fine">原始方案与预测已保留。请在结果分析中记录新的解释或修改意见。</p>');
  for(const id of ['#submitButton','#saveButton','#uploadButton','#cameraButton']) $(id).disabled=archived || S.submitting;
  $('#workFiles').innerHTML=w.files.length?w.files.map(f=>fileHTML(f,true)).join(''):'<p class="fine">还没有附件。可上传纸质方案或手绘图。</p>';
  const count=w.versions.length, last=w.versions.at(-1);
  $('#workState').textContent=count?(w.work.revision>last.revision?'已修改，待提交':'已提交'):w.work.revision?'草稿未提交':'未开始';
  if(isModel()&&last?.fields.phase==='model')$('#workState').textContent='模型已提交，待讨论';
  show('#submitRow',true);
  $('#submitButton').textContent=isModel()&&collectFields().phase==='discussion'?'提交讨论答案':'提交本组成果';
  $('#versionCount').textContent=count?`（${count} 次）`:'';
  if(typeof renderModel==='function')renderModel();
  if(typeof renderScores==='function')renderScores();
  if($('#activityFeed'))$('#activityFeed').innerHTML=w.files.map(f=>`<div class="activity-receipt">已上传 · ${esc(f.name)}</div>`).join('')+w.versions.map((v,i)=>`<div class="activity-receipt">✓ ${v.fields.phase==='model'?'模型图已提交':v.fields.phase==='discussion'?'讨论答案已提交':`第 ${i+1} 次成果已提交`} · ${stamp(v.updated)}</div>`).join('');
  $('#versionsBody').innerHTML=count?w.versions.map((v,i)=>`<article class="version"><h3>第 ${i+1} 次提交 · ${stamp(v.updated)}</h3><p class="fine">${esc(v.author)}</p>${fieldsHTML(v.fields)}${versionFiles(v.file_ids,w.files)}</article>`).join(''):'<p class="fine">提交后，原始记录与后续修改会显示在这里。</p>';
}
function fileHTML(f,actions=false) {
  const url='/api/classroom/files/'+encodeURIComponent(f.id), included=S.work?.work.file_ids.includes(f.id);
  return `<div class="file-row">${f.preview?`<a href="${url}?preview=true" target="_blank" rel="noopener"><img src="${url}?preview=true" alt="${esc(f.name)}" loading="lazy"></a>`:''}<div class="file-meta"><a href="${url}" download>${esc(f.name)}</a><small>${esc(f.uploader)} · ${(f.size/1024).toFixed(1)} KB</small></div>${actions?`<div class="file-buttons"><button type="button" data-attach="${esc(f.id)}" class="${included?'selected-file':''}" ${S.lesson.status!=='live'?'disabled':''}>${included?'已附成果':'附到成果'}</button>${f.preview?`<button type="button" data-ai-image="${esc(f.id)}">交给 AI</button>`:''}</div>`:''}</div>`;
}
function fieldsHTML(fields, projection=false) {
  const list=S.content.content.fields.filter(f=>!f.hidden||(f.legacy&&fields[f.key]));
  if(projection && S.stage===(S.lesson.assignment_stage||2))list.sort((a,b)=>(a.key==='conclusion'?-1:b.key==='conclusion'?1:0));
  if(isModel()&&fields.model_files)return pictureModelHTML(fields)+`<h3>未达预期结果后的讨论答案</h3><p class="answer-text">${esc(fields.discussion||(fields.phase==='model'?'待放置姓名后讨论':fileIds(fields,'discussion_files').length?'见下方答案图片':'尚未填写'))}</p>`+pictureAnswersHTML(fields);
  if(isModel())return modelHTML(fields)+ '<dl>'+list.filter(f=>!['sense','substance','elongation',...modelFields()].includes(f.key)).map(f=>`<dt>${esc(f.label)}</dt><dd>${esc(fields[f.key]||'尚未填写')}</dd>`).join('')+'</dl>';
  return '<dl>'+list.map(f=>`<dt>${esc(f.label)}</dt><dd>${esc(f.options?.[fields[f.key]]||fields[f.key]||'尚未填写')}</dd>`).join('')+'</dl>';
}
function versionFiles(ids,files) {
  return ids.map(id=>files.find(f=>f.id===id)).filter(Boolean).map(f=>f.preview?`<a href="/api/classroom/files/${encodeURIComponent(f.id)}?preview=true" target="_blank" rel="noopener"><img class="record-image" src="/api/classroom/files/${encodeURIComponent(f.id)}?preview=true" alt="${esc(f.name)}" loading="lazy"></a>`:fileHTML(f)).join('');
}
function collectFields() { return {...S.work?.work.fields,...Object.fromEntries($$('[data-field]').map(el=>[el.dataset.field,el.value]))}; }
function localDraft() { if(!S.user || isTeacher() || !S.lesson) return; try { sessionStorage.setItem(draftKey(),JSON.stringify({fields:collectFields(),file_ids:S.work.work.file_ids,revision:S.work.work.revision})); } catch {} }
function restoreLocalDraft() {
  let d; try { d=JSON.parse(sessionStorage.getItem(draftKey())); } catch {}
  if(!d || S.lesson.status!=='live') return;
  if(JSON.stringify(d.fields)===JSON.stringify(S.work.work.fields) && JSON.stringify(d.file_ids)===JSON.stringify(S.work.work.file_ids)) { sessionStorage.removeItem(draftKey()); return; }
  if(d.revision!==S.work.work.revision) { toast('检测到未同步的本机草稿，请在旧草稿提示中查看，避免覆盖同组最新内容。'); $('#versionsBody').insertAdjacentHTML('afterbegin',`<article class="version"><h3>本机未同步草稿</h3>${fieldsHTML(d.fields)}</article>`); $('#versionsPanel').open=true; return; }
  $$('[data-field]').forEach(el=>{if(!el.disabled) el.value=d.fields[el.dataset.field]||'';});
  S.work.work.file_ids=d.file_ids.filter(id=>S.work.files.some(f=>f.id===id)); markDirty(); renderExtras(); toast('已恢复本机未同步草稿，正在保存。');
}
function markDirty() {
  S.edit++; S.submitAttempt=null; localDraft(); $('#saveStatus').textContent='尚未同步，正在准备保存…';
  clearTimeout(S.draftTimer); S.draftTimer=setTimeout(()=>saveWork(false),900);
}
function submitFinalWork(){
  if(isModel()){$('#field-phase').value='discussion';markDirty();}
  return saveWork(true);
}
function saveWork(submit=false) {
  if(submit && S.submitting) return S.saveChain;
  if(submit) { S.submitting=true; $('#submitButton').disabled=true; $$('[data-field]').forEach(el=>el.disabled=true); }
  clearTimeout(S.draftTimer);
  const context={id:S.lesson?.id,stage:S.stage,group:S.user?.groupId};
  const perform=async()=>{
    if(!S.user || isTeacher() || S.lesson?.id!==context.id || S.stage!==context.stage || S.user.groupId!==context.group) return false;
    if(!submit && S.edit===S.savedEdit) return true;
    if(S.lesson.status!=='live') return false;
    const edit=S.edit, fields=collectFields(), file_ids=[...S.work.work.file_ids], revision=S.work.work.revision;
    const body={fields,file_ids,revision};
    if(submit) {
      const key=JSON.stringify({fields,file_ids});
      if(S.submitAttempt?.key!==key) S.submitAttempt={key,id:crypto.randomUUID()};
      body.request_id=S.submitAttempt.id;
      $('#submitButton').disabled=true;
    }
    $('#saveStatus').textContent=submit?'正在提交…':'正在保存…';
    try {
      const result=await api(`/lessons/${context.id}/stages/${context.stage}/${submit?'submissions':'work'}`,{method:submit?'POST':'PUT',body});
      if(!S.user || S.lesson?.id!==context.id || S.stage!==context.stage || S.user.groupId!==context.group) return false;
      S.work.work.revision=result.revision; S.work.work.updated=result.updated; S.work.work.fields=fields; S.savedEdit=edit;
      if(S.edit===edit) sessionStorage.removeItem(draftKey()); else localDraft();
      $('#saveStatus').textContent=(submit?'提交已保存 · ':'已保存 · ')+stamp(result.updated);
      if(submit) { S.submitAttempt=null; await refreshWork(false); toast(fields.phase==='model'?'模型图已提交，现在可在原图上放置科学家姓名。':fields.phase==='discussion'?'讨论答案已提交。':'本组成果已提交，后续修改会保留新版本。'); }
      return true;
    } catch(e) { $('#saveStatus').textContent=e.message; localDraft(); toast(e.message); return false; }
    finally { if(S.user && S.lesson?.id===context.id && S.stage===context.stage) $('#submitButton').disabled=S.lesson.status!=='live'; }
  };
  const queued=S.saveChain.then(perform,perform).finally(()=>{if(submit){S.submitting=false;if(S.user&&!isTeacher()&&S.lesson?.id===context.id&&S.stage===context.stage)renderExtras();}}); S.saveChain=queued; return queued;
}
async function flush() { globalThis.lessonVoice?.cancel(); if(busy()) { toast('请先等待当前上传或回复完成。'); return false; } return isTeacher() || !S.lesson || S.edit===S.savedEdit ? true : await saveWork(false); }
async function refreshWork(replaceFields=false) {
  const seq=S.seq, group=isTeacher()?S.group:S.user.groupId, work=await api(base()+`/groups/${group}/stages/${S.stage}`);
  if(seq!==S.seq || !S.user || group!==(isTeacher()?S.group:S.user.groupId)) return;
  if(isTeacher()) { S.work=work; renderDetail(); return; }
  if(S.edit===S.savedEdit && work.work.revision>=S.work.work.revision) { S.work=work; if(replaceFields) renderStudent(); else renderExtras(); }
}
async function poll() {
  if(!S.user || S.syncing || S.loading || document.hidden) return;
  S.syncing=true; const seq=S.seq;
  try {
    const lessons=await api('/lessons'); if(seq!==S.seq || !S.user) return;
    if(!S.lesson) { if(lessons.length) await loadLessons(); return; }
    S.lessons=lessons; const latest=lessons.find(l=>l.id===S.lesson.id); if(!latest) return;
    const changed=latest.stage!==S.lastTeacherStage;
    if(changed)globalThis.lessonVoice?.cancel();
    if(changed && !busy()) {
      if(!await flush()) { $('#syncStatus').textContent='老师已切换环节，请先保存本组草稿'; return; }
      S.lesson=latest; S.lastTeacherStage=latest.stage; await loadStage(latest.stage); toast('老师已切换到新的研究环节。'); return;
    }
    const reveal=latest.reveal_research!==S.lesson.reveal_research || latest.unlocked!==S.lesson.unlocked || latest.status!==S.lesson.status;
    if(latest.status!=='live')globalThis.lessonVoice?.cancel();
    S.lesson=latest; lessonOptions();
    const groups=await api(base()+`/groups?stage=${S.stage}`); if(seq!==S.seq || !S.user) return;
    S.groups=groups;
    if(reveal) { S.content=await api(base()+`/stages/${S.stage}`); if(seq!==S.seq) return; renderFrame(); if(!isTeacher()) renderMaterials(); }
    if(isTeacher()) { renderTeacher(); await refreshWork(); }
    else if(!S.sending && !S.uploading && !S.submitting) {
      const w=await api(base()+`/groups/${S.user.groupId}/stages/${S.stage}`); if(seq!==S.seq) return;
      if(S.edit===S.savedEdit && !S.submitting && w.work.revision>=S.work.work.revision) {
        const revisionChanged=w.work.revision!==S.work.work.revision;
        S.work=w;
        if(revisionChanged) renderStudent(); else if(JSON.stringify(w.assignment)!==$('#assignmentArea').dataset.snapshot || reveal) renderExtras();
        $('#assignmentArea').dataset.snapshot=JSON.stringify(w.assignment);
      }
    }
    renderChat(); renderScores(); $('#syncStatus').textContent='已同步 · '+new Date().toLocaleTimeString('zh-CN');
  } catch(e) { $('#syncStatus').textContent='同步失败，可手动刷新'; }
  finally { S.syncing=false; }
}
function workPreview(fields){
  if(isModel()&&fields.model_files)return `模型图 ${fileIds(fields,'model_files').length} 张 · 姓名 ${connectionList(fields).length} 处 · 讨论答案 ${fileIds(fields,'discussion_files').length} 张${fields.discussion?' · 已填写讨论':''}`;
  return S.content.content.fields.filter(f=>!f.hidden&&fields[f.key]).map(f=>`${f.label}：${fields[f.key]}`).join('；')||'等待本组记录观察与思考。';
}
function renderTeacher() {
  $('#overviewSummary').textContent=`${S.groups.filter(g=>g.status==='已提交').length} / ${S.lesson.group_count} 组已提交 · 状态来自本环节成果`;
  const ranked=[...S.groups].filter(g=>g.scores?.graded).sort((a,b)=>b.scores.total-a.scores.total);
  $('#groupGrid').innerHTML=S.groups.map(g=>`<button class="group-card ${g.id===S.group?'selected':''}" data-group="${g.id}"><header><strong>第 ${g.id} 组</strong><span class="state">${esc(g.status)}</span></header><p>${esc(workPreview(g.work.fields))}</p>${g.scores?`<div class="group-score">${g.scores.graded?g.scores.total:'—'} <small>/ 100</small><span>${g.scores.graded?'第 '+(1+ranked.filter(x=>x.scores.total>g.scores.total).length)+' 名':'待评分'}</span></div><div class="stage-dots">${g.scores.stages.map(r=>`<span title="环节${r.stage} ${scoreStatus[r.status]}">${r.stage} · ${r.total??'—'}</span>`).join('')}</div>`:''}<footer>${g.submission_count} 次提交 · ${g.chats.length} 轮讨论</footer></button>`).join('');
  $$('#groupGrid [data-group]').forEach(b=>{const g=S.groups.find(g=>g.id===Number(b.dataset.group));b.setAttribute('aria-label',`第 ${g.id} 组，${g.status}`);});
  const materialSnapshot=JSON.stringify([S.stage,S.content.materials]);
  if($('#teacherMaterials').dataset.snapshot!==materialSnapshot) {
    $('#teacherMaterials').innerHTML=S.content.materials.map(m=>`<details ${m.stage===S.stage?'open':''}><summary>${esc(m.title)}</summary>${materialHTML(m)}</details>`).join('');
    $('#teacherMaterials').dataset.snapshot=materialSnapshot;
  }
  renderDetail();
}
function renderDetail() {
  const g=S.groups.find(g=>g.id===S.group), w=S.work; if(!g || !w) return;
  const snapshot=JSON.stringify([S.stage,g,w,S.lesson.release_results,S.lesson.status]);
  if($('#groupDetail').dataset.snapshot===snapshot)return;
  const openStates=$$('#groupDetail details').map(d=>d.open);
  $('#groupDetail').innerHTML=`<div class="teacher-detail-title"><h2>第 ${g.id} 组 · ${esc(g.status)}</h2><button data-present-group="${g.id}">展示本组</button></div><p class="fine">${esc(S.roster.groups.find(x=>x.id===g.id)?.members.join('、'))}</p><div id="teacherScore">${scoreHTML(g.scores,true)}</div>${fieldsHTML(w.work.fields)}${S.stage===(S.lesson.assignment_stage||2)?assignmentHTML(w.assignment):''}${S.stage===(S.lesson.assignment_stage||2)&&S.lesson.release_results&&w.versions.length&&S.lesson.status==='live'?'<button id="adjustButton">核对／调整假设情境</button>':''}<h3>本组附件</h3>${w.files.length?w.files.map(f=>fileHTML(f)).join(''):'<p class="fine">暂无上传资料</p>'}<details><summary>提交与修改记录（${w.versions.length}）</summary>${w.versions.map((v,i)=>`<article class="version"><h3>第 ${i+1} 次 · ${stamp(v.updated)}</h3>${fieldsHTML(v.fields)}${versionFiles(v.file_ids,w.files)}</article>`).join('')||'<p>尚未提交</p>'}</details><div class="teacher-chat"><details><summary>本组 AI 对话（${g.chats.length} 轮）</summary>${chatsHTML(g.chats)}</details></div>`;
  $$('#groupDetail details').forEach((d,i)=>d.open=openStates[i]||false);
  $('#groupDetail').dataset.snapshot=snapshot;
}
async function refreshEvents() {
  if(!isTeacher() || !S.lesson) return;
  const seq=S.seq, events=await api(base()+'/events'); if(seq!==S.seq) return;
  const names={submit:'提交成果',score_correction:'教师修分',create:'创建课次',control:'课堂控制',assign:'分发预期结果',adjust:'调整假设情境'};
  $('#eventsBody').innerHTML=events.map(e=>`<div class="event-row"><strong>${esc(names[e.kind]||e.kind)}${e.group_id?' · 第 '+e.group_id+' 组':''}</strong> · ${esc(e.author)} · ${stamp(e.created)}<br>${esc(eventDescription(e))}</div>`).join('');
}
function eventDescription(e) {
  const d=e.detail;
  if(e.kind==='create') return d.title;
  if(e.kind==='submit')return `环节 ${d.stage} · 提交版本 ${d.version_id}`;
  if(e.kind==='score_correction')return `版本 ${d.version_id} · ${d.after.reason}`;
  if(e.kind==='assign') return `处理：${treatmentLabel(d.treatment)}；情境 ${'ABC'[d.variant]}`;
  if(e.kind==='adjust') return `调整为 ${treatmentLabel(d.after.treatment)}，情境 ${'ABC'[d.after.variant]}。依据：${d.after.reason}`;
  return [d.stage?'开放环节 '+d.stage:'',d.release_results?'开放预期结果分发':'',d.reveal_research?'开放历史结果核对':'',d.status==='archived'?'归档本课':''].filter(Boolean).join('；');
}
function treatmentLabel(t) { return {remove_tip:'去除顶端',tip_shade:'顶端遮光',lower_shade:'下部遮光',marking:'分段标记观察',custom:'自定义'}[t]||t; }
async function control(body) { await api(base(),{method:'PATCH',body}); await loadLessons(S.lesson.id); await refreshEvents(); }
async function createLesson() { const title=$('#newLessonTitle')?.value||'生长素探究课 · '+new Date().toLocaleDateString('zh-CN'); const l=await api('/lessons',{method:'POST',body:{title}}); await loadLessons(l.id); }
function setAI() { show('#aiPanel',!isTeacher()); $('#mainGrid').classList.toggle('with-ai',!isTeacher()); }
function chatsHTML(chats) {
  return chats.map(c=>`<div class="chat-entry student"><div class="speaker">${esc(c.author)}</div><p>${esc(c.question)}</p>${(c.images||[]).map(f=>`<a href="/api/classroom/files/${encodeURIComponent(f.id)}?preview=true" target="_blank" rel="noopener"><img src="/api/classroom/files/${encodeURIComponent(f.id)}?preview=true" alt="${esc(f.name)}"></a>`).join('')}</div><div class="chat-entry"><div class="speaker">AI 指导</div><p>${esc(c.answer)}</p></div>`).join('');
}
function renderChat() {
  if(!S.content || isTeacher()) return;
  const g=S.groups.find(g=>g.id===S.user.groupId), box=$('#chatMessages');
  let html=(S.content.opener?`<div class="chat-entry opener"><div class="speaker">本环节引导</div><p>${esc(S.content.opener)}</p></div>`:'')+chatsHTML(g?.chats||[]);
  if(S.pending) html+=`<div class="chat-entry student"><div class="speaker">${esc(S.user.name)}</div><p>${esc(S.pending.message||'请查看这些图片。')}</p>${S.pending.images.map(f=>`<img src="/api/classroom/files/${encodeURIComponent(f.id)}?preview=true" alt="${esc(f.name)}">`).join('')}</div><div class="chat-entry"><p class="${S.pending.error?'error':'muted'}">${esc(S.pending.error||'AI 正在思考…')}</p>${S.pending.error?'<button id="retryChat">重试这条消息</button>':''}</div>`;
  if(box.innerHTML!==(html||'<p class="fine">可以围绕当前任务提问，或选择已上传的图片一起分析。</p>')) {box.innerHTML=html||'<p class="fine">可以围绕当前任务提问，或选择已上传的图片一起分析。</p>';const scroller=$('#conversationScroll');if(S.content.opener||(g?.chats?.length||0)>0||S.pending)scroller.scrollTop=scroller.scrollHeight;}
  $('#quickPrompts').innerHTML=S.content.content.prompts.map(p=>`<button type="button" data-prompt="${esc(p)}">${esc(p)}</button>`).join('');
  $('#chatAttachments').innerHTML=[...S.images.values()].map(f=>`<div class="chat-attachment"><span>${esc(f.name)}</span><button type="button" data-remove-ai="${esc(f.id)}" aria-label="移除${esc(f.name)}">×</button></div>`).join('');
  $('#sendButton').disabled=S.sending||S.lesson.status!=='live'||(globalThis.lessonVoice&&lessonVoice.state!=='idle');
  $('#voiceStart').disabled=S.sending||S.lesson.status!=='live';
  for(const id of ['#chatSubmit','#chatUpload','#chatCamera'])$(id).disabled=busy()||S.lesson.status!=='live';
  $('#chatStatus').textContent=S.sending?'正在分析…':S.user.ai_ready?'仅发送文字与选中图片':'AI 暂未配置，仍可提交成果';
}
async function sendChat(retry=false) {
  if(S.sending || S.uploading || !S.lesson || S.lesson.status!=='live') return;
  const p=retry?S.pending:{message:$('#chatInput').value.trim(),images:[...S.images.values()],request_id:crypto.randomUUID()};
  if(!p || (!p.message&&!p.images.length)) return;
  if(!await saveWork(false)) return;
  const seq=S.seq, lessonId=S.lesson.id, stage=S.stage;
  p.error=null; S.pending=p; S.sending=true; S.images.clear(); $('#chatInput').value=''; renderChat();
  try {
    const reply=await api('/chats',{method:'POST',body:{request_id:p.request_id,lesson_id:lessonId,stage,message:p.message,image_ids:p.images.map(f=>f.id)}});
    if(seq!==S.seq||!S.user) return;
    S.pending=null; const g=S.groups.find(g=>g.id===S.user.groupId);
    if(!g.chats.some(c=>c.id===reply.id))g.chats.push({id:reply.id,question:reply.question,answer:reply.answer,images:reply.images,author:S.user.name});
  } catch(e) { if(seq===S.seq && S.pending){S.pending.error=e.message;$('#chatInput').value=p.message;} }
  finally { S.sending=false; if(seq===S.seq&&S.user) renderChat(); }
}
async function uploadFiles(files) {
  if(!S.lesson||S.uploading||S.sending||S.lesson.status!=='live') return false;
  const seq=S.seq,target=isModel()?(S.uploadTarget||pictureTarget()):null; S.uploading=true; let count=0, attached=0;
  try {
    if(target){
      if(files.some(f=>!/^image\/(png|jpeg|webp)$/.test(f.type)))throw new Error('请上传 PNG、JPG 或 WebP 图片。');
      if(fileIds(collectFields(),target+'_files').length+files.length>4)throw new Error('模型图和讨论答案各最多上传4张图片。');
      if(S.work.work.file_ids.length+files.length>12)throw new Error('一次成果最多关联12份附件。');
    }
    for(const file of files) {
      if(file.size>20*1024*1024) throw new Error('单份资料不能超过 20 MB');
      const body=new FormData();body.append('file',file);
      const f=await api(`/files?lesson_id=${encodeURIComponent(S.lesson.id)}&stage=${S.stage}`,{method:'POST',body});
      if(seq!==S.seq) return false;
      S.work.files.push(f); if(S.work.work.file_ids.length<12) {S.work.work.file_ids.push(f.id);attached++;} count++;
      if(target)registerPicture(f.id,target);
      renderExtras(); markDirty();
    }
    const saved=await saveWork(false); toast(`已上传 ${count} 份资料，${attached} 份已选为成果附件。${attached<count?'一次成果最多关联 12 份，可在附件列表调整。':''}${saved?'':'成果关联尚未同步，请重试保存。'}`); return saved;
  } catch(e) { toast(`已上传 ${count} 份；${e.message}`); return false; }
  finally { S.uploading=false; S.uploadTarget=null; $('#fileInput').value=''; if(isModel()&&seq===S.seq)renderExtras(); }
}
async function present(left) {
  $('#compareLeft').innerHTML=$('#compareRight').innerHTML=S.roster.groups.filter(g=>g.id<=S.lesson.group_count).map(g=>`<option value="${g.id}">第 ${g.id} 组</option>`).join('');
  $('#compareLeft').value=left||S.group; $('#compareRight').value=(Number(left||S.group)%S.lesson.group_count)+1;
  $('#presentationTitle').textContent=S.content.content.question;
  $('#presentationDialog').showModal(); await compare();
}
async function compare() {
  const seq=S.seq, ids=[$('#compareLeft').value,$('#compareRight').value];
  $('#comparison').innerHTML='<p class="loading">正在读取小组成果…</p>';
  const data=await Promise.all(ids.map(g=>api(base()+`/groups/${g}/stages/${S.stage}`))); if(seq!==S.seq) return;
  $('#comparison').innerHTML=data.map((w,i)=>{const v=w.versions.at(-1);return `<section><h3>第 ${ids[i]} 组</h3><p class="fine">${v?'展示最近提交 · '+stamp(v.updated):'本组尚未提交，以下为草稿'}</p>${w.assignment?.adjusted_at>=v?.updated?'<p class="notice">提交后教师调整过情境，以下解释可能基于先前结果，需重新核对。</p>':''}${assignmentHTML(w.assignment)}${fieldsHTML((v||w.work).fields,true)}${versionFiles((v||w.work).file_ids,w.files)}</section>`;}).join('');
}
async function legacy() {
  $('#historyDialog').showModal(); $('#historyBody').innerHTML='<p>正在读取…</p>';
  const data=await api('/groups');
  $('#historyBody').innerHTML=data.map(g=>`<details><summary>第 ${g.id} 组 · ${g.files.length} 份资料 / ${g.chat.length} 条对话</summary>${g.files.map(f=>fileHTML(f)).join('')}${g.chat.map(c=>`<div class="chat-entry"><div class="speaker">${esc(c.speaker)}</div><p>${esc(c.text)}</p>${(c.images||[]).map(f=>fileHTML(f)).join('')}</div>`).join('')}</details>`).join('');
}
async function adjust() {
  const t=S.work.versions.find(v=>v.id===S.work.assignment?.version_id)?.fields.treatment||S.work.versions.at(-1)?.fields.treatment||'custom';
  $('#adjustInfo').textContent=`第 ${S.group} 组 · 已提交处理：${treatmentLabel(t)}。自定义方案须先核对，无法匹配时保留待处理状态。`;
  const options=t==='custom'?['remove_tip','tip_shade','lower_shade','marking']:[t];
  $('#adjustTreatment').innerHTML=options.map(t=>`<option value="${t}">${treatmentLabel(t)}</option>`).join('');
  $('#adjustVariant').value=S.work.assignment?.variant||0; $('#adjustReason').value='';
  $('#adjustDialog').showModal(); await scenarioOptions(S.work.assignment?.variant||0);
}
let scenarioList=[];
async function scenarioOptions(selected=0){scenarioList=await api(base()+'/scenarios/'+encodeURIComponent($('#adjustTreatment').value));$('#adjustVariant').innerHTML=scenarioList.map(s=>`<option value="${s.variant}">${'ABC'[s.variant]} · ${esc(s.label)}</option>`).join('');$('#adjustVariant').value=selected;renderScenarioPreview();}
function renderScenarioPreview(){const s=scenarioList.find(s=>s.variant===Number($('#adjustVariant').value));$('#adjustPreview').innerHTML=s?`<img class="record-image" src="${esc(s.image)}" alt="${esc(s.label)}"><span class="fine">${esc(s.boundary)}</span>`:'';}
const camera=createCameraCapture({onConfirm:f=>uploadFiles([f]),onFile:()=>$('#fileInput').click()});
$('#loginGroup').addEventListener('change',names);
$$('[data-role]').forEach(b=>b.addEventListener('click',()=>{S.role=b.dataset.role;$$('[data-role]').forEach(x=>{x.classList.toggle('active',x===b);x.setAttribute('aria-pressed',String(x===b));});show('#groupField',S.role==='student');show('#teacherPasswordField',S.role==='teacher');$('#teacherPassword').required=S.role==='teacher';names();}));
$('#loginForm').addEventListener('submit',async e=>{e.preventDefault();$('#loginError').textContent='';$('#loginSubmit').disabled=true;try{const user=await api('/login',{method:'POST',body:{role:S.role,name:S.role==='teacher'?$('#loginName').value:'',groupId:S.role==='student'?Number($('#loginGroup').value):null,code:$('#classCode').value,teacherPassword:$('#teacherPassword').value}});await activate(user);}catch(err){$('#loginError').textContent=err.message;}finally{$('#loginSubmit').disabled=false;}});
$('#logoutButton').addEventListener('click',async()=>{if(!await flush())return;try{await api('/logout',{method:'POST'});Object.keys(sessionStorage).filter(k=>k.startsWith('auxin:')).forEach(k=>sessionStorage.removeItem(k));reset();}catch(e){toast(e.message);}});
$('#lessonSelect').addEventListener('change',async e=>{const id=e.target.value;if(!await flush()){lessonOptions();return;}await loadLessons(id).catch(e=>toast(e.message));});
$('#stageNav').addEventListener('click',async e=>{const b=e.target.closest('[data-stage]');if(!b||b.disabled)return;if(await flush())await loadStage(Number(b.dataset.stage)).catch(()=>{});});
$('#materialTabs').addEventListener('click',e=>{const b=e.target.closest('[data-material]');if(b){S.material=b.dataset.material;renderMaterials();}});
$('#workFields').addEventListener('input',e=>{if(!e.target.matches('[data-field]'))return;markDirty();});$('#workFields').addEventListener('change',e=>{if(e.target.matches('select'))markDirty();});
$('#workForm').addEventListener('submit',async e=>{e.preventDefault();if(S.uploading||S.extracting)return toast('请先等待上传或识别完成');await submitFinalWork();});
$('#saveButton').addEventListener('click',()=>saveWork(false));
$('#uploadButton').addEventListener('click',()=>choosePicture(null));$('#cameraButton').addEventListener('click',()=>choosePicture(null,true));$('#fileInput').addEventListener('change',e=>uploadFiles([...e.target.files]));
$('#workFiles').addEventListener('click',e=>{const a=e.target.closest('[data-attach]'),b=e.target.closest('[data-ai-image]');if(a){const id=a.dataset.attach,ids=S.work.work.file_ids;if(ids.includes(id))S.work.work.file_ids=ids.filter(x=>x!==id);else if(ids.length<12)ids.push(id);else return toast('一次成果最多关联 12 份附件');markDirty();renderExtras();}if(b){const f=S.work.files.find(f=>f.id===b.dataset.aiImage);if(S.images.size>=4||[...S.images.values()].reduce((n,f)=>n+f.size,0)+f.size>20*1024*1024)return toast('一次最多 4 张图片，合计不超过 20 MB');S.images.set(f.id,f);setAI(true);renderChat();}});

$('#chatForm').addEventListener('submit',e=>{e.preventDefault();sendChat();});$('#chatMessages').addEventListener('click',e=>{if(e.target.closest('#retryChat'))sendChat(true);});
$('#quickPrompts').addEventListener('click',e=>{const b=e.target.closest('[data-prompt]');if(b){$('#chatInput').value=b.dataset.prompt;$('#chatInput').focus();}});
$('#chatAttachments').addEventListener('click',e=>{const b=e.target.closest('[data-remove-ai]');if(b){S.images.delete(b.dataset.removeAi);renderChat();}});
$('#refreshButton').addEventListener('click',async()=>{if(!await flush())return;try{if(S.lesson)await loadStage(S.stage);else await loadLessons();}catch{}});
$('#emptyState').addEventListener('click',e=>{if(e.target.closest('#createLessonButton'))createLesson().catch(e=>toast(e.message));});
$('#teacherControls').addEventListener('click',async e=>{const id=e.target.closest('button')?.id;if(!id)return;try{if(id==='openStage')await control({stage:Number($('#teacherStage').value)});if(id==='releaseResults')await control({release_results:true});if(id==='revealResearch')await control({reveal_research:true});if(id==='archiveLesson'&&confirm('归档后本课只能查看，所有成果保留。确定归档？'))await control({status:'archived'});if(id==='newLessonButton')await createLesson();if(id==='presentButton')await present();}catch(err){toast(err.message);}});
$('#groupGrid').addEventListener('click',async e=>{const b=e.target.closest('[data-group]');if(!b)return;S.group=Number(b.dataset.group);await refreshWork().catch(e=>toast(e.message));renderTeacher();});
$('#groupDetail').addEventListener('click',e=>{const b=e.target.closest('[data-present-group]');if(b)present(Number(b.dataset.presentGroup)).catch(e=>toast(e.message));if(e.target.closest('#adjustButton'))adjust().catch(e=>toast(e.message));});
$('#adjustTreatment').addEventListener('change',()=>scenarioOptions().catch(e=>toast(e.message)));$('#adjustVariant').addEventListener('change',renderScenarioPreview);
$('#adjustForm').addEventListener('submit',async e=>{e.preventDefault();try{await api(base()+'/assignments',{method:'POST',body:{group_id:S.group,treatment:$('#adjustTreatment').value,variant:Number($('#adjustVariant').value),reason:$('#adjustReason').value}});$('#adjustDialog').close();await refreshWork();await refreshEvents();}catch(err){toast(err.message);}});
$('#cancelAdjust').addEventListener('click',()=>$('#adjustDialog').close());$('#closePresentation').addEventListener('click',()=>$('#presentationDialog').close());$('#compareRefresh').addEventListener('click',()=>compare().catch(e=>toast(e.message)));['#compareLeft','#compareRight'].forEach(id=>$(id).addEventListener('change',()=>compare().catch(e=>toast(e.message))));$('#fullscreenButton').addEventListener('click',()=>{const p=document.fullscreenElement?document.exitFullscreen():$('#presentationDialog').requestFullscreen();p?.catch(()=>toast('浏览器未进入全屏，可使用 F11。'));});
$('#legacyButton').addEventListener('click',()=>legacy().catch(e=>toast(e.message)));$('#closeHistory').addEventListener('click',()=>$('#historyDialog').close());
window.addEventListener('beforeunload',e=>{globalThis.lessonVoice?.cancel();if(S.edit!==S.savedEdit||S.uploading||S.sending){localDraft();e.preventDefault();e.returnValue='';}});
document.addEventListener('visibilitychange',()=>{if(document.hidden)globalThis.lessonVoice?.cancel();if(document.hidden&&S.user&&!isTeacher()&&S.edit!==S.savedEdit)saveWork(false);});
async function boot() {try{S.roster=await api('/roster');$('#loginGroup').innerHTML=S.roster.groups.map(g=>`<option value="${g.id}">第 ${g.id} 组</option>`).join('');names();try{await activate(await api('/me'));}catch(e){if(e.status!==401)$('#loginError').textContent=e.message;}}catch(e){$('#loginError').textContent='课堂服务暂时无法连接，请刷新后重试。';}}
installWidgets();
const voiceContext=()=>S.user&&S.lesson?`${S.user.groupId}:${S.lesson.id}:${S.stage}:${S.seq}`:'';
globalThis.lessonVoice=createVoiceInput({getContext:voiceContext,
  transcribe:async(blob,context,signal)=>{const body=new FormData();body.append('file',blob,'speech');body.append('lesson_id',S.lesson.id);body.append('stage',S.stage);body.append('request_id',crypto.randomUUID());return (await api('/transcriptions',{method:'POST',body,signal})).text;},
  onText:async(text,target,context)=>{if(context!==voiceContext())return;if(target==='chat'){$('#chatInput').value=[$('#chatInput').value.trim(),text].filter(Boolean).join('\n');await sendChat();}else{const f=$('#field-'+target);if(f&&!f.disabled){f.value=[f.value.trim(),text].filter(Boolean).join('\n');f.dispatchEvent(new Event('input',{bubbles:true}));}}},
  onState:(state,label)=>{$('#voiceStatus').textContent=label;show('#voiceStart',state==='idle');show('#voiceStop',state==='recording');show('#voiceCancel',state!=='idle');$('#voiceStop').textContent=globalThis.lessonVoice?.target==='chat'?'停止并发送':'停止并填入';$('#chatInput').readOnly=state!=='idle';$('#sendButton').disabled=state!=='idle'||S.sending||S.lesson?.status!=='live';$$('[data-voice-field]').forEach(b=>b.disabled=state!=='idle'||S.lesson?.status!=='live'||$('#field-'+b.dataset.voiceField)?.disabled);},
  onError:message=>{toast(message);$('#voiceStatus').textContent=message;}
});
$('#voiceStart').addEventListener('click',()=>{if(!busy()&&S.lesson?.status==='live')lessonVoice.start('chat');});
$('#voiceStop').addEventListener('click',()=>lessonVoice.stop());$('#voiceCancel').addEventListener('click',()=>lessonVoice.cancel());
$('#workFields').addEventListener('click',e=>{const b=e.target.closest('[data-voice-field]');if(b&&!busy()&&!$('#field-'+b.dataset.voiceField)?.disabled&&S.lesson?.status==='live')lessonVoice.start(b.dataset.voiceField);});
$('#chatUpload').addEventListener('click',()=>choosePicture(pictureTarget()));$('#chatCamera').addEventListener('click',()=>choosePicture(pictureTarget(),true));$('#chatSubmit').addEventListener('click',()=>{if(!busy())submitFinalWork();});
boot();setInterval(poll,5000);
