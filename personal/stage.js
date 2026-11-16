/* Uses the upstream local Live2D libraries, without its single-character global state. */
const models = new Map();
const cards = new Map();
const overrides = new Map();
const actionTrace = [];
const actionChains = new Map();
const continuity = new window.DuoPerformance.PoseContinuity();
let performancePolicy = window.DuoPerformance.policy();
window.duoTrace = [];
function traceEvent(event) { const item = {at: Date.now(), ...event}; window.duoTrace.push(item); if (window.duoTrace.length > 200) window.duoTrace.shift(); return item; }
const feedbackTimers = new Map();
let config;
let activeCast = [];
let activeArchive = null;
let previewActive = false;
let previewRequest = 0;
let pixi;
let playback = null;
let activeAudio = null;
let scheduler;
let drag = null;
let savedPositions = {};
try { savedPositions = JSON.parse(localStorage.getItem('duo-character-positions-bust-v2') || '{}'); } catch { savedPositions = {}; }
if (!savedPositions || typeof savedPositions !== 'object' || Array.isArray(savedPositions)) savedPositions = {};
const positions = new Map();
const status = document.getElementById('status');
const conversation = document.getElementById('conversation');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

function addLine(name, text) {
  const line = document.createElement('p');
  line.className = 'line';
  line.textContent = `${name}：${text}`;
  conversation.append(line);
  while (conversation.children.length > 80) conversation.firstElementChild.remove();
  conversation.scrollTop = conversation.scrollHeight;
}

function positionCharacter(id, x, y) {
  const stage = document.getElementById('stage');
  const width = stage.clientWidth, height = stage.clientHeight;
  const model = models.get(id);
  // Half-body framing deliberately extends below the canvas. Clamp only the
  // head/upper body center, never force the whole full-body asset on screen.
  x = Math.max(70, Math.min(width - 70, x));
  y = Math.max(80, Math.min(height * 1.15, y));
  positions.set(id, { x, y });
  const card = cards.get(id);
  if (card) { card.style.left = `${x}px`; card.style.top = `${y}px`; }
  if (model) model.position.set(x, y);
}
function layout() {
  if (!config) return;
  const stage = document.getElementById('stage');
  const width = stage.clientWidth, height = stage.clientHeight;
  (activeCast.length ? activeCast : config.characters).forEach((c, index) => {
    const model = models.get(c.id);
    if (model && pixi) {
      const size = model.internalModel;
      model.scale.set(height * (c.layout?.heightRatio || 3.05) / size.height);
    }
    const saved = activeArchive ? c.layout : savedPositions[c.id];
    const x = saved && Number.isFinite(saved.x) ? saved.x * width : width / 2 + (index === 0 ? -width * .20 : width * .20);
    const y = saved && Number.isFinite(saved.y) ? saved.y * height : height * .88;
    positionCharacter(c.id, x, y);
  });
}

