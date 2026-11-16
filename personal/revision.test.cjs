const {test}=require('node:test');
const assert=require('node:assert/strict');
const {compileArchive}=require('./archive.cjs');
const {reviseSegment}=require('./revision.cjs');
const template=require('./config.json');
function fixture(){return compileArchive({id:'a'.repeat(64),title:'雨后',turns:template.characters.map(c=>({characterId:c.id,text:'雨停了，去散步吧。',timeline:[{atMs:0,action:'pose_l'},{atMs:600,action:'happy'},{atMs:1200,action:'pose_r'}]}))},template.characters);}
const response=message=>({json:async()=>({choices:[{message}]})});
function requestFor(patch,args={lineIndex:0,startMs:600,endMs:1200},observe=()=>{}){return async(_p,_url,body)=>{
 observe(body);
 if(body.tools)return response({content:null,tool_calls:[{id:'real-call',type:'function',function:{name:'inspect_performance_segment',arguments:JSON.stringify(args)}}]});
 return response({content:JSON.stringify(patch)});
};}
function edit(archive,request,extra={}){return reviseSegment({archive,feedback:'不要偏头，安静微笑。',lineIndex:0,startMs:600,endMs:1200,request,provider:{model:'fixture'},...extra});}

test('actual tool call precedes bounded patch; text, other turns, layout and outside commands remain exact',async()=>{
 const archive=fixture(),original=structuredClone(archive),calls=[];
 const result=await edit(archive,requestFor({events:[{atMs:600,action:'still'},{atMs:1000,action:'happy'}],explanation:'停止身体摇晃'},undefined,b=>calls.push(b)));
 assert.equal(calls.length,2);assert.equal(calls[0].tool_choice.function.name,'inspect_performance_segment');
 assert.ok(calls[1].messages.some(m=>m.role==='tool'&&m.tool_call_id==='real-call'));
 assert.deepEqual(archive,original,'source version must remain untouched');
 assert.deepEqual(result.cast,archive.cast);assert.deepEqual(result.turns[1],archive.turns[1]);
 assert.equal(result.turns[0].text,archive.turns[0].text);
 assert.deepEqual(result.turns[0].timeline[0],archive.turns[0].timeline[0]);
 assert.equal(result.turns[0].timeline[1].command.stopMotion,true);
 assert.equal(result.published,false);assert.equal(result.revision,2);
 assert.match(result.editHistory[0].prompt,/不要偏头/);
});

test('wrong tool range, out-of-range patch, unknown actions, duplicate times and invalid selection are rejected',async()=>{
 await assert.rejects(edit(fixture(),requestFor({events:[]},{lineIndex:1,startMs:600,endMs:1200})),/越过/);
 for(const events of [[{atMs:500,action:'happy'}],[{atMs:600,action:'invented'}],[{atMs:600,action:'happy'},{atMs:600,action:'still'}]])await assert.rejects(edit(fixture(),requestFor({events})));
 let called=false;await assert.rejects(edit(fixture(),async()=>{called=true;},{startMs:1500,endMs:1200}));assert.equal(called,false);
});

test('deleting selected body events is allowed without rewriting other dialogue',async()=>{
 const archive=fixture();const result=await edit(archive,requestFor({events:[]}));
 assert.deepEqual(result.turns[0].timeline,[archive.turns[0].timeline[0]]);
 const all=await edit(archive,requestFor({events:[]},{lineIndex:0,startMs:0,endMs:6000}),{startMs:0,endMs:6000});
 assert.equal(all.turns[0].timeline[0].action,'still');assert.equal(all.turns[0].timeline[0].command.stopMotion,true);
});
