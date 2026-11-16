const fs = require('node:fs');
const path = require('node:path');
const REVIEW_VERSION = 1;
function assetCatalog(characters) {
  return characters.map(c => ({ id:c.id, name:c.name, userPrompt:c.userPrompt,
    presentation:c.presentation || {}, actions:Object.fromEntries(Object.entries(c.actions).map(([name,action])=>{
      let extremeMouth=false,closedEyes=false;
      if(action.expression && c.modelPath) {
        const modelFile=path.resolve(__dirname,'..',c.modelPath);
        const model=JSON.parse(fs.readFileSync(modelFile,'utf8'));
        const reference=model.FileReferences.Expressions.find(e=>e.Name===action.expression);
        if(reference) {
          const expression=JSON.parse(fs.readFileSync(path.join(path.dirname(modelFile),reference.File),'utf8'));
          extremeMouth=expression.Parameters.some(p=>p.Id==='ParamMouthOpenY'&&p.Value>.6);
          closedEyes=expression.Parameters.some(p=>/ParamEye[LR]Open/.test(p.Id)&&p.Blend==='Multiply'&&p.Value<.2);
        }
      }
      return [name,{...action,assetRisks:{extremeMouth,closedEyes}}];
    })) }));
}
function auditPerformance(turns,characters) {
  const issues=[];
  const totals=new Map(characters.map(c=>[c.id,{motion:0,expression:0}]));
  for(const [lineIndex,turn] of turns.entries()) {
    const character=characters.find(c=>c.id===turn.characterId);
    const timeline=turn.timeline;
    if(!timeline?.length) {issues.push({lineIndex,reason:'缺少时间轴'});continue;}
    if(timeline.length>4)issues.push({lineIndex,reason:'单句切换超过四次，表演过密'});
    if(turn.action!==timeline[0].action)issues.push({lineIndex,reason:'首动作与时间轴不一致'});
    let previous;
    for(const cue of timeline) {
      const action=character.actions[cue.action]||{};
      if(previous && cue.atMs-previous.atMs<350)issues.push({lineIndex,reason:'表演切换短于350ms，易显得抽动'});
      if(previous?.action===cue.action)issues.push({lineIndex,reason:'重复相同动作'});
      if(action.motion)totals.get(character.id).motion++;
      if(action.expression||action.parameters?.some(p=>/Eye|Mouth|Brow/.test(p.id)))totals.get(character.id).expression++;
      previous=cue;
    }
  }
  for(const c of characters) {
    if(Object.values(c.actions).some(a=>a.motion)&&!totals.get(c.id).motion)issues.push({characterId:c.id,reason:'角色没有身体动作'});
    if(Object.values(c.actions).some(a=>a.expression)&&!totals.get(c.id).expression)issues.push({characterId:c.id,reason:'角色没有面部表演'});
  }
  return issues;
}
async function reviewPerformance({turns,characters,prompt,request,provider,validate}) {
  const catalog=assetCatalog(characters),rounds=[];
  let candidate=turns;
  for(let attempt=0;attempt<2;attempt++) {
    const issues=auditPerformance(candidate,characters);
    const response=await request(provider,'/chat/completions',{
      model:provider.model,stream:false,response_format:{type:'json_object'},max_tokens:4096,temperature:.2,
      messages:[
        {role:'system',content:'你是独立的Live2D表演审稿员。你没有观看渲染画面，不能声称视觉审查通过。审查台词与情绪匹配、动作克制和时序、每个人物都有身体动作与面部表演、原台词和角色完全不变。参考assetRisks，安静闲聊避免频繁闭眼大笑/夸张张嘴/极端表情，不因资源名直接推定自然。返回JSON {"approved":true,"issues":[]}；需要修改则返回 {"approved":false,"issues":["具体原因"],"revisedTurns":[完整各句，保留characterId和text，action/emotion/timeline可修改]}。timeline从0开始，最多4事件，间隔>=350ms，末项<=6000ms。只能选给定角色动作，action必须等于首cue。'},
        {role:'user',content:JSON.stringify({prompt,characters:catalog,deterministicIssues:issues,turns:candidate})}
      ]
    });
    const data=await response.json();
    if(data.choices?.[0]?.finish_reason==='length')throw new Error('Review结果被截断，场景未发布到轮播。');
    const text=data.choices?.[0]?.message?.content;
    let verdict;try{verdict=JSON.parse(text);}catch{throw new Error('Review没有返回有效JSON，场景未发布到轮播。');}
    if(typeof verdict.approved!=='boolean'||!Array.isArray(verdict.issues))throw new Error('Review格式不完整，场景未发布到轮播。');
    rounds.push({attempt:attempt+1,approved:verdict.approved,issues:verdict.issues,deterministicIssues:issues});
    if(verdict.approved&&issues.length===0)return {turns:candidate,review:{version:REVIEW_VERSION,status:'approved',kind:'semantic-and-rules',visualReview:false,rounds}};
    if(attempt===1)break;
    if(!Array.isArray(verdict.revisedTurns))throw new Error('Review未批准且没有修订，场景未发布到轮播。');
    const revised=validate(verdict.revisedTurns,characters);
    if(revised.length!==turns.length||revised.some((t,i)=>t.characterId!==turns[i].characterId||t.text!==turns[i].text))throw new Error('Review试图改写原台词或说话人，修订已拒绝。');
    candidate=revised;
  }
  throw new Error('Review两轮后仍未通过，场景未发布到轮播。');
}
module.exports={REVIEW_VERSION,assetCatalog,auditPerformance,reviewPerformance};