async function preloadSceneActions(scene, token) {
  const resources = new Map();
  for (const turn of scene.turns) {
    const c = scene.cast.find(item => item.id === turn.characterId);
    const model = models.get(c?.id);
    if (!model) continue;
    const manager = model.internalModel.motionManager;
    const cues = turn.timeline;
    for (const cue of cues) {
      const name=cue.action,action=cue.command;
      if (!action) continue;
      if (action.motion) {
        const key = `${c.id}:motion:${action.motion.group}:${action.motion.index || 0}`;
        if (!resources.has(key)) resources.set(key, async () => {
          const loaded = await manager.loadMotion(action.motion.group, action.motion.index || 0);
          if (!loaded) throw new Error(`动作资源加载失败：${c.name} / ${name}`);
        });
      }
      if (action.expression) {
        const key = `${c.id}:expression:${action.expression}`;
        if (!resources.has(key)) resources.set(key, async () => {
          const expressions = manager.expressionManager;
          const index = expressions?.getExpressionIndex(action.expression);
          const loaded = Number.isInteger(index) && index >= 0 ? await expressions.loadExpression(index) : null;
          if (!loaded) throw new Error(`表情资源加载失败：${c.name} / ${name}`);
        });
      }
    }
  }
  await Promise.all([...resources.values()].map(load => load()));
  traceEvent({type: 'scene-ready', sceneId: scene.id, resources: resources.size, cancelled: token.cancelled});
}
function applyAction(character, name, token) {
  const previous = actionChains.get(character.id) || Promise.resolve();
  const task = previous.catch(() => {}).then(async () => {
    if (token?.cancelled) return;
    const model = models.get(character.id), action = character.actions[name];
    if (!model || !action) return;
    const trace = { type: 'action', characterId: character.id, action: name, name, at: Date.now(), expression: action.expression || null, motion: action.motion || null };
    actionTrace.push(trace); if (actionTrace.length > 100) actionTrace.shift();
    window.duoTrace.push(trace); if (window.duoTrace.length > 200) window.duoTrace.shift();
    try {
      continuity.begin(character.id,performance.now(),performancePolicy.transitionMs);
      if(action.stopMotion)model.internalModel.motionManager.stopAllMotions();
      // Await SDK calls and serialize each character: an old scene's delayed load
      // must settle before a replacement scene can issue its first command.
      if (action.expression) {
        const manager = model.internalModel.motionManager.expressionManager;
        const index = manager.getExpressionIndex(action.expression);
        const expression = await manager.loadExpression(index);
        const profile = character.presentation || {};
        expression?.setWeight?.(/bsmile/.test(action.expression) || name === 'laugh' ? (profile.laughWeight ?? .6) : /thinking/.test(action.expression) || name === 'thinking' ? (profile.thinkingWeight ?? .5) : (profile.expressionWeight ?? .8));
        if (manager.expressions[index] === manager.currentExpression) {
          trace.expressionApplied = true; trace.expressionAlreadyActive = true;
        } else {
          continuity.begin(character.id,performance.now(),performancePolicy.transitionMs);
          trace.expressionApplied = await model.expression(action.expression);
          if (!trace.expressionApplied) throw new Error(`表情未被模型接受：${character.name} / ${name}`);
        }
      }
      if (token?.cancelled) { trace.cancelled = true; return; }
      if (action.motion) {
        const state = model.internalModel.motionManager.state;
        const index = action.motion.index || 0;
        if (state.currentGroup === action.motion.group && state.currentIndex === index) {
          trace.motionApplied = true; trace.motionAlreadyActive = true;
        } else {
          continuity.begin(character.id,performance.now(),performancePolicy.transitionMs);
          trace.motionApplied = await model.motion(action.motion.group, index, 3);
          if (!trace.motionApplied) throw new Error(`动作未被模型接受：${character.name} / ${name}`);
        }
      }
      if (token?.cancelled) { trace.cancelled = true; return; }
      const core = model.internalModel.coreModel;
      const params = (action.parameters || []).flatMap(p => {
        const index = core.getParameterIndex(p.id);
        if (index < 0 || index >= core.getParameterCount() || !Number.isFinite(p.value)) return [];
        return [{ id: p.id, from: core.getParameterValueByIndex(index), value: Math.max(core.getParameterMinimumValue(index), Math.min(core.getParameterMaximumValue(index), p.value)) }];
      });
      overrides.set(character.id, { start: performance.now(), duration: Math.max(100, Math.min(3000, action.durationMs || 400)), params });
      trace.settledAt = Date.now();
    } catch (error) { trace.error = error.message; throw error; }
  });
  actionChains.set(character.id, task);
  return task;
}

async function playAudio(turn, model) {
  if (!turn.audio) return;
  const audio = new Audio(`data:audio/wav;base64,${turn.audio}`);
  activeAudio = audio;
  const context = new AudioContext();
  const source = context.createMediaElementSource(audio);
  const analyser = context.createAnalyser();
  analyser.fftSize = 256;
  source.connect(analyser);
  analyser.connect(context.destination);
  const levels = new Uint8Array(analyser.frequencyBinCount);
  let frame;
  const update = () => {
    analyser.getByteFrequencyData(levels);
    if (model) model._duoMouth = Math.min(1, levels.reduce((a, b) => a + b, 0) / levels.length / 70);
    frame = requestAnimationFrame(update);
  };
  try {
    await context.resume();
    await new Promise((resolve, reject) => {
      audio.onended = resolve;
      audio.onpause = resolve;
      audio.onerror = () => reject(new Error('音频播放失败。'));
      audio.play().then(update, reject);
    });
  } finally {
    activeAudio = null;
    audio.pause();
    cancelAnimationFrame(frame);
    if (model) model._duoMouth = 0;
    await context.close();
  }
}

