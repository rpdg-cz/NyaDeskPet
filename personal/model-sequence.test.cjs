const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { discoverActions, validateTimeline, annotateDialogue } = require('./authoring.cjs');
const { PersonalRuntime } = require('./runtime.cjs');
const configTemplate = require('./config.json');
const analysis = require('./model-analysis.json');

test('all actual model textures, expressions, moc and motion files resolve', () => {
  for (const character of configTemplate.characters) {
    const modelFile = path.resolve(__dirname, '..', character.modelPath);
    const model = JSON.parse(fs.readFileSync(modelFile,'utf8'));
    const refs = model.FileReferences;
    const files = [refs.Moc,refs.Physics,...refs.Textures,...refs.Expressions.map(e=>e.File),...Object.values(refs.Motions).flat().map(m=>m.File)];
    for (const file of files) assert.ok(fs.statSync(path.join(path.dirname(modelFile),file)).size > 0, file);
    const actions = discoverActions(character);
    for (const action of Object.values(actions)) {
      if (action.expression) assert.ok(refs.Expressions.some(e=>e.Name===action.expression));
      if (action.motion) assert.ok(refs.Motions[action.motion.group]?.[action.motion.index]);
    }
  }
});
test('authored motion metadata and complete curve segment times are valid', () => {
  for (const model of analysis.models) {
    const base=path.dirname(path.resolve(__dirname,'..',model.modelPath));
    for (const item of model.motions) {
      const motion=JSON.parse(fs.readFileSync(path.join(base,item.file),'utf8'));
      assert.equal(motion.Meta.Duration,6);assert.equal(motion.Meta.Fps,30);assert.equal(motion.Meta.Loop,false);
      assert.equal(motion.Meta.CurveCount,motion.Curves.length);
      for (const curve of motion.Curves) {
        const s=curve.Segments;let i=2,last=s[0];
        assert.equal(last,0);
        while(i<s.length) {
          const type=s[i++];
          assert.ok([0,1,2,3].includes(type));
          const length=type===1?6:2;
          assert.ok(i+length<=s.length);
          const endpoint=s[i+length-2];
          assert.ok(endpoint>=last && endpoint<=motion.Meta.Duration+.001);
          for(const value of s.slice(i,i+length))assert.ok(Number.isFinite(value));
          last=endpoint;i+=length;
        }
      }
    }
  }
});
test('strict timeline bounds and role-specific actions reject malformed sequences', () => {
  const c={id:'test',actions:{happy:{expression:'smile'}}};
  for(const sequence of [[],[{atMs:1,action:'happy'}],[{atMs:0,action:'unknown'}],[{atMs:0,action:'happy'},{atMs:6001,action:'happy'}],[{atMs:0,action:'happy'},{atMs:0,action:'happy'}]]) assert.throws(()=>validateTimeline(sequence,c));
  assert.deepEqual(validateTimeline([{atMs:0,action:'happy'},{atMs:6000,action:'idle'}],c),[{atMs:0,action:'happy'},{atMs:6000,action:'idle'}]);
});
test('imported real-model performance retains source text and timelines through offline cache reload', async t => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'duo-model-test-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const config=structuredClone(configTemplate);config.offline=false;config.tts.enabled=false;
  const runtime=new PersonalRuntime(config,dir);runtime.sessionKey='fixture-only';
  const dialogue=[{characterId:config.characters[0].id,text:'咦，雨停了吗？'},{characterId:config.characters[1].id,text:'真的停了，我们一起去看彩虹吧！'}];
  const annotations=[{lineIndex:0,action:'thinking',emotion:'surprised',timeline:[{atMs:0,action:'thinking'},{atMs:1200,action:'surprised'},{atMs:2000,action:'pose_c'}]},{lineIndex:1,action:'happy',emotion:'happy',timeline:[{atMs:0,action:'happy'},{atMs:1600,action:'laugh'},{atMs:2400,action:'pose_l'}]}];
  runtime.request=async(_p,_u,body)=>({json:async()=>({choices:[{message:{content:JSON.stringify(body.messages[0].content.includes('独立的Live2D表演审稿员')?{approved:true,issues:[]}:{title:'雨后彩虹',annotations})}}]})});
  const result=await runtime.generate('保留原文，使用真实模型表情与动作',{mode:'import',dialogue:JSON.stringify(dialogue)});
  runtime.config.offline=true;
  const scene=runtime.loadScene(result.id,{preview:true});
  assert.deepEqual(scene.turns.map(({characterId,text})=>({characterId,text})),dialogue);
  assert.equal(scene.turns[0].timeline[1].action,'surprised');
  assert.ok(scene.turns.every(turn=>turn.timeline.some(event=>event.action!=='idle')));
});
