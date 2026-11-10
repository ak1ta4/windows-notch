const { app, BrowserWindow, ipcMain, screen, shell, Menu, session, desktopCapturer, globalShortcut } = require('electron');
const { spawn, execFile } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const crypto = require('crypto');

const WIN_H = 720;      // alto de la ventana (barra + panel desplegado); el ancho es el del monitor
const CC_PORT = 47321;

if (!app.requestSingleInstanceLock()) { app.quit(); process.exit(0); }

let win = null;
let helper = null;
let hiddenForFullscreen = false;

// ---------------- Config ----------------
const defaultConfig = {
  label: '秋田',
  clock24h: true,
  folders: [
    { title: 'Inicio', path: '~' },
    { title: 'Descargas', path: '~\\Downloads' },
    { title: 'Documentos', path: '~\\Documents' },
    { title: 'Imágenes', path: '~\\Pictures' },
    { title: 'Wallpapers', path: 'D:\\OneDrive\\Pictures\\Wallpapers\\Themes' },
  ],
  chime: true,
  mediaIgnore: ['Claude'],
  appBar: true,            // reserva la franja de arriba (GlazeWM y ventanas maximizadas no la tapan)
  appBarHeight: 42,        // franja reservada en px lógicos: barra (34) + lengüeta del notch (8); GlazeWM pone su margen debajo
  homeServer: 'http://127.0.0.1:47800', // agente del home-dashboard / Nothing wallpaper
  artworkLookup: true,     // busca la carátula en iTunes cuando la app no la da (Spotify sin SMTC)
  collapseDelay: 1200,     // ms antes de cerrar el panel al sacar el ratón
  tray: true,              // bandeja del sistema dentro del notch
  launcherHotkey: 'Alt+S', // atajo global del buscador (formato de Electron: 'Alt+S', 'Ctrl+Shift+Space'...)
  barTrayPins: [],         // iconos de la bandeja fijados en la barra (se eligen en la pestaña Bandeja)
  rim: true,               // borde y halo alrededor de la isla (para que se vea en OLED)
  rimStrength: 1,          // intensidad del borde: 0.5 suave, 1 normal, 2 marcado
  claudeCli: '',           // ruta a claude.exe para "Pregúntale a Claude" (vacío = ~/.local/bin/claude.exe)
};
function loadConfig() {
  const file = path.join(__dirname, 'config.json');
  let user = {};
  try { user = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
  const merged = { ...defaultConfig, ...user };
  // Añade al archivo las opciones nuevas sin tocar las que ya tienes.
  if (Object.keys(defaultConfig).some((k) => !(k in user))) {
    try { fs.writeFileSync(file, JSON.stringify(merged, null, 2)); } catch {}
  }
  return merged;
}
const config = loadConfig();
const expand = (p) => p.replace(/^~/, os.homedir());

// ---------------- Registro de diagnóstico (%TEMP%\akita-notch.log) ----------------
const LOG = path.join(os.tmpdir(), 'akita-notch.log');
try { if (fs.statSync(LOG).size > 1e6) fs.writeFileSync(LOG, ''); } catch {}
function log(...a) {
  try { fs.appendFileSync(LOG, `${new Date().toISOString().slice(11, 23)} ${a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ')}\n`); } catch {}
}
log('---- arranque', process.pid);

// ---------------- Ventana ----------------
function targetBounds() {
  const { bounds } = screen.getPrimaryDisplay();
  return { x: bounds.x, y: bounds.y, width: bounds.width, height: WIN_H };
}
// Windows ignora la posición si se aplica antes de mostrar la ventana o si no es movible.
function place() {
  if (!win || win.isDestroyed()) return;
  const t = targetBounds();
  // Con un juego a pantalla completa, cualquier recolocación (cambios de resolución del juego, etc.)
  // debe mantenerla apartada fuera de la pantalla.
  if (hiddenForFullscreen) t.y = t.y - t.height - 200;
  win.setMovable(true);
  win.setBounds(t);
  win.setMovable(false);
}

function createWindow() {
  win = new BrowserWindow({
    ...targetBounds(),
    type: 'toolbar',                 // WS_EX_TOOLWINDOW: GlazeWM no la gestiona ni la oculta al cambiar de escritorio
    frame: false, transparent: true, resizable: false, movable: true,
    hasShadow: false, skipTaskbar: true, alwaysOnTop: true,
    minimizable: false, maximizable: false, fullscreenable: false,
    focusable: false,                // no roba el foco a tu app; se activa solo al escribir
    show: false, backgroundColor: '#00000000',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
  });
  win.setAlwaysOnTop(true, 'screen-saver');
  // Forma inicial: solo la barra. El resto de la ventana no existe para Windows (ni se dibuja ni recibe clics).
  applyShape([{ x: 0, y: 0, width: targetBounds().width, height: 46 }]);
  fixMouseActivate();
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.once('ready-to-show', () => {
    win.showInactive();
    setTimeout(place, 150);
    setTimeout(place, 1000);
    setInterval(() => {
      if (!win || win.isDestroyed() || !win.isVisible() || hiddenForFullscreen) return;
      const b = win.getBounds(); const t = targetBounds();
      if (b.x !== t.x || b.y !== t.y || b.width !== t.width || b.height !== t.height) place();
    }, 2000);
    startMouseTracking();
  });
  for (const ev of ['display-metrics-changed', 'display-added', 'display-removed']) {
    screen.on(ev, () => { setTimeout(place, 300); setTimeout(reserveSpace, 600); });
  }
}

// ---------------- Ratón ----------------
// La ventana tiene "forma" (setShape): solo la barra y la isla existen para Windows. Fuera de esa forma
// los clics van directamente a las apps de debajo, sin alternar nada desde aquí (antes se alternaba
// setIgnoreMouseEvents cada 30 ms y un clic rápido podía colarse a la app de debajo).
let shapeRects = [];
let hold = false;     // arrastrando un slider o escribiendo
function applyShape(rects) {
  if (!win || win.isDestroyed()) return;
  shapeRects = rects;
  try { win.setShape(rects); } catch (e) { log('setShape falló', e.message); }
}
function startMouseTracking() {
  // Vigilante: otras ventanas "siempre encima" pueden quedar por delante; se reafirma cada poco.
  setInterval(() => {
    if (!win || win.isDestroyed() || !win.isVisible()) return;
    win.setAlwaysOnTop(true, 'screen-saver');
    win.moveTop();
  }, 1500);
}
// Clic en cualquier sitio de la pantalla con el panel abierto: si fue fuera de la isla, se cierra.
let panelOpen = false;
function cursorInIsland() {
  if (!win || win.isDestroyed()) return false;
  const p = screen.getCursorScreenPoint(); const b = win.getBounds();
  const x = p.x - b.x, y = p.y - b.y;
  return shapeRects.some((r) => x >= r.x && x <= r.x + r.width && y >= r.y && y <= r.y + r.height);
}
function onGlobalClick() {
  if (!panelOpen || hold) return;
  if (!cursorInIsland()) { log('clic fuera: cerrar'); send('collapse'); }
}

// ---------------- Clics sin activar la ventana ----------------
// Al hacer clic en una ventana inactiva, Windows le manda WM_MOUSEACTIVATE. Chromium, si la ventana no
// acepta foco, responde MA_NOACTIVATEANDEAT: no se activa y TIRA la pulsación (solo llega el soltar), así
// que los botones no responden (pasaba con Hayase, el Administrador de tareas, al volver de pantalla
// completa...). Se intercepta ese mensaje y se responde MA_NOACTIVATE: no roba el foco y el clic llega entero.
let wndProcKeep = null;
function fixMouseActivate() {
  if (process.platform !== 'win32' || !win) return;
  try {
    const koffi = require('koffi');
    const user32 = koffi.load('user32.dll');
    const WndProc = koffi.proto('__stdcall', 'NotchWndProc', 'intptr', ['intptr', 'uint32', 'uintptr', 'intptr']);
    const SetWindowLongPtrW = user32.func('__stdcall', 'SetWindowLongPtrW', 'intptr', ['intptr', 'int', 'intptr']);
    const CallWindowProcW = user32.func('__stdcall', 'CallWindowProcW', 'intptr', ['intptr', 'intptr', 'uint32', 'uintptr', 'intptr']);
    const hwnd = win.getNativeWindowHandle().readBigUInt64LE(0);
    let prev = 0;
    wndProcKeep = koffi.register((h, msg, wp, lp) => {
      if (msg === 0x0021 /* WM_MOUSEACTIVATE */ && win && !win.isDestroyed() && !win.isFocusable()) return 3; // MA_NOACTIVATE
      return CallWindowProcW(prev, h, msg, wp, lp);
    }, koffi.pointer(WndProc));
    prev = SetWindowLongPtrW(hwnd, -4 /* GWLP_WNDPROC */, koffi.address(wndProcKeep));
    log('clics sin activar:', prev ? 'activo' : 'FALLÓ');
  } catch (e) { log('clics sin activar: no disponible', e.message); }
}

// ---------------- Primer plano sin que salte la barra de tareas ----------------
// Si una ventana pide el primer plano y Windows se lo niega, la marca como "requiere atención" y la barra
// de tareas oculta asoma. Se toma el primer plano de forma que Windows lo acepte (enganchándose al hilo de la
// ventana activa) y, al soltarlo, se devuelve a la ventana que lo tenía en vez de dejar que Windows elija.
let fg = null, prevForeground = 0n;
function fgApi() {
  if (fg !== null) return fg;
  try {
    const koffi = require('koffi');
    const u = koffi.load('user32.dll'), k = koffi.load('kernel32.dll');
    fg = {
      GetForegroundWindow: u.func('__stdcall', 'GetForegroundWindow', 'intptr', []),
      SetForegroundWindow: u.func('__stdcall', 'SetForegroundWindow', 'bool', ['intptr']),
      BringWindowToTop: u.func('__stdcall', 'BringWindowToTop', 'bool', ['intptr']),
      IsWindow: u.func('__stdcall', 'IsWindow', 'bool', ['intptr']),
      GetWindowThreadProcessId: u.func('__stdcall', 'GetWindowThreadProcessId', 'uint32', ['intptr', 'void *']),
      AttachThreadInput: u.func('__stdcall', 'AttachThreadInput', 'bool', ['uint32', 'uint32', 'bool']),
      GetCurrentThreadId: k.func('__stdcall', 'GetCurrentThreadId', 'uint32', []),
    };
  } catch (e) { log('primer plano: koffi no disponible', e.message); fg = false; }
  return fg;
}
function takeForeground() {
  const api = fgApi(); if (!api) { win.focus(); return; }
  const me = BigInt(win.getNativeWindowHandle().readBigUInt64LE(0));
  const cur = BigInt(api.GetForegroundWindow());
  if (cur === me) return;
  prevForeground = cur;
  const fgThread = cur ? api.GetWindowThreadProcessId(cur, null) : 0;
  const myThread = api.GetCurrentThreadId();
  const att = fgThread && fgThread !== myThread && api.AttachThreadInput(myThread, fgThread, true);
  api.BringWindowToTop(me);
  const ok = api.SetForegroundWindow(me);
  if (att) api.AttachThreadInput(myThread, fgThread, false);
  if (!ok) log('primer plano: Windows lo negó');
  win.focus(); // ya en primer plano: solo da el foco de teclado a la página
}
function giveBackForeground() {
  const api = fgApi();
  const prev = prevForeground; prevForeground = 0n;
  if (!api) { win.blur(); return; }
  // Si ya pasaste a otra ventana (clic fuera), no se le quita el foco
  if (BigInt(api.GetForegroundWindow()) !== BigInt(win.getNativeWindowHandle().readBigUInt64LE(0))) return;
  if (prev && api.IsWindow(prev) && api.SetForegroundWindow(prev)) return;
  win.blur();
}
function setFocusable(on) {
  if (!win || win.isDestroyed()) return;
  win.setFocusable(on);
  if (on) takeForeground(); else giveBackForeground();
}

// ---------------- Reserva de espacio (AppBar) ----------------
function reserveSpace() {
  if (!helper) return;
  if (!config.appBar) { helperCmd({ cmd: 'appbar', on: false }); return; }
  const d = screen.getPrimaryDisplay();
  const s = d.scaleFactor;
  helperCmd({
    cmd: 'appbar', on: true,
    l: Math.round(d.bounds.x * s), t: Math.round(d.bounds.y * s),
    r: Math.round((d.bounds.x + d.bounds.width) * s), b: Math.round((d.bounds.y + d.bounds.height) * s),
    h: Math.round(config.appBarHeight * s),
  });
}

// ---------------- Helper nativo ----------------
let lastMedia = null;
let lastTrayCount = -1;
function startHelper() {
  const exe = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  helper = spawn(exe, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, 'native', 'helper.ps1')], {
    windowsHide: true,
    env: { ...process.env, NOTCH_MEDIA_IGNORE: (config.mediaIgnore || []).join('|'), NOTCH_PID: String(process.pid) },
  });
  let buf = '';
  helper.stdout.setEncoding('utf8');
  helper.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (!line) continue;
      let msg; try { msg = JSON.parse(line); } catch { continue; }
      if (msg.type === 'state') { onState(msg); lastMedia = msg.media; }
      if (msg.type === 'thumb' && !msg.data && msg.artist) lookupArtwork(msg);
      if (msg.type === 'diag') log('helper', msg.msg);
      if (msg.type === 'click') onGlobalClick();
      if (msg.type === 'tray' && msg.list.length !== lastTrayCount) { lastTrayCount = msg.list.length; log('bandeja', lastTrayCount, 'iconos'); }
      send('native', msg);
    }
  });
  helper.stderr.on('data', (d) => console.error('[helper]', d.toString()));
  helper.on('exit', (code) => { log('helper salió', code); helper = null; if (!app.isQuitting) setTimeout(() => { startHelper(); setTimeout(startNativeExtras, 4000); }, 2000); });
}
function helperCmd(obj) { if (helper) helper.stdin.write(JSON.stringify(obj) + '\n'); }
// Reserva de espacio y bandeja: cuando el helper ha cargado (tarda ~3 s por WinRT).
function startNativeExtras() {
  reserveSpace();
  if (config.tray) setTimeout(() => helperCmd({ cmd: 'tray', on: true }), 800); // después de registrar la AppBar
}

