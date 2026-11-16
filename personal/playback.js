/* Shared by the desktop renderer and Node tests. No network or generation calls. */
(function (root) {
  function normalizePlayback(value = {}) {
    const settings = { enabled: value.enabled ?? true, intervalSeconds: value.intervalSeconds ?? 60, clickEnabled: value.clickEnabled ?? true };
    if (typeof settings.enabled !== 'boolean' || typeof settings.clickEnabled !== 'boolean' || !Number.isInteger(settings.intervalSeconds) || settings.intervalSeconds < 5 || settings.intervalSeconds > 86400) throw new Error('播放间隔需为 5 至 86400 秒，播放开关需为布尔值。');
    return settings;
  }
  function availableScenes(scenes) {
    if (!Array.isArray(scenes)) throw new Error('本地场景列表格式无效。');
    const playable = scenes.filter(s => s && typeof s.id === 'string' && s.compatible !== false && s.published !== false);
    const cached = playable.filter(s => !s.preset);
    // Bundled scenes are real local content too. They keep clicks and rotation
    // functional before the first API-authored scene has been prepared.
    const reviewed = cached.filter(s => s.reviewed);
    return reviewed.length ? reviewed : cached.length ? cached : playable;
  }
  class PlaybackScheduler {
    constructor({ list, play, cancel, report = () => {}, observe = () => {}, settings = {}, clock = {} }) {
      this.list = list; this.play = play; this.cancel = cancel; this.report = report; this.observe = observe;
      this.clock = { setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: id => clearTimeout(id), now: () => Date.now(), ...clock };
      this.settings = normalizePlayback(settings);
      this.timer = null; this.running = false; this.pending = null; this.paused = false; this.disposed = false; this.version = 0; this.lastId = null; this.lastClick = -Infinity;
      this.phase = 'idle'; this.nextAt = null; this.currentKind = null; this.source = null; this.error = null;
      this.availableCount = 0; this.acceptedClicks = 0; this.startedScenes = 0; this.completedScenes = 0;
    }
    getState() {
      return { phase: this.phase, paused: this.paused, running: this.running, pending: this.pending?.kind || null, nextAt: this.nextAt,
        currentId: this.lastId, currentKind: this.currentKind, source: this.source, error: this.error,
        availableCount: this.availableCount, acceptedClicks: this.acceptedClicks, startedScenes: this.startedScenes, completedScenes: this.completedScenes,
        settings: { ...this.settings } };
    }
    emit() { try { this.observe(this.getState()); } catch { /* A diagnostics UI must not stop playback. */ } }
    clearTimer() { if (this.timer !== null) this.clock.clearTimeout(this.timer); this.timer = null; this.nextAt = null; }
    schedule(delay = this.settings.intervalSeconds * 1000) {
      this.clearTimer();
      if (this.disposed || this.paused || !this.settings.enabled || this.running || this.pending) { this.emit(); return; }
      this.nextAt = this.clock.now() + delay;
      if (this.phase !== 'empty' && this.phase !== 'error') this.phase = 'waiting';
      this.timer = this.clock.setTimeout(() => { this.timer = null; this.nextAt = null; this.enqueue({ kind: 'timer' }); }, delay);
      this.emit();
    }
    configure(settings) {
      this.settings = normalizePlayback(settings); this.paused = false;
      if (!this.settings.clickEnabled && this.pending?.kind === 'click') this.pending = null;
      this.schedule(0);
    }
    refresh(settings = this.settings, { interrupt = true } = {}) {
      this.settings = normalizePlayback(settings);
      if (interrupt) { this.version++; this.pending = null; this.cancel(); }
      if (!this.settings.clickEnabled && this.pending?.kind === 'click') this.pending = null;
      this.schedule(0);
    }
    libraryChanged() { if (!this.running) this.schedule(0); }
    requestManual(id) { if (typeof id !== 'string' || !id) return; this.paused = false; this.enqueue({ kind: 'manual', id }); }
    requestClick(characterId) {
      if (this.disposed || !this.settings.clickEnabled || this.clock.now() - this.lastClick < 800) return false;
      this.lastClick = this.clock.now(); this.acceptedClicks++;
      if (this.running) { this.version++; this.cancel(); }
      this.enqueue({ kind: 'click', characterId });
      if (this.running && this.pending?.kind === 'click') this.report('点击已接收，正在切换到下一段本地对话。');
      return true;
    }
    enqueue(job) {
      if (this.disposed) return;
      this.pending = job;
      this.clearTimer(); this.emit();
      void this.pump();
    }
    async pump() {
      if (this.running || this.disposed) return;
      this.running = true;
      try {
        while (this.pending && !this.disposed) {
          const job = this.pending; this.pending = null;
          const version = this.version;
          try {
            let id = job.id;
            this.phase = 'loading'; this.currentKind = job.kind; this.error = null; this.emit();
            if (!id) {
              const scenes = availableScenes(await this.list());
              if (this.disposed || version !== this.version) continue;
              this.availableCount = scenes.length;
              this.source = scenes.some(s => !s.preset) ? 'cache' : 'preset';
              if (!scenes.length) { this.phase = 'empty'; this.source = null; this.report('没有可播放的本地场景，请先制作或导入对话。'); this.emit(); continue; }
              id = scenes[(scenes.findIndex(s => s.id === this.lastId) + 1) % scenes.length].id;
            } else this.source = id.startsWith('preset:') ? 'preset' : 'cache';
            if (this.disposed || version !== this.version || (job.kind === 'timer' && (!this.settings.enabled || this.paused)) || (job.kind === 'click' && !this.settings.clickEnabled)) continue;
            this.lastId = id; this.phase = 'playing'; this.startedScenes++; this.emit();
            await this.play(id, job.kind);
            if (version === this.version) { this.completedScenes++; this.phase = 'idle'; }
          } catch (error) { this.error = error.message; this.phase = 'error'; this.report(error.message); this.emit(); }
        }
      } finally { this.running = false; this.currentKind = null; this.schedule(); }
    }
    stop() { this.paused = true; this.version++; this.pending = null; this.clearTimer(); this.phase = 'stopped'; this.cancel(); this.emit(); }
    dispose() { this.stop(); this.disposed = true; }
  }
  const api = { PlaybackScheduler, normalizePlayback, availableScenes };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.DuoPlayback = api;
})(globalThis);
