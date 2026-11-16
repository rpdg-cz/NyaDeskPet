const { test } = require('node:test');
const assert = require('node:assert/strict');
const { PlaybackScheduler, normalizePlayback } = require('./playback.js');
const flush = () => new Promise(resolve => setImmediate(resolve));
function fixture(options = {}) {
  let now = 0, serial = 0;
  const timers = new Map(), calls = [], releases = [];
  const sceneList = [{id:'sample',preset:true,compatible:true}, {id:'a',compatible:true}, {id:'bad',compatible:false}, {id:'b',compatible:true}];
  const scheduler = new PlaybackScheduler({
    list: async () => sceneList,
    play: async (id, kind) => { calls.push({id,kind}); if (options.block) await new Promise(resolve => releases.push(resolve)); },
    cancel: () => { releases.shift()?.(); },
    settings: {enabled:true,intervalSeconds:10,clickEnabled:true},
    clock: {
      now: () => now,
      setTimeout: (fn, ms) => { timers.set(++serial, {fn,ms}); return serial; },
      clearTimeout: id => timers.delete(id)
    }, ...options.overrides
  });
  return { scheduler, calls, timers, releases, sceneList,
    time: value => {now=value;},
    async fire() { const [id, timer] = timers.entries().next().value; timers.delete(id); timer.fn(); await flush(); return timer.ms; }
  };
}
test('start cached rotation immediately, then wait after completion and rotate in order', async () => {
  const f = fixture(); f.scheduler.configure(f.scheduler.settings);
  assert.equal(await f.fire(), 0); assert.deepEqual(f.calls, [{id:'a',kind:'timer'}]);
  assert.equal(await f.fire(), 10000); assert.deepEqual(f.calls[1], {id:'b',kind:'timer'});
  await f.fire(); assert.equal(f.calls[2].id, 'a'); f.scheduler.dispose();
});
test('click cancels ongoing rotation, starts next scene and coalesces rapid clicks', async () => {
  const f = fixture({block:true}); f.scheduler.configure(f.scheduler.settings); await f.fire();
  assert.equal(f.calls.length,1); assert.equal(f.timers.size,0);
  assert.equal(f.scheduler.requestClick('a'),true);
  assert.equal(f.scheduler.requestClick('a'),false, 'debounce duplicate clicks');
  await flush();
  assert.deepEqual(f.calls[1],{id:'b',kind:'click'});
  assert.equal(f.timers.size,0);
  f.releases.shift()(); await flush();
  assert.equal(f.timers.size,1); f.scheduler.dispose();
});
test('bundled local scenes remain playable before first API scene; real cache takes priority', async () => {
  const f = fixture(); f.sceneList.splice(1); f.scheduler.configure(f.scheduler.settings); await f.fire();
  assert.equal(f.calls[0].id,'sample');
  f.sceneList.push({id:'new',compatible:true}); f.scheduler.libraryChanged();
  assert.equal(await f.fire(),0); assert.equal(f.calls[1].id,'new'); f.scheduler.dispose();
});
test('truly empty library remains idle and exposes its cause', async () => {
  const f=fixture(); f.sceneList.splice(0); f.scheduler.configure(f.scheduler.settings); await f.fire();
  assert.equal(f.calls.length,0); assert.equal(f.scheduler.getState().phase,'empty'); assert.equal(f.scheduler.getState().availableCount,0); f.scheduler.dispose();
});
test('stop cancels active work, clears queued clicks and pauses future scheduling', async () => {
  const f=fixture({block:true}); f.scheduler.configure(f.scheduler.settings); await f.fire();
  f.scheduler.requestManual('b'); f.scheduler.stop(); await flush();
  assert.equal(f.calls.length,1); assert.equal(f.timers.size,0);
  f.scheduler.requestManual('sample'); await flush(); assert.equal(f.calls[1].id,'sample');
  f.releases.shift()(); await flush(); assert.equal(f.timers.size,1); f.scheduler.dispose();
});
test('stop during cache lookup prevents late playback', async () => {
  let resolveList;
  const f=fixture({overrides:{list:()=>new Promise(resolve=>{resolveList=resolve;})}});
  f.scheduler.configure(f.scheduler.settings); await f.fire(); f.scheduler.stop();
  resolveList([{id:'a',compatible:true}]); await flush();
  assert.equal(f.calls.length,0); assert.equal(f.timers.size,0); f.scheduler.dispose();
});
test('disabled options and malformed intervals are handled without starting playback', async () => {
  const f=fixture(); f.scheduler.configure({enabled:false,intervalSeconds:60,clickEnabled:false});
  assert.equal(f.timers.size,0); assert.equal(f.scheduler.requestClick('a'),false);
  assert.throws(()=>normalizePlayback({intervalSeconds:0}),/播放间隔/);
  assert.throws(()=>normalizePlayback({intervalSeconds:6.5}),/播放间隔/);
  f.scheduler.requestManual('sample'); await flush(); assert.equal(f.calls.length,1); assert.equal(f.timers.size,0); f.scheduler.dispose();
});

test('configuration refresh preserves explicit stop while explicit configure resumes', async () => {
  const f=fixture(); f.scheduler.configure(f.scheduler.settings); await f.fire();
  f.scheduler.stop(); f.scheduler.refresh(); await flush();
  assert.equal(f.scheduler.getState().paused,true); assert.equal(f.timers.size,0);
  f.scheduler.configure(f.scheduler.settings); assert.equal(f.timers.size,1); f.scheduler.dispose();
});

test('review-approved scenes take precedence over legacy caches', async()=>{
 const f=fixture();f.sceneList.splice(0,f.sceneList.length,{id:'legacy',compatible:true},{id:'reviewed',compatible:true,reviewed:true});
 f.scheduler.configure(f.scheduler.settings);await f.fire();assert.equal(f.calls[0].id,'reviewed');f.scheduler.dispose();
});
