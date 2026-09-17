const {test}=require('node:test');
const assert=require('node:assert/strict');
const {createVoiceInput}=require('./voice.js');
const tick=()=>new Promise(resolve=>setImmediate(resolve));
function setup(extra={}) {
  const events=[],errors=[],texts=[],intervals=new Map();let stopped=0,id=0,context='lesson:1',instance;
  class Recorder {
    static isTypeSupported(){return true;}
    constructor(){instance=this;this.state='inactive';}
    start(){this.state='recording';}
    stop(){this.state='inactive';this.ondataavailable?.({data:new Blob(['sound'.repeat(30)])});this.onstop?.();}
  }
  const stream={getTracks:()=>[{stop(){stopped++;}}]};
  const options={transcribe:async()=> '胚芽鞘、琼脂',onText:async(...args)=>texts.push(args),onState:(...args)=>events.push(args),onError:e=>errors.push(e),
    getContext:()=>context,mediaDevices:{getUserMedia:async()=>stream},Recorder,Audio:null,
    clock:{setInterval(fn,ms){intervals.set(++id,{fn,ms});return id;},clearInterval(id){intervals.delete(id);}},...extra};
  const voice=createVoiceInput(options);
  return {voice,events,errors,texts,intervals,stream,get stopped(){return stopped;},get recorder(){return instance;},change(){context='lesson:2';}};
}
test('停止后只转写和发送一次，完整释放麦克风',async()=>{
  let calls=0;const s=setup({transcribe:async()=>{calls++;return '拜尔与温特';}});
  await s.voice.start();await s.voice.start();s.voice.stop();s.voice.stop();await tick();
  assert.equal(calls,1);assert.deepEqual(s.texts,[['拜尔与温特','chat','lesson:1']]);assert.equal(s.stopped,1);assert.equal(s.intervals.size,0);assert.equal(s.voice.state,'idle');
});
test('成果语音只把识别文字交给目标字段',async()=>{
  const s=setup();await s.voice.start('prediction');s.voice.stop();await tick();
  assert.equal(s.texts[0][1],'prediction');assert.equal(s.texts.length,1);
});
test('取消申请权限后到达的媒体流立即释放',async()=>{
  let grant;const s=setup({mediaDevices:{getUserMedia:()=>new Promise(r=>grant=r)}});
  const pending=s.voice.start();s.voice.cancel();grant(s.stream);await pending;
  assert.equal(s.stopped,1);assert.equal(s.voice.state,'idle');assert.equal(s.texts.length,0);
});
test('转写中取消会中止请求，丢弃迟到文字',async()=>{
  let finish,signal;const s=setup({transcribe:(_,__,sig)=>{signal=sig;return new Promise(r=>finish=r);}});
  await s.voice.start();s.voice.stop();s.voice.cancel();finish('不得发送');await tick();
  assert.equal(signal.aborted,true);assert.equal(s.texts.length,0);assert.equal(s.voice.state,'idle');
});
test('上下文改变后迟到文字不能跨课次发送',async()=>{
  let finish;const s=setup({transcribe:()=>new Promise(r=>finish=r)});
  await s.voice.start();s.voice.stop();s.change();finish('不得串入另一环节');await tick();assert.equal(s.texts.length,0);
});
test('录音中取消不调用转写',async()=>{
  let calls=0;const s=setup({transcribe:async()=>{calls++;return '无效';}});
  await s.voice.start();s.voice.cancel();await tick();assert.equal(calls,0);assert.equal(s.stopped,1);
});
test('90 秒自动停止并转写一次',async()=>{
  const realNow=Date.now;let now=1000;Date.now=()=>now;
  try {const s=setup();await s.voice.start();now+=90000;[...s.intervals.values()].find(i=>i.ms===250).fn();await tick();assert.equal(s.texts.length,1);assert.equal(s.voice.state,'idle');}
  finally {Date.now=realNow;}
});
test('权限拒绝、无麦克风、无浏览器支持分别提示且不发送',async()=>{
  for(const [name,match] of [['NotAllowedError',/权限/],['NotFoundError',/没有找到麦克风/]]) {
    const s=setup({mediaDevices:{getUserMedia:async()=>{const e=new Error();e.name=name;throw e;}}});await s.voice.start();assert.match(s.errors[0],match);assert.equal(s.texts.length,0);
  }
  const s=setup({mediaDevices:null});await s.voice.start();assert.match(s.errors[0],/HTTPS/);assert.equal(s.voice.state,'idle');
});
test('静音不送往转写服务',async()=>{
  class SilentAudio {createAnalyser(){return {fftSize:32,getByteTimeDomainData:b=>b.fill(128)};}createMediaStreamSource(){return {connect(){}};}async close(){}}
  const s=setup({Audio:SilentAudio});await s.voice.start();[...s.intervals.values()].find(i=>i.ms===100).fn();s.voice.stop();await tick();assert.equal(s.texts.length,0);assert.match(s.errors[0],/没有检测到清晰声音/);
});
test('转写空白、超时或断网不发送，恢复可重新录音',async()=>{
  for(const transcribe of [async()=>'',async()=>{throw new Error('连接超时');}]) {
    const s=setup({transcribe});await s.voice.start();s.voice.stop();await tick();assert.equal(s.texts.length,0);assert.equal(s.errors.length,1);assert.equal(s.voice.state,'idle');await s.voice.start();assert.equal(s.voice.state,'recording');s.voice.cancel();
  }
});
test('发送失败仍向聊天流程交付文字并显示错误',async()=>{
  let text;const s=setup({onText:async t=>{text=t;throw new Error('发送失败，草稿保留');}});await s.voice.start();s.voice.stop();await tick();assert.equal(text,'胚芽鞘、琼脂');assert.match(s.errors[0],/草稿保留/);
});
