'use strict';

function createTeacherChart({getContext,canEdit,transcribe,root=document,clock=globalThis,createVoice=createVoiceInput}) {
  const el=id=>root.querySelector('#'+id);
  const panel=el('teacherChart'), input=el('teacherChartInput'), mic=el('teacherChartMic');
  const cancelButton=el('teacherChartVoiceCancel'), submit=el('teacherChartSubmit');
  const status=el('teacherChartStatus'), result=el('teacherChartResult');
  let context='', timer=null, generation=0, ready=false, voiceLabel='', voiceError='', voice;

  function render() {
    const visible=!!getContext(), editable=visible&&canEdit();
    const state=voice?.state||'idle', active=state!=='idle', waiting=timer!==null;
    panel.classList.toggle('hidden',!visible);
    panel.setAttribute('aria-busy',String(waiting));
    input.readOnly=active||waiting||!editable;
    mic.disabled=waiting||!editable||(active&&state!=='recording');
    mic.textContent=state==='recording'?'停止并填入':active?'正在处理语音…':'语音输入';
    mic.classList.toggle('is-recording',state==='recording');
    mic.setAttribute('aria-pressed',String(state==='recording'));
    cancelButton.classList.toggle('hidden',!active);
    submit.disabled=waiting||active||!editable;
    submit.textContent=waiting?'正在生成…':'提交';
    status.textContent=waiting?'正在整理实验数据，约 5–6 秒后显示柱状图…':voiceError||voiceLabel||(ready?'柱状图已生成，点击图片可查看大图。':'');
    status.classList.toggle('is-loading',waiting);
    result.classList.toggle('hidden',!ready);
  }

  function cancel() {
    generation++;
    if(timer!==null)clock.clearTimeout(timer);
    timer=null;
    voice?.cancel();
    voiceLabel='';voiceError='';
    render();
  }

  function reset() {
    ready=false;
    input.value='';
    cancel();
  }

  function refresh() {
    const next=getContext();
    if(next!==context){context=next;reset();}
    if(!canEdit()&&(timer!==null||voice?.state!=='idle'))cancel();
    render();
  }

  voice=createVoice({getContext,transcribe,
    onText:(text,target,recordedContext)=>{
      if(recordedContext!==getContext()||!canEdit())return;
      input.value=[input.value.trim(),text].filter(Boolean).join('\n');
    },
    onState:(state,label)=>{if(state==='requesting')voiceError='';voiceLabel=label;render();},
    onError:message=>{voiceError=message+' 可继续打字输入。';render();}
  });

  mic.addEventListener('click',()=>{
    if(mic.disabled)return;
    if(voice.state==='recording')voice.stop();
    else voice.start('teacher-chart');
  });
  cancelButton.addEventListener('click',()=>voice.cancel());
  el('teacherChartForm').addEventListener('submit',event=>{
    event.preventDefault();
    refresh();
    if(submit.disabled)return;
    if(!input.value.trim()){
      voiceLabel='请先输入文字，或使用语音输入。';render();input.focus();return;
    }
    const submittedContext=context, request=++generation;
    ready=false;voiceLabel='';voiceError='';
    // This classroom demonstration always returns the teacher-provided image.
    timer=clock.setTimeout(()=>{
      if(request!==generation)return;
      timer=null;
      if(submittedContext===getContext()&&canEdit())ready=true;
      render();
    },5500);
    render();
  });
  refresh();
  return {refresh,reset,cancel,cancelVoice:()=>voice.cancel()};
}

if(typeof module!=='undefined')module.exports={createTeacherChart};
