const {test}=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const fs=require('node:fs');
const path=require('node:path');
const source=fs.readFileSync(path.join(__dirname,'student-sidebar.js'),'utf8');

function setup(){
  const timers=new Map();let timer=0;
  function element(parent=null){
    const classes=new Set();
    return {parent,attributes:{},listeners:{},inert:false,
      classList:{contains:key=>classes.has(key),toggle(key,on){on?classes.add(key):classes.delete(key);}},
      contains(node){return !!node&&(node===this||this.contains(node.parent));},
      setAttribute(key,value){this.attributes[key]=value;},
      addEventListener(type,callback){this.listeners[type]=callback;},
      emit(type,event={}){this.listeners[type]?.(event);},
      focus(){document.activeElement=this;},closest(){return null;}
    };
  }
  const app=element(),sidebar=element(app),toggle=element(app),select=element(sidebar),main=element(app),legacy=element(sidebar);
  select.tagName='SELECT';legacy.closest=selector=>selector==='#legacyButton'?legacy:null;
  sidebar.querySelector=()=>select;
  const document=element();document.activeElement=main;
  document.querySelector=selector=>({'#app':app,'#classroomSidebar':sidebar,'#sidebarToggle':toggle}[selector]);
  app.classList.toggle('student-view',true);
  const context=vm.createContext({document,setTimeout:fn=>{timers.set(++timer,fn);return timer;},clearTimeout:id=>timers.delete(id)});
  vm.runInContext(source,context);
  return {app,sidebar,toggle,select,main,legacy,document,
    reset:()=>context.classroomSidebar.reset(),
    runTimers(){const pending=[...timers.values()];timers.clear();pending.forEach(fn=>fn());},
    open(){toggle.emit('click');},isOpen:()=>toggle.attributes['aria-expanded']==='true'};
}

test('student starts collapsed and the arrow opens accessible navigation',()=>{
  const a=setup();assert.equal(a.isOpen(),false);assert.equal(a.sidebar.inert,true);
  a.open();assert.equal(a.isOpen(),true);assert.equal(a.sidebar.inert,false);
  assert.equal(a.toggle.attributes['aria-label'],'收起课堂导航');
  a.toggle.emit('click');assert.equal(a.isOpen(),false);
});
test('leaving with the mouse retracts the drawer; returning cancels retraction',()=>{
  const a=setup();a.open();
  a.sidebar.emit('pointerleave',{pointerType:'mouse',relatedTarget:a.main});
  assert.equal(a.isOpen(),true);
  a.sidebar.emit('pointerenter');a.runTimers();assert.equal(a.isOpen(),true);
  a.sidebar.emit('pointerleave',{pointerType:'mouse',relatedTarget:a.toggle});a.runTimers();assert.equal(a.isOpen(),true);
  a.toggle.emit('pointerleave',{pointerType:'mouse',relatedTarget:a.main});a.runTimers();assert.equal(a.isOpen(),false);
});
test('touch navigation stays open until an outside click, and old records dismiss it',()=>{
  const a=setup();a.open();
  a.sidebar.emit('pointerleave',{pointerType:'touch',relatedTarget:a.main});a.runTimers();assert.equal(a.isOpen(),true);
  a.document.emit('click',{target:a.select});assert.equal(a.isOpen(),true);
  a.document.emit('click',{target:a.main});assert.equal(a.isOpen(),false);
  a.open();a.sidebar.emit('click',{target:a.legacy});assert.equal(a.isOpen(),false);
});
test('keyboard focus is preserved during mouse movement, Escape closes and returns focus',()=>{
  const a=setup();a.document.emit('keydown',{key:'Tab'});a.open();
  assert.equal(a.document.activeElement,a.select);
  a.sidebar.emit('pointerleave',{pointerType:'mouse',relatedTarget:a.main});a.runTimers();assert.equal(a.isOpen(),true);
  a.document.emit('keydown',{key:'Escape',preventDefault(){}});
  assert.equal(a.isOpen(),false);assert.equal(a.document.activeElement,a.toggle);
  a.open();a.main.focus();a.sidebar.emit('focusout',{relatedTarget:a.main});assert.equal(a.isOpen(),false);
});
test('a native select opening outside the browser does not retract the sidebar',()=>{
  const a=setup();a.open();a.select.focus();
  a.sidebar.emit('pointerleave',{pointerType:'mouse',relatedTarget:null});a.runTimers();assert.equal(a.isOpen(),true);
});
test('role changes and lesson resets clear timers and keep teacher navigation interactive',()=>{
  const a=setup();a.open();a.sidebar.emit('pointerleave',{pointerType:'mouse',relatedTarget:a.main});
  a.app.classList.toggle('student-view',false);a.reset();a.runTimers();
  assert.equal(a.isOpen(),false);assert.equal(a.sidebar.inert,false);
  a.document.emit('click',{target:a.main});a.open();assert.equal(a.sidebar.inert,false);
  a.app.classList.toggle('student-view',true);a.reset();assert.equal(a.sidebar.inert,true);
  a.open();a.reset();assert.equal(a.isOpen(),false);
});