function onState(s) {
  if (!win) return;
  // Nunca win.hide(): tras ocultar y volver a mostrar, Electron deja de entregar los clics a la página
  // (reproducido). En pantalla completa la ventana se aparta fuera de la pantalla y luego se devuelve.
  if (s.fullscreen && !hiddenForFullscreen) {
    hiddenForFullscreen = true;
    const t = targetBounds();
    place();
    log('apartado por pantalla completa');
  } else if (!s.fullscreen && hiddenForFullscreen) {
    hiddenForFullscreen = false; place(); setTimeout(place, 150); log('de vuelta');
  }
}

function send(ch, data) { if (win && !win.isDestroyed()) win.webContents.send(ch, data); }

// ---------------- Carátulas (cuando la app no publica la suya) ----------------
const artCache = new Map();
async function lookupArtwork({ key, artist, title }) {
  if (!config.artworkLookup) return;
  if (artCache.has(key)) { const d = artCache.get(key); if (d) send('native', { type: 'thumb', key, data: d }); return; }
  artCache.set(key, null);
  try {
    const q = encodeURIComponent(`${artist} ${title}`.slice(0, 120));
    const r = await fetch(`https://itunes.apple.com/search?term=${q}&entity=song&limit=1`, { signal: AbortSignal.timeout(5000) });
    const j = await r.json();
    const url = j.results && j.results[0] && j.results[0].artworkUrl100;
    if (!url) return;
    const img = await fetch(url.replace('100x100bb', '300x300bb'), { signal: AbortSignal.timeout(5000) });
    const buf = Buffer.from(await img.arrayBuffer());
    const data = `data:${img.headers.get('content-type') || 'image/jpeg'};base64,${buf.toString('base64')}`;
    artCache.set(key, data);
    send('native', { type: 'thumb', key, data });
  } catch {}
}