function pointInTriangle(px, py, ax, ay, bx, by, cx, cy) {
  const a = (px - bx) * (ay - by) - (ax - bx) * (py - by);
  const b = (px - cx) * (by - cy) - (bx - cx) * (py - cy);
  const c = (px - ax) * (cy - ay) - (cx - ax) * (py - ay);
  return !(a < 0 || b < 0 || c < 0) || !(a > 0 || b > 0 || c > 0);
}
function pickCharacterAt(clientX, clientY, target) {
  const cardId = target?.closest('.character')?.dataset.characterId;
  if (cardId) return cardId;
  const rect = document.getElementById('canvas').getBoundingClientRect();
  const x = (clientX - rect.left) * (pixi?.screen.width || rect.width) / rect.width;
  const y = (clientY - rect.top) * (pixi?.screen.height || rect.height) / rect.height;
  for (const [id, model] of [...models.entries()].reverse()) {
    if (!model.containsPoint(new PIXI.Point(x, y))) continue;
    const internal = model.internalModel, core = internal.coreModel;
    if (typeof core.getDrawableCount !== 'function' || typeof model.toModelPosition !== 'function') return id;
    const point = model.toModelPosition(new PIXI.Point(x, y));
    for (let index = core.getDrawableCount() - 1; index >= 0; index--) {
      if (core.getDrawableOpacity(index) < .02) continue;
      const vertices = internal.getDrawableVertices(index);
      const indices = core.getDrawableVertexIndices(index);
      for (let i = 0; i < indices.length; i += 3) {
        const a = indices[i] * 2, b = indices[i + 1] * 2, c = indices[i + 2] * 2;
        const area = (vertices[b] - vertices[a]) * (vertices[c + 1] - vertices[a + 1]) - (vertices[b + 1] - vertices[a + 1]) * (vertices[c] - vertices[a]);
        if (Math.abs(area) > 1e-6 && pointInTriangle(point.x, point.y, vertices[a], vertices[a + 1], vertices[b], vertices[b + 1], vertices[c], vertices[c + 1])) return id;
      }
    }
  }
  return null;
}
function clickFeedback(id) {
  const card = cards.get(id), model = models.get(id);
  if (!card) return;
  card.classList.add('click-feedback');
  if (model) model.tint = 0xf3e9ff;
  clearTimeout(feedbackTimers.get(id));
  feedbackTimers.set(id, setTimeout(() => { card.classList.remove('click-feedback'); if (model) model.tint = 0xffffff; feedbackTimers.delete(id); }, 220));
}
async function renderCharacters(characters) {
  for(const m of models.values())m.destroy({children:true});
  continuity.clear();models.clear();cards.clear();overrides.clear();positions.clear();actionChains.clear();
  document.getElementById('cast').replaceChildren();
  activeCast=characters;
  for (const [index, c] of characters.entries()) {
    const card = document.createElement('div');
    card.className = 'character';
    card.dataset.characterId = c.id;
    card.title = '按住角色拖动，可单独调整位置';
    const placeholder = document.createElement('div');
    placeholder.className = 'placeholder';
    placeholder.textContent = index === 0 ? 'A' : 'B';
    card.append(placeholder);
    cards.set(c.id, card);
    document.getElementById('cast').append(card);

    if (c.modelUrl && pixi) {
      try {
        const model = await PIXI.live2d.Live2DModel.from(c.modelUrl, { autoInteract: false });
        model.anchor.set(.5);
        model._sourceUrl = c.modelUrl;
        configureNaturalMovement(c,model);
        model._duoMouth = 0;
        model.internalModel.on('beforeModelUpdate', () => {
          const core = model.internalModel.coreModel;
          const state = overrides.get(c.id);
          if (state) {
            const elapsed = performance.now() - state.start;
            const progress = Math.min(1, elapsed / state.duration);
            const weight = elapsed < state.duration + 1800 ? 1 : Math.max(0, 1 - (elapsed - state.duration - 1800) / 500);
            for (const p of state.params) core.setParameterValueById(p.id, p.from + (p.value - p.from) * progress, weight);
            if (!weight) overrides.delete(c.id);
          }
          if (!config.ttsEnabled) {
            const index = core.getParameterIndex('ParamMouthOpenY');
            if (index >= 0 && index < core.getParameterCount()) core.setParameterValueById('ParamMouthOpenY', Math.min(core.getParameterValueByIndex(index), (activeCast.find(item=>item.id===c.id)?.presentation||c.presentation)?.maxSilentMouth ?? .25));
          }
          if (model._duoMouth > 0) core.setParameterValueById('ParamMouthOpenY', model._duoMouth);
          const target=Array.from({length:core.getParameterCount()},(_,i)=>core.getParameterValueByIndex(i));
          const blended=continuity.sample(c.id,target,performance.now());
          blended.forEach((v,i)=>core.setParameterValueByIndex(i,v));
        });
        models.set(c.id, model);
        pixi.stage.addChild(model);
        card.classList.add('has-model');
      } catch (error) { addLine('提示', `${c.name} 模型加载失败：${error.message}`); }
    }
  }
}
function configureNaturalMovement(character,model){
  const breath=model?.internalModel.breath;if(!breath)return;
  model._duoBreathParameters??=breath.getParameters().map(p=>({...p}));
  const weight=Math.max(0,Math.min(1,character.presentation?.naturalSwayWeight??0));
  breath.setParameters(model._duoBreathParameters.map(p=>({...p,weight:p.weight*(/Angle/.test(p.parameterId)?weight:1)})));
}
async function applyArchive(archive) {
  const changed=archive.cast.some(c=>models.get(c.id)?._sourceUrl!==c.modelUrl);
  if(changed)await renderCharacters(archive.cast);
  for(const c of archive.cast)if(c.modelUrl&&!models.has(c.id))throw new Error(c.name+'归档模型未能加载');
  for(const c of archive.cast)configureNaturalMovement(c,models.get(c.id));
  performancePolicy=window.DuoPerformance.policy(archive.playback);
  activeCast=archive.cast;activeArchive=archive;layout();
}
async function initialize() {
  config = await window.duo.config();
  document.getElementById('open-editor').onclick = () => window.duo.editor();
  document.getElementById('quit').onclick = () => window.duo.close();
  window.duo.mouse(false);
  if (window.Live2DCubismCore?.Memory) window.Live2DCubismCore.Memory.initializeAmountOfMemory(128 * 1024 * 1024);
  if (window.PIXI?.live2d) {
    if (PIXI.live2d.config) PIXI.live2d.config.preserveExpressionOnMotion = true;
    pixi = new PIXI.Application({ view: document.getElementById('canvas'), resizeTo: document.getElementById('stage'), backgroundAlpha: 0, antialias: true, resolution: Math.max(2, window.devicePixelRatio || 1), autoDensity: true });
    pixi.ticker.maxFPS = 30;
    new ResizeObserver(layout).observe(document.getElementById('stage'));
  }
  await renderCharacters(config.characters);
  layout();
  setPerformancePhase(null);
  scheduler = new window.DuoPlayback.PlaybackScheduler({
    list: () => window.duo.list(),
    play: async (id, reason) => {
      const token = { cancelled: false }; playback = token;
      try { await playScene(id, token); }
      finally { playback = null; if (token.cancelled) report('已停止播放，点击播放或保存播放设置可恢复轮播。'); }
    },
    cancel: stopPlayback, report, observe: state => window.duo.playbackState?.(state), settings: config.playback
  });
  scheduler.configure(config.playback);
  report('桌宠已就绪；有本地缓存时会自动定时轮播，点击角色可触发对话。');
}

