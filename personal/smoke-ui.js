(async () => {
  const result = { scenes: document.querySelectorAll('#scene-list option').length, canvasCount: document.querySelectorAll('canvas').length };
  document.getElementById('open-characters').click();
  result.rolePrompts = document.querySelectorAll('[data-field=userPrompt]').length;
  result.roleActionEditors = document.querySelectorAll('[data-field=actions]').length;
  result.editorOpen = document.getElementById('character-editor').open;
  document.getElementById('cancel-characters').click();
  const mode = document.getElementById('authoring-mode');
  mode.value = 'import'; mode.dispatchEvent(new Event('change'));
  result.importPanelOpen = !document.getElementById('import-panel').hidden;
  mode.value = 'characters'; mode.dispatchEvent(new Event('change'));
  result.playbackSettings = document.getElementById('playback-interval').value === '60' && document.getElementById('scheduled-playback').checked && document.getElementById('click-playback').checked;
  document.getElementById('play').click();
  return result;
})()