// ---------------- Home server (tareas/recordatorios y stats) ----------------
async function home(pathname, opts = {}) {
  const r = await fetch(config.homeServer + pathname, {
    ...opts,
    headers: { 'X-Home': '1', 'Content-Type': 'application/json', ...(opts.headers || {}) },
    signal: AbortSignal.timeout(4000),
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}
async function getTodos() {
  try { const d = await home('/api/data'); return { ok: true, todos: d.todos || [] }; }
  catch { return { ok: false, todos: [] }; }
}
// Siempre lee la última versión y cambia solo lo necesario, para no pisar marcadores ni otras tareas.
async function editTodos(fn) {
  const d = await home('/api/data');
  d.todos = fn(d.todos || []);
  await home('/api/data', { method: 'PUT', body: JSON.stringify(d) });
  return { ok: true, todos: d.todos };
}
const validDue = (s) => (typeof s === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(s) ? s : '');
ipcMain.handle('todos', () => getTodos());
ipcMain.handle('todo-add', async (_e, { text, due }) => {
  text = String(text || '').trim().slice(0, 300);
  if (!text) return getTodos();
  try {
    return await editTodos((t) => [...t, { id: crypto.randomUUID(), text, done: false, created: Date.now(), due: validDue(due), notified: false }]);
  } catch { return { ok: false, todos: [] }; }
});
ipcMain.handle('todo-toggle', async (_e, id) => {
  try { return await editTodos((t) => t.map((x) => (x.id === id ? { ...x, done: !x.done } : x))); } catch { return getTodos(); }
});
ipcMain.handle('todo-delete', async (_e, id) => {
  try { return await editTodos((t) => t.filter((x) => x.id !== id)); } catch { return getTodos(); }
});
ipcMain.handle('stats', async () => { try { return await home('/api/stats'); } catch { return null; } });

// ---------------- Claude Code (hooks) ----------------
const sessions = new Map();
const pending = new Map(); // permisos esperando respuesta: id -> { info, resolve }
const VERBS = {
  Read: 'Leyendo', Edit: 'Editando', MultiEdit: 'Editando', Write: 'Escribiendo', NotebookEdit: 'Editando',
  Bash: 'Ejecutando', PowerShell: 'Ejecutando', Grep: 'Buscando', Glob: 'Buscando',
  WebFetch: 'Leyendo web', WebSearch: 'Buscando en web', Task: 'Subagente', Agent: 'Subagente', TodoWrite: 'Planificando',
};
function describe(ev) {
  const t = ev.tool_name || '';
  const i = ev.tool_input || {};
  const verb = VERBS[t] || (t.startsWith('mcp__') ? 'Herramienta' : t || 'Trabajando');
  let obj = '';
  if (i.file_path || i.notebook_path) obj = path.basename(i.file_path || i.notebook_path);
  else if (i.command) obj = String(i.command).split('\n')[0].slice(0, 48);
  else if (i.pattern) obj = String(i.pattern).slice(0, 40);
  else if (i.url) { try { obj = new URL(i.url).hostname; } catch {} }
  else if (i.query) obj = String(i.query).slice(0, 40);
  else if (i.description) obj = String(i.description).slice(0, 40);
  else if (t.startsWith('mcp__')) obj = t.split('__').pop();
  return { verb, obj };
}
const pendingList = () => [...pending.values()].map((p) => p.info);
function clearPendingFor(sessionId) {
  for (const [id, p] of pending) if (p.info.session === sessionId) { p.resolve(null); pending.delete(id); }
  send('claude-pending', pendingList());
}
function onClaudeEvent(ev) {
  log('claude', ev.hook_event_name, ev.notification_type || '', ev.tool_name || '', String(ev.session_id || '').slice(0, 8));
  const id = ev.session_id || 'default';
  const s = sessions.get(id) || { id, project: ev.cwd ? path.basename(ev.cwd) : 'Claude', status: 'idle', verb: '', obj: '', history: [] };
  if (ev.cwd) s.project = path.basename(ev.cwd);
  s.t = Date.now();
  switch (ev.hook_event_name) {
    case 'SessionStart': s.status = 'idle'; s.verb = 'Sesión iniciada'; s.obj = ''; break;
    case 'UserPromptSubmit': s.status = 'working'; s.verb = 'Pensando'; s.obj = ''; clearPendingFor(id); break;
    case 'PreToolUse': { const d = describe(ev); s.status = 'working'; s.verb = d.verb; s.obj = d.obj; s.history.unshift(`${d.verb} ${d.obj}`.trim()); s.history.length = Math.min(s.history.length, 6); break; }
    case 'PostToolUse': s.status = 'working'; clearPendingFor(id); break; // si se respondió en la terminal
    case 'Notification':
      if (ev.notification_type === 'idle_prompt') { s.status = s.status === 'done' ? 'done' : 'idle'; break; }
      s.status = 'waiting'; s.verb = 'Necesita tu atención'; s.obj = (ev.message || '').slice(0, 80); break;
    case 'Stop': s.status = 'done'; s.verb = 'Listo'; s.obj = ''; clearPendingFor(id); break;
    case 'SessionEnd': sessions.delete(id); clearPendingFor(id); send('claude', [...sessions.values()]); return;
  }
  sessions.set(id, s);
  send('claude', [...sessions.values()]);
  if (ev.hook_event_name === 'Stop' || (ev.hook_event_name === 'Notification' && s.status === 'waiting')) send('claude-alert', { kind: ev.hook_event_name, session: s });
}
setInterval(() => {
  const now = Date.now(); let changed = false;
  for (const [id, s] of sessions) if (now - s.t > 45 * 60e3) { sessions.delete(id); changed = true; }
  if (changed) send('claude', [...sessions.values()]);
}, 60e3);

// El hook PermissionRequest espera aquí la respuesta (Permitir / Denegar desde el notch).
function onPermission(ev, res, req) {
  log('claude PermissionRequest', ev.tool_name, String(ev.session_id || '').slice(0, 8));
  const id = crypto.randomUUID();
  const d = describe(ev);
  const i = ev.tool_input || {};
  const info = {
    id, session: ev.session_id || 'default',
    project: ev.cwd ? path.basename(ev.cwd) : 'Claude',
    tool: ev.tool_name || '', verb: d.verb, obj: d.obj,
    detail: String(i.command || i.file_path || i.url || i.description || '').slice(0, 300),
    t: Date.now(),
  };
  let done = false;
  const finish = (decision) => {
    if (done) return; done = true;
    pending.delete(id); clearTimeout(timer);
    send('claude-pending', pendingList());
    if (!res.writableEnded) res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ decision }));
  };
  const timer = setTimeout(() => finish(null), 110e3); // después, sigue el diálogo normal de Claude
  pending.set(id, { info, resolve: finish });
  // Si Claude corta el hook (respondiste en la terminal) se cierra la conexión antes de contestar.
  // Ojo: req 'close' salta al terminar de leer el cuerpo; el que indica el corte es el de la respuesta.
  res.on('close', () => { if (!res.writableEnded) finish(null); });
  const s = sessions.get(info.session); if (s) { s.status = 'waiting'; s.verb = 'Pide permiso'; s.obj = `${d.verb} ${d.obj}`.trim(); send('claude', [...sessions.values()]); }
  send('claude-pending', pendingList());
  send('claude-alert', { kind: 'Permission', session: s || { id: info.session, project: info.project } });
}
ipcMain.on('claude-decide', (_e, { id, decision }) => {
  const p = pending.get(id);
  if (p && (decision === 'allow' || decision === 'deny')) p.resolve(decision);
});
ipcMain.handle('claude-pending', () => pendingList());

