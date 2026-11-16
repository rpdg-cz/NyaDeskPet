const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require('node:path').join(__dirname, 'stage.js'), 'utf8');
const applySource = source.slice(source.indexOf('function applyAction('), source.indexOf('\nasync function playAudio'));
const tick = () => new Promise(resolve => setImmediate(resolve));
function fixture() {
  const calls = [], models = new Map(), overrides = new Map();
  const core = { getParameterCount: () => 0 };
  const expressions = { expressions: [{name:'old'}, {name:'new'}], currentExpression: null, getExpressionIndex: name => name === 'old' ? 0 : 1 };
  expressions.loadExpression = async index => expressions.expressions[index];
  let releaseOld;
  const model = { internalModel: { coreModel: core, motionManager: {state:{}, expressionManager:expressions} },
    expression: name => { calls.push('expression:' + name); return name === 'old' ? new Promise(resolve => {releaseOld=()=>{ expressions.currentExpression=expressions.expressions[0];resolve(true); };}) : Promise.resolve(true); },
    motion: group => {calls.push('motion:' + group); return Promise.resolve(true);}
  };
  models.set('a', model);
  const context={continuity:{begin(){}},performancePolicy:{transitionMs:450},models,overrides,actionChains:new Map(),actionTrace:[],window:{duoTrace:[]},performance,Date,Promise,Math};
  vm.createContext(context); vm.runInContext(applySource, context);
  const character={id:'a',name:'A',actions:{old:{expression:'old',motion:{group:'old-motion',index:0}},new:{expression:'new',motion:{group:'new-motion',index:0}}}};
  return { calls, context, character, release:()=>releaseOld(), model };
}
test('cancelled asynchronous expression cannot issue its old motion after new scene starts', async () => {
  const f=fixture(), oldToken={cancelled:false}, nextToken={cancelled:false};
  const old=f.context.applyAction(f.character,'old',oldToken); await tick();
  oldToken.cancelled=true;
  const next=f.context.applyAction(f.character,'new',nextToken); await tick();
  assert.deepEqual(f.calls,['expression:old']);
  f.release(); await Promise.all([old,next]);
  assert.deepEqual(f.calls,['expression:old','expression:new','motion:new-motion']);
  assert.equal(f.context.window.duoTrace[0].cancelled,true);
});
test('SDK rejection is preserved as a failed cue rather than accepted silently', async () => {
  const f=fixture(); f.model.expression=()=>Promise.resolve(false);
  await assert.rejects(f.context.applyAction(f.character,'new',{cancelled:false}),/表情未被模型接受/);
  assert.match(f.context.window.duoTrace[0].error,/表情未被模型接受/);
  assert.deepEqual(f.calls,[]);
});
