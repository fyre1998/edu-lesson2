'use strict';

const teacherEscape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const teacherNumber=value=>Number(value).toLocaleString('zh-CN',{maximumFractionDigits:2});

function teacherBarChart(data) {
  const rows=data.rows;
  if(!rows.length)return '';
  const width=Math.max(560,rows.length*105+90), height=350, left=64, top=36, bottom=280;
  const target=Math.max(1,...rows.map(r=>r.value+(r.uncertainty||0)))*1.05/4;
  const magnitude=10**Math.floor(Math.log10(target));
  const max=[1,2,2.5,5,10].find(n=>n*magnitude>=target)*magnitude*4;
  const plot=bottom-top, step=(width-left-24)/rows.length, bar=Math.min(58,step*.6);
  const y=value=>bottom-value/max*plot;
  let svg=`<svg xmlns="http://www.w3.org/2000/svg" class="${rows.length<=6?'chart-compact':'chart-wide'}" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" aria-label="${teacherEscape(data.title)}"><title>${teacherEscape(data.title)}</title>`;
  for(let i=0;i<=4;i++) {
    const value=max*i/4, pos=y(value);
    svg+=`<line x1="${left}" x2="${width-20}" y1="${pos}" y2="${pos}" class="chart-grid"/><text x="${left-10}" y="${pos+5}" text-anchor="end" class="chart-tick">${teacherNumber(value)}</text>`;
  }
  svg+=`<text x="${left}" y="18" class="chart-unit">${teacherEscape(data.metric_label)}（${teacherEscape(data.unit)}）</text>`;
  rows.forEach((row,index)=>{
    const x=left+step*(index+.5), pos=y(row.value), error=row.uncertainty||0;
    svg+=`<rect x="${x-bar/2}" y="${pos}" width="${bar}" height="${bottom-pos}" rx="3" class="chart-bar chart-color-${index%4}"><title>${teacherEscape(row.label)}：${teacherNumber(row.value)}${error?' ± '+teacherNumber(error):''} ${teacherEscape(data.unit)}</title></rect>`;
    if(error)svg+=`<path d="M${x},${y(row.value+error)}V${y(Math.max(0,row.value-error))} M${x-6},${y(row.value+error)}h12 M${x-6},${y(Math.max(0,row.value-error))}h12" class="chart-error"/>`;
    svg+=`<text x="${x}" y="${y(row.value+error)-10}" text-anchor="middle" class="chart-value">${teacherNumber(row.value)}</text>`;
    const parts=row.label.includes(' · ')?row.label.split(' · '):[row.label];
    svg+=`<text x="${x}" y="${bottom+24}" text-anchor="middle" class="chart-label">${parts.map((p,i)=>`<tspan x="${x}" dy="${i?21:0}">${teacherEscape(p)}</tspan>`).join('')}</text>`;
  });
  return svg+'</svg>';
}

function teacherResultHTML(data) {
  const e=teacherEscape, numeric=['bar','table'].includes(data.presentation);
  const labels={unsubmitted:'尚未提交',pending:'等待处理',processing:'正在处理',failed:'处理失败',needs_clarification:'需要补充',unmatched:'暂无匹配结果',previous_task:'没有当前任务的评分',ready:'暂无所选指标',corrected:'暂无所选指标'};
  const table=numeric&&data.rows.length?`<div class="teacher-chart-table"><table><thead><tr><th scope="col">${data.unit==='g'?'实验处理':'小组'}</th><th scope="col">${e(data.metric_label)}（${e(data.unit)}）</th></tr></thead><tbody>${data.rows.map(r=>`<tr><th scope="row">${e(r.label)}</th><td>${teacherNumber(r.value)}${r.uncertainty?' ± '+teacherNumber(r.uncertainty):''}</td></tr>`).join('')}</tbody></table></div>`:'';
  return `<h3>${e(data.title)}</h3><p class="teacher-analysis-message">${e(data.message)}</p>${data.observations.length?`<ul class="teacher-analysis-observations">${data.observations.map(o=>`<li>第 ${o.group_id} 组：${e(o.text)}</li>`).join('')}</ul>`:''}${data.presentation==='bar'&&data.rows.length?`<div class="teacher-chart-scroll" tabindex="0" aria-label="柱状图，可横向滚动">${teacherBarChart(data)}</div><details><summary>查看数值</summary>${table}</details>`:table}${numeric&&!data.rows.length?'<p class="notice">暂无符合要求的结果，待小组提交并完成处理后可再次汇总。</p>':''}${data.unavailable.length&&numeric?`<p class="fine">暂未纳入：${data.unavailable.map(g=>`第 ${g.group_id} 组（${e(labels[g.status]||'暂无所选结果')}）`).join('、')}。</p>`:''}${data.stale?'<p class="notice">汇总期间有小组更新了结果，可再次提交指令获取最新汇总。</p>':''}`;
}