function startClaudeServer() {
  http.createServer((req, res) => {
    if (req.method !== 'POST' || (req.url !== '/cc' && req.url !== '/cc/permission')) { res.writeHead(404).end(); return; }
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 1e6) req.destroy(); });
    req.on('end', () => {
      let ev; try { ev = JSON.parse(body); } catch { res.writeHead(400).end(); return; }
      if (req.url === '/cc/permission') { onPermission(ev, res, req); return; }
      try { onClaudeEvent(ev); } catch {}
      res.writeHead(204).end();
    });
  }).on('error', (e) => console.error('[cc-server]', e.message)).listen(CC_PORT, '127.0.0.1');
}

// ---------------- Utilidades del sistema ----------------
function run(cmd, args) { return new Promise((r) => execFile(cmd, args, { windowsHide: true }, (e, out) => r(e ? '' : out))); }

async function powerPlans() {
  const out = await run('powercfg', ['/list']);
  const plans = [];
  for (const line of out.split(/\r?\n/)) {
    const m = line.match(/([0-9a-f]{8}-[0-9a-f-]{27})\s+\((.+?)\)\s*(\*)?/i);
    if (m) plans.push({ guid: m[1], name: m[2], active: !!m[3] });
  }
  return plans;
}
const THEME_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize';
async function isLight() {
  const out = await run('reg', ['query', THEME_KEY, '/v', 'AppsUseLightTheme']);
  return /0x1/.test(out);
}

