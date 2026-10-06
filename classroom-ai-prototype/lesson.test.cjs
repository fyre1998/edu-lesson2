const {test}=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const fs=require('node:fs');
const source=fs.readFileSync(require('node:path').join(__dirname,'lesson.js'),'utf8');

function setup(scriptURL){
  const elements=new Map(), local=new Map(), calls=[], timers=new Map();let timerId=0,cameraOptions;
  const el=s=>{if(!elements.has(s))elements.set(s,{value:'',disabled:false,innerHTML:'',textContent:'',dataset:{},listeners:{},addEventListener(name,handler){this.listeners[name]=handler;},requestSubmit(){this.listeners.submit({preventDefault(){}});},classList:{add(){},remove(){},toggle(){},contains(){return false;}},insertAdjacentHTML(){},replaceChildren(){},setAttribute(){},close(){this.open=false;},showModal(){this.open=true;}});return elements.get(s);};
  const fields=[{value:'观察',dataset:{field:'observation'}},{value:'假说',dataset:{field:'hypothesis'}}];
  const context=vm.createContext({document:{querySelector:el,querySelectorAll:s=>s==='[data-field]'?fields:[]},
    ChatStream:require('./chat-stream.js'),FormData,Blob,setTimeout:(fn,ms)=>{timers.set(++timerId,{fn,ms});return timerId;},clearTimeout:id=>timers.delete(id),crypto:require('node:crypto').webcrypto,
    createCameraCapture:options=>{cameraOptions=options;return {open(){},close(){}};},
    sessionStorage:{setItem:(k,v)=>local.set(k,v),removeItem:k=>local.delete(k),getItem:k=>local.get(k)},
    fetch:(url,options)=>new Promise(resolve=>calls.push({url,headers:options.headers,replyRaw:resolve,body:options.body instanceof FormData?options.body:options.body?JSON.parse(options.body):null,reply:(data,status=200)=>resolve({ok:status<400,status,json:async()=>data})}))});
  if(scriptURL){
    context.URL=URL;context.document.currentScript={src:scriptURL};
    vm.runInContext(fs.readFileSync(require('node:path').join(__dirname,'paths.js'),'utf8'),context);
  }
  vm.runInContext(fs.readFileSync(require('node:path').join(__dirname,'score-bubble.js'),'utf8'),context);
  vm.runInContext(fs.readFileSync(require('node:path').join(__dirname,'lesson-widgets.js'),'utf8'),context);
  vm.runInContext(source.slice(0,source.indexOf('\nconst camera=')),context);
  vm.runInContext(source.slice(source.indexOf('const camera='),source.indexOf("\n$('#loginGroup')")),context);
  vm.runInContext(source.slice(source.indexOf("$('#workFiles').addEventListener"),source.indexOf("\n$('#chatForm').addEventListener")),context);
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

function photoSetup(stage=1,flow=3){
  const a=setup();a.run(`S.lesson.flow_version=${flow};S.stage=${stage};S.edit=S.savedEdit=0`);
  return a;
}
const photo=()=>new File(['photo bytes'],'实验照片.jpg',{type:'image/jpeg'});
const storedPhoto={id:'photo-1',name:'实验照片.jpg',size:11,preview:true,uploader:'第 1 组'};
function photoWork(){
  return {work:{revision:1,updated:10,fields:{},file_ids:['photo-1']},files:[storedPhoto],versions:[{id:'v1',revision:1,fields:{},file_ids:['photo-1'],updated:10}],assignment:null};
}

for(const flow of [3,4,5])for(const stage of [1,2])test(`camera confirmation automatically submits flow ${flow} stage ${stage} exactly once`,async()=>{
  const a=photoSetup(stage,flow),file=photo();
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
function revisedPhotoSetup(count=1){
  const a=photoSetup(),files=Array.from({length:count},(_,i)=>({...storedPhoto,id:'old-'+i,size:20*1024*1024}));
  const previous={id:'previous',revision:1,updated:10,fields:{design:'上次方案'},file_ids:files.map(f=>f.id)};
  a.run(`S.lesson.flow_version=5;S.work.files=${JSON.stringify(files)};S.work.versions=[${JSON.stringify(previous)}];S.work.work.file_ids=${JSON.stringify(previous.file_ids)};`);
  return a;
}

for(const flow of [4,5])for(const stage of [1,2])test(`grape flow ${flow} stage ${stage} submits the replacement photo inside the lesson 2 path`,async()=>{
  const a=setup('https://lsclass.top/lesson/paths.js');
  a.run(`S.lesson.flow_version=${flow};S.stage=${stage};S.edit=S.savedEdit=0;S.work.files=[{id:'old',name:'旧方案.jpg',size:10,preview:true}];S.work.work.file_ids=['old'];S.work.versions=[{id:'old-version',revision:1,updated:10,fields:{design:'旧方案'},file_ids:['old']}];`);
  const pending=a.camera.onConfirm(photo());
  assert.equal(a.calls[0].url,`/lesson/api/classroom/files?lesson_id=lesson&stage=${stage}`);
  a.calls[0].reply(storedPhoto,201);await tick();
  assert.equal(a.calls[1].url,`/lesson/api/classroom/lessons/lesson/stages/${stage}/submissions`);
  assert.deepEqual(a.calls[1].body.file_ids,['photo-1']);
  a.calls[1].reply({revision:2,updated:20,submission_id:'v1'},201);await tick();
  a.calls[2].reply(photoWork());assert.equal(await pending,true);
});

test('new grape uploads replace previous attachments once and append within the same draft',async()=>{
  const a=revisedPhotoSetup(),pending=a.run("uploadFiles([new Blob(['one']),new Blob(['two'])])");
  assert.deepEqual([...a.run('S.work.work.file_ids')],['old-0']);
  assert.match(a.el('#workFiles').innerHTML,/data-attach="old-0"[^>]*disabled/);
  a.el('#workFiles').listeners.click({target:{closest:selector=>selector==='[data-attach]'?{dataset:{attach:'old-0'}}:null}});
  assert.deepEqual([...a.run('S.work.work.file_ids')],['old-0']);
  a.calls[0].reply(storedPhoto,201);await tick();
  a.calls[1].reply({...storedPhoto,id:'photo-2'},201);await tick();
  assert.deepEqual(a.calls[2].body.file_ids,['photo-1','photo-2']);
  a.calls[2].reply({revision:2,updated:20});assert.equal(await pending,true);
  const next=a.run("uploadFiles([new Blob(['three'])])");
  a.calls[3].reply({...storedPhoto,id:'photo-3'},201);await tick();
  assert.deepEqual(a.calls[4].body.file_ids,['photo-1','photo-2','photo-3']);
  a.calls[4].reply({revision:3,updated:30});assert.equal(await next,true);
  assert.deepEqual([...a.run('S.work.versions[0].file_ids')],['old-0']);
  assert.deepEqual([...a.run('S.work.files.map(f=>f.id)')],['old-0','photo-1','photo-2','photo-3']);
  assert.doesNotMatch(a.el('#workFiles').innerHTML,/data-attach="old-0"[^>]*disabled/);
});

test('grape camera submits only the new photo even when the previous submission filled limits',async()=>{
  const a=revisedPhotoSetup(8),pending=a.camera.onConfirm(photo());
  assert.equal(a.calls.length,1);
  a.calls[0].reply(storedPhoto,201);await tick();
  assert.match(a.calls[1].url,/\/submissions$/);
  assert.deepEqual(a.calls[1].body.file_ids,['photo-1']);
  a.calls[1].reply({revision:2,updated:20,submission_id:'v1'},201);await tick();
  a.calls[2].reply(photoWork());assert.equal(await pending,true);
});

test('failed or late grape uploads preserve the previous attachment selection',async()=>{
  for(const failure of ['validation','upload','late']){
    const a=revisedPhotoSetup();
    const pending=failure==='validation'?a.run("uploadFiles([{size:21*1024*1024,type:'image/jpeg'}],{submitToAI:true})"):a.camera.onConfirm(photo());
    if(failure==='upload')a.calls[0].reply({detail:'上传失败'},503);
    if(failure==='late'){a.run('S.seq++;S.stage=2');a.calls[0].reply(storedPhoto,201);}
    assert.equal(await pending,false);
    assert.deepEqual([...a.run('S.work.work.file_ids')],['old-0']);
    assert.equal(a.calls.filter(c=>c.url.endsWith('/submissions')).length,0);
  }
});

test('a partial batch failure keeps the new draft photos and a retry appends without the old ones',async()=>{
  const a=revisedPhotoSetup(),pending=a.run("uploadFiles([new Blob(['one']),new Blob(['two'])])");
  a.calls[0].reply(storedPhoto,201);await tick();a.calls[1].reply({detail:'上传失败'},503);
  assert.equal(await pending,false);assert.deepEqual([...a.run('S.work.work.file_ids')],['photo-1']);
  const retry=a.run("uploadFiles([new Blob(['two'])])");
  a.calls[2].reply({...storedPhoto,id:'photo-2'},201);await tick();
  assert.deepEqual(a.calls[3].body.file_ids,['photo-1','photo-2']);
  a.calls[3].reply({revision:2,updated:20});assert.equal(await retry,true);
});

test('uploads retain a manually edited selection and retain legacy lesson behavior',async()=>{
  for(const legacy of [false,true]){
    const a=revisedPhotoSetup(2);
    a.run(legacy?'S.lesson.flow_version=3':"S.work.work.file_ids=['old-1']");
    const pending=a.run("uploadFiles([new Blob(['one'])])");
    a.calls[0].reply(storedPhoto,201);await tick();
    assert.deepEqual(a.calls[1].body.file_ids,legacy?['old-0','old-1','photo-1']:['old-1','photo-1']);
    a.calls[1].reply({revision:2,updated:20});assert.equal(await pending,true);
  }
});

test('text-only revisions keep selected photos without affecting previous submissions',async()=>{
  const a=revisedPhotoSetup();a.fields[0].value='补充本次条件';
  const pending=a.run('saveWork(true)');await tick();
  assert.deepEqual(a.calls[0].body.file_ids,['old-0']);
  a.calls[0].reply({revision:2,updated:20,submission_id:'v2'},201);await tick();
  a.calls[1].reply({detail:'同步失败'},503);assert.equal(await pending,true);
  assert.deepEqual([...a.run('S.work.versions[0].file_ids')],['old-0']);
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

function schemeVersion(id,time,status='ready',total=80){
  return {id,revision:time,updated:time,author:'第 1 组',fields:{design:`方案${id}`},file_ids:[],
    assessment:{version_id:id,revision:time,status,updated:Date.now()/1000,total:['ready','corrected'].includes(status)?total:null,maximum:100,
      items:[{key:'design',label:'阶段与处理',points:30,maximum:40}],
      feedback:{source:'ai',strengths:[{text:`优点${id}`}],improvements:[{text:`建议${id}`}]}}};
}

for(const flow of [3,4,5])test(`stage two submission feedback stays in chat across revisions and reload in flow ${flow}`,()=>{
  const a=setup(),first=schemeVersion('first',10),second=schemeVersion('second',30,'processing');
  a.run(`S.lesson.flow_version=${flow};S.stage=2;S.work.versions=${JSON.stringify([first,second])};S.groups=[{id:1,chats:[{created:20,question:'中间讨论',answer:'继续比较证据'}]}];renderChat()`);
  let html=a.el('#chatMessages').innerHTML;
  assert.match(html,/80 \/ 100/);assert.match(html,/建议first/);assert.match(html,/AI 正在阅读本次方案/);
  assert.doesNotMatch(html,/建议second|实验结果|百粒质量/);
  assert.ok(html.indexOf('方案first')<html.indexOf('中间讨论'));
  assert.ok(html.indexOf('中间讨论')<html.indexOf('方案second'));
  const ready=schemeVersion('second',30,'ready',90);
  a.run(`S.work.versions=${JSON.stringify([first,ready])};renderChat();renderChat()`);
  html=a.el('#chatMessages').innerHTML;
  assert.equal((html.match(/data-submission-id=/g)||[]).length,2);
  assert.match(html,/80 \/ 100/);assert.match(html,/90 \/ 100/);assert.match(html,/第 2 次方案评价/);assert.match(html,/建议second/);
  const fresh=setup();fresh.run(`S.lesson.flow_version=${flow};S.stage=2;S.work.versions=${JSON.stringify([first,ready])};renderChat()`);
  assert.match(fresh.el('#chatMessages').innerHTML,/建议first/);assert.match(fresh.el('#chatMessages').innerHTML,/建议second/);
  fresh.run('S.stage=1;S.work.versions=[];renderChat()');assert.doesNotMatch(fresh.el('#chatMessages').innerHTML,/方案first|建议second/);
});

test('stage two refresh updates assessment in chat without replacing the draft',async()=>{
  const a=setup(),v=schemeVersion('saved',10);
  a.run('S.lesson.flow_version=5;S.stage=2');a.fields[0].value='尚未提交的新修改';
  const pending=a.run('refreshWork(false)');
  a.calls[0].reply({work:{revision:0},versions:[v],files:[],scores:null,result_match:null});await pending;
  assert.equal(a.fields[0].value,'尚未提交的新修改');
  assert.match(a.el('#chatMessages').innerHTML,/方案saved|建议saved/);
  assert.doesNotMatch(a.el('#chatMessages').innerHTML,/尚未提交的新修改/);
});

test('stage two photo assessment shows pending, retry and clarification for the correct submission',()=>{
  const a=setup('https://lsclass.top/lesson/paths.js'),v=schemeVersion('photo',10,'pending');
  a.run('S.lesson.flow_version=5;S.stage=2');v.fields.design='';v.file_ids=['photo'];
  const render=()=>a.run(`chatsHTML([],${JSON.stringify([v])},[{id:'photo',preview:true,name:'<img src=x>'}])`);
  let html=render();assert.match(html,/增产方案照片/);assert.match(html,/\/lesson\/api\/classroom\/files\/photo\?preview=true/);
  assert.match(html,/正在排队评分/);assert.doesNotMatch(html,/data-inquiry-score-retry|<img src=x>|建议photo/);
  v.assessment.updated=1;assert.match(render(),/data-inquiry-score-retry="photo"/);
  v.assessment.status='failed';assert.match(render(),/评价暂未完成/);assert.match(render(),/data-inquiry-score-retry="photo"/);
  v.assessment.status='needs_clarification';v.assessment.clarification='请补拍<成熟期>的方案';
  html=render();assert.match(html,/请补拍&lt;成熟期&gt;的方案/);assert.doesNotMatch(html,/data-inquiry-score-retry|80 \/ 100/);
  v.assessment=schemeVersion('different',10).assessment;
  html=render();assert.match(html,/正在排队评分/);assert.doesNotMatch(html,/建议different|80 \/ 100/);
  v.assessment=schemeVersion('photo',10,'corrected',0).assessment;
  v.assessment.feedback.strengths[0].text='<script>不执行</script>';
  html=render();assert.match(html,/教师已复核/);assert.match(html,/0 \/ 100/);assert.doesNotMatch(html,/<script>/);
  a.run("S.lesson.status='archived'");v.assessment.status='failed';assert.doesNotMatch(render(),/data-inquiry-score-retry/);
});

test('teacher detail and chat projection include stage two submitted assessments',()=>{
  const a=presentationSetup(),v=schemeVersion('projected',10),waiting=schemeVersion('waiting',20,'failed');
  const w={work:{fields:{design:'未提交的草稿'},file_ids:[]},versions:[v,waiting],files:[],assignment:null};
  const g={id:1,chats:[{created:15,question:'追问',answer:'讨论回复'}]};
  a.run(`S.lesson.flow_version=5;S.stage=2;S.work=${JSON.stringify(w)};S.groups=[${JSON.stringify(g)}];S.roster={groups:[{id:1,members:[]}]};renderDetail()`);
  const detail=a.el('#groupDetail').innerHTML.split('<div class="teacher-chat">')[1];
  const projection=a.run(`presentationChatHTML(${JSON.stringify(w)},${JSON.stringify(g)},1)`);
  assert.match(detail,/本组 AI 对话（3 轮）/);assert.match(projection,/2 次方案提交与评价/);
  for(const html of [detail,projection]){
    assert.match(html,/方案projected/);assert.match(html,/建议projected/);assert.match(html,/80 \/ 100/);
    assert.match(html,/讨论回复/);assert.match(html,/评价暂未完成/);
    assert.doesNotMatch(html,/未提交的草稿|data-inquiry-score-retry|建议waiting/);
  }
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
  assert.match(a.run('presentationScoreHTML({scores:{stages:[]}})'),/本环节不计分/);
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
  a.el('#presentationDialog').open=true;a.el('#presentationGroup').value=1;
  return a;
}
function presentedWork(id,status='ready'){
  return {work:{fields:{design:'尚未提交的修改'},file_ids:[]},versions:[{id:`v${id}`,revision:1,fields:{design:`第 ${id} 组已提交的实验设计`},file_ids:[],updated:10}],files:[],scores:{stages:[
    {stage:1,version_id:`v${id}`,revision:1,status,total:15,maximum:20,items:[{key:'design',label:'实验设计',points:7,maximum:12,reason:'对照条件还需完善'}],feedback:{source:'ai',strengths:[{key:'design',text:'明确了观察指标'},{key:'design',text:'已有对照思路'}],improvements:[{key:'design',text:`第 ${id} 组请统一观察时间。`}]}},
    {stage:2,version_id:'other-stage',status:'ready',total:30,maximum:30,items:[],feedback:{improvements:[{text:'不属于当前环节的建议'}]}}
  ]}};
}

test('teacher details and projection retain a labelled previous mark while grading',()=>{
  const a=presentationSetup(), w=presentedWork(1,'processing');
  const previous={version_id:'old',submission_number:1,total:12,maximum:20,status:'ready'};
  Object.assign(w.scores.stages[0],{total:null,retained_score:previous,history:[previous]});
  Object.assign(w.scores,{total:42,graded:2});
  const projection=a.run(`presentationScoreHTML(${JSON.stringify(w)})`);
  const teacher=a.run(`scoreHTML(${JSON.stringify(w.scores)},true)`);
  assert.match(projection,/本环节 12/);assert.match(projection,/新提交评分中/);
  for(const html of [projection,teacher]){
    assert.match(html,/当前保留第 1 次提交的得分/);
    assert.match(html,/分数变化.*第 1 次.*12 <small>\/ 20/s);
    assert.doesNotMatch(html,/第 1 组请统一观察时间/);
  }
  assert.doesNotMatch(projection,/<details[^>]*open/);
  assert.match(teacher,/data-score-retry="v1"/);
});

test('projection fetches only one group and separates submitted work from score and advice',async()=>{
  const a=presentationSetup(),pending=a.run('compare()');
  assert.equal(a.calls.length,1);assert.match(a.calls[0].url,/groups\/1\/stages\/1$/);
  a.calls[0].reply(presentedWork(1));await pending;
  const html=a.el('#comparison').innerHTML;
  assert.match(html,/第 1 组成果/);assert.match(html,/第 1 组评分与建议/);
  assert.ok(html.indexOf('第 1 组已提交的实验设计')<html.indexOf('第 1 组评分与建议'));
  assert.match(html,/本环节 15/);assert.match(html,/主要优点/);assert.match(html,/第 1 组请统一观察时间/);
  assert.match(html,/<details class="projection-details">.*其他优点/s);
  assert.doesNotMatch(html,/不属于当前环节|尚未提交的修改|第 2 组/);
  for(const state of ['pending','processing','failed','model_submitted','needs_clarification']){
    const w=presentedWork(1,state);
    const result=a.run(`presentationScoreHTML(${JSON.stringify(w)})`);
    assert.doesNotMatch(result,/本环节 15|第 1 组请统一观察时间/);
  }
  const zero=presentedWork(1,'corrected');zero.scores.stages[0].total=0;
  assert.match(a.run(`presentationScoreHTML(${JSON.stringify(zero)})`),/本环节 0/);
  zero.scores.stages[0].version_id='previous';
  assert.doesNotMatch(a.run(`presentationScoreHTML(${JSON.stringify(zero)})`),/本环节 0|第 1 组请统一观察时间/);
});

test('next and previous wrap all groups; late data cannot replace the current group',async()=>{
  const a=presentationSetup(),first=a.run('compare()'),next=a.run('nextComparison()');
  assert.equal(a.el('#presentationGroup').value,2);
  a.calls[1].reply(presentedWork(2));await next;a.calls[0].reply(presentedWork(1));await first;
  assert.match(a.el('#comparison').innerHTML,/第 2 组成果/);assert.doesNotMatch(a.el('#comparison').innerHTML,/第 1 组成果/);
  a.el('#presentationGroup').value=8;
  const wrap=a.run('nextComparison()');assert.equal(a.el('#presentationGroup').value,1);a.calls[2].reply(presentedWork(1));await wrap;
  const previous=a.run('nextComparison(-1)');assert.equal(a.el('#presentationGroup').value,8);a.calls[3].reply(presentedWork(8));await previous;
  const legacy=presentationSetup(6);legacy.el('#presentationGroup').value=6;
  const p=legacy.run('nextComparison()');legacy.calls[0].reply(presentedWork(1));await p;
  assert.equal(legacy.el('#presentationGroup').value,1);
});

test('automatic switching waits twenty seconds; details and close pause rotation',async()=>{
  const a=presentationSetup();a.run('togglePresentationAuto()');
  assert.equal(a.timers.size,1);let timer=[...a.timers.values()][0];assert.equal(timer.ms,20000);
  const p=timer.fn();assert.equal(a.el('#presentationGroup').value,2);assert.equal(a.timers.size,0);
  a.calls[0].reply(presentedWork(2));await p;assert.equal(a.timers.size,1);
  a.run('pausePresentationAuto()');assert.equal(a.timers.size,0);assert.equal(a.run('presentation.auto'),false);
  a.run('togglePresentationAuto()');const late=[...a.timers.values()][0].fn();
  a.run('closePresentation()');assert.equal(a.timers.size,0);assert.equal(a.el('#presentationDialog').open,false);
  const html=a.el('#comparison').innerHTML;a.calls[1].reply(presentedWork(3));await late;
  assert.equal(a.el('#comparison').innerHTML,html);assert.equal(a.timers.size,0);
});

test('a failed group pauses rotation and manual refresh recovers',async()=>{
  const a=presentationSetup();a.run('togglePresentationAuto()');
  const p=a.run('compare()');a.calls[0].reply({detail:'连接失败'},503);
  await assert.rejects(p,/连接失败/);assert.equal(a.timers.size,0);assert.equal(a.run('presentation.auto'),false);
  assert.match(a.el('#comparison').innerHTML,/读取失败/);
  const retry=a.run('compare()');a.calls[1].reply(presentedWork(1));await retry;
  assert.match(a.el('#comparison').innerHTML,/第 1 组成果/);
});

test('chat projection displays only the selected group and preserves selection across modes',async()=>{
  const a=presentationSetup();a.run("S.stage=2;S.groups=[{id:1,chats:[{question:'旧缓存对话'}]}]");
  const pending=a.run('togglePresentationMode()');
  assert.equal(a.calls.length,2);assert.match(a.calls[1].url,/groups\?stage=2$/);
  a.calls[0].reply(presentedWork(1));
  a.calls[1].reply([{id:1,chats:[{author:'第 1 组',question:'<script>比较两侧</script>',answer:'用什么指标判断？',created:12,images:[{id:'photo',name:'设计照片'}]}]},{id:2,chats:[{question:'别组对话'}]}]);
  await pending;
  const html=a.el('#comparison').innerHTML;
  assert.match(html,/第 1 组与 AI 对话/);assert.match(html,/&lt;script&gt;/);assert.match(html,/用什么指标判断/);
  assert.match(html,/files\/photo\?preview=true/);
  assert.doesNotMatch(html,/<script>|旧缓存对话|别组对话|comparison-score|尚未提交的修改/);
  assert.equal(a.el('#presentationGroup').value,1);
  const back=a.run('togglePresentationMode()');a.calls[2].reply(presentedWork(1));await back;
  assert.match(a.el('#comparison').innerHTML,/第 1 组成果/);
});

test('late chat responses cannot replace work mode and rotation preserves chat mode',async()=>{
  const a=presentationSetup(),old=a.run('togglePresentationMode()'),current=a.run('togglePresentationMode()');
  a.calls[2].reply(presentedWork(1));await current;
  a.calls[0].reply(presentedWork(1));a.calls[1].reply([{id:1,chats:[{question:'迟到的对话',answer:'迟到回复'}]}]);await old;
  assert.doesNotMatch(a.el('#comparison').innerHTML,/迟到/);
  a.run("presentation.mode='chat';togglePresentationAuto()");
  const pending=[...a.timers.values()][0].fn();
  a.calls[3].reply(presentedWork(2));a.calls[4].reply([{id:2,chats:[{question:'第二组的问题',answer:'第二组的回复'}]}]);await pending;
  assert.equal(a.run('presentation.mode'),'chat');assert.equal(a.timers.size,1);
  assert.match(a.el('#comparison').innerHTML,/第 2 组与 AI 对话/);
});

test('projection never presents a draft as submitted work or invents missing praise',async()=>{
  const a=presentationSetup(),w=presentedWork(1);w.versions=[];
  const pending=a.run('compare()');a.calls[0].reply(w);await pending;
  assert.match(a.el('#comparison').innerHTML,/尚未提交/);
  assert.doesNotMatch(a.el('#comparison').innerHTML,/尚未提交的修改|本环节 15/);
  const ready=presentedWork(1);ready.scores.stages[0].feedback.strengths=[];
  assert.doesNotMatch(a.run(`presentationScoreHTML(${JSON.stringify(ready)})`),/主要优点/);
  ready.scores.stages=[];
  assert.match(a.run(`presentationScoreHTML(${JSON.stringify(ready)})`),/更新展示/);
});

test('stage one separates submitted design from the unscored result',async()=>{
  const a=presentationSetup();a.run("S.lesson.flow_version=3;matchHTML=m=>m?'对应实验结果图':''");
  const w=presentedWork(1);w.versions[0].result_match={status:'ready'};
  const pending=a.run('compare()');a.calls[0].reply(w);await pending;
  const html=a.el('#comparison').innerHTML;
  assert.match(html,/本环节不计分/);assert.match(html,/对应实验结果图/);
  assert.ok(html.indexOf('对应实验结果图')>html.indexOf('projection-review'));
  assert.doesNotMatch(html,/本环节 15|第 1 组请统一观察时间/);
});

test('historical feedback previews fifty Unicode characters and retains escaped full text',()=>{
  const a=presentationSetup(),text='🧪'.repeat(51)+'<script>旧建议</script>';
  const html=a.run(`feedbackTextHTML(${JSON.stringify(text)})`);
  assert.match(html,/展开全文/);assert.match(html,/&lt;script&gt;/);assert.doesNotMatch(html,/<script>|<details[^>]*open/);
  assert.ok(html.includes('🧪'.repeat(50)+'…'));
  assert.ok(html.includes('🧪'.repeat(51)));
  assert.equal(a.run("feedbackTextHTML('请补充对照组。')"),'请补充对照组。');
});

test('stage-one conversation projection includes submitted photos and result replies in order',()=>{
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


test('grape lesson shows only matched mass rows and retains clarification when unmatched',()=>{
  const h=setup();
  h.run("S.lesson.flow_version=4; S.stage=1");
  const html=h.run(`grapeResultsHTML({revision:1,status:'ready',matches:[{label:'水处理对照',mass:170,uncertainty:5.7,significance:'d',excerpt:'<img onerror=alert(1)>'}],questions:[],uncovered:['苹果GA3'],error:''})`);
  assert.match(html,/170 ± 5.7/);
  assert.match(html,/百粒质量 \/ g/);
  assert.doesNotMatch(html,/来源|课件参考|匹配依据|字母标记|暂无对应|<img|onerror|result\.png/);
  const unmatched=h.run(`grapeResultsHTML({revision:1,status:'needs_clarification',matches:[],questions:['请写明各组处理'],uncovered:['苹果GA3'],error:''})`);
  assert.match(unmatched,/请写明各组处理/);
  assert.match(unmatched,/暂无对应课件数据：苹果GA3/);
  assert.equal(h.run('isInquiry()'),true);
  assert.equal(h.run('isGrape()'),true);
});

test('saved grape result replies use the concise display without changing cases or other stages',()=>{
  const h=setup();h.run('S.lesson.flow_version=4;S.stage=1');
  const result='对应处理的百粒质量：\nGA₃：225 ± 2.8 g（字母标记 c）\nCPPU：300 ± 2.8 g（字母标记 b）';
  const saved=result+'\n\n来源：教师提供的《植物激素》课件第4页。这些是课件参考数据，并非本组实测；不据此推算未提供条件的结果。\n\n是否加入CPPU？';
  const compact='对应处理的百粒质量：\nGA₃：225 ± 2.8 g\nCPPU：300 ± 2.8 g';
  assert.equal(h.run(`chatAnswerText(${JSON.stringify(saved)})`),compact);
  const cases='生长素案例\n案例内容\n\n来源：教师提供的《植物激素》课件第3页。';
  assert.equal(h.run(`chatAnswerText(${JSON.stringify(cases+'\n\n'+saved)})`),cases+'\n\n'+compact);
  assert.equal(h.run(`chatAnswerText(${JSON.stringify(cases)})`),cases);
  const html=h.run(`chatsHTML([{author:'第 1 组',question:'加入GA3',answer:${JSON.stringify(saved)}}])`);
  assert.match(html,/225 ± 2.8 g/);assert.doesNotMatch(html,/字母标记|来源|是否加入/);
  h.run('S.stage=2');assert.equal(h.run(`chatAnswerText(${JSON.stringify(saved)})`),saved);
  h.run('S.stage=1;S.lesson.flow_version=3');assert.equal(h.run(`chatAnswerText(${JSON.stringify(saved)})`),saved);
});

test('grape stage two retains the student score bubble and revision advice',()=>{
  const h=setup();
  h.run(`S.lesson.flow_version=4;S.stage=2;S.edit=S.savedEdit=0;
    renderStudentScore({total:80,graded:1,maximum:100,stages:[{stage:2,version_id:'v',revision:1,status:'ready',total:80,maximum:100,items:[],history:[],feedback:{source:'ai',strengths:[{text:'阶段明确'}],improvements:[{text:'补充品质证据'}]}}]});`);
  assert.equal(h.el('#scoreBubblePoints').textContent,'80 / 100');
  assert.match(h.el('#studentScore').innerHTML,/补充品质证据/);
});

test('photo-only projection omits empty text fields and partial historical marks do not claim full credit',()=>{
  const a=presentationSetup();
  assert.doesNotMatch(a.run("fieldsHTML({design:''},true)"),/尚未填写|实验设计/);
  assert.match(a.run("fieldsHTML({design:''})"),/尚未填写/);
  const html=a.run("studentFeedbackHTML({total:5,maximum:10,feedback:{strengths:[],improvements:[]}})");
  assert.doesNotMatch(html,/已达到本环节要求/);
  assert.match(html,/暂无改进建议/);
});

test('10.2 results retain mixed warnings in chat, submission history and projection',()=>{
  const h=setup('https://lsclass.top/lesson/paths.js');h.run('S.lesson.flow_version=5;S.stage=1');
  assert.equal(h.run('isInquiry()'),true);assert.equal(h.run('isGrape()'),true);
  const result={revision:1,status:'ready',matches:[{label:'CPPU',mass:300,uncertainty:2.8}],questions:['D组处理是什么？'],uncovered:['B组GA3 50mg/L<未知>'],error:''};
  const html=h.run(`grapeResultsHTML(${JSON.stringify(result)},false)`);
  assert.match(html,/300 ± 2.8/);assert.match(html,/D组处理是什么/);
  assert.match(html,/暂无对应课件数据：B组GA3 50mg\/L&lt;未知&gt;/);
  const answer='对应处理的百粒质量：\nCPPU：300 ± 2.8 g\n\n暂无对应课件数据：B组浓度改变';
  assert.equal(h.run(`chatAnswerText(${JSON.stringify(answer)})`),answer);
  const version={id:'v5',revision:1,updated:10,fields:{design:'混合处理'},file_ids:[],result_match:result};
  assert.match(h.run(`chatsHTML([],${JSON.stringify([version])},[])`),/暂无对应课件数据/);
  const image=h.run(`materialHTML({id:'grape-quality',kind:'实验结果',title:'品质',source:'10.2课件',paragraphs:[],images:[{url:'/api/classroom/lessons/l/materials/grape-quality/assets/grape-1002-quality.jpg',caption:'数据'}]})`);
  assert.match(image,/src="\/lesson\/api\/classroom/);
});

test('10.2 scheme evaluation keeps the existing score bubble',()=>{
  const h=setup();h.run(`S.lesson.flow_version=5;S.stage=2;S.edit=S.savedEdit=0;
    renderStudentScore({total:90,graded:1,maximum:100,stages:[{stage:2,version_id:'v5',revision:1,status:'ready',total:90,maximum:100,items:[],history:[],feedback:{source:'ai',strengths:[{text:'区分芽与种子'}],improvements:[{text:'补充跟踪指标'}]}}]});`);
  assert.equal(h.el('#scoreBubblePoints').textContent,'90 / 100');
  assert.match(h.el('#studentScore').innerHTML,/补充跟踪指标/);
});

test('10.2 control appears with submitted results, never on initial entry, and keeps clarification',()=>{
  const h=setup();h.run('S.lesson.flow_version=5;S.stage=1');
  assert.doesNotMatch(h.run('grapeResultsHTML(null)'),/170|225|300|320/);
  const control={result_id:'water',label:'蒸馏水',mass:170,uncertainty:5.7};
  const result={revision:1,status:'needs_clarification',matches:[control],questions:['照片看不清，请补拍'],uncovered:[],error:''};
  const html=h.run(`grapeResultsHTML(${JSON.stringify(result)})`);
  assert.match(html,/蒸馏水/);assert.match(html,/170 ± 5.7/);
  assert.match(html,/照片看不清，请补拍/);assert.doesNotMatch(html,/225|300|320/);
  result.status='ready';result.questions=[];
  result.matches.push({result_id:'cppu',label:'CPPU',mass:300,uncertainty:2.8});
  const version={id:'v5',revision:1,updated:10,fields:{design:'B组：CPPU'},file_ids:[],result_match:result};
  const conversation=h.run(`chatsHTML([],${JSON.stringify([version])},[])`);
  assert.equal((conversation.match(/170 ± 5.7/g)||[]).length,1);
  assert.match(conversation,/300 ± 2.8/);
  assert.match(h.run(`matchHTML(${JSON.stringify(result)},false)`),/蒸馏水/);
});


test('streaming chat paints escaped partial text before completion and saves one final bubble',async()=>{
  const a=setup();a.run("S.edit=S.savedEdit=0;S.groups=[{id:1,chats:[]}];S.user.name='第 1 组'");
  a.el('#chatInput').value='请检查方案';
  const pending=a.run('sendChat()');await tick();
  assert.equal(a.calls[0].headers.Accept,'text/event-stream');
  let controller;
  a.calls[0].replyRaw(new Response(new ReadableStream({start(c){controller=c;}}),{status:201,headers:{'Content-Type':'text/event-stream'}}));
  const emit=(kind,data)=>controller.enqueue(new TextEncoder().encode(`event: ${kind}\ndata: ${JSON.stringify(data)}\n\n`));
  emit('text',{text:'请先观察。<img onerror=alert(1)>'});await tick();
  assert.equal(a.run('S.sending'),true);assert.equal(a.run('S.groups[0].chats.length'),0);
  assert.match(a.el('#chatMessages').innerHTML,/请先观察/);
  assert.match(a.el('#chatMessages').innerHTML,/&lt;img onerror/);
  assert.doesNotMatch(a.el('#chatMessages').innerHTML,/<img onerror/);
  emit('done',{id:99,question:'请检查方案',answer:'请先观察。再核对对照。',images:[]});
  await pending;
  assert.equal(a.run('S.sending'),false);assert.equal(a.run('S.groups[0].chats.length'),1);
  assert.equal(a.run('S.pending'),null);
});

test('a broken stream marks partial text incomplete and retries the same request ID',async()=>{
  const a=setup();a.run('S.edit=S.savedEdit=0;S.groups=[{id:1,chats:[]}]');a.el('#chatInput').value='检查实验';
  const pending=a.run('sendChat()');await tick();const id=a.calls[0].body.request_id;
  a.calls[0].replyRaw(new Response('event: text\ndata: {"text":"请核对。"}\n\n',{status:201,headers:{'Content-Type':'text/event-stream'}}));
  await pending;
  assert.match(a.el('#chatMessages').innerHTML,/回复未完成/);assert.equal(a.run('S.groups[0].chats.length'),0);
  const retry=a.run('sendChat(true)');await tick();
  assert.equal(a.calls[1].body.request_id,id);assert.equal(a.run('S.pending.answer'),'');
  a.calls[1].reply({id:1,question:'检查实验',answer:'完整答复。',images:[]},201);await retry;
  assert.equal(a.run('S.groups[0].chats.length'),1);
});

test('late streamed text cannot enter a different lesson context',async()=>{
  const a=setup();a.run('S.edit=S.savedEdit=0;S.groups=[{id:1,chats:[]}]');a.el('#chatInput').value='检查实验';
  const pending=a.run('sendChat()');await tick();
  a.run('S.seq++;S.pending=null');
  a.calls[0].replyRaw(new Response('event: text\ndata: {"text":"旧课的片段。"}\n\nevent: done\ndata: {"id":1,"answer":"旧课回答。"}\n\n',{status:201,headers:{'Content-Type':'text/event-stream'}}));
  await pending;
  assert.equal(a.run('S.pending'),null);assert.equal(a.run('S.groups[0].chats.length'),0);
  assert.doesNotMatch(a.el('#chatMessages').innerHTML,/旧课的片段/);
});
