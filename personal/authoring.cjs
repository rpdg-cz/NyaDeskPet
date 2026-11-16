const fs = require('node:fs');
const path = require('node:path');

function validateCharacters(characters, originals) {
  if (!Array.isArray(characters) || characters.length !== 2) throw new Error('请保留两个角色对象。');
  const names = new Set();
  return originals.map(original => {
    const value = characters.find(c => c?.id === original.id);
    if (!value || typeof value.name !== 'string' || !value.name.trim() || value.name.length > 40) throw new Error('角色 ID 不可修改，名字需为 1 至 40 字。');
    const name = value.name.trim();
    if (names.has(name)) throw new Error('两个角色的名字不能相同。');
    names.add(name);
    if (typeof value.userPrompt !== 'string' || value.userPrompt.length > 8000) throw new Error('角色 User Prompt 最多 8000 字。');
    const actions = value.actions ?? original.actions;
    if (!actions || typeof actions !== 'object' || Array.isArray(actions) || Object.keys(actions).length > 200) throw new Error('动作映射需要是 JSON 对象，最多 200 项。');
    for (const [key, action] of Object.entries(actions)) {
      if (!key || key.length > 100 || !action || typeof action !== 'object' || Array.isArray(action)) throw new Error('动作映射格式无效。');
      if (action.expression !== undefined && typeof action.expression !== 'string') throw new Error('表情 ID 应为字符串。');
      if (action.motion && (typeof action.motion.group !== 'string' || !Number.isInteger(action.motion.index) || action.motion.index < 0)) throw new Error('动作需有组名和非负整数 index。');
      if (action.parameters && (!Array.isArray(action.parameters) || action.parameters.some(p => typeof p?.id !== 'string' || !Number.isFinite(p.value)))) throw new Error('模型参数需有 id 和数值 value。');
    }
    return { ...original, name, userPrompt: value.userPrompt, actions };
  });
}

function parseDialogue(raw, characters) {
  if (typeof raw !== 'string' || raw.length > 40000 || !raw.trim()) throw new Error('请导入不超过 40000 字符的 TXT 或 JSON 对话。');
  const text = raw.replace(/^\uFEFF/, '').trim();
  let lines;
  if (text.startsWith('[') || text.startsWith('{')) {
    let data;
    try { data = JSON.parse(text); } catch { throw new Error('对话 JSON 无法解析。'); }
    lines = Array.isArray(data) ? data : data.turns;
  } else {
    lines = text.split(/\r?\n/).filter(line => line.trim()).map(line => {
      const match = /^\s*([^:：]+)[:：]\s*(.+)$/.exec(line);
      if (!match) throw new Error('TXT 每行请使用「角色名：台词」，也可以用角色 ID。');
      return { speaker: match[1].trim(), text: match[2] };
    });
  }
  if (!Array.isArray(lines) || lines.length < 2 || lines.length > 24) throw new Error('请导入 2 至 24 句对话。');
  const turns = lines.map(line => {
    const speaker = line?.characterId ?? line?.speaker;
    const c = characters.find(c => c.id === speaker || c.name === speaker);
    if (!c) throw new Error(`无法识别说话角色：${String(speaker)}。请使用角色名称或 ID。`);
    if (typeof line.text !== 'string' || !line.text.trim() || line.text.length > 1000) throw new Error('每句台词需为 1 至 1000 字。');
    return { characterId: c.id, text: line.text };
  });
  if (new Set(turns.map(t => t.characterId)).size !== 2) throw new Error('导入的对话需包含两位角色。');
  return turns;
}

function validateTimeline(timeline, character) {
  if (timeline === undefined) return undefined;
  if (!Array.isArray(timeline) || timeline.length < 1 || timeline.length > 8) throw new Error('每句动作序列需包含 1 至 8 个事件。');
  let last = -1;
  return timeline.map((event, index) => {
    if (!Number.isInteger(event?.atMs) || event.atMs < 0 || event.atMs > 6000 || event.atMs <= last || (index === 0 && event.atMs !== 0)) throw new Error('动作时间需从 0ms 开始、严格递增，且不超过 6000ms。');
    if (typeof event.action !== 'string' || (event.action !== 'idle' && !Object.hasOwn(character.actions, event.action))) throw new Error(`角色 ${character.id} 没有动作：${String(event.action)}`);
    last = event.atMs;
    return { atMs: event.atMs, action: event.action };
  });
}

function annotateDialogue(source, annotations, characters) {
  if (!Array.isArray(annotations) || annotations.length !== source.length) throw new Error('API 动作标注缺少台词或增加了台词，请重试。');
  const byIndex = new Map();
  for (const item of annotations) {
    if (!Number.isInteger(item?.lineIndex) || item.lineIndex < 0 || item.lineIndex >= source.length || byIndex.has(item.lineIndex)) throw new Error('API 动作标注的台词编号无效或重复。');
    byIndex.set(item.lineIndex, item);
  }
  return source.map((turn, index) => {
    const annotation = byIndex.get(index);
    const c = characters.find(c => c.id === turn.characterId);
    // The API only supplies annotations. Text and speaker always come from the import.
    const timeline = validateTimeline(annotation.timeline, c);
    return { ...turn, emotion: annotation.emotion, action: Object.hasOwn(c.actions, annotation.action) ? annotation.action : (timeline?.[0].action || 'idle'), ...(timeline ? { timeline } : {}) };
  });
}

function discoverActions(character) {
  const actions = { ...character.actions };
  if (!character.modelPath) return actions;
  const file = path.resolve(__dirname, '..', character.modelPath);
  if (!fs.existsSync(file)) return actions;
  const model = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  for (const expression of model.FileReferences?.Expressions || []) {
    actions['expression:' + expression.Name] ??= { expression: expression.Name };
  }
  for (const [group, motions] of Object.entries(model.FileReferences?.Motions || {})) {
    motions.forEach((_motion, index) => { actions[`motion:${group}:${index}`] ??= { motion: { group, index } }; });
  }
  return actions;
}
module.exports = { validateCharacters, parseDialogue, annotateDialogue, discoverActions, validateTimeline };