const iconCache = new Map();

ipcMain.handle('config', () => config);
// Guarda los iconos fijados en la barra sin tocar el resto de config.json.
ipcMain.handle('set-pins', (_e, pins) => {
  if (!Array.isArray(pins)) return config.barTrayPins;
  config.barTrayPins = pins.filter((p) => typeof p === 'string' && p.length < 120).slice(0, 40);
  const file = path.join(__dirname, 'config.json');
  try {
    let user = {}; try { user = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
    user.barTrayPins = config.barTrayPins;
    fs.writeFileSync(file, JSON.stringify(user, null, 2));
  } catch (e) { log('no se pudo guardar config', e.message); }
  return config.barTrayPins;
});
ipcMain.on('shape', (_e, rects) => {
  if (!Array.isArray(rects) || !rects.length) return;
  const clean = rects.slice(0, 4).map((r) => ({ x: Math.max(0, Math.round(r.x)), y: Math.max(0, Math.round(r.y)), width: Math.max(1, Math.round(r.width)), height: Math.max(1, Math.round(r.height)) }));
  applyShape(clean);
});
ipcMain.on('hold', (_e, h) => { hold = !!h; });
ipcMain.on('panel-open', (_e, open) => { panelOpen = !!open; helperCmd({ cmd: 'clickwatch', on: panelOpen }); });
ipcMain.on('focusable', (_e, on) => setFocusable(!!on));
ipcMain.on('native', (_e, cmd) => helperCmd(cmd));
ipcMain.on('log', (_e, ...a) => log('ui', ...a));
ipcMain.on('tray-click', (_e, { key, button }) => {
  if (typeof key !== 'string' || !['left', 'right', 'double'].includes(button)) return;
  log('tray-click', key, button);
  // Windows solo deja traer una ventana al frente a quien está en primer plano o a sus procesos hijos.
  // El notch se activa un instante y el helper (hijo suyo) cede el primer plano a la app del icono;
  // si no, su menú no aparece delante o no se cierra al hacer clic fuera.
  const wasFocusable = win.isFocusable();
  if (!wasFocusable) win.setFocusable(true);
  takeForeground();
  setTimeout(() => helperCmd({ cmd: 'trayclick', key, button }), 60);
  if (!wasFocusable) setTimeout(() => { if (!hold && win && !win.isDestroyed()) win.setFocusable(false); }, 1500); // sin blur: no quitar el foco a la app
});

// ---------------- "Pregúntale a Claude" (claude -p, sin herramientas) ----------------
let askProc = null;
ipcMain.handle('claude-ask', (_e, { question, history }) => new Promise((resolve) => {
  question = String(question || '').trim().slice(0, 4000);
  if (!question) return resolve({ ok: false, text: '' });
  const exe = config.claudeCli || path.join(os.homedir(), '.local', 'bin', 'claude.exe');
  if (!fs.existsSync(exe)) return resolve({ ok: false, text: `No encuentro el CLI de Claude en ${exe}. Pon su ruta en "claudeCli" de config.json.` });
  if (askProc) { try { askProc.kill(); } catch {} }
  const prev = (Array.isArray(history) ? history : []).slice(-6)
    .map((h) => `${h.role === 'user' ? 'Usuario' : 'Claude'}: ${String(h.text).slice(0, 2000)}`).join('\n\n');
  const prompt = prev ? `Conversación hasta ahora:\n${prev}\n\nNueva pregunta: ${question}` : question;
  const args = ['-p', '--output-format', 'text', '--no-session-persistence', '--tools', '',
    '--append-system-prompt', 'Respondes desde un notch de escritorio: en español, breve y directo (máx. ~120 palabras), sin tablas ni encabezados.'];
  log('claude-ask', question.length, 'caracteres');
  let out = '', err = '';
  const p = askProc = spawn(exe, args, { cwd: os.homedir(), windowsHide: true, env: { ...process.env, AKITA_NOTCH_CHILD: '1' } });
  const timer = setTimeout(() => { try { p.kill(); } catch {} }, 120e3);
  p.stdout.on('data', (d) => { out += d; send('claude-ask-chunk', out); });
  p.stderr.on('data', (d) => { err += d; });
  p.on('error', (e) => { clearTimeout(timer); resolve({ ok: false, text: e.message }); });
  p.on('close', (code) => {
    clearTimeout(timer); if (askProc === p) askProc = null;
    log('claude-ask fin', code, out.length);
    resolve(code === 0 ? { ok: true, text: out.trim() } : { ok: false, text: (out || err || `Claude terminó con código ${code}`).trim().slice(0, 800) });
  });
  p.stdin.end(prompt);
}));
ipcMain.handle('claude-sessions', () => [...sessions.values()]);
ipcMain.on('claude-dismiss', (_e, id) => { const s = sessions.get(id); if (s && s.status === 'done') { s.status = 'idle'; send('claude', [...sessions.values()]); } });
ipcMain.handle('open-folder', (_e, i) => { const f = config.folders[i]; if (f) shell.openPath(expand(f.path)); });
ipcMain.handle('open-uri', (_e, uri) => {
  const allowed = /^(ms-settings:|ms-screenclip:)/;
  if (allowed.test(uri)) shell.openExternal(uri);
});
ipcMain.handle('open-home', () => shell.openExternal(config.homeServer));
ipcMain.handle('launch', (_e, what) => {
  const apps = { taskmgr: ['taskmgr.exe', []], terminal: ['wt.exe', []], explorer: ['explorer.exe', []] };
  const a = apps[what]; if (a) spawn(a[0], a[1], { detached: true, stdio: 'ignore', shell: true }).unref();
});
ipcMain.handle('power', (_e, action) => {
  const cmds = {
    lock: ['rundll32.exe', ['user32.dll,LockWorkStation']],
    sleep: ['rundll32.exe', ['powrprof.dll,SetSuspendState', '0,1,0']],
    signout: ['shutdown', ['/l']],
    restart: ['shutdown', ['/r', '/t', '0']],
    shutdown: ['shutdown', ['/s', '/t', '0']],
  };
  const c = cmds[action]; if (c) execFile(c[0], c[1], { windowsHide: true });
});
ipcMain.handle('power-plans', powerPlans);
ipcMain.handle('power-plan-set', async (_e, guid) => { if (/^[0-9a-f-]{36}$/i.test(guid)) await run('powercfg', ['/setactive', guid]); return powerPlans(); });
ipcMain.handle('theme-get', isLight);
ipcMain.handle('theme-toggle', async () => {
  const v = (await isLight()) ? '0' : '1';
  await run('reg', ['add', THEME_KEY, '/v', 'AppsUseLightTheme', '/t', 'REG_DWORD', '/d', v, '/f']);
  await run('reg', ['add', THEME_KEY, '/v', 'SystemUsesLightTheme', '/t', 'REG_DWORD', '/d', v, '/f']);
  return v === '1';
});
ipcMain.handle('file-icon', async (_e, exe) => {
  if (!exe) return null;
  if (iconCache.has(exe)) return iconCache.get(exe);
  try { const img = await app.getFileIcon(exe, { size: 'small' }); const url = img.toDataURL(); iconCache.set(exe, url); return url; }
  catch { iconCache.set(exe, null); return null; }
});
ipcMain.on('context-menu', () => {
  // Un menú de Windows solo se cierra al hacer clic fuera si su ventana está en primer plano,
  // y la del notch no acepta foco: se lo damos mientras el menú está abierto.
  const wasFocusable = win.isFocusable();
  if (!wasFocusable) win.setFocusable(true);
  takeForeground();
  Menu.buildFromTemplate([
    { label: 'Recargar notch', click: () => win.reload() },
    { label: 'Herramientas de desarrollo', click: () => win.webContents.openDevTools({ mode: 'detach' }) },
    { label: 'Abrir config.json', click: () => shell.openPath(path.join(__dirname, 'config.json')) },
    { type: 'separator' },
    { label: 'Salir', click: () => { app.isQuitting = true; app.quit(); } },
  ]).popup({ window: win, callback: () => { if (!wasFocusable && !hold && win && !win.isDestroyed()) win.setFocusable(false); } });
});

// ---------------- Arranque ----------------
app.on('second-instance', () => send('expand', true));
// ---------------- Buscador (atajo global) ----------------
// Apps del menú Inicio (escritorio y Store, con icono) y archivos del índice de Windows Search vienen de
// native/search.ps1; los juegos de Steam se leen aquí de sus manifiestos.
let searcher = null, searchBuf = '', searchSeq = 0;
const searchWaiters = new Map();
const launcherIndex = { apps: [], games: [] };
const userFile = (n) => path.join(app.getPath('userData'), n);
let usage = {};
try { usage = JSON.parse(fs.readFileSync(userFile('launcher-usage.json'), 'utf8')); } catch {}
try { launcherIndex.apps = JSON.parse(fs.readFileSync(userFile('launcher-apps.json'), 'utf8')); } catch {}

function startSearcher() {
  const exe = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  searcher = spawn(exe, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, 'native', 'search.ps1')], { windowsHide: true });
  searcher.stdout.setEncoding('utf8');
  searcher.stdout.on('data', (d) => {
    searchBuf += d;
    let i;
    while ((i = searchBuf.indexOf('\n')) >= 0) {
      const line = searchBuf.slice(0, i).trim(); searchBuf = searchBuf.slice(i + 1);
      let msg; try { msg = JSON.parse(line); } catch { continue; }
      if (msg.type === 'apps' && Array.isArray(msg.list) && msg.list.length) {
        launcherIndex.apps = msg.list;
        fs.writeFile(userFile('launcher-apps.json'), JSON.stringify(msg.list), () => {});
        log('buscador:', msg.list.length, 'apps,', launcherIndex.games.length, 'juegos');
        send('launcher-index', launcherIndex);
      } else if (msg.type === 'files') {
        const w = searchWaiters.get(msg.id);
        if (w) { searchWaiters.delete(msg.id); w(Array.isArray(msg.list) ? msg.list : []); }
      }
    }
  });
  searcher.on('exit', () => { searcher = null; searchBuf = ''; for (const w of searchWaiters.values()) w([]); searchWaiters.clear(); });
}
function searchCmd(o) {
  if (!searcher) startSearcher();
  try { searcher.stdin.write(JSON.stringify(o) + '\n'); } catch {}
}

