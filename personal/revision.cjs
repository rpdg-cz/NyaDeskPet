const {validateTimeline}=require('./authoring.cjs');
function selectionContext(archive,lineIndex,startMs,endMs){
 if(!Number.isInteger(lineIndex)||!archive.turns[lineIndex])throw new Error('请选择需要修改的台词');
 if(!Number.isInteger(startMs)||!Number.isInteger(endMs)||startMs<0||endMs>6000||startMs>endMs)throw new Error('修改时间范围无效');
 const turn=archive.turns[lineIndex],character=archive.cast.find(c=>c.id===turn.characterId);
 return {tool:'inspect_performance_segment',sceneId:archive.sceneId,revision:archive.revision,lineIndex,startMs,endMs,characterId:character.id,text:turn.text,events:turn.timeline.filter(c=>c.atMs>=startMs&&c.atMs<=endMs),context:archive.turns.slice(Math.max(0,lineIndex-1),lineIndex+2).map(t=>({characterId:t.characterId,text:t.text})),allowedActions:character.actions};
}
async function reviseSegment({archive,feedback,lineIndex,startMs,endMs,request,provider}){
 if(typeof feedback!=='string'||!feedback.trim()||feedback.length>4000)throw new Error('请填写修改意见（最多4000字）');
 const selected=selectionContext(archive,lineIndex,startMs,endMs);
 const messages=[{role:'system',content:'你是局部表演修订助手。先调用inspect_performance_segment定位用户选择，严格使用用户提供的lineIndex/startMs/endMs。'}, {role:'user',content:JSON.stringify({selection:{lineIndex,startMs,endMs},feedback})}];
 const firstResponse=await request(provider,'/chat/completions',{model:provider.model,stream:false,thinking:{type:'disabled'},max_tokens:400,messages,tools:[{type:'function',function:{name:'inspect_performance_segment',description:'读取用户选中的台词、表演事件和可用动作，不修改数据。',parameters:{type:'object',properties:{lineIndex:{type:'integer'},startMs:{type:'integer'},endMs:{type:'integer'}},required:['lineIndex','startMs','endMs'],additionalProperties:false}}}],tool_choice:{type:'function',function:{name:'inspect_performance_segment'}}});
 const firstData=await firstResponse.json(),toolMessage=firstData.choices?.[0]?.message;
 if(toolMessage?.tool_calls?.length!==1||toolMessage.tool_calls[0].function?.name!=='inspect_performance_segment')throw new Error('修改助手未按要求调用定位工具');
 const toolCall=toolMessage.tool_calls[0],args=JSON.parse(toolCall.function.arguments);
 if(args.lineIndex!==lineIndex||args.startMs!==startMs||args.endMs!==endMs)throw new Error('工具试图越过用户选择范围，修改已拒绝');
 const toolResult=selected;
 const prompt='仅修改工具返回的指定台词时间范围内的动作。用户意见：'+feedback+'。保留原文、人物、布局和范围外事件；避免无语境的偏头、摇晃，允许删除多余身体动作而只保留表情。返回JSON {"events":[{"atMs":时间,"action":"允许动作键"}],"explanation":"修改原因"}。events可空表示删除此范围动作，时间必须落在选择范围内。idle也可能包含身体motion；用户要求停止摇晃时优先still（显式停止motion）或仅表情动作。';
 const response=await request(provider,'/chat/completions',{model:provider.model,stream:false,thinking:{type:'disabled'},response_format:{type:'json_object'},max_tokens:1800,messages:[{role:'system',content:'你是局部表演修订助手。根据inspect_performance_segment工具结果，只输出受限动作补丁JSON，不输出完整场景。'}, ...messages.slice(1),{role:'assistant',content:toolMessage.content||null,tool_calls:[toolCall]},{role:'tool',tool_call_id:toolCall.id,content:JSON.stringify(toolResult)},{role:'user',content:prompt}]});
 const data=await response.json();if(data.choices?.[0]?.finish_reason==='length')throw new Error('局部修改结果截断');
 const patch=JSON.parse(data.choices?.[0]?.message?.content||'{}');
 if(!Array.isArray(patch.events)||patch.events.length>8||patch.events.some(e=>!e||!Number.isInteger(e.atMs)||e.atMs<startMs||e.atMs>endMs))throw new Error('局部补丁越界或格式错误');
 const revised=structuredClone(archive),turn=revised.turns[lineIndex],character=revised.cast.find(c=>c.id===turn.characterId);
 const preserved=turn.timeline.filter(e=>e.atMs<startMs||e.atMs>endMs);
 const events=[...preserved,...patch.events.map(({atMs,action})=>({atMs,action}))].sort((a,b)=>a.atMs-b.atMs);
 if(!events.length||events[0].atMs!==0)events.unshift({atMs:0,action:character.actions.still?'still':'idle'});
 const checked=validateTimeline(events,character);
 turn.timeline=checked.map(e=>structuredClone(preserved.find(p=>p.atMs===e.atMs)||{...e,command:character.actions[e.action]||{}}));turn.action=turn.timeline[0].action;
 revised.revision++;revised.published=false;delete revised.confirmedByUser;revised.review={status:'needs-user-preview',kind:'targeted-edit'};
 revised.editHistory=[...(revised.editHistory||[]),{at:new Date().toISOString(),feedback,selection:{lineIndex,startMs,endMs},toolCall,toolResult,prompt,patch}];
 return revised;
}
module.exports={selectionContext,reviseSegment};