function setPerformancePhase(speakerId){
  for(const c of activeCast){
    const phase=speakerId?(speakerId===c.id?'speaking':'listening'):'idle';
    if(!continuity.phase(c.id,phase,performance.now(),performancePolicy))continue;
    traceEvent({type:'performance-phase',characterId:c.id,phase});
    if(phase==='idle'){
      const model=models.get(c.id),core=model?.internalModel.coreModel;
      model?.internalModel.motionManager.stopAllMotions();
      model?.internalModel.motionManager.expressionManager?.resetExpression();
      overrides.delete(c.id);
      if(core){for(let i=0;i<core.getParameterCount();i++)core.setParameterValueByIndex(i,core.getParameterDefaultValue(i));core.saveParameters();}
    }
  }
}
function stopPlayback() {
  if (playback) playback.cancelled = true;
  activeAudio?.pause();
}
async function playScene(id, token, options = {}) {
  const scene = await window.duo.load(id, options);
  if (scene.error) throw new Error(scene.error);
  if (token.cancelled) return;
  await applyArchive(scene.archive);
  await preloadSceneActions(scene, token);
  if (token.cancelled) return;
  addLine('场景', scene.title);
  try {
  for (const [lineIndex,turn] of scene.turns.entries()) {
    if(options.lineIndex!==undefined&&options.lineIndex!==lineIndex)continue;
    if (token.cancelled) break;
    const c = scene.cast.find(c => c.id === turn.characterId);
    const card = cards.get(c.id);
    setPerformancePhase(c.id);
    addLine(c.name, turn.text);
    traceEvent({ type: 'turn', sceneId: id, characterId: c.id, text: turn.text, action: turn.action, timeline: turn.timeline || [] });
    card.dataset.speaking = 'true';
    const cueTimers = [];
    const pendingActions = [];
    let cueError = null;
    const startedAt = performance.now();
    const timeline = Array.isArray(turn.timeline) && turn.timeline.length ? turn.timeline : null;
    const lastCueAt = timeline ? Math.max(...timeline.map(cue => cue.atMs)) : 0;
    try {
      if (timeline) {
        for (const cue of timeline) {
          if (!Number.isFinite(cue.atMs) || cue.atMs < 0 || cue.atMs > 6000 || !cue.command) continue;
          const cueCharacter = {...c,actions:{...c.actions,[cue.action]:cue.command}};
          if (cue.atMs === 0) await applyAction(cueCharacter, cue.action, token);
          else cueTimers.push(setTimeout(() => {
            if (!token.cancelled) pendingActions.push(applyAction(cueCharacter, cue.action, token).catch(error => { cueError = error; }));
          }, Math.max(0, cue.atMs - (performance.now() - startedAt))));
        }
      } else {
        await applyAction(c, turn.action, token);
        if (c.actions[turn.emotion]) await applyAction(c, turn.emotion, token);
      }
      if (token.cancelled) continue;
      if (config.ttsEnabled && turn.audio) await playAudio(turn, models.get(c.id));
      const subtitleDuration = config.ttsEnabled && turn.audio ? 0 : Math.min(6000, 1000 + turn.text.length * 90);
      const until = startedAt + Math.max(subtitleDuration, lastCueAt + 700);
      while (!token.cancelled && performance.now() < until) await wait(60);
    } finally {
      cueTimers.forEach(clearTimeout);
      await Promise.all(pendingActions);
      card.dataset.speaking = 'false';
    }
    if (cueError) throw cueError;
  }
  } finally {setPerformancePhase(null);}
  report(scene.warnings.join('；') || '场景播放完成。');
}