function steamGames() {
  const roots = new Set(['C:\\Program Files (x86)\\Steam']);
  try {
    const vdf = fs.readFileSync('C:\\Program Files (x86)\\Steam\\steamapps\\libraryfolders.vdf', 'utf8');
    for (const m of vdf.matchAll(/"path"\s+"([^"]+)"/g)) roots.add(m[1].replace(/\\\\/g, '\\'));
  } catch {}
  const cache = 'C:\\Program Files (x86)\\Steam\\appcache\\librarycache';
  const games = [];
  for (const r of roots) {
    let files = [];
    try { files = fs.readdirSync(path.join(r, 'steamapps')).filter((f) => /^appmanifest_\d+\.acf$/.test(f)); } catch { continue; }
    for (const f of files) {
      try {
        const t = fs.readFileSync(path.join(r, 'steamapps', f), 'utf8');
        const id = (t.match(/"appid"\s+"(\d+)"/) || [])[1]; const name = (t.match(/"name"\s+"([^"]+)"/) || [])[1];
        if (!id || !name || /redistributable|proton|steam linux runtime|steamworks/i.test(name)) continue;
        let icon = null;
        try {
          const ic = fs.readdirSync(path.join(cache, id)).find((x) => /^[0-9a-f]{40}\.jpg$/.test(x));
          if (ic) icon = require('url').pathToFileURL(path.join(cache, id, ic)).href;
        } catch {}
        games.push({ name, id, icon });
      } catch {}
    }
  }
  return games;
}
function refreshLauncherIndex() {
  launcherIndex.games = steamGames();
  searchCmd({ cmd: 'apps' });
}

