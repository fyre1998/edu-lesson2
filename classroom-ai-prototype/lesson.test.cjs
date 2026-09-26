const {test}=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const fs=require('node:fs');
const source=fs.readFileSync(require('node:path').join(__dirname,'lesson.js'),'utf8');

function setup(scriptURL){
  const elements=new Map(), local=new Map(), calls=[], timers=new Map();let timerId=0,cameraOptions;
  const el=s=>{if(!elements.has(s))elements.set(s,{value:'',disabled:false,innerHTML:'',textContent:'',dataset:{},listeners:{},addEventListener(name,handler){this.listeners[name]=handler;},requestSubmit(){this.listeners.submit({preventDefault(){}});},classList:{add(){},remove(){},toggle(){}},insertAdjacentHTML(){},replaceChildren(){},setAttribute(){},close(){this.open=false;},showModal(){this.open=true;}});return elements.get(s);};
  const fields=[{value:'观察',dataset:{field:'observation'}},{value:'假说',dataset:{field:'hypothesis'}}];
  const context=vm.createContext({document:{querySelector:el,querySelectorAll:s=>s==='[data-field]'?fields:[]},
    FormData,Blob,setTimeout:(fn,ms)=>{timers.set(++timerId,{fn,ms});return timerId;},clearTimeout:id=>timers.delete(id),crypto:require('node:crypto').webcrypto,
    createCameraCapture:options=>{cameraOptions=options;return {open(){},close(){}};},
    sessionStorage:{setItem:(k,v)=>local.set(k,v),removeItem:k=>local.delete(k),getItem:k=>local.get(k)},
    fetch:(url,options)=>new Promise(resolve=>calls.push({url,body:options.body instanceof FormData?options.body:options.body?JSON.parse(options.body):null,reply:(data,status=200)=>resolve({ok:status<400,status,json:async()=>data})}))});
  if(scriptURL){
    context.URL=URL;context.document.currentScript={src:scriptURL};
    vm.runInContext(fs.readFileSync(require('node:path').join(__dirname,'paths.js'),'utf8'),context);
  }
  vm.runInContext(fs.readFileSync(require('node:path').join(__dirname,'score-bubble.js'),'utf8'),context);
  vm.runInContext(fs.readFileSync(require('node:path').join(__dirname,'lesson-widgets.js'),'utf8'),context);
  vm.runInContext(source.slice(0,source.indexOf('\nconst camera=')),context);
  vm.runInContext(source.slice(source.indexOf('const camera='),source.indexOf("\n$('#loginGroup')")),context);
  vm.runInContext(source.slice(source.indexOf("$('#chatForm').addEventListener"),source.indexOf("$('#quickPrompts').addEventListener")),context);
  vm.runInContext("Object.assign(S,{user:{role:'student',groupId:1},lesson:{id:'lesson',status:'live'},stage:1,content:{content:{fields:[]}},work:{work:{revision:0,file_ids:[],fields:{}},files:[],versions:[],assignment:null},edit:1,savedEdit:0});",context);
  return{calls,fields,local,el,timers,camera:cameraOptions,run:code=>vm.runInContext(code,context)};
}
const tick=()=>new Promise(resolve=>setImmediate(resolve));

