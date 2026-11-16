const {test}=require('node:test');
const assert=require('node:assert/strict');
const {reviewPerformance,auditPerformance}=require('./review.cjs');
const characters=[{id:'a',actions:{pose:{motion:{group:'turn',index:0}},happy:{expression:'smile'}}},{id:'b',actions:{pose:{motion:{group:'turn',index:0}},happy:{expression:'smile'}}}];
const turns=characters.map(c=>({characterId:c.id,text:'保留这句。',emotion:'happy',action:'pose',timeline:[{atMs:0,action:'pose'},{atMs:600,action:'happy'}]}));
const validate=x=>x;
const response=x=>({json:async()=>({choices:[{message:{content:JSON.stringify(x)}}]})});
test('review independently approves a valid two-role performance and records evidence',async()=>{
 let calls=0;
 const result=await reviewPerformance({turns,characters,prompt:'温和闲聊',provider:{model:'fake'},validate,request:async(_p,_url,body)=>{calls++;assert.match(body.messages[0].content,/没有观看渲染/);return response({approved:true,issues:[]});}});
 assert.equal(calls,1);assert.equal(result.review.visualReview,false);assert.equal(result.review.status,'approved');assert.deepEqual(result.turns,turns);
});
test('one revision is independently reviewed again without rewriting original text',async()=>{
 let calls=0;
 const revised=structuredClone(turns);revised[0].timeline[1].atMs=800;
 const result=await reviewPerformance({turns,characters,prompt:'温和',provider:{},validate,request:async()=>++calls===1?response({approved:false,issues:['节奏再慢些'],revisedTurns:revised}):response({approved:true,issues:[]})});
 assert.equal(calls,2);assert.equal(result.review.rounds.length,2);assert.equal(result.turns[0].timeline[1].atMs,800);
});
test('rule issues cannot be overridden by reviewer approval',async()=>{
 const invalid=structuredClone(turns);invalid[0].timeline[1].atMs=100;
 assert.ok(auditPerformance(invalid,characters).length);
 await assert.rejects(reviewPerformance({turns:invalid,characters,provider:{},validate,request:async()=>response({approved:true,issues:[]})}),/未批准且没有修订/);
});
test('review cannot rewrite dialogue and retry loop is bounded',async()=>{
 const rewritten=structuredClone(turns);rewritten[0].text='篡改';
 await assert.rejects(reviewPerformance({turns,characters,provider:{},validate,request:async()=>response({approved:false,issues:['改'],revisedTurns:rewritten})}),/改写原台词/);
 let calls=0;await assert.rejects(reviewPerformance({turns,characters,provider:{},validate,request:async()=>{calls++;return response({approved:false,issues:['不自然'],revisedTurns:turns});}}),/两轮/);assert.equal(calls,2);
});
