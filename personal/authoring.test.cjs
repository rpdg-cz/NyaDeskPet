const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { PersonalRuntime } = require('./runtime.cjs');
const { parseDialogue, annotateDialogue, discoverActions } = require('./authoring.cjs');
const template = require('./config.json');
const {auditPerformance}=require('./review.cjs');
function reviewReply(body,runtime) {
  if(!body.messages[0].content.includes('独立的Live2D表演审稿员'))return null;
  const turns=JSON.parse(body.messages[1].content).turns;
  const issues=auditPerformance(turns,runtime.config.characters);
  const revisedTurns=turns.map(turn=>{
    const c=runtime.config.characters.find(c=>c.id===turn.characterId);
    const first=c.actions[turn.action]?turn.action:Object.keys(c.actions).find(k=>c.actions[k].motion)||Object.keys(c.actions)[0];
    const timeline=[{atMs:0,action:first}];
    const expression=Object.keys(c.actions).find(k=>c.actions[k].expression);
    const motion=Object.keys(c.actions).find(k=>c.actions[k].motion);
    if(!c.actions[first]?.expression&&expression)timeline.push({atMs:700,action:expression});
    if(!c.actions[first]?.motion&&motion)timeline.push({atMs:1400,action:motion});
    return {...turn,action:first,timeline};
  });
  return {json:async()=>({choices:[{message:{content:JSON.stringify(issues.length?{approved:false,issues,revisedTurns}:{approved:true,issues:[]})}}]})};
}
function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'duo-authoring-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const config = structuredClone(template);
  config.offline = false;
  config.tts.enabled = false;
  config.characters[0].actions = { wave: { motion: { group: 'wave', index: 0 } } };
  config.characters[1].actions = { smile: { expression: 'smile' } };
  const runtime = new PersonalRuntime(config, dir, require('./presets.json'));
  runtime.sessionKey = 'test-only';
  return runtime;
}
const dialogue = [
  { characterId: 'companion-a', text: '  雨停了：去散步吗？  ' },
  { characterId: 'companion-b', text: '好呀！\n记得带伞。' }
];
test('import keeps exact JSON text/speakers/order while adding API annotations', async t => {
  const runtime = setup(t);
  let calls = 0;
  runtime.request = async (_provider, _url, body) => {
    const reviewed=reviewReply(body,runtime);if(reviewed)return reviewed;
    calls++;
    const payload = JSON.parse(body.messages[1].content);
    assert.deepEqual(payload.dialogue.map(({lineIndex, ...turn}) => turn), dialogue);
    return { json: async () => ({ choices: [{ message: { content: JSON.stringify({ title: '散步', annotations: [
      { lineIndex: 1, action: 'smile', emotion: 'happy', text: '不应覆盖原文' },
      { lineIndex: 0, action: 'wave', emotion: 'calm', characterId: 'companion-b' }
    ] }) } }] }) };
  };
  const options = { mode: 'import', dialogue: JSON.stringify(dialogue) };
  const result = await runtime.generate('自然互动', options);
  const scene = runtime.loadScene(result.id,{preview:true});
  assert.deepEqual(scene.turns.map(({characterId, text}) => ({characterId, text})), dialogue);
  assert.deepEqual(scene.turns.map(t => t.action), ['wave', 'smile']);
  assert.ok(scene.turns.every(t => t.audio === null));
  await runtime.generate('自然互动', options);
  assert.equal(calls, 1, 'reuse prepared scene');
  runtime.config.offline = true;
  runtime.request = () => { throw new Error('offline must not call services'); };
  assert.equal(runtime.loadScene(result.id,{preview:true}).turns.length, 2);
});
test('each role prompt persists after restart and is included in cloud creation', async t => {
  const runtime = setup(t);
  const characters = runtime.config.characters.map(c => ({ ...c, userPrompt: c.id === 'companion-a' ? 'A克制含蓄，喜欢雨天' : 'B活泼，喜欢晴天' }));
  runtime.updateCharacters(characters);
  const restarted = new PersonalRuntime(structuredClone(template), runtime.dataDir);
  assert.deepEqual(restarted.config.characters.map(c => c.userPrompt), characters.map(c => c.userPrompt));
  runtime.request = async (_provider, _url, body) => {
    const reviewed=reviewReply(body,runtime);if(reviewed)return reviewed;
    for (const c of characters) assert.ok(body.messages[0].content.includes(c.userPrompt));
    return { json: async () => ({ choices: [{ message: { content: JSON.stringify({ turns: dialogue }) } }] }) };
  };
  const generated = await runtime.generate('聊聊喜欢的天气');
  runtime.updateCharacters(characters.map(c => ({ ...c, userPrompt: c.userPrompt + '；补充设定' })));
  assert.equal(runtime.loadScene(generated.id,{preview:true}).turns.length, 2, 'prompt editing must preserve existing playback');
  assert.throws(() => runtime.updateCharacters(characters.map(c => ({ ...c, name: '同名' }))), /不能相同/);
  assert.equal(runtime.config.characters[0].name, characters[0].name);
});
test('TXT names/IDs resolve and invalid annotations/unknown speakers are rejected', t => {
  const runtime = setup(t);
  const parsed = parseDialogue('角色 A：你好：今天天气好。\ncompanion-b: 是呀！', runtime.config.characters);
  assert.equal(parsed[0].text, '你好：今天天气好。');
  assert.throws(() => parseDialogue('陌生人：你好\n角色 B：你好', runtime.config.characters), /无法识别/);
  assert.throws(() => annotateDialogue(dialogue, [{ lineIndex: 0 }, { lineIndex: 0 }], runtime.config.characters), /重复/);
  const result = annotateDialogue(dialogue, [{lineIndex:0,action:'smile'}, {lineIndex:1,action:'smile'}], runtime.config.characters);
  assert.equal(result[0].action, 'idle', 'role A cannot use role B action');
});
test('discovers model expressions and motions without loading Live2D', t => {
  const runtime = setup(t);
  const file = path.join(runtime.dataDir, 'test.model3.json');
  fs.writeFileSync(file, JSON.stringify({ FileReferences: { Expressions: [{ Name: 'happy', File: 'happy.exp3.json' }], Motions: { Idle: [{ File: 'idle.motion3.json' }] } } }));
  const actions = discoverActions({ modelPath: file, actions: { custom: { expression: 'custom' } } });
  assert.deepEqual(actions['expression:happy'], { expression: 'happy' });
  assert.deepEqual(actions['motion:Idle:0'], { motion: { group: 'Idle', index: 0 } });
  assert.ok(actions.custom);
});
test('missing/duplicate annotation results are not saved as scenes', async t => {
  const runtime = setup(t);
  runtime.request = async () => ({ json: async () => ({ choices: [{ message: { content: JSON.stringify({ annotations: [{lineIndex:0}] }) } }] }) });
  await assert.rejects(runtime.generate('动作', { mode: 'import', dialogue: JSON.stringify(dialogue) }), /缺少台词/);
  assert.equal(runtime.listScenes().length, 2);
});

test('offline preset playback still works with no API and no speech', t => {
  const runtime = setup(t);
  runtime.config.offline = true;
  runtime.request = () => { throw new Error('must stay offline'); };
  assert.equal(runtime.loadScene('preset:雨天闲聊').turns.length, 4);
});
