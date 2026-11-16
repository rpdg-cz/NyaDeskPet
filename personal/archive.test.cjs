const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {compileArchive,checkResources,ArchiveStore}=require('./archive.cjs');
const {PersonalRuntime,writeJson}=require('./runtime.cjs');
const {availableScenes}=require('./playback.js');
const template=require('./config.json');
const id='a'.repeat(64);
function fixture(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'duo-archive-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));return dir;}
function scene(){return{id,title:'归档测试',turns:template.characters.map(c=>({characterId:c.id,text:'雨停了。',action:'pose_l',timeline:[{atMs:0,action:'pose_l'},{atMs:600,action:'happy'}]}))};}

test('legacy caches migrate once; playback retains its complete cast and commands after global configuration changes',t=>{
 const dir=fixture(t);writeJson(path.join(dir,'scenes',id+'.json'),scene());
 const runtime=new PersonalRuntime(structuredClone(template),dir,require('./presets.json'));
 assert.equal(runtime.listScenes().length,3);
 const before=runtime.loadScene(id);
 fs.writeFileSync(path.join(dir,'scenes',id+'.json'),'invalid old generation data');
 runtime.config.characters[0].actions.pose_l={motion:{group:'unrelated',index:0}};
 runtime.config.characters[0].modelPath='nonexistent.model3.json';
 runtime.config.characters[0].presentation={expressionWeight:0};
 runtime.request=()=>{throw new Error('playback cannot generate');};
 assert.deepEqual(runtime.loadScene(id),before);
 assert.ok(before.cast.every(c=>c.layout.x&&c.layout.heightRatio&&c.model.resources.length));
 assert.deepEqual(before.turns[0].timeline[0].command,template.characters[0].actions.pose_l);
 assert.equal(runtime.listScenes().length,3,'listing must use archives even if old generation files are unavailable');
 const restarted=new PersonalRuntime(structuredClone(template),dir,require('./presets.json'));
 assert.deepEqual(restarted.loadScene(id),before,'restart must not depend on already migrated generation data');
});

test('drafts stay out of playback until confirmed; persisted layout has revision checks',t=>{
 const runtime=new PersonalRuntime(structuredClone(template),fixture(t));
 runtime.archives.save(compileArchive(scene(),template.characters,{published:false}));
 assert.throws(()=>runtime.loadScene(id),/草稿/);
 assert.equal(availableScenes(runtime.listScenes()).length,0);
 const before=runtime.loadScene(id,{preview:true});
 const next=runtime.saveLayout(id,before.revision,{'companion-a':{x:.36,y:.90}});
 assert.equal(next.revision,2);
 assert.throws(()=>runtime.publishScene(id,1),/变化/);
 assert.throws(()=>runtime.saveLayout(id,2,{'companion-a':{x:NaN,y:.9}}),/布局/);
 runtime.publishScene(id,2);
 assert.equal(runtime.loadScene(id).cast[0].layout.x,.36);
 assert.equal(availableScenes(runtime.listScenes()).length,1);
});

test('model definition and dependent resources are fingerprinted and checked without an API',t=>{
 const dir=fixture(t),model=path.join(dir,'test.model3.json'),moc=path.join(dir,'test.moc3');
 fs.writeFileSync(moc,'moc-fixture');fs.writeFileSync(model,JSON.stringify({FileReferences:{Moc:'test.moc3'}}));
 const characters=structuredClone(template.characters);characters[0].modelPath=model;characters[1].modelPath='';
 const archive=compileArchive(scene(),characters);
 checkResources(archive);
 fs.appendFileSync(model,' ');
 assert.throws(()=>checkResources(archive),/资源已变化/);
 assert.equal(archive.cast[0].model.resources[0].relative,'test.model3.json');
 const store=new ArchiveStore(dir);store.save(archive);
 assert.deepEqual(store.read(id),archive);
});
