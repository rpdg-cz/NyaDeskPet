const { app, BrowserWindow, ipcMain, session, shell, safeStorage, screen } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { PersonalRuntime, writeJson } = require('./runtime.cjs');
const { normalizePlayback } = require('./playback.js');
const { CredentialStore } = require('./credential-store.cjs');
app.setName('Personal Duo Pet');
const dataDir = process.argv.includes('--archive-verify') ? path.join(__dirname,'..','.preview','archive-user-data') : (process.argv.includes('--smoke') || process.argv.includes('--visual-probe')) ? path.join(__dirname, '..', '.preview', 'desktop-user-data') : path.join(app.getPath('appData'), 'PersonalDuoPet');
app.setPath('userData', dataDir);
const configFile = path.join(__dirname, 'config.json');
const config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
const preferencesFile = path.join(dataDir, 'preferences.json');
let preferences = {};
if (fs.existsSync(preferencesFile)) {
  const prefs = JSON.parse(fs.readFileSync(preferencesFile, 'utf8'));
  preferences = prefs;
  if (typeof prefs.offline === 'boolean') config.offline = prefs.offline;
}
config.playback = normalizePlayback(preferences.playback || config.playback);
if (process.argv.includes('--joint-debug')) config.playback = { ...config.playback, enabled: true, intervalSeconds: 5, clickEnabled: true };
const runtime = new PersonalRuntime(config, dataDir, JSON.parse(fs.readFileSync(path.join(__dirname, 'presets.json'), 'utf8')));
const credentials = new CredentialStore(dataDir, safeStorage);
let credentialError = '';
let busy = false;
const previewed = new Map();
let window;
let editorWindow;
let quitting = false;
const isDesktopTask = !process.argv.some(arg => ['--smoke','--visual-probe','--prepare-dialogue','--inspect-provider','--credential-check','--revise-dialogue','--archive-verify','--migrate-archives'].includes(arg));
if (isDesktopTask && !app.requestSingleInstanceLock()) app.exit(0);
app.on('second-instance', () => { window?.show(); editorWindow?.show(); });
function createEditor(show = true) {
  if (editorWindow) { if (show) { editorWindow.show(); editorWindow.focus(); } return editorWindow; }
  const stageBounds = window?.getBounds();
  const area = stageBounds ? screen.getDisplayMatching(stageBounds).workArea : screen.getPrimaryDisplay().workArea;
  const editorPosition = stageBounds ? {
    x: Math.max(area.x, Math.min(area.x + area.width - 560, stageBounds.x + stageBounds.width + 12)),
    y: Math.max(area.y, Math.min(area.y + area.height - 580, stageBounds.y))
  } : {};
  editorWindow = new BrowserWindow({ ...editorPosition, width: 560, height: 580, minWidth: 420, minHeight: 420, maxWidth: 600, maxHeight: 600, show, autoHideMenuBar: true,
    title: '双角色桌宠 · 编辑器', backgroundColor: '#faf9f6',
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true } });
  editorWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  editorWindow.webContents.on('will-navigate', event => event.preventDefault());
  editorWindow.loadFile(path.join(__dirname, 'editor.html'));
  editorWindow.on('close', event => {
    if (!quitting) { event.preventDefault(); editorWindow.hide(); }
  });
  editorWindow.on('closed', () => { editorWindow = null; });
  return editorWindow;
}
app.whenReady().then(async () => {
  try {
    runtime.sessionKey = credentials.load();
    const importFile = path.resolve(__dirname, '..', '..', 'deepseekapi.txt');
    if (!runtime.sessionKey && !process.argv.includes('--smoke') && fs.existsSync(importFile)) runtime.sessionKey = credentials.importFile(importFile);
  } catch (error) { credentialError = error.message; }
  if(process.argv.includes('--migrate-archives')){console.log(JSON.stringify({archives:runtime.listScenes().map(({id,published})=>({id,published}))}));app.exit(0);return;}
  if (process.argv.includes('--inspect-provider')) {
    try {
      runtime.config.offline = false;
      const response = await runtime.request(config.llm, '/models', null, 'GET');
      const result = await response.json();
      console.log(JSON.stringify({ modelIds: (result.data || []).map(item => item.id) }));
      app.exit(0);
    } catch (error) { console.error(error.message); app.exit(1); }
    return;
  }
  if (process.argv.includes('--prepare-dialogue')) {
    try {
      if (!runtime.sessionKey) throw new Error(credentialError || '请先保存本机 DeepSeek 密钥。');
      const input = path.join(__dirname, 'examples', 'rain-after-dialogue.json');
      runtime.config.offline = false;
      const result = await runtime.generate('雨后散步（表情＋身体动作联合测试）：原台词保持不变。必须为每个人物编排至少一个真实身体motion（pose_c/pose_l/pose_r），不能只有表情：角色A第一句以pose_r开始，角色B第一句以pose_l开始，随后在400ms之后独立添加合适的表情变化。其余台词按语义安排表情与身体转向，单句最多4事件，末事件不晚于3500ms。不要用idle代替身体转向。', { mode: 'import', dialogue: fs.readFileSync(input, 'utf8') });
      const reportFile = path.join(__dirname, 'reports', 'deepseek-rain-walk-result.json');
      const scene = runtime.loadScene(result.id,{preview:true});
      const bodyMotionCharacters = new Set(scene.turns.flatMap(turn => (turn.timeline || []).filter(cue => runtime.config.characters.find(c => c.id === turn.characterId).actions[cue.action]?.motion).map(() => turn.characterId)));
      if (bodyMotionCharacters.size !== 2) throw new Error('本次API结果未包含两个人物的真实身体动作，联合测试未通过。');
      writeJson(reportFile, { bodyMotionCharacters: [...bodyMotionCharacters], testedAt: new Date().toISOString(), provider: 'DeepSeek', model: config.llm.model, sourceDialogue: JSON.parse(fs.readFileSync(input, 'utf8')), result, scene });
      console.log(JSON.stringify({ success: true, keyStored: credentials.exists(), sceneId: result.id, turns: scene.turns.length, cues: scene.turns.reduce((n,t) => n+(t.timeline?.length||0),0), bodyMotionCharacters: [...bodyMotionCharacters], reportFile }));
      app.exit(0);
    } catch (error) { console.error(JSON.stringify({ success: false, error: error.message })); app.exit(1); }
    return;
  }
  if(process.argv.includes('--revise-dialogue')){
    try{console.log(JSON.stringify(await require('./revision-verification.cjs').runRevisionVerification(runtime)));app.exit(0);}catch(error){console.error(error.stack);app.exit(1);}return;
  }
  if (process.argv.includes('--credential-check')) {
    console.log(JSON.stringify({ keyStored: credentials.exists(), keyLoaded: Boolean(runtime.sessionKey), encryptionAvailable: safeStorage.isEncryptionAvailable(), error: credentialError || null }));
    app.exit(runtime.sessionKey && credentials.exists() ? 0 : 1);
    return;
  }
  // The stage never needs internet access, even when the main process creates scenes.
  session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] }, (_details, callback) => callback({ cancel: true }));
  window = new BrowserWindow({ show: !(process.argv.includes('--smoke') || process.argv.includes('--visual-probe') || process.argv.includes('--archive-verify')), width: 480, height: 480, minWidth: 360, minHeight: 360, maxWidth: 600, maxHeight: 600, transparent: true, backgroundColor: '#00000000', hasShadow: false, frame: false, alwaysOnTop: true,
    webPreferences: { offscreen: process.argv.includes('--smoke') || process.argv.includes('--visual-probe') || process.argv.includes('--archive-verify'), backgroundThrottling: false, preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true } });
  let moveEffectTimer;
  window.on('move', () => {
    window?.webContents.send('duo:native-drag', true);
    clearTimeout(moveEffectTimer);
    moveEffectTimer = setTimeout(() => window?.webContents.send('duo:native-drag', false), 180);
  });
  window.on('closed', () => clearTimeout(moveEffectTimer));
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', event => event.preventDefault());
  window.loadFile(path.join(__dirname, 'stage.html'));
  window.on('closed', () => { window = null; if (!quitting) app.quit(); });
  if (process.argv.includes('--editor')) createEditor();
  if (process.argv.includes('--visual-probe')) {
    const { runVisualProbe } = require('./visual-probe.cjs');
    void runVisualProbe({app, window, runtime}).catch(error => {console.error(error.stack);app.exit(1);});
  }
  if(process.argv.includes('--archive-verify')){void require('./archive-verification.cjs').runArchiveVerification({app,window,createEditor,runtime}).catch(error=>{console.error(error.stack);app.exit(1);});}
  if (process.argv.includes('--smoke')) {
    const { runDesktopVerification } = require('./desktop-verification.cjs');
    void runDesktopVerification({ app, window, createEditor, runtime, dataDir }).catch(error => { console.error(error.message); app.exit(1); });
  }
});
ipcMain.handle('duo:config', () => ({ playback: config.playback, offline: config.offline, ttsEnabled: config.tts.enabled,
  keyConfigured: Boolean(runtime.sessionKey || process.env[config.llm.apiKeyEnv]), keyStored: credentials.exists(), credentialError,
  characters: config.characters.map(c => ({ id: c.id, name: c.name, presentation: c.presentation, userPrompt: c.userPrompt, actions: c.actions, modelUrl: c.modelPath ? pathToFileURL(path.resolve(__dirname, '..', c.modelPath)).href : null })) }));
