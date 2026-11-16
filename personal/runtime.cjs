const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const hash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const { validateCharacters, parseDialogue, annotateDialogue, discoverActions, validateTimeline } = require('./authoring.cjs');
const playbackFingerprint = characters => hash(characters.map(c => ({ id: c.id, modelPath: c.modelPath, revision: c.revision, actions: c.actions })));
const { reviewPerformance, REVIEW_VERSION } = require('./review.cjs');
const { ArchiveStore, compileArchive, checkResources } = require('./archive.cjs');
const { reviseSegment } = require('./revision.cjs');
const {policy}=require('./performance.js');
const EMOTIONS = ['neutral', 'happy', 'sad', 'surprised', 'calm'];
function endpoint(baseUrl, suffix, offline) {
  if (offline) throw new Error('离线播放模式不调用任何生成服务。');
  const url = new URL(baseUrl.replace(/\/$/, '') + suffix);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('请使用 HTTP/HTTPS 服务地址，密钥单独配置。');
  return url;
}
function validateTurns(value, characters) {
  if (!Array.isArray(value) || value.length < 2 || value.length > 24) throw new Error('场景应包含 2 至 24 段双角色对话。');
  const turns = value.map(turn => {
    const c = characters.find(c => c.id === turn?.characterId);
    if (!c || typeof turn.text !== 'string' || !turn.text.trim() || turn.text.length > 1000) throw new Error('角色或台词格式无效。');
    const timeline = validateTimeline(turn.timeline, c);
    return { ...(timeline ? { timeline } : {}), characterId: c.id, text: turn.text, emotion: EMOTIONS.includes(turn.emotion) ? turn.emotion : 'neutral', action: Object.hasOwn(c.actions, turn.action) ? turn.action : 'idle' };
  });
  if (new Set(turns.map(t => t.characterId)).size !== 2) throw new Error('场景必须包含两位角色的台词。');
  return turns;
}
function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.' + crypto.randomUUID() + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}
function readJson(file, fallback) { return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : fallback; }
class PersonalRuntime {
  constructor(config, dataDir, presets = {}) {
    if (typeof config.offline !== 'boolean' || config.characters?.length !== 2 || new Set(config.characters.map(c => c.id)).size !== 2) throw new Error('需要两位不同角色及离线模式设置。');
    for (const c of config.characters) if (!/^[a-z0-9-]+$/.test(c.id) || !c.actions) throw new Error('角色配置无效。');
    this.config = config;
    this.dataDir = dataDir;
    this.presets = presets;
    this.sessionKey = '';
    const saved = readJson(path.join(dataDir, 'characters.json'), null);
    const defaults = config.characters.map(c => ({ ...c, userPrompt: c.userPrompt ?? c.persona ?? '' }));
    config.characters = saved ? validateCharacters(saved, defaults).map(c => ({ ...c, actions: { ...defaults.find(original => original.id === c.id).actions, ...c.actions } })) : defaults;
    config.characters = config.characters.map(c => ({ ...c, actions: discoverActions(c) }));
    this.archives = new ArchiveStore(dataDir);
    this.migrateArchives();
  }
  updateCharacters(characters) {
    const next = validateCharacters(characters, this.config.characters);
    writeJson(path.join(this.dataDir, 'characters.json'), next);
    this.config.characters = next;
    return next;
  }
  sceneFile(id) {
    if (!/^[a-f0-9]{64}$/.test(id)) throw new Error('场景编号无效。');
    return path.join(this.dataDir, 'scenes', id + '.json');
  }
  async request(provider, suffix, body, method = 'POST') {
    const url = endpoint(provider.baseUrl, suffix, this.config.offline);
    const key = (provider === this.config.llm ? this.sessionKey : '') || process.env[provider.apiKeyEnv] || '';
    const response = await fetch(url, { method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(key ? { Authorization: `Bearer ${key}` } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}), redirect: 'error', signal: AbortSignal.timeout(provider.timeoutMs || 60000) });
    if (!response.ok) {
      let detail='';
      try { const data=await response.json();detail=String(data.error?.message||data.message||'').slice(0,500); } catch { /* Some providers return an HTML error page. */ }
      if(key)detail=detail.replaceAll(key,'[已隐藏]');
      throw new Error(`生成服务返回 ${response.status}，请检查密钥、模型及接口配置。${detail?' '+detail:''}`);
    }
    return response;
  }
  async synthesize(turn) {
    const provider = this.config.tts;
    const c = this.config.characters.find(c => c.id === turn.characterId);
    const speech = c.speech || {};
    const audioKey = hash({ text: turn.text, id: c.id, revision: c.revision, voice: c.voice, speech, provider });
    const file = path.join(this.dataDir, 'audio', audioKey + '.wav');
    if (fs.existsSync(file)) return audioKey;
    if (provider.provider === 'gpt-sovits') {
      const customWeights = this.config.characters.some(item => item.speech?.gptWeights || item.speech?.sovitsWeights);
      if (customWeights && (!speech.gptWeights || !speech.sovitsWeights)) throw new Error(`${c.name} 需要完整配置 GPT 和 SoVITS 权重，避免继承另一位角色的声音。`);
      if (!speech.refAudioPath) throw new Error(`${c.name} 尚未配置 GPT-SoVITS 参考音频。`);
      // api_v2 keeps one pair of active weights globally. Switch and synthesize
      // sequentially; never run two character synthesis requests concurrently.
      if (speech.gptWeights) await this.request(provider, '/set_gpt_weights?weights_path=' + encodeURIComponent(speech.gptWeights), null, 'GET');
      if (speech.sovitsWeights) await this.request(provider, '/set_sovits_weights?weights_path=' + encodeURIComponent(speech.sovitsWeights), null, 'GET');
    } else if (!provider.model || !c.voice) throw new Error('请配置语音模型和角色音色。');
    const body = provider.provider === 'gpt-sovits' ? {
      text: turn.text, text_lang: speech.textLang || 'zh', ref_audio_path: speech.refAudioPath,
      prompt_text: speech.promptText || '', prompt_lang: speech.promptLang || 'zh',
      text_split_method: 'cut5', batch_size: 1, media_type: 'wav', streaming_mode: false, speed_factor: speech.speed || 1
    } : { model: provider.model, voice: c.voice, input: turn.text, response_format: 'wav' };
    const response = await this.request(provider, provider.provider === 'gpt-sovits' ? '/tts' : '/audio/speech', body);
    const audio = Buffer.from(await response.arrayBuffer());
    if (audio.length < 44 || audio.toString('ascii', 0, 4) !== 'RIFF' || audio.toString('ascii', 8, 12) !== 'WAVE') throw new Error('语音服务未返回有效 WAV。');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, audio);
    fs.renameSync(tmp, file);
    return audioKey;
  }
  migrateArchives() {
    for (const [title,turns] of Object.entries(this.presets)) {
      const id='preset:'+title;
      if(!this.archives.exists(id))this.archives.save(compileArchive({id,title,turns},this.config.characters,{migration:true}));
    }
    const directory=path.join(this.dataDir,'scenes');
    if(fs.existsSync(directory))for(const file of fs.readdirSync(directory).filter(f=>/^[a-f0-9]{64}\.json$/.test(f))){
      const id=file.slice(0,-5);
      if(this.archives.exists(id))continue;
      const scene=readJson(path.join(directory,file));
      if(scene.id!==id)throw new Error('旧缓存文件编号与内容不一致');
      if(!this.archives.exists(scene.id))this.archives.save(compileArchive(scene,this.config.characters,{migration:true}));
    }
    // Version 1 defines unrequested head/body sway as disabled; persist that
    // policy in archives created during the initial migration as well.
    for(const a of this.archives.list())if(a.playback?.continuityVersion!==1||a.cast.some(c=>c.presentation.naturalSwayWeight===undefined)){
      a.playback=policy(a.playback);
      for(const c of a.cast)c.presentation.naturalSwayWeight??=0;
      this.archives.save(a);
    }
  }
  listScenes() {
    return this.archives.list().map(a=>({id:a.sceneId,title:a.title,turnCount:a.turns.length,revision:a.revision,published:a.published,userConfirmed:Boolean(a.confirmedByUser),preset:a.sceneId.startsWith('preset:'),reviewed:a.review?.status==='approved'||Boolean(a.confirmedByUser),compatible:true,audioCount:a.turns.filter(t=>this.hasAudio(t.audioKey)).length}));
  }
  hasAudio(key) { return /^[a-f0-9]{64}$/.test(key || '') && fs.existsSync(path.join(this.dataDir, 'audio', key + '.wav')); }
  loadScene(id,{preview=false}={}) {
    const archive=this.archives.read(id);
    if(!preview&&!archive.published)throw new Error('该场景是草稿，请预览并确认后加入轮播。');
    checkResources(archive);
    return {id:archive.sceneId,title:archive.title,revision:archive.revision,cast:archive.cast,archive,turns:archive.turns.map(t=>({...t,audio:this.hasAudio(t.audioKey)?fs.readFileSync(path.join(this.dataDir,'audio',t.audioKey+'.wav')).toString('base64'):null})),warnings:[]};
  }
  async reviseScene(id,options){
    if(this.config.offline)throw new Error('修改动作需切换到联网制作。');
    const archive=this.archives.read(id);
    const revised=await reviseSegment({archive,...options,request:this.request.bind(this),provider:this.config.llm});
    revised.sceneId=hash({parent:id,revision:revised.revision,turns:revised.turns});
    revised.title=archive.title+' · 修订'+revised.revision;
    revised.parentId=id;
    this.archives.save(revised);
    const edit=revised.editHistory.at(-1);return {id:revised.sceneId,revision:revised.revision,prompt:edit.prompt,inspection:{...edit.selection,characterId:edit.toolResult.characterId,text:edit.toolResult.text,events:edit.toolResult.events.map(({atMs,action})=>({atMs,action}))},explanation:edit.patch.explanation||''};
  }
  publishScene(id,revision){const a=this.archives.read(id);if(a.revision!==revision)throw new Error('场景已变化，请重新预览');a.published=true;a.confirmedByUser=new Date().toISOString();this.archives.save(a);return{id,revision:a.revision};}
  saveLayout(id,revision,positions){const a=this.archives.read(id);if(a.revision!==revision)throw new Error('场景版本已变化');for(const c of a.cast){const p=positions[c.id];if(p)c.layout={...c.layout,x:p.x,y:p.y};}a.revision++;a.published=false;delete a.confirmedByUser;this.archives.save(a);return{id,revision:a.revision};}
  async generate(prompt, options = {}) {
    if (this.config.offline) throw new Error('请切换到联网制作后生成场景。离线模式只播放本地对话库。');
    if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > 4000) throw new Error('请输入 1 至 4000 字场景描述。');
    prompt = prompt.trim();
    const mode = options.mode || 'characters';
    if (!['characters', 'import'].includes(mode)) throw new Error('未知创作方式。');
    const imported = mode === 'import' ? parseDialogue(options.dialogue, this.config.characters) : null;
    const id = hash({ version: 5, reviewVersion: REVIEW_VERSION, mode, imported, prompt, characters: this.config.characters, llm: this.config.llm });
    const file = this.sceneFile(id);
    let scene = readJson(file);
    const warnings = [];
    if (!scene) {
      if (!this.config.llm.model || !(this.sessionKey || process.env[this.config.llm.apiKeyEnv])) throw new Error('请配置 DeepSeek API Key。');
      const cast = this.config.characters.map(c => ({ id: c.id, name: c.name, userPrompt: c.userPrompt, actions: { idle: {}, ...c.actions } }));
      const instruction = imported
        ? '你是 Live2D 表演导演。原始台词已定稿，只为每一句标注情绪和动作，不编写、不删减、不调换台词或说话人。返回 JSON：{"title":"场景名","annotations":[{"lineIndex":0,"emotion":"happy","action":"thinking","timeline":[{"atMs":0,"action":"thinking"},{"atMs":1200,"action":"happy"}]}]}。每个 lineIndex 必须出现且只出现一次，从 0 编号。'
        : '你是双角色桌宠编剧。按每个角色对象各自的 userPrompt（人物性格、关系、说话方式和创作要求）分别塑造角色，结合场景要求生成两人互相交谈的完整场景，6至12句，不能等待用户回答。返回 JSON：{"title":"场景名","turns":[{"characterId":"角色ID","text":"台词","emotion":"happy","action":"thinking","timeline":[{"atMs":0,"action":"thinking"},{"atMs":1200,"action":"happy"}]}]}。两人都要出场。';
      const response = await this.request(this.config.llm, '/chat/completions', {
        model: this.config.llm.model, stream: false, response_format: { type: 'json_object' }, max_tokens: 4096,
        messages: [
          { role: 'system', content: `${instruction} emotion 只可选 ${EMOTIONS.join(',')}。action 只可选说话角色自己的动作键，不可发明模型资源 ID；没有合适动作就用 idle。每句必须包含 timeline，按台词情绪组织 1至4 个表演事件；第一个 atMs 必须为0，其后严格递增，最大6000ms，每句最多8项。优先选有中文description的语义action；不能整场只有idle，除非人物确实没有资源。表情与身体动作是独立维度，可先安排已有pose身体动作，再在后续时间点切换表情，不能把仅expression的action当作身体motion。action字段与timeline第一项一致。角色对象：${JSON.stringify(cast)}` },
          { role: 'user', content: JSON.stringify({ scenePrompt: prompt, ...(imported ? { dialogue: imported.map((turn, lineIndex) => ({ lineIndex, ...turn })) } : {}) }) }
        ]
      });
      const data = await response.json();
      const choice = data.choices?.[0];
      if (choice?.finish_reason === 'length') throw new Error('场景被截断，请缩短要求后重试。');
      const raw = choice?.message?.content;
      if (typeof raw !== 'string' || !raw.trim()) throw new Error('DeepSeek 返回空内容，请重试。');
      const parsed = JSON.parse(raw.replace(/^\s*```(?:json)?\s*/, '').replace(/\s*```\s*$/, ''));
      const directedTurns = imported ? annotateDialogue(imported, parsed.annotations, this.config.characters) : parsed.turns;
      scene = { id, mode, title: typeof parsed.title === 'string' ? parsed.title.slice(0, 100) : prompt.slice(0, 40), prompt, createdAt: new Date().toISOString(), castFingerprint: hash(this.config.characters), playbackFingerprint: playbackFingerprint(this.config.characters), turns: validateTurns(directedTurns, this.config.characters) };
    }
    if (scene.review?.version !== REVIEW_VERSION || scene.review?.status !== 'approved') {
      const reviewed = await reviewPerformance({turns:scene.turns,characters:this.config.characters,prompt,request:this.request.bind(this),provider:this.config.llm,validate:validateTurns});
      scene.turns = reviewed.turns;
      scene.review = {...reviewed.review,reviewedAt:new Date().toISOString()};
      writeJson(file, scene);
    }
    if (this.config.tts.enabled) {
      for (const turn of scene.turns) {
        try { turn.audioKey = await this.synthesize(turn); }
        catch (error) { warnings.push(error.message); }
        // Save each completed turn so interrupted preparation can resume.
        writeJson(file, scene);
      }
    }
    if(!this.archives.exists(id))this.archives.save(compileArchive(scene,this.config.characters,{published:false}));
    return { id, title: scene.title, warnings: [...new Set(warnings)], scenes: this.listScenes(), review: scene.review };
  }
}
module.exports = { PersonalRuntime, endpoint, validateTurns, writeJson };
