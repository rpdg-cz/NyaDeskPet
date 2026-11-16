const fs=require('node:fs'),path=require('node:path');
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function runVisualProbe({app,window,runtime}) {
  const query=s=>window.webContents.executeJavaScript(s);
  for(let i=0;i<200;i++) {if(await query('Boolean(scheduler&&models.size===2)'))break;await wait(100);}
  await query('scheduler.stop(); true;');await wait(150);
  const directory=path.join(__dirname,'..','.preview','portrait-probe');fs.mkdirSync(directory,{recursive:true});
  const report={};
  report.initial=await query('({resolution:pixi.renderer.resolution,screen:{w:innerWidth,h:innerHeight},models:[...models.entries()].map(([id,m])=>({id,x:m.x,y:m.y,w:m.width,h:m.height,n:m.internalModel.coreModel.getParameterCount()})),names:document.querySelectorAll(".name").length})');
  await query('savedPositions={};layout();true;');
  fs.writeFileSync(path.join(directory,'bust.png'),(await window.webContents.capturePage()).toPNG());
  await query('for(const m of models.values()) m.internalModel.on("beforeModelUpdate",()=>{const c=m.internalModel.coreModel;m._visualParams=Array.from({length:c.getParameterCount()},(_,i)=>({id:c._parameterIds[i],v:c.getParameterValueByIndex(i),min:c.getParameterMinimumValue(i),max:c.getParameterMaximumValue(i)}));});true;');
  for(const name of ['idle','happy','laugh','thinking','surprised','calm']){
    await query(`Promise.all(config.characters.map(c=>applyAction(c,${JSON.stringify(name)},{cancelled:false})))`);
    await wait(1000);
    report[name]=await query('Object.fromEntries([...models.entries()].map(([id,m])=>{const core=m.internalModel.coreModel;return [id,{params:m._visualParams,expressionManager:{currentIndex:m.internalModel.motionManager.expressionManager.expressions.indexOf(m.internalModel.motionManager.expressionManager.currentExpression)}}]}))');
    fs.writeFileSync(path.join(directory,name+'.png'),(await window.webContents.capturePage()).toPNG());
  }
  await query('config.characters[0].actions.probe={parameters:[{id:"ParamMouthForm",value:1},{id:"ParamMouthOpenY",value:.5},{id:"ParamEyeLOpen",value:.4},{id:"ParamEyeROpen",value:.4}],durationMs:300};applyAction(config.characters[0],"probe",{cancelled:false});true;');
  await wait(900);
  report.direct=await query('Object.fromEntries([...models.entries()].map(([id,m])=>[id,{params:m._visualParams,vertices:[...m.internalModel.coreModel.getDrawableVertices(0)]}]))');
  fs.writeFileSync(path.join(directory,'direct-parameters.png'),(await window.webContents.capturePage()).toPNG());
  await query('models.get("companion-b").visible=false;true;');await wait(400);
  fs.writeFileSync(path.join(directory,'a-only.png'),(await window.webContents.capturePage()).toPNG());
  report.sensitivity=await query(`Object.fromEntries([...models.entries()].map(([id,m])=>{const c=m.internalModel.coreModel;const measure=()=>({vertices:[...c.getModel().drawables.vertexPositions].flatMap(a=>Array.from(a)),opacity:Array.from(c.getModel().drawables.opacities)});c.setParameterValueById('ParamMouthOpenY',0);c.setParameterValueById('ParamEyeLOpen',1);c.update();const a=measure();c.setParameterValueById('ParamMouthOpenY',1);c.setParameterValueById('ParamEyeLOpen',0);c.update();const b=measure();return[id,{vertexDelta:b.vertices.reduce((s,v,i)=>s+Math.abs(v-a.vertices[i]),0),opacityDelta:b.opacity.reduce((s,v,i)=>s+Math.abs(v-a.opacity[i]),0),coreVersion:Live2DCubismCore.Version.csmGetVersion()}]}))`);
  fs.writeFileSync(path.join(directory,'parameters.json'),JSON.stringify(report,null,2));
  console.log(JSON.stringify(report.initial));app.exit(0);
}
module.exports={runVisualProbe};
