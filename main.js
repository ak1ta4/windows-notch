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
  askHotkey: 'Alt+Q',      // atajo global para preguntar a la IA (apartado de Claude)
  barTrayPins: [],         // iconos de la bandeja fijados en la barra (se eligen en la pestaña Bandeja)
  rim: true,               // borde y halo alrededor de la isla (para que se vea en OLED)
  rimStrength: 1,          // intensidad del borde: 0.5 suave, 1 normal, 2 marcado
  claudeCli: '',           // ruta a claude.exe para "Pregúntale a Claude" (vacío = ~/.local/bin/claude.exe)
};
function loadConfig() {
  const file = path.join(__dirname, 'config.json');
  let user = {}, broken = false;
  try { user = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { broken = fs.existsSync(file); if (broken) console.error('config.json con error de formato:', e.message); }
  const merged = { ...defaultConfig, ...user };
  // Añade al archivo las opciones nuevas sin tocar las que ya tienes.
  // Si el archivo existe pero tiene un error de formato, NO se reescribe (se perderían tus datos y claves).
  if (!broken && Object.keys(defaultConfig).some((k) => !(k in user))) {
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
  // Excepción: con la Herramienta Recortes abierta el notch se queda por debajo de ella (si no, tapa
  // su barra de tipos de recorte, que sale justo arriba en el centro).
  let yielding = false, tick = 0;
  setInterval(() => {
    tick++;
    if (!win || win.isDestroyed() || !win.isVisible()) return;
    if (snipOverlayOpen()) {
      if (!yielding) { yielding = true; win.setAlwaysOnTop(false); log('cediendo a Recortes'); }
      return;
    }
    if (yielding) { yielding = false; tick = 0; log('Recortes cerrado'); }
    else if (tick % 4) return; // reafirmar cada ~1,6 s; mirar Recortes cada 0,4 s
    if (tick % 20 === 0) checkReservedSpace(); // cada ~8 s
    win.setAlwaysOnTop(true, 'screen-saver');
    win.moveTop();
  }, 400);
}
// A veces Windows se queda con una franja reservada más corta de la pedida (se vio con 42 px físicos
// en vez de 63 a escala 150 %): las ventanas suben y la lengüeta del notch tapa su borde superior.
// Si pasa, se vuelve a pedir la reserva.
function checkReservedSpace() {
  if (!config.appBar || !helper || hiddenForFullscreen) return;
  const api = fgApi(); if (!api || !api.WorkTop) return;
  const d = screen.getPrimaryDisplay();
  const want = Math.round((d.bounds.y + config.appBarHeight) * d.scaleFactor);
  let top; try { top = api.WorkTop(); } catch { return; }
  if (top == null || top >= want) { shortCount = 0; return; }
  shortCount++;
  log('reserva corta', { top, want, intento: shortCount });
  // Volver a pedir la posición no siempre basta (se vio quedarse en 0 durante minutos): al segundo
  // intento se da de baja la franja y se registra de nuevo.
  if (shortCount >= 2) { helperCmd({ cmd: 'appbar', on: false }); setTimeout(reserveSpace, 500); shortCount = 0; }
  else reserveSpace();
}
let shortCount = 0;
function snipOverlayOpen() {
  const api = fgApi(); if (!api) return false;
  try { const h = api.FindWindowW('SnipOverlayRootWindow', null); return !!h && api.IsWindowVisible(h); } catch { return false; }
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
      FindWindowW: u.func('__stdcall', 'FindWindowW', 'intptr', ['str16', 'str16']),
      IsWindowVisible: u.func('__stdcall', 'IsWindowVisible', 'bool', ['intptr']),
      AllowSetForegroundWindow: u.func('__stdcall', 'AllowSetForegroundWindow', 'bool', ['uint32']),
      GetWindow: u.func('__stdcall', 'GetWindow', 'intptr', ['intptr', 'uint32']),
      SetWindowPos: u.func('__stdcall', 'SetWindowPos', 'bool', ['intptr', 'intptr', 'int', 'int', 'int', 'int', 'uint32']),
      GetWindowLongW: u.func('__stdcall', 'GetWindowLongW', 'int32', ['intptr', 'int']),
      // Área de trabajo de la pantalla principal (en píxeles físicos: Electron es consciente del DPI)
      WorkTop: (() => {
        const R = koffi.struct('NotchRect', { l: 'int', t: 'int', r: 'int', b: 'int' });
        const spi = u.func('__stdcall', 'SystemParametersInfoW', 'bool', ['uint', 'uint', koffi.out(koffi.pointer(R)), 'uint']);
        return () => { const r = {}; return spi(0x30 /*SPI_GETWORKAREA*/, 0, r, 0) ? r.t : null; };
      })(),
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
// Al abrir algo desde el buscador, el primer plano es para la app que se abre: si se devolviera a la
// ventana anterior, Windows le negaría a la nueva ponerse delante y la barra de tareas oculta saltaría
// avisando. Se le da permiso y se espera a que la app lo tome (o, si no aparece, se devuelve a los 8 s).
let launchingUntil = 0;
function handForegroundToLaunch() {
  const api = fgApi(); if (!api) return;
  try { api.AllowSetForegroundWindow(0xFFFFFFFF /*ASFW_ANY*/); } catch {}
  launchingUntil = Date.now() + 8000; // las apps de la Store tardan ~3 s en abrir en frío
}
// Soltar el foco SIEMPRE en este orden: primero se devuelve el primer plano a otra ventana y solo después
// la del notch deja de aceptar foco. Al revés (como estaba), win.setFocusable(false) suelta el primer plano
// sin dárselo a nadie, Windows se lo da a la barra de tareas y la oculta asoma (pasaba al escribir en el
// notch, con los menús de la bandeja y con el menú contextual).
function giveBackForeground() {
  const api = fgApi();
  const prev = prevForeground; prevForeground = 0n;
  if (!api) return null;
  const me = BigInt(win.getNativeWindowHandle().readBigUInt64LE(0));
  // Si ya pasaste a otra ventana (clic fuera, menú de una app), no se le quita el foco
  const cur = BigInt(api.GetForegroundWindow());
  if (cur !== me) return cur || null;
  if (prev && api.IsWindow(prev) && api.IsWindowVisible(prev) && api.SetForegroundWindow(prev)) return prev;
  // Sin ventana anterior: la primera ventana visible por debajo del notch (como mínimo, el escritorio)
  for (let h = api.GetWindow(me, 2 /*GW_HWNDNEXT*/); h; h = api.GetWindow(h, 2)) {
    if (!api.IsWindowVisible(h)) continue;
    const ex = api.GetWindowLongW(h, -20 /*GWL_EXSTYLE*/);
    if (ex & (0x80 | 0x08000000)) continue; // TOOLWINDOW / NOACTIVATE
    if (api.SetForegroundWindow(h)) return BigInt(h);
  }
  const desk = api.FindWindowW('Progman', null); if (desk && api.SetForegroundWindow(desk)) return BigInt(desk);
  return null;
}
// win.setFocusable() de Electron, en Windows, además de cambiar el estilo llama a Focus(false), que pone en
// primer plano la SIGUIENTE ventana visible en el orden de apilado. Como el notch está siempre encima,
// esa ventana suele ser la barra de tareas: se activa y la oculta asoma. Cada vez que el notch empezaba
// o dejaba de aceptar foco (escribir, menús de la bandeja, menú contextual) pasaba esto.
// Arreglo: justo antes, el notch se coloca en el apilado inmediatamente encima de la ventana que debe
// quedarse con el foco, así "la siguiente" es esa; justo después vuelve a estar por encima de todo.
function setFocusableSafe(on, keep) {
  if (!win || win.isDestroyed()) return;
  if (win.isFocusable() === on) return;
  const api = fgApi();
  if (!api) { win.setFocusable(on); return; }
  const me = BigInt(win.getNativeWindowHandle().readBigUInt64LE(0));
  const SWP = 0x0001 | 0x0002 | 0x0010; // NOSIZE | NOMOVE | NOACTIVATE
  let target = keep != null ? BigInt(keep) : BigInt(api.GetForegroundWindow());
  if (target === me) target = 0n;
  try {
    if (target && api.IsWindow(target)) {
      const above = BigInt(api.GetWindow(target, 3 /*GW_HWNDPREV*/));
      if (above === me) { /* ya está justo encima */ }
      else if (above) api.SetWindowPos(me, above, 0, 0, 0, 0, SWP);  // queda entre "above" y target
      else { api.SetWindowPos(me, -2 /*HWND_NOTOPMOST*/, 0, 0, 0, 0, SWP); api.SetWindowPos(me, 0 /*HWND_TOP*/, 0, 0, 0, 0, SWP); }
    } else {
      api.SetWindowPos(me, 1 /*HWND_BOTTOM*/, 0, 0, 0, 0, SWP); // sin destino: que no haya "siguiente"
    }
  } catch (e) { log('apilado: falló', e.message); }
  win.setFocusable(on);
  win.setSkipTaskbar(true);
  try { api.SetWindowPos(me, -1 /*HWND_TOPMOST*/, 0, 0, 0, 0, SWP); } catch {}
  win.setAlwaysOnTop(true, 'screen-saver');
}
function releaseFocus() {
  if (!win || win.isDestroyed()) return;
  const to = giveBackForeground(); // la ventana que se queda con el foco
  setFocusableSafe(false, to);
}
function setFocusable(on) {
  if (!win || win.isDestroyed()) return;
  // Abriendo algo desde el buscador: se espera a que la app nueva se ponga delante y solo entonces se
  // deja de aceptar el foco (si se devolviera a la ventana de antes, a la nueva se le negaría).
  if (!on && Date.now() < launchingUntil) { waitLaunchThenRelease(); return; }
  if (on) { setFocusableSafe(true); takeForeground(); } else releaseFocus();
}
function waitLaunchThenRelease() {
  const api = fgApi(); if (!api) { launchingUntil = 0; setFocusable(false); return; }
  const me = BigInt(win.getNativeWindowHandle().readBigUInt64LE(0));
  try { api.AllowSetForegroundWindow(0xFFFFFFFF /*ASFW_ANY*/); } catch {}
  const check = () => {
    if (!win || win.isDestroyed()) return;
    const cur = BigInt(api.GetForegroundWindow());
    if (cur !== me && cur !== 0n) { launchingUntil = 0; prevForeground = 0n; setFocusableSafe(false, cur); return; } // la app ya está delante: soltar sin más
    if (Date.now() < launchingUntil) { setTimeout(check, 100); return; }
    launchingUntil = 0; setFocusable(false); // no apareció: se devuelve a la ventana de antes
  };
  setTimeout(check, 100);
}

// ---------------- Reserva de espacio (AppBar) ----------------
function reserveSpace() {
  if (!helper) return;
  if (!config.appBar) { helperCmd({ cmd: 'appbar', on: false }); return; }
  const d = screen.getPrimaryDisplay();
  const s = d.scaleFactor;
  log('reserva', { bounds: d.bounds, scale: s, h: Math.round(config.appBarHeight * s) });
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
// Editar texto y/o fecha. Si cambia la fecha, el agente vuelve a avisar en la nueva hora.
ipcMain.handle('todo-update', async (_e, { id, text, due }) => {
  text = String(text || '').trim().slice(0, 300);
  if (!text) return getTodos();
  due = validDue(due);
  try {
    return await editTodos((t) => t.map((x) => (x.id === id
      ? { ...x, text, due, notified: x.due === due ? x.notified : false }
      : x)));
  } catch { return getTodos(); }
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
// Sesiones que vienen de "Pregúntale a Claude" (abiertas luego en la app): no se listan en el notch
const isAskSession = (ev) => !!ev.cwd && path.resolve(String(ev.cwd)).toLowerCase() === path.resolve(ASK_DIR).toLowerCase();
function onClaudeEvent(ev) {
  if (isAskSession(ev)) { if (ev.session_id && sessions.delete(ev.session_id)) send('claude', [...sessions.values()]); return; }
  log('claude', ev.hook_event_name, ev.notification_type || '', ev.tool_name || '', String(ev.session_id || '').slice(0, 8));
  const id = ev.session_id || 'default';
  const s = sessions.get(id) || { id, project: ev.cwd ? path.basename(ev.cwd) : 'Claude', status: 'idle', verb: '', obj: '', history: [] };
  if (ev.cwd) s.project = path.basename(ev.cwd);
  if (Number.isInteger(ev.ppid) && ev.ppid > 0) s.pid = ev.ppid; // proceso que lanzó el hook: lleva a su ventana
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
  if (Array.isArray(i.questions) && i.questions.length) {
    info.questions = i.questions;
    info.verb = 'Te pregunta'; info.obj = String(i.questions[0].header || i.questions[0].question || '').slice(0, 48); info.detail = '';
  }
  let done = false;
  const finish = (decision, answers) => {
    if (done) return; done = true;
    pending.delete(id); clearTimeout(timer);
    send('claude-pending', pendingList());
    if (!res.writableEnded) res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ decision, answers }));
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
ipcMain.on('claude-decide', (_e, { id, decision, answers }) => {
  const p = pending.get(id);
  if (!p || (decision !== 'allow' && decision !== 'deny')) return;
  // Respuestas a AskUserQuestion: { "texto de la pregunta": "opción elegida" }
  let ans;
  if (decision === 'allow' && p.info.questions && answers && typeof answers === 'object') {
    ans = {};
    for (const q of p.info.questions) if (typeof answers[q.question] === 'string') ans[q.question] = answers[q.question].slice(0, 1000);
  }
  p.resolve(decision, ans);
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
    let user = {}; try { user = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { if (fs.existsSync(file)) throw new Error('config.json tiene un error de formato: no se toca'); }
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
  if (!wasFocusable) setFocusableSafe(true);
  takeForeground();
  setTimeout(() => helperCmd({ cmd: 'trayclick', key, button }), 60);
  // Si el icono no abrió nada y el notch sigue delante, se devuelve el foco antes de soltarlo
  if (!wasFocusable) setTimeout(() => { if (!hold) releaseFocus(); }, 1500);
});

// ---------------- "Pregúntale a Claude" (claude -p, sin herramientas; se guarda en Claude Code) ----------------
let askProc = null;
// ---- "Pregúntale a Claude": siempre Haiku (rápido y barato). Si Haiku ve que la pregunta se le
// complica, contesta solo ESCALAR (no se muestra) y se repite la pregunta con Sonnet.
const ASK_SYSTEM = 'Respondes desde un notch de escritorio: en español, breve y directo (máx. ~120 palabras), sin tablas ni encabezados.';
const ESCALATE = 'ESCALAR';
// Al seguir una conversación el CLI reutiliza el prompt de sistema del primer turno (aunque cambie el
// modelo), así que la regla es una sola y depende del modelo que esté respondiendo.
const ESCALATE_RULE = `Regla de modelos. Si eres Claude Haiku: cuando la pregunta requiera razonamiento de varios pasos, matemáticas o lógica no triviales, escribir o depurar código que no sea trivial, un análisis o comparación a fondo, o conocimiento muy especializado en el que podrías equivocarte, NO la respondas: contesta exactamente "${ESCALATE}" y nada más; todo lo demás (dudas rápidas, definiciones, traducciones, conversiones, recomendaciones sencillas, charla) lo respondes tú. Si eres Claude Sonnet o cualquier otro modelo: responde SIEMPRE a la pregunta y nunca contestes "${ESCALATE}".`;
const MODEL_NAMES = { haiku: 'Haiku', sonnet: 'Sonnet' };
// Cada conversación del notch se guarda como una sesión de Claude Code en la carpeta "Notch"
// (así sale como proyecto "Notch" en Claude y en `claude --resume`). Cada pregunta continúa la
// sesión con una copia nueva (--fork-session) y se borra la anterior: así un intento de Haiku
// que pasa a Sonnet no deja rastro y solo queda una sesión por conversación.
const ASK_DIR = path.join(app.getPath('userData'), 'Notch');
const CLAUDE_PROJECTS = path.join(os.homedir(), '.claude', 'projects');
let askSession = null;        // sesión que tiene la conversación actual
const askOwned = new Set();   // sesiones creadas por el notch (las únicas que puede borrar)
const askImported = new Set(); // ya pasadas a la app de Claude: no se tocan
function dropAskSession(id) {
  if (!id || !askOwned.has(id) || askImported.has(id)) return;
  askOwned.delete(id);
  // Si ya está en la app de Claude (p. ej. importada a mano) no se toca
  if (desktopSessionFor(id)) { askImported.add(id); return; }
  try {
    for (const d of fs.readdirSync(CLAUDE_PROJECTS)) {
      const f = path.join(CLAUDE_PROJECTS, d, `${id}.jsonl`);
      if (fs.existsSync(f)) { fs.rmSync(f, { force: true }); fs.rmSync(path.join(CLAUDE_PROJECTS, d, id), { recursive: true, force: true }); }
    }
  } catch (e) { log('claude-ask: no pude borrar la copia', id, e.message); }
}
ipcMain.handle('claude-ask', async (_e, { question }) => {
  question = String(question || '').trim().slice(0, 4000);
  if (!question) return { ok: false, text: '' };
  const base = askSession;
  // Título de la sesión en Claude: la primera pregunta de la conversación
  const title = (base && askTitles.get(base)) || askTitleFrom(question);
  let r = await askClaude(question, 'haiku', base, title);
  if (r.escalate) {
    log('claude-ask: Haiku lo pasa a Sonnet');
    send('claude-ask-model', MODEL_NAMES.sonnet);
    r = await askClaude(question, 'sonnet', base, title);
  }
  if (r.ok && r.session) {
    // Si mientras tanto se empezó otra conversación, esta respuesta queda en su propia sesión
    if (askSession === base) { askSession = r.session; dropAskSession(base); }
  }
  delete r.session;
  return r;
});
// Nueva conversación: la anterior se queda guardada tal cual
ipcMain.handle('claude-ask-reset', () => { askSession = null; return true; });
// Abre la conversación en la app de Claude (la importa) y el notch empieza una nueva
ipcMain.handle('claude-ask-open', async () => {
  if (!askSession) return false;
  const id = askSession;
  askImported.add(id); askSession = null;
  log('claude-ask: abro en Claude', id);
  try { handForegroundToLaunch(); } catch {}
  await shell.openExternal(`claude://resume?session=${id}`);
  return true;
});
const askTitles = new Map(); // sesión -> título (las copias de una conversación heredan el suyo)
function askTitleFrom(q) {
  const t = q.replace(/\s+/g, ' ').trim();
  return t.length > 60 ? `${t.slice(0, 57).trimEnd()}…` : t;
}
const askClaude = (question, model, base, title) => new Promise((resolve) => {
  const exe = config.claudeCli || path.join(os.homedir(), '.local', 'bin', 'claude.exe');
  if (!fs.existsSync(exe)) return resolve({ ok: false, text: `No encuentro el CLI de Claude en ${exe}. Pon su ruta en "claudeCli" de config.json.` });
  if (askProc) { try { askProc.kill(); } catch {} }
  try { fs.mkdirSync(ASK_DIR, { recursive: true }); } catch {}
  const haiku = model === 'haiku';
  const id = crypto.randomUUID(); askOwned.add(id);
  if (title) askTitles.set(id, title);
  const args = ['-p', '--model', model, '--output-format', 'text', '--tools', '', '--session-id', id,
    ...(title ? ['--name', title] : []),
    ...(base ? ['--resume', base, '--fork-session'] : []),
    '--append-system-prompt', `${ASK_SYSTEM}\n\n${ESCALATE_RULE}`];
  log('claude-ask', model, question.length, 'caracteres', base ? '(sigue la conversación)' : '(nueva)');
  let out = '', err = '';
  // Con Haiku no se enseña nada hasta saber que no empieza por ESCALAR
  const mayEscalate = () => haiku && ESCALATE.startsWith(out.trim().toUpperCase().slice(0, ESCALATE.length));
  const p = askProc = spawn(exe, args, { cwd: ASK_DIR, windowsHide: true, env: { ...process.env, AKITA_NOTCH_CHILD: '1' } });
  const timer = setTimeout(() => { try { p.kill(); } catch {} }, 120e3);
  p.stdout.on('data', (d) => { out += d; if (!mayEscalate()) send('claude-ask-chunk', out); });
  p.stderr.on('data', (d) => { err += d; });
  p.on('error', (e) => { clearTimeout(timer); dropAskSession(id); resolve({ ok: false, text: e.message }); });
  p.on('close', (code) => {
    clearTimeout(timer); if (askProc === p) askProc = null;
    log('claude-ask fin', model, code, out.length);
    const msg = (out || err || `Claude terminó con código ${code}`).trim();
    const fail = (r) => { dropAskSession(id); resolve(r); };
    // Sesión del CLI caducada: se avisa en claro y el notch ofrece un botón para iniciar sesión
    if (code !== 0 && /authenticat|oauth|not logged in|\/login|log in/i.test(msg)) {
      return fail({ ok: false, auth: true, text: 'El CLI de Claude Code no tiene la sesión iniciada (caducó). Inicia sesión y vuelve a preguntar.' });
    }
    if (code === 0 && new RegExp(`^\\W*${ESCALATE}\\W*$`, 'i').test(out.trim())) {
      return fail(haiku ? { escalate: true } : { ok: false, text: 'Sonnet no ha querido responder; vuelve a preguntar.' });
    }
    if (code !== 0) return fail({ ok: false, text: msg.slice(0, 800) });
    resolve({ ok: true, text: out.trim(), model: MODEL_NAMES[model], session: id });
  });
  p.stdin.end(question);
});
// (Se probó meterlas solas en una sección "Notch" de Claude: la app no lo permite con ella abierta.)
try { fs.rmSync(path.join(app.getPath('userData'), 'notch-section-pending.json'), { force: true }); } catch {}

// Abre una terminal con "claude auth login" (el inicio de sesión se hace en el navegador)
ipcMain.on('claude-login', () => {
  const exe = config.claudeCli || path.join(os.homedir(), '.local', 'bin', 'claude.exe');
  if (!fs.existsSync(exe)) return;
  handForegroundToLaunch();
  spawn('cmd.exe', ['/c', 'start', '"Claude Code - iniciar sesión"', 'cmd', '/k', `"${exe}" auth login`], { detached: true, stdio: 'ignore', windowsVerbatimArguments: true }).unref();
});
ipcMain.handle('claude-sessions', () => [...sessions.values()]);
// Clic en una sesión: traer al frente la ventana donde corre (terminal, VS Code, app de Claude…).
// Igual que con la bandeja: el notch se pone delante un instante y el helper (hijo suyo) cede el foco.
// Sesiones de la app de escritorio de Claude: cada una guarda su id de Claude Code (cliSessionId)
// junto al id propio (local_...) que acepta el enlace claude://code/continue?session=local_...
function desktopSessionFor(cliId) {
  const roots = [];
  const la = process.env.LOCALAPPDATA, ra = process.env.APPDATA;
  try { for (const d of fs.readdirSync(path.join(la, 'Claude-Data'))) roots.push(path.join(la, 'Claude-Data', d, 'claude-code-sessions')); } catch {}
  if (ra) roots.push(path.join(ra, 'Claude', 'claude-code-sessions'));
  const walk = (dir, depth) => {
    let ents; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return null; }
    for (const e of ents) {
      const f = path.join(dir, e.name);
      if (e.isDirectory() && depth < 3) { const r = walk(f, depth + 1); if (r) return r; }
      else if (e.isFile() && /^local_[\w-]+\.json$/.test(e.name)) {
        let txt; try { txt = fs.readFileSync(f, 'utf8'); } catch { continue; }
        if (!txt.includes(cliId)) continue; // lectura rápida antes de parsear
        try {
          const d = JSON.parse(txt);
          if (!d.isArchived && (d.cliSessionId === cliId || d.lastAssistantCliSessionId === cliId) && /^local_[A-Za-z0-9-]{1,64}$/.test(d.sessionId)) return d.sessionId;
        } catch {}
      }
    }
    return null;
  };
  for (const r of roots) { const hit = walk(r, 0); if (hit) return hit; }
  return null;
}
ipcMain.on('claude-focus', (_e, id) => {
  const s = sessions.get(id);
  if (!s) return;
  // 1) Sesión de la app de Claude: abre esa conversación exacta
  const local = /^[0-9a-f-]{36}$/i.test(id) ? desktopSessionFor(id) : null;
  if (local) {
    log('claude-focus: app', local);
    handForegroundToLaunch(); // la app puede ponerse delante sin que asome la barra de tareas
    shell.openExternal(`claude://code/continue?session=${local}`);
    return;
  }
  // 2) Terminal / VS Code: se trae al frente su ventana
  if (!s.pid) { log('claude-focus: sin proceso para', String(id).slice(0, 8)); return; }
  const wasFocusable = win.isFocusable();
  if (!wasFocusable) setFocusableSafe(true);
  takeForeground();
  setTimeout(() => helperCmd({ cmd: 'focuspid', pid: s.pid }), 60);
  if (!wasFocusable) setTimeout(() => { if (!hold) releaseFocus(); }, 1200);
});
ipcMain.on('claude-dismiss', (_e, id) => { const s = sessions.get(id); if (s && s.status === 'done') { s.status = 'idle'; send('claude', [...sessions.values()]); } });
ipcMain.handle('open-folder', (_e, i) => { const f = config.folders[i]; if (f) shell.openPath(expand(f.path)); });
ipcMain.handle('open-uri', (_e, uri) => {
  const allowed = /^(ms-settings:|ms-screenclip:)/;
  if (allowed.test(uri)) shell.openExternal(uri);
});
ipcMain.handle('open-home', () => shell.openExternal(config.homeServer));
function launchApp(what) {
  const apps = { taskmgr: ['taskmgr.exe', []], terminal: ['wt.exe', []], explorer: ['explorer.exe', []] };
  const a = apps[what]; if (a) spawn(a[0], a[1], { detached: true, stdio: 'ignore', shell: true }).unref();
}
ipcMain.handle('launch', (_e, what) => launchApp(what));
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
  if (!wasFocusable) setFocusableSafe(true);
  takeForeground();
  Menu.buildFromTemplate([
    { label: 'Administrador de tareas', click: () => { handForegroundToLaunch(); launchApp('taskmgr'); } },
    { type: 'separator' },
    { label: 'Recargar notch', click: () => win.reload() },
    { label: 'Herramientas de desarrollo', click: () => win.webContents.openDevTools({ mode: 'detach' }) },
    { label: 'Abrir config.json', click: () => shell.openPath(path.join(__dirname, 'config.json')) },
    { type: 'separator' },
    { label: 'Salir', click: () => { app.isQuitting = true; app.quit(); } },
  ]).popup({ window: win, callback: () => { if (!wasFocusable && !hold) setFocusable(false); } }); // si se lanzó algo, espera a que salga delante
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
// El proceso del buscador (~80 MB) solo vive mientras se usa: arranca al abrir el buscador y se cierra
// tras 3 minutos sin peticiones.
let searcherIdle = 0;
function touchSearcher() {
  if (!searcher) startSearcher();
  clearTimeout(searcherIdle);
  searcherIdle = setTimeout(() => { if (searcher && !searchWaiters.size) { try { searcher.stdin.end(); } catch {} } }, 3 * 60 * 1000);
}
function searchCmd(o) {
  touchSearcher();
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

// Conversaciones de la app de Claude (pestaña Code) para buscarlas con "@" en el buscador
let convCache = { t: 0, list: [] };
const convFiles = new Map(); // id de la app -> su ficha (para mandarle mensajes)
function claudeConversations() {
  if (Date.now() - convCache.t < 10e3) return convCache.list;
  const roots = [];
  const la = process.env.LOCALAPPDATA, ra = process.env.APPDATA;
  try { for (const d of fs.readdirSync(path.join(la, 'Claude-Data'))) roots.push(path.join(la, 'Claude-Data', d, 'claude-code-sessions')); } catch {}
  if (ra) roots.push(path.join(ra, 'Claude', 'claude-code-sessions'));
  const list = []; const seen = new Set();
  const walk = (dir, depth) => {
    let ents; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const f = path.join(dir, e.name);
      if (e.isDirectory() && depth < 3) walk(f, depth + 1);
      else if (e.isFile() && /^local_[\w-]+\.json$/.test(e.name)) {
        try {
          const d = JSON.parse(fs.readFileSync(f, 'utf8'));
          if (d.isArchived || !/^local_[A-Za-z0-9-]{1,64}$/.test(d.sessionId) || seen.has(d.sessionId)) continue;
          seen.add(d.sessionId); convFiles.set(d.sessionId, f);
          const project = d.cwd ? path.basename(d.cwd) : '';
          list.push({ id: d.sessionId, title: String(d.title || project || 'Sin título').slice(0, 120), project, t: d.lastActivityAt || d.createdAt || 0 });
        } catch {}
      }
    }
  };
  for (const r of roots) walk(r, 0);
  list.sort((x, y) => y.t - x.t);
  convCache = { t: Date.now(), list };
  return list;
}
ipcMain.handle('claude-conversations', () => claudeConversations());
// Mandar un mensaje a una conversación de la app ("@título mensaje" en el buscador). La app no tiene forma
// de recibirlo desde fuera, así que se usa el CLI sobre la misma sesión (claude -p --resume), con el modelo
// y el modo de permisos de esa conversación. Lo que haga sale en la pestaña de Claude del notch (hooks).
const convSending = new Set();
const convLastDone = new Map(); // sesión -> cuándo terminó el último envío del notch (su escritura no cuenta como "trabajando")
// Procesos de Claude que tienen esa sesión abierta. La app deja uno en reposo por cada conversación que has
// abierto (su CLI con --input-format stream-json); los demás son terminales tuyas.
const convProcs = (cliId) => new Promise((ok) => {
  const ps = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const cmd = `@(Get-CimInstance Win32_Process -Filter "Name='claude.exe'" | Where-Object { $_.CommandLine -like '*${cliId}*' } | ForEach-Object { [pscustomobject]@{ pid = $_.ProcessId; app = ($_.CommandLine -like '*--input-format*stream-json*' -and $_.CommandLine -like '*Claude-Data*') } }) | ConvertTo-Json -Compress`;
  execFile(ps, ['-NoProfile', '-Command', cmd], { windowsHide: true, timeout: 10e3 }, (err, out) => {
    if (err) return ok(null);
    try { const j = JSON.parse(String(out).trim() || '[]'); ok(Array.isArray(j) ? j : [j]); } catch { ok([]); }
  });
});
function transcriptOf(cliId) {
  const base = path.join(os.homedir(), '.claude', 'projects');
  try { for (const d of fs.readdirSync(base)) { const f = path.join(base, d, `${cliId}.jsonl`); if (fs.existsSync(f)) return f; } } catch {}
  return null;
}
ipcMain.handle('claude-conv-send', async (_e, { id, text }) => {
  text = String(text || '').trim().slice(0, 8000);
  if (!/^local_[A-Za-z0-9-]{1,64}$/.test(String(id)) || !text) return { ok: false, text: 'Escribe el mensaje.' };
  claudeConversations();
  let d; try { d = JSON.parse(fs.readFileSync(convFiles.get(id), 'utf8')); } catch { return { ok: false, text: 'No encuentro esa conversación.' }; }
  const cli = d.lastAssistantCliSessionId || d.cliSessionId;
  if (!/^[0-9a-f-]{36}$/i.test(String(cli || ''))) return { ok: false, text: 'Esa conversación no se puede continuar desde fuera.' };
  if (!d.cwd || !fs.existsSync(d.cwd)) return { ok: false, text: 'Ya no existe la carpeta de esa conversación.' };
  const tr = transcriptOf(cli);
  if (!tr) return { ok: false, text: 'No encuentro el historial de esa conversación.' };
  // Trabajando = un envío del notch en marcha, o su historial cambió hace nada
  let mtime = 0; try { mtime = fs.statSync(tr).mtimeMs; } catch {}
  const ours = mtime <= (convLastDone.get(cli) || 0) + 2000; // lo último que se escribió fue la respuesta a nuestro mensaje
  if (convSending.has(cli) || (!ours && Date.now() - mtime < 20e3)) return { ok: false, busy: true, text: 'Claude está trabajando ahora mismo en esa conversación. Enter para abrirla.' };
  const procs = await convProcs(cli);
  if (procs === null) return { ok: false, text: 'No pude comprobar si esa conversación está en uso.' };
  if (procs.some((p) => !p.app)) return { ok: false, busy: true, text: 'Esa conversación está abierta en una terminal. Enter para abrirla en Claude.' };
  // La app la tiene abierta en reposo: se cierra ese proceso para que, al volver a ella, la app la recargue
  // del disco con este mensaje incluido (si no, seguiría con la versión de antes en memoria)
  for (const p of procs) { try { process.kill(p.pid); log('mensaje a conversación: cierro el proceso en reposo de la app', p.pid); } catch {} }
  const exe = config.claudeCli || path.join(os.homedir(), '.local', 'bin', 'claude.exe');
  if (!fs.existsSync(exe)) return { ok: false, text: 'No encuentro el CLI de Claude.' };
  const args = ['-p', '--resume', cli, '--output-format', 'text'];
  if (/^claude-[\w.-]+$/.test(String(d.model || ''))) args.push('--model', d.model);
  if (['default', 'acceptEdits', 'plan', 'auto', 'bypassPermissions'].includes(d.permissionMode)) args.push('--permission-mode', d.permissionMode);
  log('mensaje a conversación', id, d.model || '', d.permissionMode || '', text.length, 'caracteres');
  convSending.add(cli);
  // Sin AKITA_NOTCH_CHILD: así sus avisos (trabajando, permisos, terminado) llegan al notch
  const p = spawn(exe, args, { cwd: d.cwd, windowsHide: true });
  let err = '', reply = '';
  p.stdout.on('data', (x) => { reply += x; });
  p.stderr.on('data', (x) => { err += x; });
  const done = (code, why) => {
    if (!convSending.delete(cli)) return;
    convLastDone.set(cli, Date.now());
    log('mensaje a conversación fin', id, code, why || String(err).trim().slice(0, 200));
    if (code === 0) send('conv-send-done', { id, title: d.title || path.basename(d.cwd), text: reply.trim().slice(0, 700) });
    else send('conv-send-failed', { id, title: d.title || path.basename(d.cwd), text: /authenticat|oauth|log in|\/login/i.test(err) ? 'el CLI no tiene la sesión iniciada' : String(why || err).trim().slice(0, 160) || `código ${code}` });
  };
  p.on('error', (e) => done(-1, e.message));
  p.on('close', (code) => done(code));
  p.stdin.end(text);
  return { ok: true };
});
ipcMain.handle('launcher-index', () => { touchSearcher(); return { ...launcherIndex, usage }; }); // se abre el buscador: ir arrancando
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
  handForegroundToLaunch();
  if (it.type === 'app' && typeof it.id === 'string') {
    spawn('explorer.exe', [`shell:AppsFolder\\${it.id}`], { detached: true, stdio: 'ignore' }).unref();
  } else if (it.type === 'game' && /^\d+$/.test(String(it.id))) {
    shell.openExternal(`steam://rungameid/${it.id}`);
  } else if (it.type === 'file' && typeof it.path === 'string') {
    shell.openPath(it.path);
  } else if (it.type === 'conv' && /^local_[A-Za-z0-9-]{1,64}$/.test(String(it.id))) {
    shell.openExternal(`claude://code/continue?session=${it.id}`);
  } else return false;
  return true;
});
ipcMain.handle('launcher-reveal', (_e, p) => { if (typeof p === 'string') { handForegroundToLaunch(); shell.showItemInFolder(p); } });

function registerLauncherHotkey() {
  const key = config.launcherHotkey || 'Alt+S';
  try {
    const ok = globalShortcut.register(key, () => {
      if (hiddenForFullscreen) return; // jugando: ni se abre ni roba el foco
      send('launcher');
    });
    log('atajo del buscador', key, ok ? 'activo' : 'NO DISPONIBLE (lo usa otra app)');
  } catch (e) { log('atajo del buscador no válido:', key, e.message); }
  // Atajo para preguntar a la IA: abre el apartado de Claude con el cursor en "Pregúntale a…"
  const ask = config.askHotkey;
  if (ask && ask !== key) {
    try {
      const ok = globalShortcut.register(ask, () => { if (!hiddenForFullscreen) send('ask-hotkey'); });
      log('atajo de la IA', ask, ok ? 'activo' : 'NO DISPONIBLE (lo usa otra app)');
    } catch (e) { log('atajo de la IA no válido:', ask, e.message); }
  }
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
