let config;
let selectedArchive = null;
let previewedRevision = null;
let submitting = false;
const status = document.getElementById('status');
function updateMode() {
  document.getElementById('scheduled-playback').checked = config.playback.enabled;
  document.getElementById('playback-interval').value = config.playback.intervalSeconds;
  document.getElementById('click-playback').checked = config.playback.clickEnabled;
  document.getElementById('offline').checked = config.offline;
  document.getElementById('studio').hidden = config.offline;
  document.getElementById('key-status').textContent = config.keyStored && config.keyConfigured ? '已加密保存，重启自动加载' : config.keyConfigured ? '已从环境变量加载' : (config.credentialError || 'API Key 尚未设置');
}
async function refreshScenes(selected) {
  const scenes = await window.duo.list();
  const select = document.getElementById('scene-list');
  const previous = selected || select.value;
  select.replaceChildren();
  for (const scene of scenes) {
    const option = new Option(`${scene.title}${scene.published === false ? ' · 草稿' : ''} · ${scene.turnCount} 句${!scene.preset ? (scene.userConfirmed ? ' · 已确认' : scene.reviewed ? ' · Review已通过' : scene.published===false ? ' · 待预览' : ' · 旧版未复审') : ''}${config.ttsEnabled ? ` · 语音 ${scene.audioCount}/${scene.turnCount}` : ''}${scene.compatible ? '' : ' · 需重新制作'}`, scene.id);
    option.disabled = !scene.compatible;
    select.add(option);
  }
  if ([...select.options].some(o => o.value === previous && !o.disabled)) select.value = previous;
  await inspectArchive();
}
document.getElementById('offline').onchange = async event => {
  const result = await window.duo.offline(event.target.checked);
  if (result.error) status.textContent = result.error;
  else { config.offline = result.offline; status.textContent = config.offline ? '离线播放：不会调用 DeepSeek 或 GPT-SoVITS。' : '联网制作：生成场景会使用 DeepSeek API。'; }
  updateMode();
};
document.getElementById('save-key').onclick = async () => {
  const field = document.getElementById('api-key');
  const result = await window.duo.key(field.value);
  field.value = '';
  if (result.error) status.textContent = result.error;
  else { config.keyConfigured = result.configured; config.keyStored = result.stored; updateMode(); status.textContent = '密钥已加密保存在本机，重启后自动加载。'; }
};
document.getElementById('open-folder').onclick = () => window.duo.folder();
document.getElementById('prompt-form').onsubmit = async event => {
  event.preventDefault();
  if (submitting || !config || config.offline) return;
  const prompt = document.getElementById('prompt').value.trim() || (document.getElementById('authoring-mode').value === 'import' ? '保持原台词，根据角色编排自然的表演。' : '');
  if (!prompt && document.getElementById('authoring-mode').value !== 'import') return;
  submitting = true;
  document.getElementById('send').disabled = true;
  status.textContent = document.getElementById('authoring-mode').value === 'import' ? '正在编排动作，随后进行独立 Review；原台词保持不变…' : '正在创作台词与表演，随后独立 Review（必要时修订一次）…';
  try {
    const result = await window.duo.generate(prompt, { mode: document.getElementById('authoring-mode').value, dialogue: document.getElementById('dialogue-source').value });
    if (result.error) throw new Error(result.error);
    await refreshScenes(result.id);
    status.textContent = result.warnings.length ? `场景已保存：${result.warnings.join('；')}` : '草稿已归档，请预览后确认加入轮播。';
  } catch (error) { status.textContent = error.message; }
  finally { submitting = false; document.getElementById('send').disabled = false; }
};