ipcMain.handle('duo:offline', (_event, offline) => {
  if (busy) return { error: '制作中暂不能切换模式，请等待完成。' };
  if (typeof offline !== 'boolean') return { error: '模式无效。' };
  config.offline = offline;
  preferences.offline = offline;
  writeJson(preferencesFile, preferences);
  return { offline };
});
ipcMain.handle('duo:playback-settings', (_event, value) => {
  try {
    const settings = normalizePlayback(value);
    preferences.playback = settings;
    writeJson(preferencesFile, preferences);
    config.playback = settings;
    window?.webContents.send('duo:playback-settings', settings);
    return { settings };
  } catch (error) { return { error: error.message }; }
});
ipcMain.handle('duo:key', (_event, key) => {
  if (typeof key !== 'string' || key.length > 512) return { error: '密钥格式无效。' };
  try { runtime.sessionKey = credentials.save(key); credentialError = ''; return { configured: true, stored: true }; }
  catch (error) { return { error: error.message }; }
});
ipcMain.handle('duo:list', () => runtime.listScenes());
ipcMain.handle('duo:load', (_event, id, options) => {
  try { return runtime.loadScene(id, options); } catch (error) { return { error: error.message }; }
});
ipcMain.handle('duo:archive', (_event,id)=>{try{return runtime.archives.read(id);}catch(error){return{error:error.message};}});
ipcMain.on('duo:preview',(_event,value)=>{window?.show();window?.webContents.send('duo:preview',value);});
ipcMain.on('duo:preview-complete',(event,value)=>{if(event.sender!==window?.webContents||!value)return;if(value.full)previewed.set(value.id,value.revision);editorWindow?.webContents.send('duo:preview-complete',value);});
ipcMain.on('duo:capture-layout',(_event,id)=>window?.webContents.send('duo:capture-layout',id));
ipcMain.handle('duo:save-layout',(_event,id,revision,positions)=>{try{const r=runtime.saveLayout(id,revision,positions);editorWindow?.webContents.send('duo:library-changed');return r;}catch(error){return{error:error.message};}});
ipcMain.handle('duo:publish',(_event,id,revision)=>{try{if(previewed.get(id)!==revision)throw new Error('请完整预览当前修订后再确认加入轮播');const r=runtime.publishScene(id,revision);window?.webContents.send('duo:playback-settings',config.playback);window?.webContents.send('duo:library-changed');return r;}catch(error){return{error:error.message};}});
ipcMain.handle('duo:revise',async(_event,id,options)=>{
 if(busy)return{error:'正在创作，请稍候'};busy=true;
 try{return await runtime.reviseScene(id,options);}catch(error){return{error:error.message};}finally{busy=false;}
});
ipcMain.handle('duo:generate', async (_event, prompt, options) => {
  if (busy) return { error: '请等待当前场景制作完成。' };
  busy = true;
  try { const result = await runtime.generate(prompt, options); window?.webContents.send('duo:library-changed'); return result; }
  catch (error) { return { error: error.message }; }
  finally { busy = false; }
});
ipcMain.handle('duo:characters', (_event, characters) => {
  if (busy) return { error: '制作中请等待完成后再保存角色。' };
  try { runtime.updateCharacters(characters); window?.webContents.send('duo:characters-changed'); return { saved: true }; }
  catch (error) { return { error: error.message }; }
});
let windowDrag = null;
ipcMain.on('duo:window-drag', (event, value) => {
  if (event.sender !== window?.webContents || !value) return;
  if (value.phase === 'end') { windowDrag = null; return; }
  if (!Number.isFinite(value.x) || !Number.isFinite(value.y)) return;
  if (value.phase === 'start') windowDrag = { cursor: { x: value.x, y: value.y }, bounds: window.getBounds() };
  else if (value.phase === 'move' && windowDrag) {
    window.setBounds({ ...windowDrag.bounds, x: Math.round(windowDrag.bounds.x + value.x - windowDrag.cursor.x), y: Math.round(windowDrag.bounds.y + value.y - windowDrag.cursor.y) });
  }
});
ipcMain.on('duo:mouse', (event, ignore) => {
  if (event.sender === window?.webContents && typeof ignore === 'boolean') window?.setIgnoreMouseEvents(ignore, { forward: true });
});
ipcMain.on('duo:editor', () => createEditor());
ipcMain.on('duo:play', (_event, value) => {
  if (value && typeof value.id === 'string' && typeof value.autoplay === 'boolean') {
    window?.show();
    window?.webContents.send('duo:play', value);
  }
});
ipcMain.on('duo:stop', () => window?.webContents.send('duo:stop'));
let playbackState = null;
ipcMain.on('duo:playback-state', (event, state) => {
  if (event.sender !== window?.webContents || !state || typeof state.phase !== 'string') return;
  playbackState = state;
  if (process.argv.includes('--joint-debug')) writeJson(path.join(dataDir, 'joint-debug-state.json'), { observedAt: new Date().toISOString(), ...state });
  editorWindow?.webContents.send('duo:playback-state', state);
});
ipcMain.handle('duo:playback-state', () => playbackState);
ipcMain.on('duo:status', (event, message) => {
  if (event.sender === window?.webContents && typeof message === 'string') editorWindow?.webContents.send('duo:status', message.slice(0, 2000));
});
ipcMain.on('duo:folder', () => { fs.mkdirSync(dataDir, { recursive: true }); shell.openPath(dataDir); });
ipcMain.on('duo:close', () => app.quit());
ipcMain.on('duo:minimize', () => window?.minimize());
app.on('before-quit', () => { quitting = true; });
app.on('window-all-closed', () => app.quit());
