const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { PersonalRuntime, endpoint } = require('./runtime.cjs');
const configTemplate = require('./config.json');
const presets = require('./presets.json');
function sandbox(t, changes = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'duopet-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const config = structuredClone(configTemplate);
  Object.assign(config, changes);
  return new PersonalRuntime(config, dir, presets);
}
function wav() {
  const audio = Buffer.alloc(48);
  audio.write('RIFF'); audio.writeUInt32LE(40, 4); audio.write('WAVE', 8);
  audio.write('fmt ', 12); audio.writeUInt32LE(16, 16); audio.writeUInt16LE(1, 20); audio.writeUInt16LE(1, 22);
  audio.writeUInt32LE(16000, 24); audio.writeUInt32LE(32000, 28); audio.writeUInt16LE(2, 32); audio.writeUInt16LE(16, 34);
  audio.write('data', 36); audio.writeUInt32LE(4, 40);
  return audio;
}
async function service(t, callback) {
  const server = http.createServer(callback);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}`;
}
const turns = [
  { characterId: 'companion-a', text: '雨停了吗？', action: 'idle', emotion: 'calm' },
  { characterId: 'companion-b', text: '还没有，一起听音乐吧。', action: 'idle', emotion: 'happy' }
];
test('offline blocks all generation requests, including localhost', async t => {
  const runtime = sandbox(t);
  assert.throws(() => endpoint('http://127.0.0.1', '/tts', true), /离线/);
  await assert.rejects(runtime.generate('两人聊天'), /离线/);
  assert.equal(runtime.listScenes().length, 2);
  assert.equal(runtime.loadScene('preset:雨天闲聊').turns.length, 4);
});
test('generate with API, restart offline and replay WAV without contacting services', async t => {
  const calls = [];
  let allowRequests = true;
  const baseUrl = await service(t, async (req, res) => {
    calls.push(req.url);
    if (!allowRequests) { res.writeHead(503).end(); return; }
    let body = ''; for await (const chunk of req) body += chunk;
    if (req.url === '/chat/completions') {
      assert.equal(req.headers.authorization, 'Bearer test-secret');
      const parsed = JSON.parse(body);
      assert.equal(parsed.messages.length, 2);
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ title: '雨天', turns }) }, finish_reason: 'stop' }] }));
    } else if (req.url.startsWith('/set_')) res.end('success');
    else if (req.url === '/tts') {
      const parsed = JSON.parse(body);
      assert.equal(parsed.streaming_mode, false);
      res.setHeader('Content-Type', 'audio/wav'); res.end(wav());
    } else res.writeHead(404).end();
  });
  const runtime = sandbox(t, { offline: false });
  runtime.sessionKey = 'test-secret';
  runtime.config.llm.baseUrl = baseUrl;
  Object.assign(runtime.config.tts, { enabled: true, baseUrl });
  for (const c of runtime.config.characters) Object.assign(c.speech, { refAudioPath: c.id + '.wav', gptWeights: c.id + '.ckpt', sovitsWeights: c.id + '.pth' });
  const result = await runtime.generate('雨天闲聊');
  assert.deepEqual(result.warnings, []);
  assert.equal(calls.filter(c => c === '/tts').length, 2);
  const count = calls.length;
  await runtime.generate('雨天闲聊');
  assert.equal(calls.length, count, 'cached generation should use no services');
  allowRequests = false;
  runtime.config.offline = true;
  const restarted = new PersonalRuntime(runtime.config, runtime.dataDir, presets);
  const scene = restarted.loadScene(result.id);
  assert.equal(scene.turns.length, 2);
  assert.ok(scene.turns.every(t => t.audio && Buffer.from(t.audio, 'base64').toString('ascii', 0, 4) === 'RIFF'));
  assert.equal(calls.length, count);
  assert.ok(!fs.readFileSync(restarted.sceneFile(result.id), 'utf8').includes('test-secret'));
  restarted.config.characters[0].revision++;
  assert.throws(() => restarted.loadScene(result.id), /配置已变化/);
});
test('failed TTS preserves text and retries only missing speech on next preparation', async t => {
  let llmCalls = 0;
  let working = false;
  const baseUrl = await service(t, (req, res) => {
    if (req.url === '/chat/completions') {
      llmCalls++; res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ turns }) } }] }));
    } else if (!working) res.writeHead(503).end();
    else res.end(wav());
  });
  const runtime = sandbox(t, { offline: false });
  runtime.sessionKey = 'test'; runtime.config.llm.baseUrl = baseUrl;
  Object.assign(runtime.config.tts, { enabled: true, baseUrl });
  for (const c of runtime.config.characters) c.speech.refAudioPath = c.id + '.wav';
  const first = await runtime.generate('咖啡');
  assert.ok(first.warnings.length);
  assert.ok(runtime.loadScene(first.id).turns.every(t => !t.audio));
  working = true;
  const second = await runtime.generate('咖啡');
  assert.deepEqual(second.warnings, []);
  assert.equal(llmCalls, 1);
  assert.ok(runtime.loadScene(second.id).turns.every(t => t.audio));
});
test('invalid/unknown cast responses cannot enter the library', async t => {
  const baseUrl = await service(t, (_req, res) => res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ turns: [{ characterId: 'stranger', text: '坏数据' }] }) } }] })));
  const runtime = sandbox(t, { offline: false }); runtime.sessionKey = 'test'; runtime.config.llm.baseUrl = baseUrl;
  await assert.rejects(runtime.generate('测试'), /场景应包含/);
  assert.equal(runtime.listScenes().length, 2);
  assert.throws(() => runtime.loadScene('../../secret'), /编号无效/);
});
