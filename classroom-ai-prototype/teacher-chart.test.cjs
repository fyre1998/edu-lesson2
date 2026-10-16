const {test}=require('node:test');
const assert=require('node:assert/strict');
const {createTeacherChart,teacherResultHTML}=require('./teacher-chart.js');
const {createVoiceInput}=require('./voice.js');
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const result=(changes={})=>({presentation:'bar',title:'各组百粒质量',message:'按处理汇总。',observations:[],
  unit:'g',metric_label:'百粒质量',rows:[{label:'蒸馏水',value:170,uncertainty:5.7},{label:'GA₃',value:225,uncertainty:2.8}],unavailable:[],...changes});

function setup({permissionError=null}={}) {
  const elements=new Map(), timers=new Map(), calls=[], analyses=[];
  let id=0, context='teacher:lesson:1', editable=true, stopped=0;
  const el=name=>{
    if(!elements.has(name)){
      const classes=new Set();
      elements.set(name,{value:'',textContent:'',innerHTML:'',disabled:false,readOnly:false,listeners:{},
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
    root:{querySelector:selector=>el(selector.slice(1))}, makeId:()=>`request-${++id}`,
    clock:{setTimeout(fn){timers.set(++id,fn);return id;},clearTimeout:id=>timers.delete(id)},
    createVoice:options=>createVoiceInput({...options,Recorder,Audio:null,
      mediaDevices:{getUserMedia:async()=>{if(permissionError)throw permissionError;return {getTracks:()=>[{stop(){stopped++;}}]};}},
      clock:{setInterval:()=>1,clearInterval(){}}}),
    transcribe:(blob,context,signal)=>new Promise((resolve,reject)=>calls.push({resolve,reject,signal})),
    analyze:(body,signal)=>new Promise((resolve,reject)=>{
      analyses.push({body,signal,resolve,reject});signal.addEventListener('abort',()=>reject(new Error('aborted')));
    })
  });
  return {el,widget,calls,timers,analyses,click:name=>el(name).listeners.click(),
    submit:()=>el('teacherChartForm').listeners.submit({preventDefault(){}}),get stopped(){return stopped;},
    context(value){context=value;widget.refresh();},archive(){editable=false;widget.refresh();}};
}

test('文字交给AI，等待真实返回后绘图，轮询与重复点击不重复请求',async()=>{
  const a=setup();a.el('teacherChartInput').value='汇总各组数据并绘制柱状图';const promise=a.submit();
  assert.equal(a.analyses.length,1);assert.equal(a.el('teacherChartSubmit').disabled,true);
  assert.equal(a.el('teacherChartResult').classList.contains('hidden'),true);
  a.widget.refresh();await a.submit();assert.equal(a.analyses.length,1);
  assert.equal(a.analyses[0].body.instruction,'汇总各组数据并绘制柱状图');
  a.analyses[0].resolve(result());await promise;
  assert.equal(a.el('teacherChartResult').classList.contains('hidden'),false);
  assert.match(a.el('teacherChartResultBody').innerHTML,/<svg/);assert.match(a.el('teacherChartResultBody').innerHTML,/225/);
  assert.equal(a.el('teacherChartSubmit').disabled,false);assert.equal(a.timers.size,0);
  a.widget.refresh();assert.match(a.el('teacherChartResultBody').innerHTML,/<svg/);
});

test('空白与过长指令不请求，切换环节、课次、退出或归档中止汇总并忽略迟到结果',async()=>{
  for(const text of [' \n ','长'.repeat(2001)]) {
    const a=setup();a.el('teacherChartInput').value=text;await a.submit();assert.equal(a.analyses.length,0);
  }
  for(const change of [a=>a.context(''),a=>a.context('teacher:other:1'),a=>a.context('teacher:lesson:2'),a=>a.archive(),a=>a.widget.reset()]){
    const a=setup();a.el('teacherChartInput').value='生成图表';const pending=a.submit();change(a);
    assert.equal(a.analyses[0].signal.aborted,true);a.analyses[0].resolve(result());await pending;
    assert.equal(a.el('teacherChartResult').classList.contains('hidden'),true);assert.equal(a.timers.size,0);
  }
});

test('语音识别填入，执行指令后才汇总；取消转写不填入迟到文字',async()=>{
  const a=setup();a.el('teacherChartInput').value='请';a.click('teacherChartMic');await tick();
  assert.equal(a.el('teacherChartMic').textContent,'停止并填入');assert.equal(a.el('teacherChartSubmit').disabled,true);
  a.click('teacherChartMic');await tick();assert.equal(a.calls.length,1);assert.equal(a.stopped,1);
  a.calls[0].resolve('比较百粒质量');await tick();
  assert.equal(a.el('teacherChartInput').value,'请\n比较百粒质量');assert.equal(a.analyses.length,0);
  const request=a.submit();a.analyses[0].resolve(result());await request;
  for(const cancel of [a=>a.click('teacherChartVoiceCancel'),a=>a.context('')]){
    const b=setup();b.click('teacherChartMic');await tick();b.click('teacherChartMic');await tick();
    cancel(b);assert.equal(b.calls[0].signal.aborted,true);b.calls[0].resolve('迟到文字');await tick();
    assert.equal(b.el('teacherChartInput').value,'');assert.equal(b.analyses.length,0);
  }
});

test('网络失败保留指令与上次结果，重试沿用请求编号，成功后重新汇总使用新编号',async()=>{
  const a=setup();a.el('teacherChartInput').value='比较结果';let pending=a.submit();
  a.analyses[0].resolve(result());await pending;
  pending=a.submit();a.analyses[1].reject(new Error('连接失败'));await pending;
  assert.match(a.el('teacherChartStatus').textContent,/连接失败.*保留/);
  assert.match(a.el('teacherChartResultBody').innerHTML,/<svg/);assert.equal(a.el('teacherChartInput').value,'比较结果');
  pending=a.submit();assert.equal(a.analyses[2].body.request_id,a.analyses[1].body.request_id);
  assert.notEqual(a.analyses[2].body.request_id,a.analyses[0].body.request_id);
  a.analyses[2].resolve(result({presentation:'summary',message:'各组已经提出处理方案。'}));await pending;
  assert.doesNotMatch(a.el('teacherChartResultBody').innerHTML,/<svg|<table/);
});

test('超时与麦克风拒绝后恢复输入',async()=>{
  const a=setup();a.el('teacherChartInput').value='汇总';const pending=a.submit();
  [...a.timers.values()][0]();await pending;
  assert.match(a.el('teacherChartStatus').textContent,/超时/);assert.equal(a.el('teacherChartSubmit').disabled,false);
  const error=new Error('denied');error.name='NotAllowedError';
  const denied=setup({permissionError:error});denied.click('teacherChartMic');await tick();
  assert.match(denied.el('teacherChartStatus').textContent,/权限.*打字/);assert.equal(denied.el('teacherChartInput').readOnly,false);
});

test('渲染表格、澄清与空数据，保留零分，转义AI文本，不输出数据来源',()=>{
  const html=teacherResultHTML(result({presentation:'table',title:'<script>alert(1)</script>',
    rows:[{label:'<img src=x onerror=alert(1)>',value:0}],unit:'分',metric_label:'总分'}));
  assert.match(html,/<table/);assert.match(html,/<td>0<\/td>/);assert.doesNotMatch(html,/<svg|<script|<img|数据来源|版本/);
  assert.match(html,/&lt;script&gt;/);
  assert.doesNotMatch(teacherResultHTML(result({presentation:'clarify',rows:[]})),/<svg|<table/);
  assert.match(teacherResultHTML(result({rows:[],unavailable:[{group_id:2,status:'unsubmitted'}]})),/尚未提交/);
});
