const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {policy}=require('./performance.js');
const {pathToFileURL}=require('node:url');
const clone=x=>structuredClone(x);
const digest=x=>crypto.createHash('sha256').update(x).digest('hex');
function archiveName(id){if(typeof id!=='string'||!(id.startsWith('preset:')||/^[a-f0-9]{64}$/.test(id)))throw new Error('归档ID无效');return digest(id)+'.json';}
function castSnapshot(characters){return characters.map((c,i)=>{
 let model=null;
 if(c.modelPath){const file=path.resolve(__dirname,'..',c.modelPath);if(fs.existsSync(file)){
 const definition=JSON.parse(fs.readFileSync(file,'utf8'));const refs=definition.FileReferences;
 const resources=[path.basename(file),refs.Moc,...(refs.Textures||[]),...(refs.Expressions||[]).map(e=>e.File),...Object.values(refs.Motions||{}).flat().map(m=>m.File),refs.Physics,refs.Pose,...Object.values(refs.Motions||{}).flat().map(m=>m.Sound)].filter(Boolean);
 model={definition,resources:resources.map(relative=>{const target=path.resolve(path.dirname(file),relative);return{relative,path:target,sha256:digest(fs.readFileSync(target))};})};
 }}
 return {id:c.id,name:c.name,modelPath:c.modelPath||'',modelUrl:c.modelPath?pathToFileURL(path.resolve(__dirname,'..',c.modelPath)).href:null,model,actions:clone({still:{stopMotion:true,description:'停止身体动作并恢复正面姿态，可在后续事件叠加表情',parameters:['ParamAngleX','ParamAngleY','ParamAngleZ','ParamBodyAngleX','ParamBodyAngleY','ParamBodyAngleZ'].map(id=>({id,value:0})),...(c.actions.idle?.expression?{expression:c.actions.idle.expression}:{})},...c.actions}),presentation:clone({naturalSwayWeight:0,...c.presentation}),layout:{x:i===0?.3:.7,y:.88,heightRatio:3.05}};
});}
function compileArchive(scene,characters,{published=true,migration=false}={}){
 const cast=castSnapshot(characters);
 const turns=scene.turns.map(turn=>{
 const c=cast.find(c=>c.id===turn.characterId);if(!c)throw new Error('归档说话人不存在');
 const timeline=turn.timeline?.length?turn.timeline:[{atMs:0,action:turn.action||'idle'},...(turn.emotion&&c.actions[turn.emotion]&&turn.emotion!==turn.action?[{atMs:500,action:turn.emotion}]:[])];
 return {...clone(turn),timeline:timeline.map(cue=>{const command=c.actions[cue.action];if(!command&&cue.action!=='idle')throw new Error('归档动作不存在：'+cue.action);return{atMs:cue.atMs,action:cue.action,command:clone(command||{})};})};
 });
 return {schema:'personal-duo-performance',version:1,sceneId:scene.id,title:scene.title,revision:1,published,playback:policy(),createdAt:scene.createdAt||new Date().toISOString(),cast,turns,review:clone(scene.review||null),provenance:{mode:scene.mode||'legacy',prompt:scene.prompt||'',migration}};
}
function validateArchive(archive){
 if(archive?.schema!=='personal-duo-performance'||archive.version!==1||archive.cast?.length!==2||!Array.isArray(archive.turns))throw new Error('表演归档格式无效');
 for(const c of archive.cast){if(!Number.isFinite(c.layout?.x)||!Number.isFinite(c.layout?.y)||c.layout.x<0||c.layout.x>1||c.layout.y<0||c.layout.y>1.2||!Number.isFinite(c.layout.heightRatio)||c.layout.heightRatio<.5||c.layout.heightRatio>5)throw new Error('归档布局无效');}
 for(const turn of archive.turns){const c=archive.cast.find(c=>c.id===turn.characterId);if(!c||typeof turn.text!=='string'||!Array.isArray(turn.timeline)||!turn.timeline.length||turn.timeline.length>8||turn.timeline[0].atMs!==0)throw new Error('归档台词无效');let last=-1;for(const cue of turn.timeline){if(!Number.isInteger(cue.atMs)||cue.atMs<=last||cue.atMs>6000||typeof cue.action!=='string'||(cue.action!=='idle'&&!Object.hasOwn(c.actions,cue.action))||!cue.command||typeof cue.command!=='object'||Array.isArray(cue.command))throw new Error('归档动作时间轴无效');last=cue.atMs;}}
 return archive;
}
function checkResources(archive){for(const c of archive.cast)for(const resource of c.model?.resources||[]){if(!fs.existsSync(resource.path))throw new Error('归档资源缺失：'+resource.relative);if(digest(fs.readFileSync(resource.path))!==resource.sha256)throw new Error('归档资源已变化，请重新归档：'+resource.relative);}}
class ArchiveStore{
 constructor(directory){this.directory=path.join(directory,'archives');}
 file(id){return path.join(this.directory,archiveName(id));}
 exists(id){return fs.existsSync(this.file(id));}
 read(id){const archive=validateArchive(JSON.parse(fs.readFileSync(this.file(id),'utf8')));if(archive.sceneId!==id)throw new Error('归档ID不一致');return archive;}
 save(archive){validateArchive(archive);fs.mkdirSync(this.directory,{recursive:true});const file=this.file(archive.sceneId),temp=file+'.tmp';fs.writeFileSync(temp,JSON.stringify(archive,null,2));fs.renameSync(temp,file);return archive;}
 list(){if(!fs.existsSync(this.directory))return[];return fs.readdirSync(this.directory).filter(f=>/^[a-f0-9]{64}\.json$/.test(f)).map(f=>validateArchive(JSON.parse(fs.readFileSync(path.join(this.directory,f),'utf8'))));}
}
module.exports={ArchiveStore,compileArchive,validateArchive,checkResources,clone};
