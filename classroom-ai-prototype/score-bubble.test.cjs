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
    isTeacher:()=>S.user?.role==='teacher',isInquiry:()=>[3,4,5].includes(S.lesson?.flow_version),esc:s=>String(s??'').replaceAll('<','&lt;').replaceAll('>','&gt;'),
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
test('a submitted version awaiting the next poll retains complete feedback with a clear version label',()=>{
  const a=setup();a.S.work.versions=[{id:'v2',revision:2,fields:{}}];
  a.run('renderStudentScore(scores)');
  assert.equal(a.el('#scoreBubblePoints').textContent,'12 / 20');
  assert.match(a.el('#studentScore').innerHTML,/保留透明罩对照/);
  assert.match(a.el('#studentScore').innerHTML,/明确观察什么变化/);
  assert.match(a.el('#studentScore').innerHTML,/实验设计<\/span><strong>12 \/ 20/);
  assert.doesNotMatch(a.el('#studentScore').innerHTML,/针对本环节最新提交的评价/);
  assert.match(a.el('#studentScore').innerHTML,/正在排队评分/);
  assert.match(a.el('#studentScore').innerHTML,/当前保留第 1 次提交的得分与评价/);
  assert.match(a.el('#studentScore').innerHTML,/分数变化/);
  assert.match(a.el('#studentScore').innerHTML,/本组累计 <strong>12 \/ 100/);
});
for(const status of ['pending','processing','failed','needs_clarification'])test(`${status} survives reload with the previous zero score and full feedback`,()=>{
  const a=setup();
  a.S.lesson.flow_version=5;
  const history={version_id:'v1',revision:1,submission_number:1,status:'corrected',total:0,maximum:20};
  const previous={...history,feedback:{source:'teacher_review',strengths:[],improvements:[{key:'design',text:'明确观察什么变化'}]},
    items:[{key:'design',label:'实验设计',points:0,maximum:20}]};
  Object.assign(a.score,{version_id:'v2',revision:2,total:null,status,feedback:null,items:[],retained_score:previous,history:[history],clarification:'请补拍新方案',updated:1});
  a.S.work.versions=[{id:'v2',revision:2,fields:{}}];
  a.run('renderStudentScore(scores)');
  assert.equal(a.el('#scoreBubblePoints').textContent,'0 / 20');
  assert.equal(a.el('#scoreBubbleToggle').attributes['aria-expanded'],'true');
  assert.match(a.el('#scoreBubbleStage').textContent,/保留上次得分/);
  assert.match(a.el('#studentScore').innerHTML,/第 1 次.*0 <small>\/ 20.*教师复核/s);
  assert.match(a.el('#studentScore').innerHTML,/本组累计 <strong>0 \/ 100/);
  assert.match(a.el('#studentScore').innerHTML,/明确观察什么变化/);
  assert.match(a.el('#studentScore').innerHTML,/实验设计<\/span><strong>0 \/ 20/);
  assert.doesNotMatch(a.el('#studentScore').innerHTML,/保留透明罩对照|针对本环节最新提交的评价/);
  if(status==='needs_clarification')assert.match(a.el('#studentScore').innerHTML,/请补拍新方案/);
  else assert.match(a.el('#studentScore').innerHTML,/data-inquiry-score-retry="v2"/);
});
test('new results replace the visible score, retain lower and higher past marks, and reopen the bubble',()=>{
  const a=setup();
  a.score.history=[{version_id:'v1',submission_number:1,total:12,maximum:20,status:'ready'}];
  a.run('renderStudentScore(scores);setScoreBubbleExpanded(false)');
  const previous={...a.score.history[0],feedback:a.score.feedback,items:a.score.items};
  Object.assign(a.score,{version_id:'v2',revision:2,status:'processing',total:null,feedback:null,items:[],retained_score:previous});
  a.S.work.versions=[{id:'v2',revision:2,fields:{}}];
  a.run('renderStudentScore(scores)');
  assert.equal(a.el('#scoreBubblePoints').textContent,'12 / 20');
  assert.equal(a.el('#scoreBubbleToggle').attributes['aria-expanded'],'false');
  assert.match(a.el('#studentScore').innerHTML,/保留透明罩对照|明确观察什么变化/);
  Object.assign(a.score,{status:'ready',total:8,retained_score:null,
    feedback:{source:'ai',strengths:[{key:'design',text:'新方案保留两侧来源'}],improvements:[{key:'design',text:'核对检测条件'}]},
    items:[{key:'design',label:'实验设计',points:8,maximum:20}]});
  a.score.history.push({version_id:'v2',submission_number:2,total:8,maximum:20,status:'ready'});
  a.run('renderStudentScore(scores)');
  assert.equal(a.el('#scoreBubblePoints').textContent,'8 / 20');
  assert.equal(a.el('#scoreBubbleToggle').attributes['aria-expanded'],'true');
  assert.match(a.el('#studentScore').innerHTML,/第 1 次.*12 <small>\/ 20.*第 2 次.*8 <small>\/ 20/s);
  assert.doesNotMatch(a.el('#studentScore').innerHTML,/当前保留|保留透明罩对照|明确观察什么变化/);
  assert.match(a.el('#studentScore').innerHTML,/新方案保留两侧来源/);
  assert.match(a.el('#studentScore').innerHTML,/核对检测条件/);
  assert.match(a.el('#studentScore').innerHTML,/实验设计<\/span><strong>8 \/ 20/);
});

test('another submission arriving before the score poll keeps the original full feedback',()=>{
  const a=setup();
  const history={version_id:'v1',revision:1,submission_number:1,status:'ready',total:12,maximum:20};
  const previous={...history,feedback:a.score.feedback,items:a.score.items};
  Object.assign(a.score,{version_id:'v2',revision:2,status:'failed',total:null,feedback:null,items:[],retained_score:previous,history:[history]});
  a.S.work.versions=[{id:'v3',revision:3,fields:{}}];
  a.run('renderStudentScore(scores)');
  assert.match(a.el('#studentScore').innerHTML,/当前保留第 1 次提交的得分与评价/);
  assert.match(a.el('#studentScore').innerHTML,/保留透明罩对照/);
  assert.match(a.el('#studentScore').innerHTML,/明确观察什么变化/);
  assert.match(a.el('#studentScore').innerHTML,/正在排队评分/);
});

test('switching groups cannot carry previous feedback into a first pending submission',()=>{
  const a=setup();a.run('renderStudentScore(scores)');
  a.S.user.groupId=2;a.S.work.versions=[{id:'other-v1',revision:1,fields:{}}];
  Object.assign(a.score,{version_id:'other-v1',status:'pending',total:null,feedback:null,items:[],retained_score:null,history:[]});
  a.run('renderStudentScore(scores)');
  assert.equal(a.el('#scoreBubblePoints').textContent,'— / 20');
  assert.doesNotMatch(a.el('#studentScore').innerHTML,/当前保留|保留透明罩对照|明确观察什么变化|查看分项得分/);
  assert.match(a.el('#studentScore').innerHTML,/正在排队评分/);
});
test('a completed work response wins over an older group poll without losing history',()=>{
  const a=setup();
  a.S.work.versions.push({id:'v2',revision:2,fields:{},assessment:{...a.score,version_id:'v2',revision:2,total:18}});
  a.run('renderStudentScore(scores)');
  assert.equal(a.el('#scoreBubblePoints').textContent,'18 / 20');
  assert.match(a.el('#studentScore').innerHTML,/第 1 次.*12 <small>\/ 20.*第 2 次.*18 <small>\/ 20/s);
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