document.getElementById('authoring-mode').onchange = event => {
  document.getElementById('import-panel').hidden = event.target.value !== 'import';
  document.getElementById('prompt').required = event.target.value !== 'import';
};
document.getElementById('dialogue-file').onchange = async event => {
  const file = event.target.files[0];
  if (!file) return;
  if (file.size > 160000) { status.textContent = '文件过大，请导入不超过 40000 字符的对话。'; return; }
  try {
    document.getElementById('dialogue-source').value = await file.text();
    if (!document.getElementById('prompt').value.trim()) document.getElementById('prompt').value = '保留台词原文，根据人物性格编排自然、克制的表演。';
    status.textContent = `已读取 ${file.name}，点击「制作并缓存」后才会调用 API。`;
  } catch (error) { status.textContent = error.message; }
};
function renderCharacterEditor() {
  const fields = document.getElementById('character-fields');
  fields.replaceChildren();
  for (const c of config.characters) {
    const fieldset = document.createElement('fieldset');
    fieldset.dataset.characterId = c.id;
    const legend = document.createElement('legend');
    legend.textContent = c.id;
    fieldset.append(legend);
    for (const [key, label, value, multiline] of [
      ['name', '角色名称', c.name, false],
      ['userPrompt', 'User Prompt · 性格 / 关系 / 说话方式 / 创作要求', c.userPrompt || '', true],
      ['actions', '动作映射 JSON · 支持表情、动作组和参数组合', JSON.stringify(c.actions, null, 2), true]
    ]) {
      const element = document.createElement('label');
      element.className = 'field';
      element.append(document.createTextNode(label));
      const input = document.createElement(multiline ? 'textarea' : 'input');
      input.dataset.field = key;
      input.value = value;
      if (multiline) input.rows = key === 'userPrompt' ? 4 : 3;
      if (key === 'name') input.maxLength = 40;
      if (key === 'userPrompt') input.maxLength = 8000;
      element.append(input);
      if (key === 'actions') {
        const details = document.createElement('details');
        const summary = document.createElement('summary');
        summary.textContent = '动作映射（高级）';
        details.append(summary, element);
        fieldset.append(details);
      } else fieldset.append(element);
    }
    fields.append(fieldset);
  }
}
document.getElementById('open-characters').onclick = () => {
  if (!config) return;
  renderCharacterEditor();
  document.getElementById('character-status').textContent = '';
  document.getElementById('character-editor').showModal();
};
document.getElementById('cancel-characters').onclick = () => document.getElementById('character-editor').close();
document.getElementById('characters-form').onsubmit = async event => {
  event.preventDefault();
  try {
    const characters = [...document.querySelectorAll('#character-fields fieldset')].map(fieldset => ({
      id: fieldset.dataset.characterId,
      name: fieldset.querySelector('[data-field=name]').value,
      userPrompt: fieldset.querySelector('[data-field=userPrompt]').value,
      actions: JSON.parse(fieldset.querySelector('[data-field=actions]').value)
    }));
    const result = await window.duo.characters(characters);
    if (result.error) throw new Error(result.error);
    config = await window.duo.config();
    await refreshScenes();
    document.getElementById('character-editor').close();
    status.textContent = '角色对象已保存，下次创作将分别应用两位角色的 User Prompt。';
  } catch (error) { document.getElementById('character-status').textContent = error.message; }
};

document.getElementById('play').onclick = () => {
  const id = document.getElementById('scene-list').value;
  if (id) window.duo.play(id, false);
};
document.getElementById('stop').onclick = () => window.duo.stop();
window.duo.onStatus(message => { status.textContent = message; });
(async () => { config = await window.duo.config(); updateMode(); await refreshScenes(); })().catch(error => { status.textContent = error.message; });

document.getElementById('quit').onclick = () => window.duo.close();

document.getElementById('playback-form').onsubmit = async event => {
  event.preventDefault();
  const result = await window.duo.savePlayback({
    enabled: document.getElementById('scheduled-playback').checked,
    intervalSeconds: Number(document.getElementById('playback-interval').value),
    clickEnabled: document.getElementById('click-playback').checked
  });
  if (result.error) { status.textContent = result.error; return; }
  config.playback = result.settings;
  status.textContent = '播放设置已保存，立即生效；轮播与点击事件都只使用本地缓存。';
};
window.duo.onLibrary(() => { void refreshScenes(); });

let lastPlaybackState = null;
function renderPlaybackState() {
  const target = document.getElementById('playback-state');
  const state = lastPlaybackState;
  if (!state) { target.textContent = '桌宠正在初始化模型，稍候即可播放。'; return; }
  const names = {idle:'就绪',loading:'读取本地场景',playing:'正在播放',waiting:'等待下一段',empty:'没有可播放场景',error:'播放出错',stopped:'已暂停'};
  const source = state.source === 'cache' ? '生成缓存' : state.source === 'preset' ? '内置示例' : '本地场景';
  const countdown = state.nextAt ? ` · ${Math.max(0, Math.ceil((state.nextAt - Date.now()) / 1000))} 秒后播放` : '';
  target.textContent = `${names[state.phase] || state.phase} · ${source} ${state.availableCount} 段 · 已接收点击 ${state.acceptedClicks} 次 · 已开始 ${state.startedScenes} 段${countdown}${state.error ? ' · ' + state.error : ''}`;
}
window.duo.onPlaybackState(state => { lastPlaybackState = state; renderPlaybackState(); });
void window.duo.getPlaybackState().then(state => { lastPlaybackState = state; renderPlaybackState(); });
setInterval(renderPlaybackState, 1000);

