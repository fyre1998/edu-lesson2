const {test}=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const fs=require('node:fs');
const path=require('node:path');
const {createVoiceInput}=require('./voice.js');
const source=fs.readFileSync(path.join(__dirname,'lesson.js'),'utf8');
const tick=()=>new Promise(resolve=>setImmediate(resolve));

function setup({delayPermission=false,permissionError=null}={}){
  const elements=new Map(),calls=[],intervals=new Map();let intervalId=0,stopped=0,grant;
  const el=selector=>{
    if(!elements.has(selector)){
      const classes=new Set();
      elements.set(selector,{value:'',textContent:'',innerHTML:'',disabled:false,dataset:{},listeners:{},
        classList:{toggle(name,on){if(on)classes.add(name);else classes.delete(name);},contains:name=>classes.has(name),add:name=>classes.add(name),remove:name=>classes.delete(name)},
        addEventListener(name,handler){this.listeners[name]=handler;},dispatchEvent(event){this.listeners[event.type]?.(event);},
        setAttribute(){},insertAdjacentHTML(){},closest(query){return query==='[data-voice-field]'&&this.dataset.voiceField||query==='[data-voice-cancel]'&&this.dataset.voiceCancel?this:null;}});
    }
    return elements.get(selector);
  };
  const fields=['design','prediction'].map(key=>Object.assign(el('#field-'+key),{dataset:{field:key},value:'原有草稿'}));
  const buttons=fields.map(field=>Object.assign(el('mic-'+field.dataset.field),{dataset:{voiceField:field.dataset.field}}));
  fields.forEach(field=>el('#voice-cancel-'+field.dataset.field).dataset.voiceCancel=field.dataset.field);
  const stream={getTracks:()=>[{stop(){stopped++;}}]};
  class Recorder{
    static isTypeSupported(){return true;}
    start(){this.state='recording';}
    stop(){this.state='inactive';this.ondataavailable?.({data:new Blob(['sound'.repeat(30)])});this.onstop?.();}
  }
  const context=vm.createContext({document:{querySelector:el,querySelectorAll:selector=>selector==='[data-field]'?fields:selector==='[data-voice-field]'?buttons:[]},
    FormData,Blob,Event,crypto:require('node:crypto').webcrypto,setTimeout(){},clearTimeout(){},
    createVoiceInput:options=>createVoiceInput({...options,Recorder,Audio:null,
      mediaDevices:{getUserMedia:()=>permissionError?Promise.reject(permissionError):delayPermission?new Promise(resolve=>grant=resolve):Promise.resolve(stream)},
      clock:{setInterval(fn){intervals.set(++intervalId,fn);return intervalId;},clearInterval:id=>intervals.delete(id)}}),
    fetch:(url,options)=>new Promise(resolve=>calls.push({url,signal:options.signal,reply:data=>resolve({ok:true,json:async()=>data})}))});
  const run=code=>vm.runInContext(code,context);
  run(fs.readFileSync(path.join(__dirname,'lesson-widgets.js'),'utf8'));
  run(source.slice(0,source.indexOf('\nconst camera=')));
  run("Object.assign(S,{user:{role:'student',groupId:1},lesson:{id:'lesson',status:'live',flow_version:3},stage:1,content:{content:{fields:[]}},work:{work:{revision:0,file_ids:[],fields:{}},files:[],versions:[],assignment:null}});renderScores=()=>{};");
  run(source.slice(source.indexOf('const voiceContext='),source.indexOf("$('#chatUpload').addEventListener")));
  let inputs=0;fields.forEach(field=>field.addEventListener('input',()=>inputs++));
  const click=element=>el('#workFields').listeners.click({target:element});
  return {el,buttons,fields,calls,run,click,grant:()=>grant(stream),get stopped(){return stopped;},get inputs(){return inputs;},intervals};
}

