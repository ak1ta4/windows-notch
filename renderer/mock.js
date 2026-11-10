// Solo para previsualizar la UI en un navegador normal (dev.html). No se usa en la app.
document.documentElement.style.background = 'linear-gradient(160deg,#5b6b5e,#2c3540)';
(() => {
  const L = {}; const on = (ch) => (fn) => { (L[ch] = L[ch] || []).push(fn); };
  const emit = (ch, d) => (L[ch] || []).forEach((f) => f(d));
  window.__emit = emit;
  window.notch = {
    config: async () => ({ label: '秋田', clock24h: true, chime: false, folders: [{ title: 'Inicio' }, { title: 'Descargas' }, { title: 'Documentos' }, { title: 'Imágenes' }, { title: 'Wallpapers' }] }),
    shape() {}, hold() {}, focusable() {}, onHover: on('hover'), onCollapse: on('collapse'), panelOpen() {}, native(c) { console.log('native', c); }, onNative: on('native'), onClaude: on('claude'), onClaudeAlert: on('alert'), onClaudePending: on('pending'), onExpand: on('expand'),
    claudePending: async () => [], claudeDecide(id, d) { console.log('decide', id, d); }, todos: async () => ({ ok: true, todos: [{ id: '1', text: 'Tarea de ejemplo', done: false, due: '' }] }), todoAdd: async () => ({ ok: true, todos: [] }), todoToggle: async () => ({ ok: true, todos: [] }), todoDelete: async () => ({ ok: true, todos: [] }), stats: async () => null, openHome() {},
    claudeSessions: async () => [], claudeDismiss() {}, openFolder() {}, openUri() {}, launch() {}, power() {},
    powerPlans: async () => [{ guid: 'a', name: 'Equilibrado', active: true }, { guid: 'b', name: 'Alto rendimiento' }],
    setPowerPlan: async () => [], themeGet: async () => false, themeToggle: async () => true, fileIcon: async () => null, contextMenu() {},
  };
  setTimeout(() => {
    emit('native', { type: 'thumb', key: 'k', data: null });
    emit('native', { type: 'state', vol: 0.42, mute: false, mic: 0.8, micMute: false, lang: 'ES', langName: 'español', win: { title: 'notch — Visual Studio Code' },
      media: { key: 'k', title: 'Kiss of Life', artist: 'Sade', app: 'Spotify.exe', playing: true, canNext: true, canPrev: true, canSeek: true, pos: 61, dur: 330, upd: Date.now() } });
  }, 200);
})();