test('subpath classroom sends API requests and renders attachments inside lesson 2',async()=>{
  const a=setup('https://lsclass.top/lesson/paths.js');
  const pending=a.run("api('/me')");
  assert.equal(a.calls[0].url,'/lesson/api/classroom/me');
  a.calls[0].reply({role:'student'});await pending;
  const html=a.run("fileHTML({id:'picture',name:'图片',preview:true,size:12,uploader:'本组'},false)");
  assert.match(html,/href="\/lesson\/api\/classroom\/files\/picture/);
  assert.match(html,/src="\/lesson\/api\/classroom\/files\/picture\?preview=true"/);
  assert.doesNotMatch(html,/(href|src)="\/api\//);
  assert.match(a.run('draftKey()'),/^lesson2:/);
});

function photoSetup(stage=1){
  const a=setup();a.run(`S.lesson.flow_version=3;S.stage=${stage};S.edit=S.savedEdit=0`);
  return a;
}
const photo=()=>new File(['photo bytes'],'实验照片.jpg',{type:'image/jpeg'});
const storedPhoto={id:'photo-1',name:'实验照片.jpg',size:11,preview:true,uploader:'第 1 组'};
function photoWork(){
  return {work:{revision:1,updated:10,fields:{},file_ids:['photo-1']},files:[storedPhoto],versions:[{id:'v1',revision:1,fields:{},file_ids:['photo-1'],updated:10}],assignment:null};
}

for(const stage of [1,2])test(`camera confirmation automatically submits the photo in stage ${stage} exactly once`,async()=>{
  const a=photoSetup(stage),file=photo();
  const pending=a.camera.onConfirm(file);
  assert.equal(a.calls.length,1);assert.ok(a.calls[0].body instanceof FormData);
  assert.equal(a.calls[0].body.get('file').name,'实验照片.jpg');
  await a.camera.onConfirm(file);assert.equal(a.calls.length,1);
  a.calls[0].reply(storedPhoto,201);await tick();
  assert.equal(a.calls.length,2);assert.match(a.calls[1].url,new RegExp(`/stages/${stage}/submissions$`));
  assert.deepEqual([...a.calls[1].body.file_ids],['photo-1']);assert.ok(a.calls[1].body.request_id);
  assert.equal(a.calls.filter(c=>c.url.endsWith('/chats')||c.url.endsWith('/work')).length,0);
  a.calls[1].reply({revision:1,updated:10,submission_id:'v1'},201);await tick();
  a.calls[2].reply(photoWork());assert.equal(await pending,true);
  assert.match(a.el('#toast').textContent,/照片已自动提交给 AI/);
  assert.equal(a.run('S.uploading'),false);assert.equal(a.run('S.submitting'),false);
  assert.equal(Boolean(a.el('#chatCamera').disabled),false);
});

test('failed automatic submission keeps the uploaded photo and reuses its request ID on retry',async()=>{
  const a=photoSetup(),pending=a.camera.onConfirm(photo());
  a.calls[0].reply(storedPhoto,201);await tick();const request=a.calls[1].body.request_id;
  a.calls[1].reply({detail:'网络暂时不可用'},503);
  assert.equal(await pending,true);assert.match(a.el('#toast').textContent,/无需重拍或再次上传/);
  assert.deepEqual([...a.run('S.work.work.file_ids')],['photo-1']);
  const retry=a.run('saveWork(true)');await tick();
  assert.equal(a.calls[2].body.request_id,request);assert.deepEqual([...a.calls[2].body.file_ids],['photo-1']);
  a.calls[2].reply({revision:1,updated:10,submission_id:'v1'},201);await tick();a.calls[3].reply(photoWork());await retry;
  assert.equal(a.calls.filter(c=>c.body instanceof FormData).length,1);
});

test('failed upload does not submit and a late upload cannot submit into another stage',async()=>{
  const a=photoSetup(),pending=a.camera.onConfirm(photo());
  a.calls[0].reply({detail:'上传失败'},503);assert.equal(await pending,false);assert.equal(a.calls.length,1);
  const late=a.camera.onConfirm(photo());a.run('S.seq++;S.stage=2');a.calls[1].reply(storedPhoto,201);
  assert.equal(await late,false);assert.equal(a.calls.length,2);assert.equal(a.run('S.work.work.file_ids.length'),0);
});

test('a saved photo submission with a failed refresh does not ask for another submission',async()=>{
  const a=photoSetup(),pending=a.camera.onConfirm(photo());
  a.calls[0].reply(storedPhoto,201);await tick();a.calls[1].reply({revision:1,updated:10,submission_id:'v1'},201);await tick();
  a.calls[2].reply({detail:'同步失败'},503);assert.equal(await pending,true);
  assert.equal(a.run('S.savedEdit===S.edit'),true);assert.match(a.el('#toast').textContent,/已自动提交/);
  assert.equal(a.calls.filter(c=>c.url.endsWith('/submissions')).length,1);
});

test('ordinary uploads still save a draft; camera confirmation in a legacy lesson stays manual',async()=>{
  for(const legacy of [false,true]){
    const a=photoSetup();if(legacy)a.run('S.lesson.flow_version=2');
    const pending=legacy?a.camera.onConfirm(photo()):a.run("uploadFiles([new Blob(['photo'],{type:'image/jpeg'})])");
    a.calls[0].reply(storedPhoto,201);await tick();
    assert.match(a.calls[1].url,/\/work$/);a.calls[1].reply({revision:1,updated:10});assert.equal(await pending,true);
    assert.equal(a.calls.length,2);
  }
});

test('automatic photo submission validates image count and total size before uploading',async()=>{
  const a=photoSetup();a.run("S.work.work.file_ids=Array.from({length:8},(_,i)=>'existing-'+i)");
  assert.equal(await a.camera.onConfirm(photo()),false);assert.match(a.el('#toast').textContent,/最多提交8张/);
  a.run("S.work.work.file_ids=['large'];S.work.files=[{id:'large',size:20*1024*1024}]");
  assert.equal(await a.camera.onConfirm(photo()),false);assert.match(a.el('#toast').textContent,/合计超过20 MB/);
  assert.equal(a.calls.length,0);
});
test('teacher summary escapes evidence and hides stale issues',()=>{
  const a=setup();
  const data={status:'ready',submitted:1,evaluated:1,group_count:8,updated:null,groups:[{group_id:2,status:'processing'}],
    result:{overview:'<script>不要执行</script>',issues:[{title:'两侧未比较',detail:'缺少依据',group_ids:[1],suggestion:'重点检查两侧比较依据。',evidence:[{group_id:1,quote:'<img src=x onerror=bad>'}]}],sources:[{group_id:1,revision:3}],discussion:[]}};
  const html=a.run(`teacherSummaryHTML(${JSON.stringify(data)})`);
  assert.doesNotMatch(html,/<script>|<img /);assert.match(html,/提交版本 3/);assert.match(html,/第 2 组：正在评价/);
  data.status='pending';assert.doesNotMatch(a.run(`teacherSummaryHTML(${JSON.stringify(data)})`),/两侧未比较/);
});
test('teacher summary ignores late responses after switching lessons and coalesces polling',async()=>{
  const a=setup();a.run("S.user={role:'teacher'};S.stage=2;S.lesson.flow_version=3;S.seq=1");
  const first=a.run('refreshTeacherSummary()');await a.run('refreshTeacherSummary()');
  assert.equal(a.calls.length,1);
  a.run("S.lesson.id='new-lesson';S.seq=2");const second=a.run('refreshTeacherSummary()');
  const data={status:'waiting',submitted:0,evaluated:0,group_count:8,groups:[]};
  a.calls[1].reply(data);await second;
  const html=a.el('#teacherSummaryBody').innerHTML;
  a.calls[0].reply({...data,status:'failed'});await first;
  assert.equal(a.el('#teacherSummaryBody').innerHTML,html);
  a.run('S.stage=1');await a.run('refreshTeacherSummary()');assert.equal(a.calls.length,2);
});
test('two-part result matching updates while typing without replacing the draft',async()=>{
  const a=setup(); a.run('S.lesson.flow_version=3');
  a.fields[0].value='还在修改的设计';
  const refresh=a.run('refreshWork(false)');
  const match={version_id:'new',revision:1,status:'ready',matches:[{result_id:'gelatin_separator',image:'/one.png',label:'明胶隔层',excerpt:'学生原话'}],questions:[],uncovered:[]};
  a.calls[0].reply({work:{revision:0},versions:[{id:'new',revision:1,fields:{design:'学生原话'},file_ids:[],result_match:match}],files:[],scores:null,result_match:match});
  await refresh;
  assert.equal(a.fields[0].value,'还在修改的设计');
  assert.match(a.el('#chatMessages').innerHTML,/one.png/);
  assert.match(a.el('#chatMessages').innerHTML,/第 1 次实验结果/);
  assert.doesNotMatch(a.el('#chatMessages').innerHTML,/还在修改的设计/);
  assert.equal(a.el('#assignmentArea').innerHTML,'');
});

function inquiryVersion(id,time,status='ready'){
  return {id,revision:time,updated:time,author:'第 1 组',fields:{design:`思路${id}`},file_ids:[],
    result_match:{version_id:id,revision:time,status,matches:status==='ready'?[{image:`/${id}.png`,label:`处理${id}`,excerpt:`思路${id}`}]:[],questions:[],uncovered:[]}};
}

test('all submission replies persist in chronological chat history during matching, retries and reload',()=>{
  const a=setup(),first=inquiryVersion('first',10),second=inquiryVersion('second',30,'processing');
  a.run(`S.lesson.flow_version=3;S.work.versions=${JSON.stringify([first,second])};S.groups=[{id:1,chats:[{id:1,created:20,question:'中间讨论',answer:'请分析第一轮证据'}]}];renderChat()`);
  let html=a.el('#chatMessages').innerHTML;
  assert.match(html,/first.png/);assert.match(html,/正在匹配结果图/);
  assert.ok(html.indexOf('思路first')<html.indexOf('中间讨论'));
  assert.ok(html.indexOf('中间讨论')<html.indexOf('思路second'));
  second.result_match.status='failed';second.result_match.error='请重试';
  a.run(`S.work.versions=${JSON.stringify([first,second])};renderChat()`);
  assert.match(a.el('#chatMessages').innerHTML,/data-match-retry="second"/);
  const ready=inquiryVersion('second',30);
  a.run(`S.work.versions=${JSON.stringify([first,ready])};renderChat();renderChat()`);
  html=a.el('#chatMessages').innerHTML;
  assert.equal((html.match(/data-submission-id=/g)||[]).length,2);
  assert.match(html,/first.png/);assert.match(html,/second.png/);
  const fresh=setup();fresh.run(`S.lesson.flow_version=3;S.work.versions=${JSON.stringify([first,ready])};renderChat()`);
  assert.match(fresh.el('#chatMessages').innerHTML,/first.png/);assert.match(fresh.el('#chatMessages').innerHTML,/second.png/);
  fresh.run('S.stage=2;renderChat()');assert.doesNotMatch(fresh.el('#chatMessages').innerHTML,/first.png|second.png/);
});

test('photo submissions and multi-image replies stay together and escape student content',()=>{
  const a=setup(),v=inquiryVersion('photos',10);
  v.fields.design='';v.file_ids=['photo'];
  v.result_match.matches.push({image:'/extra.png',label:'第二种处理',excerpt:'<script>危险内容</script>'});
  const html=a.run(`chatsHTML([],${JSON.stringify([v])},[{id:'photo',preview:true,name:'<img src=x>'}])`);
  assert.match(html,/实验思路照片/);assert.match(html,/photo\?preview=true/);
  assert.match(html,/photos.png/);assert.match(html,/extra.png/);
  assert.doesNotMatch(html,/<script>|<img src=x>/);
});

test('Enter sends through the form exactly once and retains normal chat completion',async()=>{
  const a=setup();a.run('S.edit=S.savedEdit=0;S.groups=[{id:1,chats:[]}]');
  a.el('#chatInput').value='请比较两次实验';let prevented=0;
  const enter=()=>a.el('#chatInput').listeners.keydown({key:'Enter',preventDefault(){prevented++;}});
  enter();enter();await tick();
  assert.equal(prevented,2);assert.equal(a.calls.length,1);assert.equal(a.calls[0].body.message,'请比较两次实验');
  assert.equal(a.el('#chatInput').value,'');
  a.calls[0].reply({id:1,created:20,question:'请比较两次实验',answer:'请比较处理。',images:[]},201);await tick();
  assert.match(a.el('#chatMessages').innerHTML,/请比较处理/);
});

test('Shift+Enter and IME confirmation never submit; busy, archived and empty inputs are guarded',async()=>{
  const a=setup();a.run('S.edit=S.savedEdit=0');a.el('#chatInput').value='正在选字';
  for(const extra of [{shiftKey:true},{isComposing:true},{keyCode:229},{key:'a'}]){
    a.el('#chatInput').listeners.keydown({key:'Enter',preventDefault(){assert.fail('must keep native input');},...extra});
  }
  const key=extra=>a.el('#chatInput').listeners.keydown({key:'Enter',preventDefault(){},...extra});
  key({repeat:true});a.el('#chatInput').readOnly=true;key();a.el('#chatInput').readOnly=false;
  for(const flag of ['uploading','submitting','sending','loading','extracting']){a.run(`S.${flag}=true`);key();a.run(`S.${flag}=false`);}
  a.el('#sendButton').disabled=true;key();a.el('#sendButton').disabled=false;
  a.run("S.lesson.status='archived'");key();a.run("S.lesson.status='live'");
  a.el('#chatInput').value='  ';key();await tick();
  assert.equal(a.calls.length,0);
});
test('late result snapshots cannot replace a newer inquiry submission',()=>{
  const a=setup();a.run("S.lesson.flow_version=3; S.work.versions=[{id:'new',revision:5}];S.work.result_match={version_id:'new'};syncSubmissionResults({versions:[{id:'old',revision:3}],result_match:{version_id:'old'}})");
  assert.equal(a.run('S.work.result_match.version_id'),'new');
});
test('inquiry histories show their own results and scores; stage one has no grading',()=>{
  const a=setup();a.run('S.lesson.flow_version=3');
  assert.match(a.run("versionExtras({result_match:{version_id:'a',revision:1,status:'ready',matches:[{image:'/first.png',label:'处理',excerpt:'<script>不执行</script>'}],questions:[],uncovered:[]}})"),/first.png/);
  assert.doesNotMatch(a.run("matchHTML({status:'ready',revision:1,matches:[{image:'/first.png',label:'处理',excerpt:'<script>不执行</script>'}],questions:[],uncovered:[]})"),/<script>/);
  assert.match(a.run('presentationScoreHTML({scores:{stages:[]}})'),/本部分不计分/);
  a.run('S.stage=2');
  assert.match(a.run("versionExtras({assessment:{status:'ready',total:70,maximum:100,items:[],feedback:null}})"),/70 \/ 100/);
});
test('autosave then submission uses the new revision; double click creates one submission',async()=>{
  const a=setup();const draft=a.run('saveWork(false)');await tick();
  const submit=a.run('saveWork(true)');const double=a.run('saveWork(true)');
  assert.equal(a.calls.length,1);assert.equal(a.fields[0].disabled,true);
  a.calls[0].reply({revision:1,updated:10});await draft;await tick();
  assert.equal(a.calls.length,2);assert.equal(a.calls[1].body.revision,1);
  assert.ok(a.calls[1].body.request_id);a.calls[1].reply({revision:2,updated:11});await tick();
  a.calls[2].reply({work:{revision:2,updated:11,fields:{observation:'观察',hypothesis:'假说'},file_ids:[]},files:[],versions:[{revision:2,fields:{},file_ids:[],updated:11}],assignment:null});
  await Promise.all([submit,double]);assert.equal(a.calls.filter(c=>c.url.endsWith('/submissions')).length,1);
  assert.equal(a.fields[0].disabled,false);assert.equal(a.run('S.work.work.revision'),2);
});
test('conflict retains typed content and local draft without overwriting the server revision',async()=>{
  const a=setup();const pending=a.run('saveWork(false)');await tick();
  a.calls[0].reply({detail:'同组另一台设备已修改'},409);assert.equal(await pending,false);
  assert.equal(a.fields[0].value,'观察');assert.equal(a.run('S.savedEdit'),0);assert.equal(a.local.size,1);
});
test('failed submission retry uses the same request id',async()=>{
  const a=setup();const pending=a.run('saveWork(true)');await tick();const id=a.calls[0].body.request_id;
  a.calls[0].reply({detail:'暂时无法连接'},503);await pending;
  const retry=a.run('saveWork(true)');await tick();assert.equal(a.calls[1].body.request_id,id);
  a.calls[1].reply({detail:'暂时无法连接'},503);await retry;
});
test('delayed refresh cannot replace a newer saved revision',async()=>{
  const a=setup();a.run('S.edit=S.savedEdit=0');const refresh=a.run('refreshWork(false)');
  a.run('S.work.work.revision=3');a.calls[0].reply({work:{revision:1},files:[],versions:[]});await refresh;
  assert.equal(a.run('S.work.work.revision'),3);
});
test('result arrives while typing without replacing the local draft or locking an unsubmitted design',async()=>{
  const a=setup();
  a.fields[0].dataset.field='design';a.fields[0].value='尚未保存的本组设计';
  a.run('S.lesson.flow_version=2');
  const pending=a.run('refreshWork(false)');
  a.calls[0].reply({work:{revision:0,fields:{design:'服务器旧草稿'}},assignment:{variant:1,image:'/result.png',design_locked:false}});
  await pending;
  assert.equal(a.fields[0].value,'尚未保存的本组设计');
  assert.equal(a.fields[0].disabled,false);
  assert.equal(a.run('S.work.assignment.variant'),1);
  assert.match(a.el('#assignmentArea').innerHTML,/result.png/);
});
test('teacher switching groups ignores a late response for the previous group',async()=>{
  const a=setup();a.run("S.user={role:'teacher'};S.group=7");const refresh=a.run('refreshWork(false)');
  a.run('S.group=8;S.work.work.revision=8');a.calls[0].reply({work:{revision:7},files:[],versions:[]});await refresh;
  assert.equal(a.run('S.work.work.revision'),8);
});
test('initial guide is brought into view even when materials are longer than the window',()=>{
  const a=setup();a.el('#conversationScroll').scrollHeight=1200;
  a.run("S.content.opener='本环节第一轮问题';S.content.content.prompts=[];renderChat()");
  assert.equal(a.el('#conversationScroll').scrollTop,1200);
  assert.match(a.el('#chatMessages').innerHTML,/本环节第一轮问题/);
});

test('chat locks before draft save so rapid clicks create one AI request',async()=>{
  const a=setup();a.run("S.content.content.prompts=[];S.groups=[{id:1,chats:[]}];S.user.name='第 1 组'");
  a.el('#chatInput').value='请检查我们的预测';
  const first=a.run('sendChat()');
  assert.equal(a.el('#sendButton').disabled,true);
  await a.run('sendChat()');await tick();
  assert.equal(a.calls.length,1);assert.match(a.calls[0].url,/\/work$/);
  a.calls[0].reply({revision:1,updated:10});await tick();
  assert.equal(a.calls.length,2);assert.match(a.calls[1].url,/\/chats$/);
  assert.equal(a.calls[1].body.message,'请检查我们的预测');
  await a.run('sendChat()');assert.equal(a.calls.length,2);
  a.calls[1].reply({id:1,question:'请检查我们的预测',answer:'请先描述对照条件。',images:[]},201);
  await first;
  assert.equal(a.run('S.groups[0].chats.length'),1);
  assert.equal(Boolean(a.el('#sendButton').disabled),false);
  assert.equal(a.run('S.sending'),false);
});

test('draft failure unlocks chat and retains the question and selected images',async()=>{
  const a=setup();a.run("S.content.content.prompts=[];S.images.set('image-1',{id:'image-1',name:'模型.png'})");
  a.el('#chatInput').value='请检查我们的预测';
  const first=a.run('sendChat()');await tick();
  a.calls[0].reply({detail:'同组另一台设备已修改'},409);await first;
  assert.equal(a.calls.length,1);assert.equal(Boolean(a.el('#sendButton').disabled),false);
  assert.equal(a.el('#chatInput').value,'请检查我们的预测');
  assert.equal(a.run('S.images.size'),1);assert.equal(a.run('S.sending'),false);
});

function presentationSetup(count=8){
  const a=setup();
  a.run(`S.user={role:'teacher'};S.lesson.group_count=${count};S.lesson.flow_version=2;S.content.content.fields=[{key:'design',label:'实验设计'}]`);
  a.el('#presentationDialog').open=true;a.el('#compareLeft').value=1;a.el('#compareRight').value=2;
  return a;
}
function presentedWork(id,status='ready'){
  return {work:{fields:{design:'尚未提交的修改'},file_ids:[]},versions:[{id:`v${id}`,fields:{design:`第 ${id} 组已提交的实验设计`},file_ids:[],updated:10}],files:[],scores:{stages:[
    {stage:1,version_id:`v${id}`,status,total:15,maximum:20,items:[{key:'design',label:'实验设计',points:7,maximum:12,reason:'对照条件还需完善'}],feedback:{source:'ai',improvements:[{key:'design',text:`第 ${id} 组请统一观察时间。`}]}},
    {stage:2,version_id:'other-stage',status:'ready',total:30,maximum:30,items:[],feedback:{improvements:[{text:'不属于当前环节的建议'}]}}
  ]}};
}
function replyPair(a,offset=0,ids=[1,2]){ids.forEach((id,i)=>a.calls[offset+i].reply(presentedWork(id)));}

test('teacher details and projection keep the previous mark and show numeric history during grading',()=>{
  const a=presentationSetup(), w=presentedWork(1,'processing');
  const previous={version_id:'old',submission_number:1,total:12,maximum:20,status:'ready'};
  Object.assign(w.scores.stages[0],{total:null,retained_score:previous,history:[previous]});
  Object.assign(w.scores,{total:42,graded:2});
  const projection=a.run(`presentationScoreHTML(${JSON.stringify(w)})`);
  const teacher=a.run(`scoreHTML(${JSON.stringify(w.scores)},true)`);
  assert.match(projection,/本环节 12/);
  assert.match(projection,/新提交评分中/);
  for(const html of [projection,teacher]){
    assert.match(html,/当前保留第 1 次提交的得分/);
    assert.match(html,/分数变化.*第 1 次.*12 <small>\/ 20/s);
    assert.doesNotMatch(html,/第 1 组请统一观察时间/);
  }
  assert.match(teacher,/data-score-retry="v1"/);
});

test('presentation pairs current-stage score and advice with the submitted work, including zero and pending scores',async()=>{
  const a=presentationSetup();const pending=a.run('compare()');replyPair(a);await pending;
  const html=a.el('#comparison').innerHTML;
  assert.match(html,/本环节 15/);assert.match(html,/第 1 组请统一观察时间/);assert.match(html,/第 2 组已提交的实验设计/);
  assert.doesNotMatch(html,/不属于当前环节|尚未提交的修改/);
  for(const state of ['pending','processing','failed','model_submitted']){
    const w=presentedWork(1,state);
    const result=a.run(`presentationScoreHTML(${JSON.stringify(w)})`);
    assert.doesNotMatch(result,/本环节 15|第 1 组请统一观察时间/);
  }
  const zero=presentedWork(1,'corrected');zero.scores.stages[0].total=0;
  assert.match(a.run(`presentationScoreHTML(${JSON.stringify(zero)})`),/本环节 0/);
  zero.scores.stages[0].version_id='previous';
  assert.doesNotMatch(a.run(`presentationScoreHTML(${JSON.stringify(zero)})`),/本环节 0|第 1 组请统一观察时间/);
});

test('next pair loops through all groups and a late response cannot overwrite a newer pair',async()=>{
  const a=presentationSetup();const first=a.run('compare()');const next=a.run('nextComparison()');
  assert.equal(a.el('#compareLeft').value,3);assert.equal(a.el('#compareRight').value,4);
  replyPair(a,2,[3,4]);await next;replyPair(a);await first;
  assert.match(a.el('#comparison').innerHTML,/第 3 组成果与评分/);assert.doesNotMatch(a.el('#comparison').innerHTML,/第 1 组成果与评分/);
  for(const [offset,ids] of [[4,[5,6]],[6,[7,8]],[8,[1,2]]]){
    const p=a.run('nextComparison()');replyPair(a,offset,ids);await p;
    assert.equal(a.el('#compareLeft').value,ids[0]);assert.equal(a.el('#compareRight').value,ids[1]);
  }
  const legacy=presentationSetup(6);legacy.el('#compareLeft').value=5;legacy.el('#compareRight').value=6;
  const p=legacy.run('nextComparison()');replyPair(legacy);await p;
  assert.equal(legacy.el('#compareLeft').value,1);assert.equal(legacy.el('#compareRight').value,2);
});

test('automatic switching waits eight seconds per loaded pair, supports pause, and stops on close',async()=>{
  const a=presentationSetup();a.run('togglePresentationAuto()');
  assert.equal(a.timers.size,1);let timer=[...a.timers.values()][0];assert.equal(timer.ms,8000);
  assert.equal(a.calls.length,0);
  const p=timer.fn();assert.equal(a.el('#compareLeft').value,3);assert.equal(a.timers.size,0);
  a.run('togglePresentationAuto();togglePresentationAuto()');assert.equal(a.timers.size,0);
  replyPair(a,0,[3,4]);await p;
  assert.equal(a.timers.size,1);assert.equal([...a.timers.values()][0].ms,8000);
  a.run('togglePresentationAuto()');assert.equal(a.timers.size,0);
  a.run('togglePresentationAuto()');const late=[...a.timers.values()][0].fn();
  a.run('closePresentation()');assert.equal(a.timers.size,0);assert.equal(a.el('#presentationDialog').open,false);
  const html=a.el('#comparison').innerHTML;replyPair(a,2,[5,6]);await late;
  assert.equal(a.el('#comparison').innerHTML,html);assert.equal(a.timers.size,0);assert.equal(a.run('presentation.auto'),false);
});

test('a failed pair pauses auto switching and manual refresh recovers',async()=>{
  const a=presentationSetup();a.run('togglePresentationAuto()');
  const p=a.run('compare()');a.calls[0].reply({detail:'连接失败'},503);a.calls[1].reply(presentedWork(2));
  await assert.rejects(p,/连接失败/);assert.equal(a.timers.size,0);assert.equal(a.run('presentation.auto'),false);
  assert.match(a.el('#comparison').innerHTML,/读取失败/);
  const retry=a.run('compare()');replyPair(a,2);await retry;
  assert.match(a.el('#comparison').innerHTML,/第 1 组成果与评分/);
});

test('conversation display fetches current-stage chats, escapes text and preserves pair selection',async()=>{
  const a=presentationSetup();
  a.run("S.stage=2;S.groups=[{id:1,chats:[{question:'旧缓存对话'}]}]");
  const pending=a.run('togglePresentationMode()');
  assert.match(a.calls[2].url,/groups\?stage=2$/);
  replyPair(a);
  a.calls[2].reply([{id:1,chats:[{author:'第 1 组',question:'<script>比较两侧</script>',answer:'用什么指标判断？',created:12,images:[{id:'photo',name:'设计照片'}]}]},{id:2,chats:[]}]);
  await pending;
  const html=a.el('#comparison').innerHTML;
  assert.match(html,/第 1 组与 AI 对话/);assert.match(html,/&lt;script&gt;/);
  assert.match(html,/用什么指标判断/);assert.match(html,/files\/photo\?preview=true/);
  assert.match(html,/本组在当前环节还没有与 AI 的对话/);
  assert.doesNotMatch(html,/<script>|旧缓存对话|comparison-score|尚未提交的修改/);
  assert.equal(a.el('#compareLeft').value,1);assert.equal(a.el('#compareRight').value,2);
  assert.equal(a.el('#presentationMode').textContent,'展示成果与评分');
  const back=a.run('togglePresentationMode()');replyPair(a,3);await back;
  assert.match(a.el('#comparison').innerHTML,/第 1 组成果与评分/);
});

test('late conversation responses cannot replace work mode and auto rotation keeps conversation mode',async()=>{
  const a=presentationSetup();
  const old=a.run('togglePresentationMode()'),current=a.run('togglePresentationMode()');
  replyPair(a,3);await current;replyPair(a);a.calls[2].reply([{id:1,chats:[{question:'迟到的对话',answer:'迟到回复'}]}]);await old;
  assert.doesNotMatch(a.el('#comparison').innerHTML,/迟到/);
  a.run("presentation.mode='chat';togglePresentationAuto()");
  const pending=[...a.timers.values()][0].fn();
  replyPair(a,5,[3,4]);a.calls[7].reply([{id:3,chats:[{question:'第三组的问题',answer:'第三组的回复'}]},{id:4,chats:[]}]);await pending;
  assert.equal(a.run('presentation.mode'),'chat');assert.equal(a.timers.size,1);
  assert.match(a.el('#comparison').innerHTML,/第 3 组与 AI 对话/);
  assert.match(a.el('#comparison').innerHTML,/第三组的问题/);
});

test('stage-one conversation projection includes submitted images and result replies in order',()=>{
  const a=presentationSetup();a.run('S.lesson.flow_version=3');
  const work={versions:[{id:'submission',fields:{design:'先前实验思路'},file_ids:['photo'],updated:10,result_match:{status:'ready',matches:[{label:'结果图',image:'/result.png'}],questions:[],uncovered:[]}}],files:[{id:'photo',name:'实验照片',preview:true}]};
  const group={chats:[{author:'第 1 组',question:'之后的追问',answer:'AI的追问回复',created:20}]};
  const html=a.run(`presentationChatHTML(${JSON.stringify(work)},${JSON.stringify(group)},1)`);
  assert.ok(html.indexOf('先前实验思路')<html.indexOf('之后的追问'));
  assert.match(html,/\/result.png/);assert.match(html,/files\/photo\?preview=true/);
});

test('summary fullscreen updates together with the teacher panel and hides stale deficiencies',async()=>{
  const a=presentationSetup();a.run('S.stage=2;S.lesson.flow_version=3');
  a.el('#summaryPresentationSurface').requestFullscreen=async()=>a.run("document.fullscreenElement=document.querySelector('#summaryPresentationSurface')");
  a.run("document.exitFullscreen=async()=>{document.fullscreenElement=null;}");
  a.run('presentSummary()');assert.equal(a.el('#summaryPresentationDialog').open,true);
  const data={status:'ready',submitted:1,evaluated:1,group_count:8,groups:[],result:{overview:'部分小组未区分两侧来源。',issues:[{title:'未区分向光侧与背光侧',detail:'总量不能反映两侧分布。',group_ids:[1],suggestion:'核查方案能否分别保留两侧来源。',evidence:[{group_id:1,quote:'只测总量'}]}],sources:[{group_id:1,revision:1}],discussion:[]}};
  a.calls[0].reply(data);await tick();
  assert.match(a.el('#teacherSummaryBody').innerHTML,/未区分向光侧与背光侧/);
  assert.match(a.el('#summaryPresentationBody').innerHTML,/未区分向光侧与背光侧/);
  assert.doesNotMatch(a.el('#summaryPresentationBody').innerHTML,/<details[^>]*open/);
  const refresh=a.run('refreshTeacherSummary()');a.calls[1].reply({...data,status:'processing',result:null});await refresh;
  assert.doesNotMatch(a.el('#summaryPresentationBody').innerHTML,/未区分向光侧与背光侧/);
  a.run('closeSummaryPresentation()');assert.equal(a.el('#summaryPresentationDialog').open,false);
  assert.equal(a.run('document.fullscreenElement'),null);
});