function createTeacherChart({getContext,canEdit,transcribe,analyze,root=document,clock=globalThis,createVoice=createVoiceInput,makeId=()=>crypto.randomUUID()}) {
  const el=id=>root.querySelector('#'+id);
  const panel=el('teacherChart'), input=el('teacherChartInput'), mic=el('teacherChartMic');
  const cancelButton=el('teacherChartVoiceCancel'), submit=el('teacherChartSubmit');
  const status=el('teacherChartStatus'), result=el('teacherChartResult'), body=el('teacherChartResultBody');
  let context='', generation=0, ready=false, voiceLabel='', error='', voice, pending=null, attempt=null;

  function render() {
    const visible=!!getContext(), editable=visible&&canEdit();
    const state=voice?.state||'idle', active=state!=='idle', waiting=!!pending;
    panel.classList.toggle('hidden',!visible);
    panel.setAttribute('aria-busy',String(waiting));
    input.readOnly=active||waiting||!editable;
    mic.disabled=waiting||!editable||(active&&state!=='recording');
    mic.textContent=state==='recording'?'停止并填入':active?'正在处理语音…':'语音输入';
    mic.classList.toggle('is-recording',state==='recording');
    mic.setAttribute('aria-pressed',String(state==='recording'));
    cancelButton.classList.toggle('hidden',!active);
    submit.disabled=waiting||active||!editable;
    submit.textContent=waiting?'正在汇总…':'执行指令';
    status.textContent=waiting?'AI 正在理解要求并汇总各组结果…':error||voiceLabel||(ready?'汇总完成，可继续输入新的要求。':'');
    status.classList.toggle('is-loading',waiting);
    result.classList.toggle('hidden',!ready);
  }
  function cancel() {
    generation++;
    pending?.abort();pending=null;
    voice?.cancel();voiceLabel='';error='';render();
  }
  function reset() {
    ready=false;attempt=null;body.innerHTML='';input.value='';cancel();
    if(root.fullscreenElement===result)root.exitFullscreen?.().catch(()=>{});
  }
  function refresh() {
    const next=getContext();
    if(next!==context){context=next;reset();}
    if(!canEdit()&&(pending||voice?.state!=='idle'))cancel();
    render();
  }
  voice=createVoice({getContext,transcribe,
    onText:(text,target,recordedContext)=>{
      if(recordedContext!==getContext()||!canEdit())return;
      input.value=[input.value.trim(),text].filter(Boolean).join('\n');
    },
    onState:(state,label)=>{if(state==='requesting')error='';voiceLabel=label;render();},
    onError:message=>{error=message+' 可继续打字输入。';render();}
  });
  mic.addEventListener('click',()=>{
    if(mic.disabled)return;
    if(voice.state==='recording')voice.stop();else voice.start('teacher-chart');
  });
  cancelButton.addEventListener('click',()=>voice.cancel());
  el('teacherChartFullscreen').addEventListener('click',async()=>{
    try {
      if(root.fullscreenElement===result)await root.exitFullscreen();
      else if(result.requestFullscreen)await result.requestFullscreen();
      else {error='此浏览器暂不支持全屏展示。';render();}
    } catch {error='无法进入全屏，请在当前窗口查看。';render();}
  });
  root.addEventListener?.('fullscreenchange',()=>{el('teacherChartFullscreen').textContent=root.fullscreenElement===result?'退出全屏':'全屏展示';});
  el('teacherChartForm').addEventListener('submit',async event=>{
    event.preventDefault();refresh();
    if(submit.disabled)return;
    const instruction=input.value.trim();
    if(!instruction||instruction.length>2000){error=instruction?'指令请控制在 2000 字以内。':'请先输入要求，或使用语音输入。';render();input.focus();return;}
    const submittedContext=context, request=++generation, controller=new AbortController();
    if(!attempt||attempt.instruction!==instruction)attempt={instruction,request_id:makeId()};
    pending=controller;voiceLabel='';error='';render();
    const timer=clock.setTimeout(()=>controller.abort(),105000);
    try {
      const data=await analyze({...attempt},controller.signal);
      if(request!==generation||submittedContext!==getContext()||!canEdit())return;
      body.innerHTML=teacherResultHTML(data);ready=true;attempt=null;
    } catch(e) {
      if(request!==generation||submittedContext!==getContext())return;
      error=(controller.signal.aborted?'汇总等待超时，请重试。':e.message||'汇总失败，请重试。')+(ready?' 下方保留上次汇总。':'');
    } finally {
      clock.clearTimeout(timer);
      if(request===generation){pending=null;render();}
    }
  });
  refresh();
  return {refresh,reset,cancel,cancelVoice:()=>voice.cancel()};
}

if(typeof module!=='undefined')module.exports={createTeacherChart,teacherResultHTML,teacherBarChart};
