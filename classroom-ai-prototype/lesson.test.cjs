const {test}=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const fs=require('node:fs');
const source=fs.readFileSync(require('node:path').join(__dirname,'lesson.js'),'utf8');

function setup(){
  const elements=new Map(), local=new Map(), calls=[];
  const el=s=>{if(!elements.has(s))elements.set(s,{value:'',disabled:false,innerHTML:'',textContent:'',dataset:{},classList:{add(){},remove(){}},insertAdjacentHTML(){}});return elements.get(s);};
  const fields=[{value:'观察',dataset:{field:'observation'}},{value:'假说',dataset:{field:'hypothesis'}}];
  const context=vm.createContext({document:{querySelector:el,querySelectorAll:s=>s==='[data-field]'?fields:[]},
    FormData,setTimeout:()=>1,clearTimeout(){},crypto:require('node:crypto').webcrypto,
    sessionStorage:{setItem:(k,v)=>local.set(k,v),removeItem:k=>local.delete(k),getItem:k=>local.get(k)},
    fetch:(url,options)=>new Promise(resolve=>calls.push({url,body:options.body?JSON.parse(options.body):null,reply:(data,status=200)=>resolve({ok:status<400,status,json:async()=>data})}))});
  vm.runInContext(source.slice(0,source.indexOf('\nconst camera=')),context);
  vm.runInContext("Object.assign(S,{user:{role:'student',groupId:1},lesson:{id:'lesson',status:'live'},stage:1,content:{content:{fields:[]}},work:{work:{revision:0,file_ids:[],fields:{}},files:[],versions:[],assignment:null},edit:1,savedEdit:0});",context);
  return{calls,fields,local,el,run:code=>vm.runInContext(code,context)};
}
const tick=()=>new Promise(resolve=>setImmediate(resolve));
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