ipcMain.handle('launcher-index', () => ({ ...launcherIndex, usage }));
ipcMain.handle('launcher-files', (_e, q) => new Promise((resolve) => {
  q = String(q || '').trim().slice(0, 100);
  if (q.length < 2) return resolve([]);
  const id = ++searchSeq;
  searchWaiters.set(id, resolve);
  setTimeout(() => { if (searchWaiters.delete(id)) resolve([]); }, 4000);
  searchCmd({ cmd: 'files', q, id });
}));
ipcMain.handle('launcher-open', (_e, it) => {
  if (!it || typeof it !== 'object') return false;
  const key = `${it.type}:${it.id || it.path}`;
  usage[key] = (usage[key] || 0) + 1;
  fs.writeFile(userFile('launcher-usage.json'), JSON.stringify(usage), () => {});
  log('buscador abre', key);
  if (it.type === 'app' && typeof it.id === 'string') {
    spawn('explorer.exe', [`shell:AppsFolder\\${it.id}`], { detached: true, stdio: 'ignore' }).unref();
  } else if (it.type === 'game' && /^\d+$/.test(String(it.id))) {
    shell.openExternal(`steam://rungameid/${it.id}`);
  } else if (it.type === 'file' && typeof it.path === 'string') {
    shell.openPath(it.path);
  } else return false;
  return true;
});
ipcMain.handle('launcher-reveal', (_e, p) => { if (typeof p === 'string') shell.showItemInFolder(p); });