function report(message) { status.textContent = message; window.duo.status(message); }
window.duo.onPlay(async ({id}) => {if(previewActive){stopPlayback();while(previewActive)await wait(30);}scheduler?.requestManual(id);});
window.duo.onPreview(async ({id,lineIndex})=>{
  const request=++previewRequest;if(previewActive)stopPlayback();while(previewActive)await wait(30);if(request!==previewRequest)return;previewActive=true;scheduler?.stop();
  while(scheduler?.running)await wait(30);
  const token={cancelled:false};playback=token;
  try{await playScene(id,token,{preview:true,lineIndex});if(!token.cancelled)window.duo.previewComplete({id,revision:activeArchive.revision,full:lineIndex===undefined});}catch(error){report(error.message);}finally{playback=null;previewActive=false;}
});
window.duo.onCaptureLayout(async id=>{if(previewActive){report('请等待预览结束或停止播放后，再保存坐标。');return;}if(!activeArchive||activeArchive.sceneId!==id){report('请先预览选中的场景，再保存坐标。');return;}const result=await window.duo.saveLayout(activeArchive.sceneId,activeArchive.revision,Object.fromEntries([...positions].map(([id,p])=>[id,{x:p.x/document.getElementById('stage').clientWidth,y:p.y/document.getElementById('stage').clientHeight}])));if(result.error)report(result.error);else{activeArchive.revision=result.revision;report('人物坐标已归档，请重新预览确认。');}});
window.duo.onStop(() => { scheduler?.stop(); report('已暂停播放与轮播，点击播放或保存播放设置可恢复。'); });
window.duo.onPlaybackSettings(async settings => {if(previewActive){stopPlayback();while(previewActive)await wait(30);}config.playback = settings; scheduler?.configure(settings); });
window.duo.onLibrary(() => scheduler?.libraryChanged());
window.addEventListener('beforeunload', () => scheduler?.dispose());
window.duo.onCharacters(async () => {
  config = await window.duo.config();

  scheduler?.refresh(config.playback, { interrupt: true });
});
document.addEventListener('pointerdown', event => {
  if (event.button !== 0 || event.target.closest('button, .line')) return;
  const id = pickCharacterAt(event.clientX, event.clientY, event.target);
  traceEvent({type:'pointerdown',characterId:id,x:event.clientX,y:event.clientY});
  if (id && positions.has(id)) {
    drag = { kind: 'character', id, pointerId: event.pointerId, target: event.target, x: event.clientX, y: event.clientY, start: { ...positions.get(id) }, moved: false };
  } else {
    drag = { kind: 'window', pointerId: event.pointerId, target: event.target, x: event.clientX, y: event.clientY, moved: false };
    window.duo.dragWindow({ phase: 'start', x: event.screenX, y: event.screenY });
  }
  event.target.setPointerCapture(event.pointerId);
  window.duo.mouse(false);
  event.preventDefault();
});
document.addEventListener('pointermove', event => {
  if (!drag || event.pointerId !== drag.pointerId) return;
  if (drag.kind === 'window') {
    if ((event.buttons & 1) && (drag.moved || Math.hypot(event.clientX - drag.x, event.clientY - drag.y) > 5)) { drag.moved = true; document.body.classList.add('dragging'); window.duo.dragWindow({ phase: 'move', x: event.screenX, y: event.screenY }); }
    return;
  }
  if (!(event.buttons & 1) || event.clientX < 0 || event.clientY < 0 || event.clientX > innerWidth || event.clientY > innerHeight) return;
  if (Math.hypot(event.clientX - drag.x, event.clientY - drag.y) > 5) drag.moved = true;
  if (drag.moved) document.body.classList.add('dragging');
  if (drag.moved) positionCharacter(drag.id, drag.start.x + event.clientX - drag.x, drag.start.y + event.clientY - drag.y);
});
function endDrag(event) {
  if (!drag || (event.pointerId !== undefined && event.pointerId !== drag.pointerId)) return;
  const finished = drag;
  drag = null;
  const clickedCharacter = finished.kind === 'character' && !finished.moved && event.type === 'pointerup' ? finished.id : null;
  if (finished.kind === 'window') window.duo.dragWindow({ phase: 'end' });
  else {
    const position = positions.get(finished.id);
    const stage = document.getElementById('stage');
    savedPositions[finished.id] = { x: position.x / stage.clientWidth, y: position.y / stage.clientHeight };
    try { localStorage.setItem('duo-character-positions-bust-v2', JSON.stringify(savedPositions)); } catch { /* The current position remains usable without persistence. */ }
  }
  if (finished.target.hasPointerCapture(finished.pointerId)) finished.target.releasePointerCapture(finished.pointerId);
  document.body.classList.remove('dragging');
  traceEvent({type:'pointerup',characterId:clickedCharacter,trigger:event.type});
  if (clickedCharacter && !previewActive) { clickFeedback(clickedCharacter); const accepted = scheduler?.requestClick(clickedCharacter); traceEvent({type:'click',characterId:clickedCharacter,accepted:Boolean(accepted)}); }
}
document.addEventListener('pointerup', endDrag);
document.addEventListener('pointercancel', endDrag);
window.addEventListener('blur', endDrag);
document.addEventListener('lostpointercapture', endDrag);
if (window.duo.onNativeDrag) window.duo.onNativeDrag(active => document.body.classList.toggle('native-dragging', Boolean(active)));
window.duoStageDebug = Object.freeze({
  pickCharacterAt: (x, y) => pickCharacterAt(x, y),
  readState: () => ({ initialized: Boolean(config && scheduler), modelIds: [...models.keys()], activePlayback: Boolean(playback), performance:continuity.read(), drag: drag ? {kind: drag.kind, moved: drag.moved} : null, background: getComputedStyle(document.body).backgroundColor, dragOpacity: Number(getComputedStyle(document.getElementById('drag-effect')).opacity), actionTrace: actionTrace.map(item => ({...item})), scheduler: scheduler?.getState?.() || null })
});
initialize().catch(error => report(`初始化失败：${error.message}`));
