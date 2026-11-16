const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path');
const {writeJson}=require('./runtime.cjs');
async function runRevisionVerification(runtime){
 runtime.config.offline=false;
 assert.equal(runtime.config.tts.enabled,false);
 const previous=JSON.parse(fs.readFileSync(path.join(__dirname,'reports','deepseek-rain-walk-result.json'),'utf8'));
 const id=previous.result.id,before=runtime.archives.read(id);
 const options={lineIndex:0,startMs:0,endMs:0,feedback:'仅把第1句0ms的身体转向改为still：保持正面、停止偏头和摇晃。0ms之后已有的表情动作全部保留，台词完全不变。'};
 const result=await runtime.reviseScene(id,options),after=runtime.archives.read(result.id);
 assert.deepEqual(runtime.archives.read(id),before);
 assert.deepEqual(after.turns.slice(1),before.turns.slice(1));
 assert.deepEqual(after.cast,before.cast);
 assert.deepEqual(after.turns[0].timeline.slice(1),before.turns[0].timeline.slice(1));
 assert.equal(after.turns[0].text,before.turns[0].text);
 assert.equal(after.turns[0].timeline[0].action,'still');
 assert.equal(after.turns[0].timeline[0].command.stopMotion,true);
 assert.equal(after.published,false);
 runtime.config.offline=true;
 runtime.loadScene(result.id,{preview:true});
 const file=path.join(__dirname,'reports','targeted-revision-result.json');
 writeJson(file,{testedAt:new Date().toISOString(),provider:'DeepSeek',model:runtime.config.llm.model,originalId:id,revisedId:result.id,migratedLegacyScenes:fs.readdirSync(path.join(runtime.dataDir,'scenes')).filter(f=>f.endsWith('.json')).length,archiveCount:runtime.listScenes().length,checks:{originalPreserved:true,otherTurnsPreserved:true,outsideRangePreserved:true,castAndLayoutPreserved:true,offlineLoad:true,speechDisabled:true,draftOnly:true},before:before.turns[0],after:after.turns[0],edit:after.editHistory.at(-1)});
 return {success:true,archiveCount:runtime.listScenes().length,sceneId:result.id,reportFile:file};
}
module.exports={runRevisionVerification};
