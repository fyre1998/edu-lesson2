'use strict';
function isModel(){return S.lesson?.flow_version===2&&S.stage===4;}
function modelFields(){return ['connections','extraction_id','confirmed','model_files','discussion_files','phase'];}
function fieldHTML(f){
  const value=S.work.work.fields[f.key]||'';
  if(f.legacy)return '';
  if(f.hidden)return `<input type="hidden" id="field-${f.key}" data-field="${f.key}" value="${esc(value||(f.key==='phase'?'model':f.key.endsWith('_files')||f.key==='connections'?'[]':''))}">`;
  if(f.input==='short')return `<div class="work-field short-field"><label for="field-${f.key}">${esc(f.label)}</label><input id="field-${f.key}" data-field="${f.key}" maxlength="200" placeholder="${esc(f.placeholder)}" value="${esc(value)}"></div>`;
  if(isModel()&&modelFields().includes(f.key))return `<input type="hidden" id="field-${f.key}" data-field="${f.key}" value="${esc(value)}">`;
  return `<div class="work-field" ${f.key==='discussion'?'id="discussionField"':''}><label for="field-${f.key}">${esc(f.label)}${f.key==='discussion'?'（也可上传照片）':''}</label>${f.options?`<select id="field-${f.key}" data-field="${f.key}"><option value="">请选择</option>${Object.entries(f.options).map(([v,l])=>`<option value="${esc(v)}" ${value===v?'selected':''}>${esc(l)}</option>`).join('')}</select>`:`<textarea id="field-${f.key}" data-field="${f.key}" maxlength="6000" placeholder="${esc(f.placeholder)}" rows="${['design','summary','discussion'].includes(f.key)?6:3}">${esc(value)}</textarea><button type="button" class="field-mic" data-voice-field="${f.key}">语音填写</button>`}</div>`;
}
function connectionList(fields){try{const x=JSON.parse(fields.connections||'[]');return Array.isArray(x)?x:[];}catch{return [];}}
function modelHTML(fields,interactive=false){
  const labels=['单侧蓝光','某些部位感受 '+(fields.sense||'________'),'产生一种可向下移动的 '+(fields.substance||'________'),'化学物质的分布或作用出现两侧差异','幼苗两侧细胞 '+(fields.elongation||'________'),'向光弯曲'];
  const links=connectionList(fields),scientists=S.content.scientists||{};
  const tags=target=>links.filter(x=>x.target===target).map(x=>`<span class="model-tag">${esc(scientists[x.scientist]||x.scientist)}${interactive?`<button type="button" data-unlink="${esc(x.scientist)}:${target}" aria-label="移除${esc(scientists[x.scientist])}连接">×</button>`:''}</span>`).join('');
  const node=(id,text,arrow=false)=>`<div class="${arrow?'model-arrow':'model-node'}" ${interactive?`data-target="${id}" tabindex="0" role="button" aria-label="连接到${esc(S.content.targets[id])}"`:''}><span>${esc(text)}</span><div>${tags(id)}</div></div>`;
  return `<div class="model-diagram">${labels.map((l,i)=>node('node'+i,l)+(i<5?node('arrow'+i,'↓',true):'')).join('')}</div>`;
}
function renderModel(){
  if(!$('#modelTools'))return;
  if(!isModel()){show('#modelTools',false);return;}
  show('#modelTools',true);
  const f=collectFields(),ready=modelSubmitted(f),discussion=f.phase==='discussion',editable=S.lesson.status==='live'&&!S.submitting&&!S.uploading;
  const controls=(target,label)=>`<div class="actions"><button type="button" data-picture-upload="${target}" ${!editable?'disabled':''}>上传${label}</button><button type="button" data-picture-camera="${target}" ${!editable?'disabled':''}>拍照</button></div>`;
  $('#modelTools').innerHTML=`<section class="model-step"><h3><span>1</span> 提交模型图 ${ready?'<small>已提交</small>':''}</h3><p class="fine">上传或拍摄本组完成的模型图。</p>${controls('model','模型图')}${!ready?pictureModelHTML(f,false,true):''}${!ready?`<button type="button" id="submitModelPicture" class="primary" ${!editable||!fileIds(f,'model_files').length?'disabled':''}>提交模型图</button>`:''}</section><section class="model-step ${!ready?'step-locked':''}"><h3><span>2</span> 在模型图上放置科学家姓名</h3>${ready?`<p class="fine">拖动姓名到原图对应位置，或先点姓名再点图中位置。可重复放置，点 × 移除。键盘可用方向键选位置，回车放置。</p><div class="scientist-tray">${Object.entries(S.content.scientists||{}).map(([id,name])=>`<button type="button" draggable="${editable}" data-scientist="${id}" aria-pressed="${S.selectedScientist===id}" ${!editable?'disabled':''}>${esc(name)}</button>`).join('')}</div>${pictureModelHTML(f,editable,true)}<button type="button" id="finishPlacements" ${!editable?'disabled':''}>${discussion?'已进入讨论':'进入讨论（姓名可不放置）'}</button>`:`<p class="fine">提交模型图后可放置姓名，也可跳过。</p><button type="button" id="finishPlacements" ${!editable?'disabled':''}>跳过模型与姓名，进入讨论</button>`}</section><section class="model-step ${!discussion?'step-locked':''}"><h3><span>3</span> 讨论未达预期的结果</h3>${discussion?`<p class="fine">结合达尔文父子、波森·詹森和拜尔的实验思路，讨论未达预期的结果及其对模型的影响。上传讨论答案照片，或在下方填写答案。</p>${controls('discussion','讨论答案')}${pictureAnswersHTML(f,editable)}`:'<p class="fine">进入讨论后可填写或上传答案，也可留空提交。</p>'}</section>`;
  if($('#discussionField'))show('#discussionField',discussion);
  show('#submitRow',true);
}
function fileIds(fields,key){try{const ids=JSON.parse(fields[key]||'[]');return Array.isArray(ids)?ids:[];}catch{return [];}}
function modelSubmitted(fields){
  const ids=fileIds(fields,'model_files');
  return ids.length>0&&S.work.versions.some(v=>{const old=fileIds(v.fields,'model_files');return old.length===ids.length&&ids.every(id=>old.includes(id));});
}
function pictureModelHTML(fields,interactive=false,removable=false){
  const links=connectionList(fields),editable=S.lesson.status==='live'&&!S.submitting&&!S.uploading;
  return fileIds(fields,'model_files').map(id=>`<figure class="uploaded-model"><div class="picture-board" ${interactive?`data-picture-board="${esc(id)}" tabindex="0" role="group" aria-label="放置科学家姓名的模型图；方向键移动位置，回车放置"`:''}><img src="/api/classroom/files/${encodeURIComponent(id)}?preview=true" alt="本组上传的模型图" draggable="false">${links.map((p,i)=>p.file_id===id?`<span class="picture-name" style="left:clamp(50px,${Number(p.x)*100}%,calc(100% - 50px));top:${Number(p.y)*100}%">${esc(S.content.scientists?.[p.scientist]||p.scientist)}${interactive?`<button type="button" data-remove-placement="${i}" aria-label="移除${esc(S.content.scientists?.[p.scientist]||p.scientist)}">×</button>`:''}</span>`:'').join('')}</div>${removable&&editable?`<figcaption><button type="button" data-remove-picture="${esc(id)}" data-picture-kind="model">移除此图</button></figcaption>`:''}</figure>`).join('')||'<p class="upload-empty">尚未上传模型图</p>';
}
function pictureAnswersHTML(fields,editable=false){
  return fileIds(fields,'discussion_files').map(id=>`<figure class="uploaded-answer"><a href="/api/classroom/files/${encodeURIComponent(id)}?preview=true" target="_blank" rel="noopener"><img src="/api/classroom/files/${encodeURIComponent(id)}?preview=true" alt="未达预期结果后的讨论答案"></a>${editable?`<figcaption><button type="button" data-remove-picture="${esc(id)}" data-picture-kind="discussion">移除此图</button></figcaption>`:''}</figure>`).join('');
}
function pictureTarget(){return isModel()?(collectFields().phase==='discussion'?'discussion':'model'):null;}
function choosePicture(target,capture=false){
  if(busy()||S.lesson.status!=='live')return;
  S.uploadTarget=target;
  $('#fileInput').accept=(target||isInquiry())?'.png,.jpg,.jpeg,.webp':'.png,.jpg,.jpeg,.webp,.pdf,.doc,.docx,.xlsx,.csv,.txt,.md';
  if(capture)camera.open();else $('#fileInput').click();
}
function registerPicture(id,target){
  const field=$('#field-'+target+'_files'),ids=fileIds(collectFields(),target+'_files');
  field.value=JSON.stringify([...ids,id]);
  if(target==='model'){$('#field-phase').value='model';$('#field-connections').value='[]';}
}
function placeScientist(board,x,y){
  if(!S.selectedScientist||busy()||S.lesson.status!=='live'||!modelSubmitted(collectFields()))return toast('请先提交模型图并选择科学家姓名。');
  const links=connectionList(collectFields());
  if(links.length>=44)return toast('最多放置44个姓名标签。');
  links.push({scientist:S.selectedScientist,file_id:board.dataset.pictureBoard,x:Math.round(Math.max(0,Math.min(1,x))*10000)/10000,y:Math.round(Math.max(0,Math.min(1,y))*10000)/10000});
  $('#field-connections').value=JSON.stringify(links);markDirty();renderModel();
}
function installPictureEvents(){
  $('#workForm').addEventListener('click',async e=>{
    const upload=e.target.closest('[data-picture-upload]'),capture=e.target.closest('[data-picture-camera]');
    if(upload)return choosePicture(upload.dataset.pictureUpload);
    if(capture)return choosePicture(capture.dataset.pictureCamera,true);
    if(busy()||S.lesson.status!=='live')return;
    const remove=e.target.closest('[data-remove-picture]');
    if(remove){const id=remove.dataset.removePicture,key=remove.dataset.pictureKind+'_files';$('#field-'+key).value=JSON.stringify(fileIds(collectFields(),key).filter(x=>x!==id));S.work.work.file_ids=S.work.work.file_ids.filter(x=>x!==id);if(key==='model_files'){$('#field-phase').value='model';$('#field-connections').value='[]';}markDirty();renderExtras();return;}
    const unlink=e.target.closest('[data-remove-placement]');
    if(unlink){$('#field-connections').value=JSON.stringify(connectionList(collectFields()).filter((_,i)=>i!==Number(unlink.dataset.removePlacement)));markDirty();renderExtras();return;}
    if(e.target.closest('#submitModelPicture')){$('#field-phase').value='model';markDirty();return saveWork(true);}
    if(e.target.closest('#finishPlacements')){$('#field-phase').value='discussion';markDirty();renderExtras();await saveWork(false);$('#field-discussion').focus();return;}
    const board=e.target.closest('[data-picture-board]');
    if(board&&!e.target.closest('.picture-name')){const rect=board.getBoundingClientRect();placeScientist(board,(e.clientX-rect.left)/rect.width,(e.clientY-rect.top)/rect.height);}
  });
  $('#workForm').addEventListener('dragover',e=>{if(e.target.closest('[data-picture-board]'))e.preventDefault();});
  $('#workForm').addEventListener('drop',e=>{const board=e.target.closest('[data-picture-board]');if(!board)return;e.preventDefault();const id=e.dataTransfer.getData('text/plain');if(!S.content.scientists[id])return;S.selectedScientist=id;const r=board.getBoundingClientRect();placeScientist(board,(e.clientX-r.left)/r.width,(e.clientY-r.top)/r.height);});
  $('#workForm').addEventListener('keydown',e=>{const board=e.target.closest('[data-picture-board]');if(!board||e.target!==board)return;const p=board._cursor||(board._cursor={x:.5,y:.5});if(e.key.startsWith('Arrow')){e.preventDefault();p.x=Math.max(0,Math.min(1,p.x+(e.key==='ArrowRight'?.05:e.key==='ArrowLeft'?-.05:0)));p.y=Math.max(0,Math.min(1,p.y+(e.key==='ArrowDown'?.05:e.key==='ArrowUp'?-.05:0)));let cursor=board.querySelector('.picture-cursor');if(!cursor){cursor=document.createElement('span');cursor.className='picture-cursor';cursor.textContent='+';board.append(cursor);}cursor.style.left=p.x*100+'%';cursor.style.top=p.y*100+'%';}if(e.key==='Enter'||e.key===' '){e.preventDefault();placeScientist(board,p.x,p.y);}});
}
async function extractModel(){
  if(S.extracting||!await flush())return;
  const ids=S.work.work.file_ids.filter(id=>S.work.files.some(f=>f.id===id&&f.preview));
  if(!ids.length)return toast('请先上传模型照片并附到成果。');
  if(ids.length>4)return toast('请只选择最多4张模型照片作为成果附件。');
  const seq=S.seq,edit=S.edit;S.extracting=true;renderModel();
  try{const result=await api(base()+'/model-extractions',{method:'POST',body:{revision:S.work.work.revision,file_ids:ids}});if(seq!==S.seq||edit!==S.edit)return toast('识别期间文字已修改，未覆盖草稿，请重新识别。');
    ['sense','substance','elongation'].forEach(k=>$('#field-'+k).value=result[k]);$('#field-extraction_id').value=result.id;$('#field-confirmed').value='false';$('#field-connections').value='[]';
    S.modelNotice=result.uncertain.length?'这些位置需要核对：'+result.uncertain.map(k=>S.content.content.fields.find(f=>f.key===k).label).join('、'):'已按原图转录，请核对后确认。';markDirty();renderModel();await saveWork(false);
  }catch(e){toast(e.message);}finally{S.extracting=false;if(seq===S.seq)renderModel();}
}
function addConnection(target){
  if(!S.selectedScientist||$('#field-confirmed')?.value!=='true'||S.lesson.status!=='live')return toast('请先核对模型，再选择研究者。');
  const list=connectionList(collectFields());if(!list.some(x=>x.scientist===S.selectedScientist&&x.target===target))list.push({scientist:S.selectedScientist,target});
  $('#field-connections').value=JSON.stringify(list);markDirty();renderModel();
}
const scoreStatus={previous_task:'旧任务已保留，请提交新方案',unsubmitted:'未提交',model_submitted:'模型已提交，待讨论',needs_clarification:'请补充清晰设计',pending:'待评分',processing:'评分中',failed:'待重试',ready:'已评分',corrected:'教师已复核'};
function scoreHTML(scores,teacher=false){
  if(isInquiry()&&S.stage===1)return '<p class="fine">第一部分不计分，提交后获取对应结果图。</p>';
  if(!scores)return '';
  const stages=teacher?scores.stages:scores.stages.filter(s=>s.stage===S.stage);
  const heading=teacher?`<div class="score-heading"><strong>本组积分 ${scores.graded?scores.total:'—'} <small>/ 100</small></strong><span class="fine">${scores.graded} / ${scores.stages.length} 个计分环节已有评分</span></div>`:'';
  return `${heading}${stages.map(s=>`<details class="score-stage" data-score-stage="${s.stage}" ${teacher&&s.stage===S.stage&&s.total!==null?'open':''}><summary>${teacher?`环节 ${s.stage} ·`:'本环节积分'} ${s.total??'—'} / ${s.maximum} · ${scoreStatus[s.status]||s.status}</summary>${s.clarification?`<p class="notice">${esc(s.clarification)}</p>`:''}${s.items.map(i=>`<div class="score-item"><span>${esc(i.label)}</span><strong>${i.points??'—'} / ${i.maximum}</strong>${i.missing?'<small>待完成</small>':''}<p class="fine">${esc(teacher?i.reason:i.hint)}</p>${teacher&&i.evidence?.length?`<small>依据：${esc(i.evidence.join('、'))}</small>`:''}</div>`).join('')}${teacher&&s.version_id&&S.lesson.status==='live'?`<div class="actions"><button type="button" data-score-edit="${esc(s.version_id)}">教师修分</button>${['failed','pending','processing'].includes(s.status)?`<button type="button" data-score-retry="${esc(s.version_id)}">重试评分</button>`:''}</div>`:''}${teacher&&s.correction?.reason?`<p class="fine">${esc(s.correction.author)}：${esc(s.correction.reason)}</p>`:''}</details>`).join('')}`;
}
function renderScores(){
  const g=S.groups.find(g=>g.id===(isTeacher()?S.group:S.user?.groupId));
  renderStudentScore(!isTeacher()&&isInquiry()?S.work?.scores||g?.scores:g?.scores);
  for(const [id,teacher] of [['#teacherScore',true]]){
    const el=$(id);if(!el||(teacher&&!isTeacher()))continue;
    const snapshot=JSON.stringify([S.stage,g?.id,g?.scores,teacher]);if(el.dataset.scoreSnapshot===snapshot)continue;
    const states=new Map($$(id+' details').map(d=>[d.dataset.scoreStage,d.open]));el.innerHTML=scoreHTML(g?.scores,teacher);
    $$(id+' details').forEach(d=>{if(states.has(d.dataset.scoreStage))d.open=states.get(d.dataset.scoreStage);});el.dataset.scoreSnapshot=snapshot;
    if(teacher&&g?.scores)g.scores.stages.forEach(s=>{if(s.correction?.reason){const items=$$(id+' details').find(d=>Number(d.dataset.scoreStage)===s.stage)?.querySelectorAll('.score-item');items?.forEach((el,i)=>{const p=document.createElement('small');p.textContent='AI 原评分：'+(s.items[i].ai_points??'未完成');el.append(p);});}});
  }
}
function editScore(id){
  const score=S.groups.find(g=>g.id===S.group)?.scores?.stages.find(s=>s.version_id===id);if(!score)return;
  $('#scoreVersion').value=id;$('#scoreFields').innerHTML=score.items.map(i=>`<label>${esc(i.label)}（0–${i.maximum}）<input type="number" min="0" max="${i.maximum}" step="1" required data-score-key="${i.key}" value="${i.points??0}"></label>`).join('');$('#scoreReason').value='';$('#scoreDialog').showModal();
}
function installWidgets(){
  installScoreBubble();
  installPictureEvents();
  $('#workForm').addEventListener('click',async e=>{try{
    if(e.target.closest('#extractModel'))return extractModel();
    if(e.target.closest('#confirmModel')){if(['sense','substance','elongation'].some(k=>!$('#field-'+k).value.trim()))return toast('请先核对并填写三个模型空白。');$('#field-confirmed').value='true';markDirty();renderModel();}
    const b=e.target.closest('[data-scientist]');if(b){S.selectedScientist=b.dataset.scientist;renderModel();}
    const u=e.target.closest('[data-unlink]');if(u){e.stopPropagation();const [scientist,target]=u.dataset.unlink.split(':');$('#field-connections').value=JSON.stringify(connectionList(collectFields()).filter(x=>x.scientist!==scientist||x.target!==target));markDirty();renderModel();return;}
    const t=e.target.closest('[data-target]');if(t)addConnection(t.dataset.target);
    if(e.target.closest('#extractionHistory')){const rows=await api(base()+`/groups/${S.user.groupId}/model-extractions`);$('#historyBody').innerHTML=rows.map(r=>`<article><h3>转录 · ${stamp(r.created)}</h3>${versionFiles(r.file_ids,S.work.files)}<pre>${esc(JSON.stringify(r.data,null,2))}</pre></article>`).join('')||'尚无转录记录';$('#historyDialog').showModal();}
  }catch(err){toast(err.message);}});
  $('#workForm').addEventListener('dragstart',e=>{const b=e.target.closest('[data-scientist]');if(b){S.selectedScientist=b.dataset.scientist;e.dataTransfer.setData('text/plain',b.dataset.scientist);}});
  $('#workForm').addEventListener('dragover',e=>{if(e.target.closest('[data-target]'))e.preventDefault();});
  $('#workForm').addEventListener('drop',e=>{const t=e.target.closest('[data-target]');if(t){e.preventDefault();const id=e.dataTransfer.getData('text/plain');if(S.content.scientists[id]){S.selectedScientist=id;addConnection(t.dataset.target);}}});
  $('#workForm').addEventListener('keydown',e=>{if(['Enter',' '].includes(e.key)&&e.target.matches('[data-target]')){e.preventDefault();addConnection(e.target.dataset.target);}});
  $('#groupDetail').addEventListener('click',async e=>{const edit=e.target.closest('[data-score-edit]'),retry=e.target.closest('[data-score-retry]');if(edit)editScore(edit.dataset.scoreEdit);if(retry)try{await api(base()+`/assessments/${retry.dataset.scoreRetry}/retry`,{method:'POST'});toast('已请求重新评分');await poll();}catch(err){toast(err.message);}});
  $('#scoreCancel').addEventListener('click',()=>$('#scoreDialog').close());
  $('#scoreForm').addEventListener('submit',async e=>{e.preventDefault();try{await api(base()+`/assessments/${$('#scoreVersion').value}`,{method:'PUT',body:{points:Object.fromEntries($$('[data-score-key]').map(i=>[i.dataset.scoreKey,Number(i.value)])),reason:$('#scoreReason').value}});$('#scoreDialog').close();await poll();await refreshEvents();}catch(err){toast(err.message);}});
  $('#teachingGuide').addEventListener('click',async()=>{try{const guide=await api(base()+'/teaching-guide');$('#historyBody').innerHTML=Object.entries(guide.prompts).map(([stage,p])=>`<details><summary>环节 ${stage} 提示词</summary><pre>${esc(p)}</pre></details>`).join('')+`${guide.went_original?`<details><summary>温特原始提示词</summary><pre>${esc(guide.went_original)}</pre></details>`:''}${guide.matching?`<h3>教师原图匹配表</h3><pre>${esc(JSON.stringify(guide.matching,null,2))}</pre>`:''}<h3>评分量规</h3><pre>${esc(JSON.stringify(guide.rubric,null,2))}</pre>`;$('#historyDialog').showModal();}catch(e){toast(e.message);}});
}