async function inspectArchive(){
 const id=document.getElementById('scene-list').value;if(!id)return;
 const archive=await window.duo.archive(id);
 if(archive.error){status.textContent=archive.error;return;}
 selectedArchive=archive;previewedRevision=null;
 document.getElementById('archive-info').textContent=`归档 v${archive.version} · 修订 ${archive.revision} · ${archive.published?'已发布':'草稿待确认'} · ${archive.cast.map(c=>c.name).join(' / ')}`;
 const lines=document.getElementById('edit-line');lines.replaceChildren();
 archive.turns.forEach((t,i)=>lines.add(new Option(`${i+1}. ${archive.cast.find(c=>c.id===t.characterId).name}：${t.text}`,String(i))));
 renderSelectedTimeline();
}
function renderSelectedTimeline(){if(!selectedArchive)return;const turn=selectedArchive.turns[Number(document.getElementById('edit-line').value)];document.getElementById('selected-timeline').textContent=turn.timeline.map(c=>`${c.atMs} ms · ${c.command.description||(c.command.motion?'身体动作':c.command.expression?'表情变化':'静止')}`).join('\n');}
document.getElementById('scene-list').addEventListener('change',()=>void inspectArchive());
document.getElementById('edit-line').onchange=renderSelectedTimeline;
document.getElementById('preview-scene').onclick=()=>{if(!selectedArchive)return;previewedRevision=null;window.duo.preview(selectedArchive.sceneId);status.textContent='桌面正在预览归档；轮播暂停，拖动可调整构图。';};
document.getElementById('publish-scene').onclick=async()=>{if(!selectedArchive)return;if(previewedRevision!==selectedArchive.revision){status.textContent='请先预览当前修订，再确认发布。';return;}const result=await window.duo.publish(selectedArchive.sceneId,selectedArchive.revision);if(result.error){status.textContent=result.error;return;}await refreshScenes(result.id);status.textContent='已确认归档，轮播将从本地对象读取。';};
document.getElementById('capture-layout').onclick=()=>{if(!selectedArchive)return;window.duo.captureLayout(selectedArchive.sceneId);status.textContent='正在将预览中的人物坐标写入归档，保存后请重新预览确认。';};
document.getElementById('revise-scene').onclick=async()=>{
 if(!selectedArchive||submitting)return;if(config.offline){status.textContent='请先切换到联网制作。';return;}
 submitting=true;const button=document.getElementById('revise-scene');button.disabled=true;
 try{
 const options={lineIndex:Number(document.getElementById('edit-line').value),startMs:Number(document.getElementById('edit-start').value),endMs:Number(document.getElementById('edit-end').value),feedback:document.getElementById('edit-feedback').value};
 status.textContent='工具正在定位所选片段，LLM 只返回此范围内的动作补丁…';
 const result=await window.duo.revise(selectedArchive.sceneId,options);if(result.error)throw new Error(result.error);
 document.getElementById('revision-prompt').textContent=JSON.stringify(result.inspection,null,2)+'\n\n'+result.prompt+'\n\n修改说明：'+result.explanation;await refreshScenes(result.id);status.textContent='局部修订已保存为新归档，原版保留。请预览，再确认加入轮播。';
 }catch(error){status.textContent=error.message;}finally{submitting=false;button.disabled=false;}
};

document.getElementById('preview-line').onclick=()=>{if(selectedArchive)window.duo.preview(selectedArchive.sceneId,{lineIndex:Number(document.getElementById('edit-line').value)});};
window.duo.onPreviewComplete(value=>{if(selectedArchive?.sceneId===value.id&&selectedArchive.revision===value.revision&&value.full){previewedRevision=value.revision;status.textContent='完整预览结束；可填写局部反馈，或确认加入轮播。';}});
