const {test}=require('node:test');
const assert=require('node:assert/strict');
const {createTeacherChart}=require('./teacher-chart.js');
const {createVoiceInput}=require('./voice.js');
const tick=()=>new Promise(resolve=>setImmediate(resolve));

function setup({permissionError=null}={}) {
  const elements=new Map(), timers=new Map(), calls=[];
  let now=0, id=0, context='teacher:lesson:1', editable=true, stopped=0;
  const el=name=>{
    if(!elements.has(name)){
      const classes=new Set();
      elements.set(name,{value:'',textContent:'',disabled:false,readOnly:false,listeners:{},
        addEventListener(type,fn){this.listeners[type]=fn;},setAttribute(){},focus(){},
        classList:{toggle(name,on){if(on)classes.add(name);else classes.delete(name);},contains:name=>classes.has(name)}});
    }
    return elements.get(name);
  };
  class Recorder {
    static isTypeSupported(){return true;}
    start(){this.state='recording';}
    stop(){this.state='inactive';this.ondataavailable?.({data:new Blob(['audio'.repeat(50)])});this.onstop?.();}
  }
  const widget=createTeacherChart({getContext:()=>context,canEdit:()=>editable,
    root:{querySelector:selector=>el(selector.slice(1))},
    clock:{setTimeout(fn,ms){timers.set(++id,{fn,at:now+ms});return id;},clearTimeout:id=>timers.delete(id)},
    createVoice:options=>createVoiceInput({...options,Recorder,Audio:null,
      mediaDevices:{getUserMedia:async()=>{if(permissionError)throw permissionError;return {getTracks:()=>[{stop(){stopped++;}}]};}},
      clock:{setInterval:()=>1,clearInterval(){}}}),
    transcribe:(blob,context,signal)=>new Promise((resolve,reject)=>calls.push({resolve,reject,signal}))
  });
  const click=name=>el(name).listeners.click();
  const submit=()=>el('teacherChartForm').listeners.submit({preventDefault(){}});
  const advance=ms=>{now+=ms;for(const [key,t] of timers){if(t.at<=now){timers.delete(key);t.fn();}}};
  return {el,widget,calls,timers,click,submit,advance,get stopped(){return stopped;},
    context(value){context=value;widget.refresh();},archive(){editable=false;widget.refresh();}};
}

test('任意非空输入只在 5.5 秒后显示同一结果，轮询和重复点击不重置等待',()=>{
  for(const input of ['请生成柱状图','任意无关文字','<script>alert(1)</script>']){
    const a=setup();a.el('teacherChartInput').value=input;a.submit();
    assert.equal(a.el('teacherChartResult').classList.contains('hidden'),true);
    assert.equal(a.el('teacherChartSubmit').disabled,true);
    a.advance(5000);a.widget.refresh();a.submit();
    assert.equal(a.timers.size,1);
    assert.equal(a.el('teacherChartInput').value,input);
    a.advance(499);assert.equal(a.el('teacherChartResult').classList.contains('hidden'),true);
    a.advance(1);assert.equal(a.el('teacherChartResult').classList.contains('hidden'),false);
    assert.equal(a.el('teacherChartSubmit').disabled,false);assert.equal(a.calls.length,0);
    a.widget.refresh();assert.equal(a.el('teacherChartResult').classList.contains('hidden'),false);
    a.submit();assert.equal(a.el('teacherChartResult').classList.contains('hidden'),true);
    a.advance(5500);assert.equal(a.el('teacherChartResult').classList.contains('hidden'),false);
  }
});

test('空白输入不开始等待；切换环节、课次或归档取消待返回图片',()=>{
  const blank=setup();blank.el('teacherChartInput').value=' \n ';blank.submit();assert.equal(blank.timers.size,0);
  for(const change of [a=>a.context(''),a=>a.context('teacher:other:1'),a=>a.archive(),a=>a.widget.reset()]){
    const a=setup();a.el('teacherChartInput').value='生成图表';a.submit();change(a);a.advance(6000);
    assert.equal(a.timers.size,0);assert.equal(a.el('teacherChartResult').classList.contains('hidden'),true);
  }
});

test('语音填入教师输入框供检查，手动提交后才开始 5.5 秒等待',async()=>{
  const a=setup();a.el('teacherChartInput').value='原有文字';a.click('teacherChartMic');await tick();
  assert.equal(a.el('teacherChartMic').textContent,'停止并填入');assert.equal(a.el('teacherChartSubmit').disabled,true);
  a.click('teacherChartMic');await tick();assert.equal(a.calls.length,1);assert.equal(a.stopped,1);
  a.calls[0].resolve('比较葡萄百粒质量');await tick();
  assert.equal(a.el('teacherChartInput').value,'原有文字\n比较葡萄百粒质量');
  assert.equal(a.timers.size,0);assert.equal(a.el('teacherChartSubmit').disabled,false);
  a.submit();a.advance(5500);assert.equal(a.el('teacherChartResult').classList.contains('hidden'),false);
});

test('取消和切换环节中止转写，不把迟到文字填到新上下文',async()=>{
  for(const cancel of [a=>a.click('teacherChartVoiceCancel'),a=>a.context('')]){
    const a=setup();a.click('teacherChartMic');await tick();a.click('teacherChartMic');await tick();
    cancel(a);assert.equal(a.calls[0].signal.aborted,true);a.calls[0].resolve('迟到文字');await tick();
    assert.equal(a.el('teacherChartInput').value,'');assert.equal(a.timers.size,0);
  }
});

test('权限或转写失败保留提示并恢复打字提交',async()=>{
  const error=new Error('denied');error.name='NotAllowedError';
  const denied=setup({permissionError:error});denied.click('teacherChartMic');await tick();
  assert.match(denied.el('teacherChartStatus').textContent,/权限.*打字/);
  const failed=setup();failed.click('teacherChartMic');await tick();failed.click('teacherChartMic');await tick();
  failed.calls[0].reject(new Error('转写连接失败'));await tick();
  assert.match(failed.el('teacherChartStatus').textContent,/转写连接失败.*打字/);
  for(const a of [denied,failed]){
    assert.equal(a.el('teacherChartInput').readOnly,false);a.el('teacherChartInput').value='直接打字';
    a.submit();a.advance(5500);assert.equal(a.el('teacherChartResult').classList.contains('hidden'),false);
  }
});