test('成果语音在原字段停止并填入，自动刷新不移走控件，也不发送聊天或成果',async()=>{
  const a=setup();
  a.click(a.buttons[0]);await tick();
  assert.equal(a.buttons[0].textContent,'停止并填入');assert.equal(a.buttons[0].disabled,false);
  assert.equal(a.buttons[1].disabled,true);assert.match(a.el('#voice-status-design').textContent,/录音中/);
  assert.equal(a.el('#voice-cancel-design').classList.contains('hidden'),false);
  assert.equal(a.el('#voiceStop').classList.contains('hidden'),true);
  assert.equal(a.el('#voiceCancel').classList.contains('hidden'),true);assert.equal(a.el('#voiceStatus').textContent,'');
  a.run('renderExtras();renderChat()');
  assert.equal(a.buttons[0].disabled,false);assert.equal(a.buttons[1].disabled,true);
  a.click(a.buttons[0]);a.click(a.buttons[0]);await tick();
  assert.equal(a.calls.length,1);assert.match(a.calls[0].url,/\/transcriptions$/);
  assert.equal(a.buttons[0].textContent,'正在转写…');assert.equal(a.buttons[0].disabled,true);
  assert.equal(a.el('#voice-cancel-design').classList.contains('hidden'),false);
  assert.match(a.el('#voice-status-design').textContent,/正在转成文字/);assert.equal(a.el('#voiceStatus').textContent,'');
  a.calls[0].reply({text:'比较两侧生长情况'});await tick();
  assert.equal(a.fields[0].value,'原有草稿\n比较两侧生长情况');assert.equal(a.fields[1].value,'原有草稿');
  assert.equal(a.inputs,1);assert.equal(a.calls.length,1);assert.equal(a.stopped,1);
  assert.equal(a.buttons[0].textContent,'语音填写');assert.equal(a.buttons[1].disabled,false);
  assert.equal(a.el('#voice-cancel-design').classList.contains('hidden'),true);
});

for(const phase of ['requesting','recording','transcribing'])test(`成果语音可以在原字段取消 ${phase}，不填入迟到文字`,async()=>{
  const a=setup({delayPermission:phase==='requesting'});
  a.click(a.buttons[0]);await tick();
  if(phase==='transcribing'){a.click(a.buttons[0]);await tick();}
  assert.equal(a.el('#voice-cancel-design').classList.contains('hidden'),false);
  a.click(a.el('#voice-cancel-design'));
  if(phase==='requesting')a.grant();
  if(phase==='transcribing'){assert.equal(a.calls[0].signal.aborted,true);a.calls[0].reply({text:'应被丢弃'});}
  await tick();
  assert.equal(a.run('lessonVoice.state'),'idle');assert.equal(a.fields[0].value,'原有草稿');
  assert.equal(a.inputs,0);assert.equal(a.stopped,1);assert.equal(a.intervals.size,0);
  assert.equal(a.buttons[0].textContent,'语音填写');assert.equal(a.buttons[1].disabled,false);
});

test('AI 对话录音仍只在对话栏停止，字段控件不会接管或取消它',async()=>{
  const a=setup();a.el('#voiceStart').listeners.click();await tick();
  assert.equal(a.el('#voiceStop').classList.contains('hidden'),false);
  assert.equal(a.el('#voiceCancel').classList.contains('hidden'),false);assert.match(a.el('#voiceStatus').textContent,/录音中/);
  for(const button of a.buttons){assert.equal(button.textContent,'语音填写');assert.equal(button.disabled,true);}
  assert.equal(a.el('#voice-cancel-design').classList.contains('hidden'),true);assert.equal(a.el('#voice-status-design').textContent,'');
  a.click(a.el('#voice-cancel-design'));assert.equal(a.run('lessonVoice.state'),'recording');
  a.el('#voiceStop').listeners.click();await tick();assert.equal(a.calls.length,1);
  a.el('#voiceCancel').listeners.click();assert.equal(a.calls[0].signal.aborted,true);
  a.calls[0].reply({text:'已取消的对话'});await tick();assert.equal(a.calls.length,1);
});

test('麦克风错误在对应成果字段提示，恢复后保留已锁定字段的禁用状态',async()=>{
  const error=new Error('denied');error.name='NotAllowedError';
  const a=setup({permissionError:error});a.fields[1].disabled=true;a.click(a.buttons[0]);await tick();
  assert.match(a.el('#voice-status-design').textContent,/麦克风权限未开启/);assert.equal(a.el('#voiceStatus').textContent,'');
  assert.equal(a.buttons[0].disabled,false);assert.equal(a.buttons[1].disabled,true);
  a.run("S.lesson.status='archived';renderExtras();renderChat()");assert.equal(a.buttons[0].disabled,true);
});

test('每个成果文本框包含自己的取消按钮与状态提示',()=>{
  const a=setup();
  const html=a.run("fieldHTML({key:'design',label:'实验设计',placeholder:'记录方案'})");
  assert.match(html,/data-voice-field="design"/);assert.match(html,/data-voice-cancel="design"/);
  assert.match(html,/id="voice-status-design"[^>]*role="status"/);
});
