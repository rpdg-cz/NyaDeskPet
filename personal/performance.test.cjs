const {test}=require('node:test');
const assert=require('node:assert/strict');
const {policy,PoseContinuity}=require('./performance.js');
test('new cue blends from the displayed pose without snapping to neutral',()=>{
 const p=new PoseContinuity(),settings=policy();
 p.phase('a','speaking',0,settings);p.sample('a',[12,-8],0);
 p.begin('a',100,400);
 assert.deepEqual(p.sample('a',[-12,8],100),[12,-8]);
 assert.deepEqual(p.sample('a',[-12,8],300),[0,0]);
 assert.deepEqual(p.sample('a',[-12,8],500),[-12,8]);
});
test('speaker becomes listener without losing pose; repeated cues resume from the last rendered blend',()=>{
 const p=new PoseContinuity(),settings=policy();
 p.phase('a','speaking',0,settings);p.sample('a',[20],0);
 p.phase('a','listening',100,settings);
 assert.deepEqual(p.sample('a',[20],200),[20]);
 p.begin('a',250,400);p.sample('a',[-20],450);
 p.begin('a',450,400);
 assert.deepEqual(p.sample('a',[30],450),[0]);
 assert.deepEqual(p.sample('a',[30],850),[30]);
});
test('stop/scene completion gently returns both actors to idle without restarting an existing idle transition',()=>{
 const p=new PoseContinuity(),settings=policy();
 for(const id of ['a','b']){p.phase(id,'speaking',0,settings);p.sample(id,[24],0);p.phase(id,'idle',100,settings);}
 assert.deepEqual(p.sample('a',[0],100),[24]);
 assert.equal(p.phase('a','idle',200,settings),false);
 assert.deepEqual(p.sample('a',[0],550),[12]);
 assert.deepEqual(p.sample('b',[0],1000),[0]);
 assert.equal(p.read().find(s=>s.id==='b').phase,'idle');
});
test('legacy reset policy normalizes to continuity and transition durations are bounded',()=>{
 assert.equal(policy({resetBeforeTurn:true}).resetBeforeTurn,false);
 assert.equal(policy({transitionMs:-1}).transitionMs,100);
 assert.equal(policy({idleTransitionMs:Infinity}).idleTransitionMs,900);
});
