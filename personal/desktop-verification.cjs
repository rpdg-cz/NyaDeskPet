const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { writeJson } = require('./runtime.cjs');
const hash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function runDesktopVerification({ app, window, createEditor, runtime, dataDir }) {
  const report = { beganAt: new Date().toISOString(), checks: {}, observations: [] };
  const reportDir = path.join(__dirname, '..', '.preview');
  fs.mkdirSync(reportDir, { recursive: true });
  const query = source => window.webContents.executeJavaScript(source);
  const poll = async (description, predicate, timeout = 25000) => {
    const until = Date.now() + timeout;
    while (Date.now() < until) {
      const value = await query('({state:typeof scheduler!=="undefined"&&scheduler?scheduler.getState():null,models:typeof models!=="undefined"?models.size:0,lines:[...document.querySelectorAll(".line")].map(n=>n.textContent),speaking:document.querySelectorAll("[data-speaking=true]").length,trace:window.duoTrace||[]})');
      assert.ok(value.speaking <= 1, 'two dialogue tracks must never speak concurrently');
      if (predicate(value)) return value;
      await pause(100);
    }
    throw new Error(`Desktop verification timeout: ${description}`);
  };
  try {
    await poll('stage initialization and two real Live2D models', value => value.state && value.models === 2);
    await query('scheduler.stop(); true;');
    await poll('initial playback fully cancelled', value => !value.state.running);
    const bounds = window.getBounds();
    assert.ok(bounds.width <= 600 && bounds.height <= 600, 'stage must remain <= 600 logical pixels');
    report.checks.realModels = await query('[...models.entries()].map(([id,model])=>({id,width:model.width,height:model.height,motions:Object.keys(model.internalModel.motionManager.definitions||{}).length}))');
    const fingerprint = hash(runtime.config.characters.map(c => ({id:c.id,modelPath:c.modelPath,revision:c.revision,actions:c.actions})));
    const apiReportFile = path.join(__dirname,'reports','deepseek-rain-walk-result.json');
    const apiResult = fs.existsSync(apiReportFile) ? JSON.parse(fs.readFileSync(apiReportFile,'utf8')) : null;
    const apiId = apiResult?.result?.id || apiResult?.scene?.id;
    assert.ok(typeof apiId === 'string' && /^[a-f0-9]{64}$/.test(apiId), 'latest API report must identify its actual cached scene');
    const apiTarget = path.join(dataDir, 'scenes', apiId+'.json');
    assert.ok(path.resolve(dataDir).startsWith(path.resolve(reportDir)+path.sep), 'verification must use isolated user data');
    const manifestFile = path.join(reportDir,'desktop-verification-owned-cache.json');
    const priorCopies = fs.existsSync(manifestFile) ? JSON.parse(fs.readFileSync(manifestFile,'utf8')) : [];
    const ownedApiCopies = [...new Set([...priorCopies, '040305bdb577857a79c57254c2a147cee20d31ea4b32785e5be8c7cf8ded6433', apiId])];
    for (const id of ownedApiCopies) {
      assert.ok(/^[a-f0-9]{64}$/.test(id));
      const ownedCopy = path.join(dataDir,'scenes',id+'.json');
      if (fs.existsSync(ownedCopy)) fs.unlinkSync(ownedCopy);
      const ownedArchive=runtime.archives.file(id);if(fs.existsSync(ownedArchive))fs.unlinkSync(ownedArchive);
    }
    fs.writeFileSync(manifestFile,JSON.stringify(ownedApiCopies));
    const ids = ['desktop-integration-a', 'desktop-integration-b'].map(hash);
    const expectedActions = [];
    for (const [index, id] of ids.entries()) {
      const turns = runtime.config.characters.map((c, i) => {
        const keys = Object.keys(c.actions);
        const motionKeys = keys.filter(k => k !== 'idle' && c.actions[k].motion);
        const action = motionKeys[index % motionKeys.length] || keys.find(k => c.actions[k].expression) || 'idle';
        expectedActions.push({characterId:c.id,action});
        return {characterId:c.id,text:`${index + 1}-${i + 1}`,emotion:'neutral',action};
      });
      writeJson(path.join(dataDir, 'scenes', id + '.json'), { id, title:`Desktop actual cache ${index+1}`, turns, playbackFingerprint:fingerprint });
      runtime.migrateArchives();
      assert.equal(runtime.loadScene(id).turns.length,2, 'real runtime must load persisted cache');
    }
    report.checks.cacheFiles = ids.map(id => ({id,exists:fs.existsSync(path.join(dataDir,'scenes',id+'.json'))}));
    const available = runtime.listScenes().filter(s => s.compatible && !s.preset);
    assert.ok(ids.every(id=>available.some(s=>s.id===id)), 'both on-disk scenes must be discoverable');
    // Use the actual setting IPC, then observe real wall-clock scheduling.
    const editor = createEditor(false);
    if (editor.webContents.isLoading()) await new Promise(resolve=>editor.webContents.once('did-finish-load',resolve));
    await pause(400);
    const settingsResult = await editor.webContents.executeJavaScript('window.duo.savePlayback({enabled:true,intervalSeconds:5,clickEnabled:true})');
    assert.ok(!settingsResult.error, settingsResult.error);
    const first = await poll('first timed cache scene rendered', value=>value.state.currentKind==='timer'&&value.state.phase==='playing'&&ids.includes(value.state.currentId)&&value.lines.some(t=>t.includes('1-1')||t.includes('2-1')));
    const firstId=first.state.currentId;
    report.observations.push({event:'first-timer-scene',at:Date.now(),state:first.state,lines:first.lines});
    const waiting = await poll('five-second gap after completed scene', value=>value.state.phase==='waiting'&&value.state.completedScenes>=first.state.completedScenes+1);
    const waitBegan = Date.now();
    assert.ok(waiting.state.nextAt > Date.now()+4400 && waiting.state.nextAt <= Date.now()+5100,'timer must wait five seconds after finishing');
    const second = await poll('second timer scene after real five-second gap', value=>value.state.phase==='playing'&&value.state.currentKind==='timer'&&value.state.currentId!==firstId);
    assert.ok(Date.now()-waitBegan>=4400,'real timer cannot skip its configured interval');
    report.observations.push({event:'second-timer-scene',at:Date.now(),state:second.state,lines:second.lines});
    const target = await query('(()=>{for(let y=70;y<innerHeight-120;y+=3)for(let x=30;x<innerWidth-30;x+=3)if(window.duoStageDebug.pickCharacterAt(x,y)===config.characters[0].id)return{x,y};throw new Error("model click target missing")})()');
    const screenPosition=window.getPosition();
    for (const input of [
      {type:'mouseMove',...target},
      {type:'mouseDown',...target,button:'left',clickCount:1,modifiers:['leftButtonDown']},
      {type:'mouseUp',...target,button:'left',clickCount:1}
    ]) {window.webContents.sendInputEvent({...input,globalX:screenPosition[0]+input.x,globalY:screenPosition[1]+input.y});await pause(35);}
    const clicked = await poll('native click cancels timer scene and renders next scene', value=>value.state.currentKind==='click'&&value.state.phase==='playing'&&value.state.currentId!==second.state.currentId&&value.state.acceptedClicks>second.state.acceptedClicks, 5000);
    report.observations.push({event:'native-click-scene',at:Date.now(),state:clicked.state,lines:clicked.lines});
    await pause(850);
    const meshPoint = await query('(()=>{const id=config.characters[0].id; const b=models.get(id).getBounds(); const canvas=document.getElementById("canvas").getBoundingClientRect(); for(let iy=2;iy<10;iy++)for(let ix=2;ix<10;ix++){const x=Math.round(canvas.left+b.x+b.width*ix/12),y=Math.round(canvas.top+b.y+b.height*iy/12);if(window.duoStageDebug.pickCharacterAt(x,y)===id)return{x,y,id};}return null;})()');
    assert.ok(meshPoint,'real drawable triangle must have a clickable point');
    const meshClickedAt=Date.now();
    for(const input of [{type:'mouseMove',x:meshPoint.x,y:meshPoint.y},{type:'mouseDown',x:meshPoint.x,y:meshPoint.y,button:'left',clickCount:1,modifiers:['leftButtonDown']},{type:'mouseUp',x:meshPoint.x,y:meshPoint.y,button:'left',clickCount:1}]) {
      window.webContents.sendInputEvent({...input,globalX:screenPosition[0]+input.x,globalY:screenPosition[1]+input.y}); await pause(35);
    }
    const meshClicked=await poll('visible model mesh click actually renders scene and SDK motion',v=>v.state.phase==='playing'&&v.state.currentKind==='click'&&v.state.acceptedClicks>clicked.state.acceptedClicks&&v.trace.some(e=>e.type==='action'&&e.at>=meshClickedAt&&e.motionApplied===true),5000);
    report.checks.visibleMeshClick={point:meshPoint,acceptedClicks:meshClicked.state.acceptedClicks,sdkMotionApplied:true};
    report.checks.nativeClickRendered = true;
    report.checks.realTimerRotation = true;
    report.checks.intervalSeconds = 5;
    await pause(150);
    const trace = await query('window.duoTrace||[]');
    report.checks.renderTrace = trace;
    report.checks.expectedActions = expectedActions;
    const image=await window.webContents.capturePage();
    fs.writeFileSync(path.join(reportDir,'desktop-live-models.png'),image.toPNG());
    const editorBounds=editor.getBounds();
    assert.ok(editorBounds.width<=600&&editorBounds.height<=600,'editor must remain <= 600 logical pixels');
    report.checks.editorSize=editorBounds;
    await query('scheduler.stop(); true;');
    await poll('stop stops playback and timer', value=>value.state.phase==='stopped'&&!value.state.running&&value.state.nextAt===null);
    report.checks.stop=true;
    const staticAppearance=await query('window.duoStageDebug.readState()');
    assert.equal(staticAppearance.background,'rgba(0, 0, 0, 0)');
    const initialPosition=window.getPosition();
    for(const input of [{type:'mouseMove',x:20,y:80},{type:'mouseDown',x:20,y:80,button:'left',clickCount:1,modifiers:['leftButtonDown']},{type:'mouseMove',x:44,y:92,modifiers:['leftButtonDown']}]) {
      window.webContents.sendInputEvent({...input,globalX:initialPosition[0]+input.x,globalY:initialPosition[1]+input.y}); await pause(35);
    }
    await pause(130);
    const duringDrag=await query('window.duoStageDebug.readState()');
    assert.ok(duringDrag.dragOpacity>0.1,'native drag must show translucent floating effect');
    fs.writeFileSync(path.join(reportDir,'desktop-drag-floating.png'),(await window.webContents.capturePage()).toPNG());
    window.webContents.sendInputEvent({type:'mouseUp',x:44,y:92,globalX:initialPosition[0]+44,globalY:initialPosition[1]+92,button:'left',clickCount:1});
    await pause(600);
    const afterDrag=await query('window.duoStageDebug.readState()');
    assert.equal(afterDrag.dragOpacity,0,'translucent effect must fade after release');
    assert.equal(afterDrag.background,'rgba(0, 0, 0, 0)');
    report.checks.dragAppearance={staticOpacity:staticAppearance.dragOpacity,duringOpacity:duringDrag.dragOpacity,afterOpacity:afterDrag.dragOpacity};
    const apiSource = path.join(app.getPath('appData'),'PersonalDuoPet','scenes',apiId+'.json');
    if (fs.existsSync(apiSource)) {
      fs.copyFileSync(apiSource,apiTarget);
      runtime.migrateArchives();
      const apiScene = runtime.loadScene(apiId);
      assert.deepEqual(apiScene.turns.map(({characterId,text})=>({characterId,text})),apiResult.sourceDialogue,'API playback preserves all supplied dialogue');
      const expected = apiScene.turns.flatMap(t=>(t.timeline||[]).map(cue=>({characterId:t.characterId,name:cue.action,atMs:cue.atMs})));
      const reportedCueCount = apiResult.scene.turns.reduce((count,turn)=>count+(turn.timeline||[]).length,0);
      assert.ok(expected.length >= 12, 'paid API scene must contain at least twelve ordered cues');
      assert.equal(expected.length,reportedCueCount,'cache cue count matches the latest real API report');
      await query('window.duoTrace.length=0; scheduler.requestManual('+JSON.stringify(apiId)+'); true;');
      await poll('real API scene playing',v=>v.state.phase==='playing'&&v.state.currentId===apiId);
      const frame1 = (await window.webContents.capturePage()).toPNG();
      const parameters1 = await query('[...models.values()].map(m=>Array.from({length:m.internalModel.coreModel.getParameterCount()},(_,i)=>m.internalModel.coreModel.getParameterValueByIndex(i)))');
      await pause(1200);
      const frame2 = (await window.webContents.capturePage()).toPNG();
      const parameters2 = await query('[...models.values()].map(m=>Array.from({length:m.internalModel.coreModel.getParameterCount()},(_,i)=>m.internalModel.coreModel.getParameterValueByIndex(i)))');
      assert.notEqual(hash(frame1),hash(frame2),'real Live2D rendered pixels change');
      assert.notDeepEqual(parameters1,parameters2,'real model core parameters change');
      const finished = await poll('all real API dialogue turns and timeline actions complete',v=>v.state.currentId===apiId&&!v.state.running&&v.state.phase==='waiting',60000);
      const actual = finished.trace.filter(e=>e.type==='action');
      assert.deepEqual(actual.map(({characterId,name})=>({characterId,name})),expected.map(({characterId,name})=>({characterId,name})),'all API cues execute in source order');
      report.checks.apiActionTrace = actual;
      report.checks.apiExpected = expected;
      assert.ok(actual.every(e=>e.settledAt&&!e.cancelled&&!e.error&&(!e.motion||e.motionApplied===true)&&(!e.expression||e.expressionApplied===true)),'every API cue must settle and the SDK must accept each requested expression/motion');
      assert.equal(finished.trace.filter(e=>e.type==='turn'&&e.sceneId===apiId).length,apiScene.turns.length);
      const bodyMotions = runtime.config.characters.map(character=>({
        characterId:character.id,
        applied:actual.filter(event=>event.characterId===character.id&&event.motion&&event.motionApplied===true).map(event=>({name:event.name,motion:event.motion,reused:Boolean(event.motionAlreadyActive)}))
      }));
      assert.ok(bodyMotions.every(character=>character.applied.length>0),'both characters must actually apply at least one body motion from the API timeline');
      report.checks.realApiScene={id:apiId,turns:apiScene.turns.length,cues:expected.length,textPreserved:true,coreParametersChanged:true,pixelsChanged:true,bodyMotions,actual};
      fs.writeFileSync(path.join(reportDir,'api-scene-frame-1.png'),frame1);
      fs.writeFileSync(path.join(reportDir,'api-scene-frame-2.png'),frame2);
      await query('scheduler.stop(); true;');
    } else report.checks.realApiScene={pending:true,reason:'real API cache has not been prepared'};
    report.passed=true;
    fs.writeFileSync(path.join(reportDir,'desktop-verification.json'),JSON.stringify(report,null,2));
    console.log(JSON.stringify({passed:true,checks:{models:2,realCacheFiles:2,rotation:true,nativeClick:true,stop:true},report:path.join(reportDir,'desktop-verification.json')}));
    app.exit(0);
  } catch(error) {
    report.passed=false; report.error=error.message;
    fs.writeFileSync(path.join(reportDir,'desktop-verification.json'),JSON.stringify(report,null,2));
    console.error(error.stack); throw error;
  }
}
module.exports={runDesktopVerification};