function registerLauncherHotkey() {
  const key = config.launcherHotkey || 'Alt+S';
  try {
    const ok = globalShortcut.register(key, () => {
      if (hiddenForFullscreen) return; // jugando: ni se abre ni roba el foco
      send('launcher');
    });
    log('atajo del buscador', key, ok ? 'activo' : 'NO DISPONIBLE (lo usa otra app)');
  } catch (e) { log('atajo del buscador no válido:', key, e.message); }
}

app.whenReady().then(() => {
  // Captura de audio del sistema (loopback) para el visualizador.
  session.defaultSession.setDisplayMediaRequestHandler((_req, cb) => {
    desktopCapturer.getSources({ types: ['screen'] }).then((s) => cb({ video: s[0], audio: 'loopback' })).catch(() => cb({}));
  });
  createWindow();
  startHelper();
  setTimeout(startNativeExtras, 4000);
  startClaudeServer();
  registerLauncherHotkey();
  setTimeout(refreshLauncherIndex, 8000);
  setInterval(refreshLauncherIndex, 30 * 60 * 1000);
});
app.on('will-quit', () => { globalShortcut.unregisterAll(); if (searcher) searcher.stdin.end(); });
app.on('before-quit', () => {
  app.isQuitting = true;
  for (const p of pending.values()) p.resolve(null);
  if (helper) { helperCmd({ cmd: 'appbar', on: false }); helper.stdin.end(); }
});
app.on('window-all-closed', () => app.quit());
