const {test}=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const fs=require('node:fs');
const path=require('node:path');

function setup(){
  const elements=new Map();
  const el=id=>{
    if(!elements.has(id)){
      const classes=new Set();
      elements.set(id,{dataset:{},innerHTML:'',textContent:'',attributes:{},
        classList:{toggle:(k,v)=>v?classes.add(k):classes.delete(k),contains:k=>classes.has(k)},
        setAttribute(k,v){this.attributes[k]=v;},replaceChildren(){this.innerHTML='';}});
    }
    return elements.get(id);
  };
  const score={stage:1,version_id:'v1',revision:1,status:'ready',total:12,maximum:20,
    items:[{key:'design',label:'实验设计',points:12,maximum:20}],
    feedback:{source:'ai',strengths:[{key:'design',text:'保留透明罩对照'}],improvements:[{key:'design',text:'明确观察什么变化'}]}};
  const S={user:{role:'student',groupId:1},lesson:{id:'lesson',flow_version:2,status:'live'},stage:1,edit:0,savedEdit:0,
    work:{work:{revision:1},versions:[{id:'v1',revision:1,fields:{}}]}};
  const context=vm.createContext({S,$:el,$$:()=>[],show:(id,on)=>el(id).classList.toggle('hidden',!on),
    isTeacher:()=>S.user?.role==='teacher',isInquiry:()=>S.lesson?.flow_version===3,esc:s=>String(s??'').replaceAll('<','&lt;').replaceAll('>','&gt;'),
    scoreStatus:{ready:'已评分',pending:'待评分'},scores:{stages:[score],total:12,graded:1}});
  vm.runInContext(fs.readFileSync(path.join(__dirname,'score-bubble.js'),'utf8'),context);
  return {S,score,el,run:code=>vm.runInContext(code,context)};
}

test('a completed score opens persistent feedback; polling preserves a user collapse',()=>{
  const a=setup();a.run('renderStudentScore(scores)');
  assert.equal(a.el('#scoreBubbleToggle').attributes['aria-expanded'],'true');
  assert.match(a.el('#studentScore').innerHTML,/保留透明罩对照/);
  a.run('setScoreBubbleExpanded(false);renderStudentScore(scores)');
  assert.equal(a.el('#scoreBubbleToggle').attributes['aria-expanded'],'false');
  a.score.version_id='v2';a.score.revision=2;a.S.work.versions=[];
  a.run('renderStudentScore(scores)');
  assert.equal(a.el('#scoreBubbleToggle').attributes['aria-expanded'],'true');
});
test('a submitted version awaiting the next poll hides outdated scores and feedback',()=>{
  const a=setup();a.S.work.versions=[{id:'v2',revision:2,fields:{}}];
  a.run('renderStudentScore(scores)');
  assert.equal(a.el('#scoreBubblePoints').textContent,'— / 20');
  assert.doesNotMatch(a.el('#studentScore').innerHTML,/保留透明罩对照/);
  assert.match(a.el('#studentScore').innerHTML,/正在排队评分/);
});
test('draft edits label the assessment as previous and cannot erase the advice',()=>{
  const a=setup();a.S.edit=1;a.run('renderStudentScore(scores)');
  assert.match(a.el('#studentScore').innerHTML,/已修改，待再次提交/);
  assert.match(a.el('#studentScore').innerHTML,/明确观察什么变化/);
});

test('legacy task marks stay in history while the new task asks for a new submission',()=>{
  const a=setup();a.S.lesson.flow_version=3;a.score.status='previous_task';a.score.total=null;
  a.run('renderStudentScore(scores)');
  assert.match(a.el('#studentScore').innerHTML,/请提交研究水稻突变体的新方案/);
  assert.doesNotMatch(a.el('#studentScore').innerHTML,/保留透明罩对照/);
});
test('feedback text is escaped and displayed improvements never exceed two',()=>{
  const a=setup();a.score.feedback.strengths[0].text='<img src=x onerror=attack()>';
  a.score.feedback.improvements=[1,2,3].map(i=>({text:'建议'+i}));a.run('renderStudentScore(scores)');
  assert.match(a.el('#studentScore').innerHTML,/&lt;img/);
  assert.doesNotMatch(a.el('#studentScore').innerHTML,/<img|建议3/);
});
test('teacher, logged-out and legacy views cannot retain student feedback',()=>{
  const a=setup();a.run('renderStudentScore(scores)');a.S.user.role='teacher';a.run('renderStudentScore(scores)');
  assert.equal(a.el('#studentScoreBubble').classList.contains('hidden'),true);
  assert.equal(a.el('#studentScore').innerHTML,'');
  a.S.user=null;a.run('renderStudentScore(scores)');
  a.S.user={role:'student',groupId:2};a.S.lesson.flow_version=1;a.run('renderStudentScore(scores)');
  assert.equal(a.el('#studentScoreBubble').classList.contains('hidden'),true);
});
