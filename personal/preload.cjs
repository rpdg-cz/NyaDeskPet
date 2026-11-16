const { contextBridge, ipcRenderer } = require('electron');
function listen(channel, callback) {
  const handler = (_event, value) => callback(value);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}
contextBridge.exposeInMainWorld('duo', {
  editor: () => ipcRenderer.send('duo:editor'),
  play: (id, autoplay) => ipcRenderer.send('duo:play', { id, autoplay }),
  stop: () => ipcRenderer.send('duo:stop'),
  status: message => ipcRenderer.send('duo:status', message),
  savePlayback: value => ipcRenderer.invoke('duo:playback-settings', value),
  onPlaybackSettings: callback => listen('duo:playback-settings', callback),
  onLibrary: callback => listen('duo:library-changed', callback),
  playbackState: value => ipcRenderer.send('duo:playback-state', value),
  getPlaybackState: () => ipcRenderer.invoke('duo:playback-state'),
  onPlaybackState: callback => listen('duo:playback-state', callback),
  onNativeDrag: callback => listen('duo:native-drag', callback),
  onPlay: callback => listen('duo:play', callback),
  onStop: callback => listen('duo:stop', callback),
  onStatus: callback => listen('duo:status', callback),
  onCharacters: callback => listen('duo:characters-changed', callback),
  config: () => ipcRenderer.invoke('duo:config'),
  offline: value => ipcRenderer.invoke('duo:offline', value),
  key: value => ipcRenderer.invoke('duo:key', value),
  list: () => ipcRenderer.invoke('duo:list'),
  load: (id, options) => ipcRenderer.invoke('duo:load', id, options),
  archive: id => ipcRenderer.invoke('duo:archive', id),
  preview: (id,options={}) => ipcRenderer.send('duo:preview', {id,...options}),
  previewComplete: value => ipcRenderer.send('duo:preview-complete',value),
  onPreviewComplete: callback => listen('duo:preview-complete',callback),
  onPreview: callback => listen('duo:preview', callback),
  revise: (id, options) => ipcRenderer.invoke('duo:revise',id,options),
  publish: (id, revision) => ipcRenderer.invoke('duo:publish',id,revision),
  captureLayout: id => ipcRenderer.send('duo:capture-layout',id),
  onCaptureLayout: callback => listen('duo:capture-layout',callback),
  saveLayout: (id,revision,positions) => ipcRenderer.invoke('duo:save-layout',id,revision,positions),
  generate: (prompt, options) => ipcRenderer.invoke('duo:generate', prompt, options),
  characters: value => ipcRenderer.invoke('duo:characters', value),
  dragWindow: value => ipcRenderer.send('duo:window-drag', value),
  mouse: ignore => ipcRenderer.send('duo:mouse', ignore),
  folder: () => ipcRenderer.send('duo:folder'),
  close: () => ipcRenderer.send('duo:close'),
  minimize: () => ipcRenderer.send('duo:minimize')
});
