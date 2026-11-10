/* global notch, hydrateIcons, icon */
const $ = (id) => document.getElementById(id);
const island = $('island');
const compact = $('compact');
const expanded = $('expanded');
const EXP_W = 700;
const BAR_H = 34;       // alto de la franja reservada (appBarHeight)
const NOTCH_H = 41;     // barra (34) + lengüeta (7): la forma de la ventana debe cubrirla entera
const EAR = 16;         // ancho de cada curva en S a los lados de la lengüeta

const S = {
  cfg: null,
  open: false,
  view: 'main',
  sys: { vol: 0, mute: false, mic: 0, micMute: false, lang: '', win: {} },
  layouts: [],
  tray: [],            // iconos de la bandeja del sistema
  ask: [],             // conversación con Claude desde el notch
  asking: false,
  media: null,
  thumbs: {},          // key -> dataURL
  artColor: null,
  claude: [],
  pending: [],         // permisos de Claude esperando respuesta
  doneShownUntil: {},  // sessionId -> ts
  todos: [], todosOk: false,
  remindAlerted: new Set(),
  remindShow: null,    // { text, until }
  hudUntil: 0,
  audioActive: false,
  calOffset: 0,
  hover: false,
  typing: false,
  dragging: { vol: false, mic: false, seek: false },
};

// ============ Utilidades ============
const fmtTime = (s) => { s = Math.max(0, Math.floor(s || 0)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
const cap = (t) => t.charAt(0).toUpperCase() + t.slice(1);
const esc = (t) => String(t ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const pad = (n) => String(n).padStart(2, '0');
const localIso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
function appName(aumid) {
  if (!aumid) return '';
  let n = aumid.includes('!') ? aumid.split('!').pop() : aumid;
  n = n.replace(/\.exe$/i, '').split('\\').pop();
  if (/^[0-9a-f]{10,}$/i.test(n)) return 'Navegador'; // Firefox y otros publican un identificador sin nombre
  return n.charAt(0).toUpperCase() + n.slice(1);
}
function setRange(el, v, muted) { el.value = Math.round(v * 100); el.style.setProperty('--v', `${Math.round(v * 100)}%`); el.classList.toggle('muted', !!muted); }
const anyDrag = () => Object.values(S.dragging).some(Boolean);

// ============ Tamaño de la isla y forma de la ventana ============
// La forma (setShape) es lo único que existe para Windows: barra + isla. Al crecer se amplía al
// momento; al encoger se espera a que termine la animación para no recortarla.
let lastShape = '', shrinkTimer = 0, shapeW = 0, shapeH = 0;
function sendShape(w, h) {
  const W = window.innerWidth;
  const rects = [
    { x: 0, y: 0, width: W, height: BAR_H + 3 },
    { x: (W - w) / 2 - EAR - 3, y: 0, width: w + EAR * 2 + 6, height: h + 4 },
  ];
  // Tamaño final del desplegable (offset*, sin la transformación de su animación de entrada): con
  // getBoundingClientRect se medía encogido al abrir y la forma recortaba sus bordes en recto.
  if (S.pop) { const p = $('pop'); rects.push({ x: p.offsetLeft - 4, y: 0, width: p.offsetWidth + 8, height: p.offsetTop + p.offsetHeight + 6 }); }
  const k = JSON.stringify(rects);
  if (k !== lastShape) { lastShape = k; notch.shape(rects); }
  shapeW = w; shapeH = h;
}
function resize() {
  let w, h;
  if (S.open) { w = EXP_W; h = Math.max(NOTCH_H, expanded.offsetHeight); }
  else { w = Math.max(150, compact.offsetWidth); h = BAR_H; } // compacto: la isla es parte de la barra; la lengüeta va debajo
  island.style.width = `${w}px`;
  island.style.height = `${h}px`;
  h = Math.max(h, NOTCH_H);
  if (!S.open) { $('bar').style.setProperty('--notch-gap', `${w + EAR * 2 + 20}px`); scheduleFit(); }
  clearTimeout(shrinkTimer);
  if (w >= shapeW && h >= shapeH) sendShape(w, h);
  else shrinkTimer = setTimeout(() => sendShape(w, h), 600);
}
window.addEventListener('resize', () => { lastShape = ''; sendShape(shapeW || 150, shapeH || NOTCH_H); });
new ResizeObserver(resize).observe(compact);
new ResizeObserver(() => S.open && resize()).observe(expanded);

function setOpen(open) {
  if (S.open === open) return;
  S.open = open;
  island.classList.toggle('open', open);
  notch.panelOpen(open || !!S.pop);
  if (open) closePop();
  if (!open) {
    stopTyping();
    setView('main'); S.calOffset = 0; renderCalendar();
  } else if (S.pending.length) setView('claude');
  resize();
}
function setView(v) {
  if (S.view === 'search' && v !== 'search') stopTyping();
  S.view = v;
  document.querySelectorAll('.view').forEach((el) => el.classList.toggle('active', el.dataset.name === v));
  document.querySelectorAll('.tab').forEach((el) => el.classList.toggle('active', el.dataset.view === v));
  if (v === 'power') loadPlans();
  if (v === 'tasks') loadTodos();
  if (v === 'stats') loadStats();
  if (v === 'lang') renderLayouts();
  if (v === 'search') { LS.focused = false; lsInput.value = ''; LS.sel = 0; LS.files = []; LS.fileQ = ''; lsLoadIndex(); renderLS(); startTyping(lsInput); }
  resize();
}

// ============ Ratón ============
let leaveTimer = 0;
// El panel solo se cierra al hacer clic fuera de la isla, con Escape o al usar una acción.
island.addEventListener('mouseenter', () => { S.hover = true; island.classList.add('hover'); });
island.addEventListener('mouseleave', () => { S.hover = false; island.classList.remove('hover'); });
// Clic dentro de la ventana pero fuera de la isla (en la barra o en el margen): cierra el panel.
document.addEventListener('mousedown', (e) => {
  if (S.open && !island.contains(e.target) && !S.typing && !anyDrag()) setOpen(false);
}, true);
notch.onCollapse(() => { closePop(); setOpen(false); });
document.addEventListener('mousedown', (e) => {
  if (S.pop && !e.target.closest('#pop, #barVol')) closePop();
}, true);
compact.addEventListener('click', (e) => { if (!e.target.closest('[data-perm]')) setOpen(true); });
island.addEventListener('contextmenu', (e) => { e.preventDefault(); notch.contextMenu(); });
compact.addEventListener('auxclick', (e) => { if (e.button === 1) notch.native({ cmd: 'media', action: 'toggle' }); });
compact.addEventListener('wheel', (e) => {
  const v = Math.max(0, Math.min(1, S.sys.vol + (e.deltaY < 0 ? 0.02 : -0.02)));
  S.sys.vol = v; S.sys.mute = false;
  notch.native({ cmd: 'vol', v });
  showHud();
}, { passive: true });
window.addEventListener('keydown', (e) => { if (e.key === 'Escape') setOpen(false); });
// El buscador se cierra al pasar a otra ventana, pero solo si llegó a tener el foco (al abrirse hay un parpadeo de foco)
window.addEventListener('focus', () => { if (S.open && S.view === 'search') LS.focused = true; });
window.addEventListener('blur', () => {
  if (S.open && S.view === 'search') { if (LS.focused) setOpen(false); return; }
  if (S.typing) stopTyping();
});
notch.onExpand(() => setOpen(true));

// Escribir: la ventana solo acepta foco mientras hay un campo activo (así no roba el foco a tus apps).
function startTyping(el) {
  if (!S.typing) { S.typing = true; notch.hold(true); notch.focusable(true); }
  setTimeout(() => el.focus(), 30);
}
function stopTyping() {
  if (!S.typing) return;
  S.typing = false; notch.hold(false); notch.focusable(false);
  if (document.activeElement) document.activeElement.blur();
}
document.addEventListener('mousedown', (e) => {
  const t = e.target.closest('button, input, .compact, [data-tray]');
  notch.log('mousedown', e.button, t ? (t.id || t.dataset.view || t.dataset.tray || t.className || t.tagName) : e.target.tagName, S.open ? `abierto:${S.view}` : 'compacto');
  const inp = e.target.closest('input[type=text], input[type=datetime-local]');
  if (inp) startTyping(inp);
  else if (S.typing && !e.target.closest('.task-form, .quick-due, .ask-form')) stopTyping();
});

// ============ Reloj ============
const dateFmt = new Intl.DateTimeFormat('es-ES', { weekday: 'short', day: 'numeric', month: 'short' });
const bigDateFmt = new Intl.DateTimeFormat('es-ES', { weekday: 'long', day: 'numeric', month: 'long' });
function hhmm(d) {
  if (S.cfg && S.cfg.clock24h === false) return d.toLocaleTimeString('es-ES', { hour: 'numeric', minute: '2-digit', hour12: true });
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
let lastDay = -1;
function tick() {
  const d = new Date();
  $('cTime').textContent = hhmm(d);
  $('cDate').textContent = cap(dateFmt.format(d).replace(/\./g, ''));
  $('bigTime').textContent = hhmm(d);
  $('bigDate').textContent = cap(bigDateFmt.format(d));
  if (d.getDate() !== lastDay) { lastDay = d.getDate(); renderCalendar(); }
  updateProgress();
  checkReminders();
}
setInterval(tick, 1000);

// ============ Calendario ============
function isoWeek(d) {
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const day = t.getUTCDay() || 7; t.setUTCDate(t.getUTCDate() + 4 - day);
  const y0 = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  return Math.ceil(((t - y0) / 864e5 + 1) / 7);
}
function renderCalendar() {
  const now = new Date();
  const base = new Date(now.getFullYear(), now.getMonth() + S.calOffset, 1);
  $('calMonth').textContent = cap(base.toLocaleDateString('es-ES', { month: 'long', year: 'numeric' }));
  const start = new Date(base); start.setDate(1 - ((base.getDay() + 6) % 7));
  const last = new Date(base.getFullYear(), base.getMonth() + 1, 0);
  const weeks = Math.ceil((((base.getDay() + 6) % 7) + last.getDate()) / 7);
  const dueDays = new Set(S.todos.filter((t) => t.due && !t.done).map((t) => t.due.slice(0, 10)));
  let html = '<span></span>' + ['L', 'M', 'X', 'J', 'V', 'S', 'D'].map((d) => `<span class="dow">${d}</span>`).join('');
  const d = new Date(start);
  for (let w = 0; w < weeks; w++) {
    html += `<span class="wk">${isoWeek(d)}</span>`;
    for (let i = 0; i < 7; i++) {
      const cls = ['d'];
      if (d.getMonth() !== base.getMonth()) cls.push('out');
      if (i >= 5) cls.push('we');
      if (d.toDateString() === now.toDateString()) cls.push('today');
      if (dueDays.has(localIso(d).slice(0, 10))) cls.push('has-task');
      html += `<span class="${cls.join(' ')}">${d.getDate()}</span>`;
      d.setDate(d.getDate() + 1);
    }
  }
  $('calGrid').innerHTML = html;
}
$('calPrev').onclick = () => { S.calOffset--; renderCalendar(); };
$('calNext').onclick = () => { S.calOffset++; renderCalendar(); };
$('calMonth').onclick = () => { S.calOffset = 0; renderCalendar(); };

// ============ Estado nativo ============
notch.onNative((msg) => {
  if (msg.type === 'thumb') {
    if (msg.data && msg.data.length < 64) msg.data = null; // miniatura vacía (p. ej. YouTube a veces no da imagen)
    if (msg.data || !S.thumbs[msg.key]) S.thumbs[msg.key] = msg.data;
    if (S.media && S.media.key === msg.key) { if (msg.data) computeArtColor(msg.data); else S.artColor = null; }
    renderMedia(); renderCompact(); renderBar();
    return;
  }
  if (msg.type === 'layouts') { S.layouts = msg.list || []; renderLayouts(); return; }
  if (msg.type === 'tray') { S.tray = msg.list || []; renderTray(); renderBarTray(); return; }
  if (msg.type !== 'state') return;
  const prev = S.sys;
  // Tras cambiar de idioma a mano, un estado viejo (de antes del cambio) no debe volver a pintar el anterior
  if (langPending && (msg.lang === langPending.code || Date.now() > langPending.until)) langPending = null;
  if (langPending) { msg.lang = langPending.code; msg.langName = langPending.name; }
  S.sys = msg;
  if (prev.vol !== undefined && (Math.abs(prev.vol - msg.vol) > 0.001 || prev.mute !== msg.mute) && !S.dragging.vol) showHud();
  const ignore = (S.cfg && S.cfg.mediaIgnore) || ['Claude'];
  const m = msg.media;
  const prevKey = S.media && S.media.key;
  S.media = m && !ignore.some((x) => appName(m.app).toLowerCase().includes(x.toLowerCase())) ? m : null;
  if (S.media && S.media.key !== prevKey) { const t = S.thumbs[S.media.key]; if (t) computeArtColor(t); else S.artColor = null; }
  renderSystem(); renderMedia(); renderCompact(); renderBar();
});

let lastExe = null;
function renderSystem() {
  const s = S.sys;
  if (!S.dragging.vol) setRange($('volRange'), s.vol, s.mute);
  if (!S.dragging.mic) setRange($('micRange'), s.mic, s.micMute);
  $('volPct').textContent = s.mute ? 'Mudo' : `${Math.round(s.vol * 100)}%`;
  $('micPct').textContent = s.micMute ? 'Mudo' : `${Math.round(s.mic * 100)}%`;
  $('volMute').querySelector('i').dataset.icon = s.mute ? 'volx' : 'vol';
  $('micMute').querySelector('i').dataset.icon = s.micMute ? 'micx' : 'mic';
  $('volMute').classList.toggle('on', s.mute);
  $('micMute').classList.toggle('on', s.micMute);
  hydrateIcons(document.querySelector('.sliders'));
  $('langBtn').textContent = s.lang || '—';
  const w = s.win || {};
  $('activeTitle').textContent = w.title || '';
  if (w.exe !== lastExe) {
    lastExe = w.exe;
    notch.fileIcon(w.exe).then((url) => { if (lastExe === w.exe) $('activeIcon').src = url || ''; });
  }
}

function renderLayouts() {
  $('langTiles').innerHTML = S.layouts.map((l) =>
    `<button class="tile ${l.code === S.sys.lang ? 'sel' : ''}" data-hkl="${esc(l.hkl)}"><span class="big-code">${esc(l.code)}</span><span>${esc(cap(l.name))}</span></button>`).join('')
    || '<div class="empty">No se encontraron distribuciones de teclado.</div>';
  resize();
}

// ============ Media ============
function mediaPos() {
  const m = S.media; if (!m) return 0;
  let p = m.pos;
  if (m.playing && m.upd) p += (Date.now() - m.upd) / 1000;
  return Math.min(p, m.dur || p);
}
function updateProgress() {
  const m = S.media;
  const ok = m && m.dur > 1;
  $('mProgress').classList.toggle('hidden', !ok);
  if (!ok || S.dragging.seek) return;
  const p = mediaPos();
  $('mPos').textContent = fmtTime(p);
  $('mDur').textContent = fmtTime(m.dur);
  const pct = `${(p / m.dur) * 100}%`;
  $('mFill').style.width = pct; $('mKnob').style.left = pct;
}
function renderMedia() {
  const m = S.media;
  $('mediaCard').classList.toggle('playing', !!(m && m.playing));
  $('mTitle').textContent = m ? m.title || 'Sin título' : 'Nada sonando';
  $('mArtist').textContent = m ? m.artist || m.album || '' : 'Pon algo de música';
  $('mApp').textContent = m ? appName(m.app) : '';
  const art = m && S.thumbs[m.key];
  const el = $('mArt');
  el.style.backgroundImage = art ? `url("${art}")` : '';
  el.classList.toggle('has-img', !!art);
  $('mPlay').querySelector('i').dataset.icon = m && m.playing ? 'pause' : 'play'; hydrateIcons($('mPlay'));
  // Con Spotify sin controles de Windows se usan las teclas multimedia, que funcionan aunque no se detecte nada.
  $('mPlay').disabled = false;
  $('mPrev').disabled = !!(m && m.canPrev === false);
  $('mNext').disabled = !!(m && m.canNext === false);
  updateProgress();
}
$('mPlay').onclick = () => notch.native({ cmd: 'media', action: 'toggle' });
$('mPrev').onclick = () => notch.native({ cmd: 'media', action: 'prev' });
$('mNext').onclick = () => notch.native({ cmd: 'media', action: 'next' });
(() => {
  const bar = $('mBar');
  const at = (e) => { const r = bar.getBoundingClientRect(); return Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)); };
  bar.addEventListener('pointerdown', (e) => {
    if (!S.media || !S.media.canSeek) return;
    S.dragging.seek = true; notch.hold(true); bar.setPointerCapture(e.pointerId);
    const show = (f) => { $('mFill').style.width = $('mKnob').style.left = `${f * 100}%`; $('mPos').textContent = fmtTime(f * S.media.dur); };
    show(at(e));
    bar.onpointermove = (ev) => show(at(ev));
    bar.onpointerup = (ev) => {
      const t = at(ev) * S.media.dur;
      S.media.pos = t; S.media.upd = Date.now();
      notch.native({ cmd: 'seek', t });
      S.dragging.seek = false; notch.hold(S.typing); bar.onpointermove = bar.onpointerup = null;
    };
  });
})();

function computeArtColor(url) {
  const img = new Image();
  img.onload = () => {
    const c = document.createElement('canvas'); c.width = c.height = 16;
    const x = c.getContext('2d'); x.drawImage(img, 0, 0, 16, 16);
    const d = x.getImageData(0, 0, 16, 16).data;
    let r = 0, g = 0, b = 0, n = 0;
    for (let i = 0; i < d.length; i += 4) {
      const mx = Math.max(d[i], d[i + 1], d[i + 2]), mn = Math.min(d[i], d[i + 1], d[i + 2]);
      const w = (mx - mn) / 255 + 0.05;
      r += d[i] * w; g += d[i + 1] * w; b += d[i + 2] * w; n += w;
    }
    r /= n; g /= n; b /= n;
    const k = 200 / Math.max(r, g, b, 1);
    S.artColor = `rgb(${Math.min(255, r * k) | 0},${Math.min(255, g * k) | 0},${Math.min(255, b * k) | 0})`;
  };
  img.src = url;
}

// ============ Sliders ============
function bindSlider(id, key, cmd) {
  const el = $(id); let last = 0;
  el.addEventListener('pointerdown', () => { S.dragging[key] = true; notch.hold(true); });
  el.addEventListener('input', () => {
    el.style.setProperty('--v', `${el.value}%`);
    const now = Date.now();
    if (now - last > 40) { last = now; notch.native({ cmd, v: el.value / 100 }); }
  });
  const end = () => { notch.native({ cmd, v: el.value / 100 }); setTimeout(() => { S.dragging[key] = false; notch.hold(S.typing); }, 250); };
  el.addEventListener('change', end);
  el.addEventListener('pointerup', end);
}
bindSlider('volRange', 'vol', 'vol');
bindSlider('micRange', 'mic', 'micvol');
$('volMute').onclick = () => notch.native({ cmd: 'mute' });
$('micMute').onclick = () => notch.native({ cmd: 'micmute' });

// ============ Compacto ============
let hudTimer = 0;
function showHud() {
  S.hudUntil = Date.now() + 1600;
  renderCompact();
  clearTimeout(hudTimer); hudTimer = setTimeout(renderCompact, 1650);
}
function pickClaude() {
  const now = Date.now();
  const list = S.claude;
  return list.find((s) => s.status === 'waiting')
    || list.filter((s) => s.status === 'working').sort((a, b) => b.t - a.t)[0]
    || list.find((s) => s.status === 'done' && (S.doneShownUntil[s.id] || 0) > now);
}
function nextReminder() {
  const now = Date.now();
  if (S.remindShow && S.remindShow.until > now) return { text: S.remindShow.text, due: true };
  let best = null;
  for (const t of S.todos) {
    if (t.done || !t.due) continue;
    const ms = new Date(t.due).getTime();
    if (ms - now <= 15 * 60e3 && ms - now > -60e3 && (!best || ms < best.ms)) best = { ms, text: t.text, at: t.due.slice(11) };
  }
  return best;
}
let lastCompactKey = '';
function renderCompact() {
  const left = $('cLeft'); const right = $('cRight');
  const now = Date.now();
  let leftHtml = ''; let rightMode = 'viz';
  right.querySelector('.c-vol')?.remove();
  if (S.hudUntil > now) {
    const v = S.sys.mute ? 0 : S.sys.vol;
    leftHtml = `<span class="c-icon muted-ico">${icon(S.sys.mute ? 'volx' : 'vol')}</span>`;
    rightMode = 'hud';
    right.insertAdjacentHTML('beforeend', `<div class="c-vol"><div class="vbar"><span style="width:${v * 100}%"></span></div>${Math.round(v * 100)}</div>`);
  } else if (S.pending.length) {
    const p = S.pending[0];
    leftHtml = `<div class="c-status perm"><span class="c-icon warn">${icon('shield')}</span><span class="txt"><b>${esc(p.project)}</b> · ${esc(p.verb)} ${esc(p.obj)}</span>
      <button class="mini ok" data-perm="allow" data-id="${p.id}" title="Permitir">${icon('check')}</button>
      <button class="mini no" data-perm="deny" data-id="${p.id}" title="Denegar">${icon('x')}</button></div>`;
  } else {
    const cc = pickClaude();
    const rem = nextReminder();
    if (cc && cc.status !== 'done') {
      const ico = `<span class="dot ${cc.status}"></span>`;
      const txt = cc.status === 'waiting' ? `<b>${esc(cc.project)}</b> · te necesita` : `<b>${esc(cc.verb)}</b> ${esc(cc.obj || cc.project)}`;
      leftHtml = `<div class="c-status">${ico}<span class="txt">${txt}</span></div>`;
    } else if (rem) {
      leftHtml = `<div class="c-status"><span class="c-icon ${rem.due ? 'warn' : ''}">${icon('alarm')}</span><span class="txt">${rem.at ? `<b>${esc(rem.at)}</b> ` : ''}${esc(rem.text)}</span></div>`;
    } else if (cc) {
      leftHtml = `<div class="c-status"><span class="c-icon">${icon('check')}</span><span class="txt"><b>${esc(cc.project)}</b> · listo</span></div>`;
    }
  }
  if (leftHtml !== lastCompactKey) { left.innerHTML = leftHtml; lastCompactKey = leftHtml; }
  $('miniViz').style.display = rightMode === 'viz' ? '' : 'none';
  right.classList.toggle('empty', rightMode === 'viz' && !S.audioActive);
  island.classList.toggle('pulse-wait', S.pending.length > 0 || S.claude.some((s) => s.status === 'waiting'));
}

// ============ Visualizador (audio del sistema en loopback) ============
const viz = { analyser: null, data: null, levels: new Float32Array(32), silentSince: 0 };
async function startViz() {
  try {
    const stream = await navigator.mediaDevices.getDisplayMedia({ video: { width: 1, height: 1, frameRate: 1 }, audio: true });
    stream.getVideoTracks().forEach((t) => t.stop());
    if (!stream.getAudioTracks().length) return;
    const ctx = new AudioContext();
    const src = ctx.createMediaStreamSource(new MediaStream(stream.getAudioTracks()));
    const an = ctx.createAnalyser(); an.fftSize = 1024; an.smoothingTimeConstant = 0.75;
    src.connect(an);
    viz.analyser = an; viz.data = new Uint8Array(an.frequencyBinCount); viz.rate = ctx.sampleRate;
    requestAnimationFrame(drawViz);
  } catch (e) { console.warn('Visualizador no disponible:', e); }
}
function bands(n, fMin = 60, fMax = 12000) {
  const out = new Float32Array(n); const d = viz.data; const hz = viz.rate / 2 / d.length;
  for (let i = 0; i < n; i++) {
    const a = fMin * Math.pow(fMax / fMin, i / n), b = fMin * Math.pow(fMax / fMin, (i + 1) / n);
    let s = 0, c = 0;
    for (let k = Math.floor(a / hz); k <= Math.ceil(b / hz) && k < d.length; k++) { s += d[k]; c++; }
    out[i] = c ? s / c / 255 : 0;
  }
  return out;
}
function drawBars(canvas, vals, color, gap, mirror) {
  const x = canvas.getContext('2d'); const W = canvas.width, H = canvas.height;
  x.clearRect(0, 0, W, H); x.fillStyle = color;
  const n = vals.length; const bw = (W - gap * (n - 1)) / n;
  for (let i = 0; i < n; i++) {
    const h = Math.max(bw, Math.pow(vals[i], 1.4) * H);
    const y = mirror ? (H - h) / 2 : H - h;
    x.beginPath(); x.roundRect(i * (bw + gap), y, bw, h, bw / 2); x.fill();
  }
}
// Ritmo del visualizador: a la frecuencia del monitor (144 Hz o más) costaba ~20 % de un núcleo de GPU.
// 24 fps mientras se ven las barras; 4 por segundo en silencio (solo para notar que vuelve el sonido);
// 1 por segundo con un juego a pantalla completa, donde el notch ni se ve.
function nextViz() {
  const visible = !S.sys.fullscreen && !document.hidden;
  const drawing = visible && (S.open ? S.view === 'main' : S.audioActive);
  setTimeout(() => requestAnimationFrame(drawViz), !visible ? 1000 : drawing ? 42 : 250);
}
function drawViz() {
  nextViz();
  viz.analyser.getByteFrequencyData(viz.data);
  const b = bands(32);
  let energy = 0;
  for (let i = 0; i < b.length; i++) { viz.levels[i] += (b[i] - viz.levels[i]) * 0.7; energy += b[i]; }
  if (S.sys.fullscreen) { if (S.audioActive) { S.audioActive = false; renderCompact(); } return; }
  const now = performance.now();
  const active = energy / b.length > 0.04;
  if (active) viz.silentSince = 0; else if (!viz.silentSince) viz.silentSince = now;
  const shouldShow = active || (viz.silentSince && now - viz.silentSince < 2000);
  if (shouldShow !== S.audioActive) { S.audioActive = shouldShow; renderCompact(); }
  const color = S.artColor || '#ddc7a1';
  if (S.audioActive && !S.open) {
    const m = [0, 4, 9, 14, 20].map((i) => (viz.levels[i] + viz.levels[i + 1]) / 2);
    drawBars($('miniViz'), m, color, 9, true);
  }
  if (S.open && S.view === 'main') drawBars($('bigViz'), viz.levels, color, 5, false);
}

// ============ Claude Code ============
function permCards() {
  return S.pending.map((p) => `<div class="perm-card">
      <div class="perm-top"><span class="c-icon warn">${icon('shield')}</span>
        <div class="perm-main"><div class="perm-title"><b>${esc(p.project)}</b> quiere ${esc(p.verb.toLowerCase())} <b>${esc(p.obj)}</b></div>
        ${p.detail ? `<code class="perm-detail">${esc(p.detail)}</code>` : ''}</div></div>
      <div class="perm-btns">
        <button class="pbtn no" data-perm="deny" data-id="${p.id}">${icon('x')}<span>Denegar</span></button>
        <button class="pbtn ok" data-perm="allow" data-id="${p.id}">${icon('check')}<span>Permitir</span></button>
      </div></div>`).join('');
}
function renderClaude() {
  const items = S.claude.filter((s) => s.status !== 'idle' || Date.now() - s.t < 10 * 60e3);
  const sessHtml = items.map((s) => {
    const st = { working: 'Trabajando', waiting: 'Esperando tu respuesta', done: 'Terminado', idle: 'En espera' }[s.status];
    const ico = s.status === 'done' ? `<span class="c-icon">${icon('check')}</span>` : `<span class="dot ${s.status}" ${s.status === 'idle' ? 'style="background:var(--sub)"' : ''}></span>`;
    return `<div class="cc ${s.status}">${ico}<div class="cc-main">
      <div class="cc-proj">${esc(s.project)} <span class="cc-state">· ${st}</span></div>
      <div class="cc-act">${esc(s.verb)} ${esc(s.obj)}</div>
      ${s.history && s.history.length > 1 ? `<div class="cc-hist">${s.history.slice(1, 4).map(esc).join('  ·  ')}</div>` : ''}
    </div></div>`;
  }).join('');
  $('claudeList').innerHTML = sessHtml || (S.pending.length ? '' : '<div class="empty">Sin sesiones de Claude Code activas.<br>Cuando Claude trabaje, pida permiso o termine, aparecerá aquí.</div>');
  const cards = permCards();
  $('permList').innerHTML = cards;
  $('permMain').innerHTML = cards;
  const busy = S.pending.length + S.claude.filter((s) => s.status === 'working' || s.status === 'waiting').length;
  $('ccBadge').textContent = busy || '';
  $('ccBadge').classList.toggle('warn', S.pending.length > 0);
  resize();
}
notch.onClaude((list) => { S.claude = list; renderClaude(); renderCompact(); });
notch.onClaudePending((list) => { S.pending = list; renderClaude(); renderCompact(); });
notch.onClaudeAlert(({ kind, session }) => {
  if (kind === 'Stop') {
    S.doneShownUntil[session.id] = Date.now() + 10000;
    setTimeout(() => { notch.claudeDismiss(session.id); renderCompact(); }, 10000);
    pulse('pulse-done');
    chime([659.25, 987.77]);
  } else {
    chime([523.25, 523.25]);
  }
  renderCompact();
});
document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-perm]'); if (!b) return;
  e.stopPropagation();
  notch.claudeDecide(b.dataset.id, b.dataset.perm);
}, true);

function pulse(cls) { island.classList.remove(cls); void island.offsetWidth; island.classList.add(cls); }
let actx = null;
function chime(notes) {
  if (S.cfg && S.cfg.chime === false) return;
  actx = actx || new AudioContext();
  notes.forEach((f, i) => {
    const o = actx.createOscillator(); const g = actx.createGain();
    o.type = 'sine'; o.frequency.value = f;
    const t = actx.currentTime + i * 0.14;
    g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(0.12, t + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.6);
    o.connect(g).connect(actx.destination); o.start(t); o.stop(t + 0.65);
  });
}

// ============ Tareas / recordatorios (home-dashboard) ============
function applyTodos(r) {
  S.todosOk = !!(r && r.ok);
  S.todos = (r && r.todos) || [];
  renderTodos(); renderCalendar(); renderCompact();
}
async function loadTodos() { applyTodos(await notch.todos()); }
function dueLabel(due) {
  const d = new Date(due); const now = new Date();
  const tom = new Date(now); tom.setDate(now.getDate() + 1);
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  if (d.toDateString() === now.toDateString()) return `Hoy ${time}`;
  if (d.toDateString() === tom.toDateString()) return `Mañana ${time}`;
  return `${d.toLocaleDateString('es-ES', { day: 'numeric', month: 'short' }).replace('.', '')} ${time}`;
}
function renderTodos() {
  const pendingT = S.todos.filter((t) => !t.done);
  $('taskBadge').textContent = pendingT.length || '';
  if (!S.todosOk) {
    $('tasks').innerHTML = `<div class="empty">No conecto con el agente del home-dashboard (${esc((S.cfg && S.cfg.homeServer) || '')}).<br>Arráncalo y vuelve a abrir esta pestaña.</div>`;
    resize(); return;
  }
  const now = Date.now();
  const sorted = [...S.todos].sort((a, b) => (a.done - b.done) || ((a.due || '9') < (b.due || '9') ? -1 : 1));
  $('tasks').innerHTML = sorted.slice(0, 8).map((t) => {
    const late = t.due && !t.done && new Date(t.due).getTime() < now;
    return `<div class="task ${t.done ? 'done' : ''}">
      <button class="check" data-todo-toggle="${esc(t.id)}">${t.done ? icon('check') : ''}</button>
      <span class="t-text">${esc(t.text)}</span>
      ${t.due ? `<span class="due ${late ? 'late' : ''}">${icon('alarm')}${esc(dueLabel(t.due))}</span>` : ''}
      <button class="icon-btn sm del" data-todo-del="${esc(t.id)}" title="Borrar">${icon('trash')}</button>
    </div>`;
  }).join('') + (sorted.length > 8 ? `<button class="more" id="openHome">${sorted.length - 8} más en el dashboard ${icon('ext')}</button>` : '')
    || '<div class="empty">Sin tareas. Añade una arriba; si le pones hora, el agente te avisará y aquí verás la cuenta atrás.</div>';
  resize();
}
$('taskForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const text = $('taskText').value.trim(); if (!text) return;
  const due = $('taskDue').value;
  $('taskText').value = ''; $('taskDue').value = '';
  applyTodos(await notch.todoAdd({ text, due }));
});
$('quickDue').addEventListener('click', (e) => {
  const b = e.target.closest('[data-in]'); if (!b) return;
  const d = new Date(); const v = b.dataset.in;
  if (v === 'none') { $('taskDue').value = ''; return; }
  if (v === 'tonight') { d.setHours(21, 0, 0, 0); if (d < new Date()) d.setDate(d.getDate() + 1); }
  else if (v === 'tomorrow') { d.setDate(d.getDate() + 1); d.setHours(9, 0, 0, 0); }
  else d.setMinutes(d.getMinutes() + Number(v));
  $('taskDue').value = localIso(d);
  startTyping($('taskText'));
});
$('quickTask').onclick = () => { setView('tasks'); startTyping($('taskText')); };
function checkReminders() {
  const now = Date.now();
  for (const t of S.todos) {
    if (t.done || !t.due) continue;
    const k = `${t.id}|${t.due}`;
    const ms = new Date(t.due).getTime();
    if (ms <= now && !S.remindAlerted.has(k)) {
      S.remindAlerted.add(k);
      if (now - ms < 2 * 60e3) { S.remindShow = { text: t.text, until: now + 60e3 }; pulse('pulse-wait'); chime([783.99, 659.25, 783.99]); }
    }
  }
  if (S.remindShow && S.remindShow.until < now) S.remindShow = null;
  if (now % 15000 < 1000) renderCompact();
}
setInterval(loadTodos, 30000);

// ============ Stats (agente del home-dashboard) ============
const gb = (v) => `${v.toFixed(1)} GB`;
const rate = (b) => fmtRate(b);
function meter(label, pct, value, sub) {
  return `<div class="meter"><div class="m-row"><span class="m-label">${label}</span><span class="m-val">${value}</span></div>
    <div class="m-bar"><span style="width:${Math.max(0, Math.min(100, pct))}%"></span></div>${sub ? `<div class="m-sub">${sub}</div>` : ''}</div>`;
}
async function loadStats() {
  const s = await notch.stats();
  if (S.view !== 'stats') return;
  if (!s) {
    $('stats').innerHTML = `<div class="empty">No conecto con el agente del home-dashboard (${esc((S.cfg && S.cfg.homeServer) || '')}).</div>`;
    resize(); return;
  }
  const up = s.uptime || 0;
  const cores = (s.cores || []).map((c) => `<span style="height:${Math.max(6, c)}%"></span>`).join('');
  const g = s.gpu || {};
  $('stats').innerHTML = `
    <div class="card st-cpu"><div class="st-big">${Math.round(s.cpu)}<small>%</small></div><div class="st-name">CPU · ${esc(s.threads)} hilos</div><div class="cores">${cores}</div></div>
    <div class="card st-col">
      ${meter('GPU', g.util || 0, `${g.util ?? '—'}%`, `${esc(g.name || '')}${g.temp != null ? ` · ${g.temp} °C` : ''}`)}
      ${g.vramTotal ? meter('VRAM', (g.vramUsed / g.vramTotal) * 100, `${gb(g.vramUsed)} / ${gb(g.vramTotal)}`) : ''}
      ${meter('RAM', (s.memUsed / s.memTotal) * 100, `${gb(s.memUsed)} / ${gb(s.memTotal)}`)}
    </div>
    <div class="card st-col">
      <div class="net"><span>↓ ${rate(s.down || 0)}</span><span>↑ ${rate(s.up || 0)}</span></div>
      ${(s.disks || []).slice(0, 3).map((d) => meter(esc(d.name), (d.used / d.total) * 100, `${Math.round(d.used)} / ${Math.round(d.total)} GB`)).join('')}
    </div>
    <div class="card st-top"><div class="st-h">Procesos</div>${(s.top || []).slice(0, 5).map((p) =>
      `<div class="proc"><span>${esc(p.name)}</span><span>${p.cpu.toFixed(1)}%</span><span>${(p.mem / 1024).toFixed(1)} GB</span></div>`).join('')}</div>
    <div class="st-foot"><span>${esc(s.host)} · ${esc(s.ip || '')} · encendido ${Math.floor(up / 3600)} h ${Math.floor((up % 3600) / 60)} min · ${esc(s.procs)} procesos</span>
      <button class="chip" id="openHome">Dashboard ${icon('ext')}</button></div>`;
  resize();
}
setInterval(() => { if (S.open && S.view === 'stats') loadStats(); }, 2000);

// ============ Bandeja del sistema ============
function trayLabel(t) {
  const tip = (t.tip || '').split(/\s[-–·:]\s|\n/)[0].trim();
  return tip || cap(t.exe || '');
}
function renderTray() {
  const items = [...S.tray].sort((a, b) => trayLabel(a).localeCompare(trayLabel(b), 'es'));
  const pins = (S.cfg && S.cfg.barTrayPins) || [];
  $('trayGrid').innerHTML = items.map((t) => `<button class="tray-item ${pins.includes(t.pin) ? 'pinned' : ''}" data-tray="${esc(t.key)}" title="${esc(t.tip || t.exe)}">
      <span class="pin-btn" data-pin="${esc(t.pin)}" title="${pins.includes(t.pin) ? 'Quitar de la barra' : 'Fijar en la barra'}">${icon('pin')}</span>
      ${t.icon ? `<img src="${t.icon}" alt="">` : `<span class="tray-noicon">${esc((t.exe || '?').slice(0, 1).toUpperCase())}</span>`}
      <span class="tray-name">${esc(trayLabel(t))}</span></button>`).join('')
    || '<div class="empty">Cargando iconos de la bandeja…<br>Si no aparece ninguno, revisa que "tray" esté activado en config.json.</div>';
  resize();
}
let trayTimer = 0;
// Chincheta: fija / quita el icono de la barra (y no abre la app)
$('trayGrid').addEventListener('click', async (e) => {
  const p = e.target.closest('[data-pin]'); if (!p) return;
  e.stopPropagation(); e.preventDefault();
  const pin = p.dataset.pin; if (!pin) return;
  const cur = (S.cfg.barTrayPins || []).slice();
  const i = cur.indexOf(pin);
  if (i >= 0) cur.splice(i, 1); else cur.push(pin);
  S.cfg.barTrayPins = await notch.setPins(cur);
  renderTray(); renderBarTray();
}, true);
$('trayGrid').addEventListener('dblclick', (e) => { if (e.target.closest('[data-pin]')) e.stopPropagation(); }, true);
$('trayGrid').addEventListener('click', (e) => {
  const b = e.target.closest('[data-tray]'); if (!b) return;
  clearTimeout(trayTimer);
  trayTimer = setTimeout(() => { notch.trayClick(b.dataset.tray, 'left'); setOpen(false); }, 260);
});
$('trayGrid').addEventListener('dblclick', (e) => {
  const b = e.target.closest('[data-tray]'); if (!b) return;
  clearTimeout(trayTimer);
  notch.trayClick(b.dataset.tray, 'double'); setOpen(false);
});
$('trayGrid').addEventListener('contextmenu', (e) => {
  const b = e.target.closest('[data-tray]'); if (!b) return;
  e.preventDefault(); e.stopPropagation();
  notch.trayClick(b.dataset.tray, 'right'); setOpen(false);
}, true);

// ============ Pregúntale a Claude ============
function renderAsk(streaming) {
  const log = $('askLog');
  const items = S.ask.slice(-4);
  log.innerHTML = items.map((m) => `<div class="msg ${m.role}">${esc(m.text)}</div>`).join('')
    + (S.asking ? `<div class="msg claude pending">${streaming ? esc(streaming) : '<span class="typing"><i></i><i></i><i></i></span>'}</div>` : '');
  log.style.display = items.length || S.asking ? '' : 'none';
  log.scrollTop = log.scrollHeight;
  resize();
}
notch.onClaudeAskChunk((txt) => { if (S.asking) renderAsk(txt); });
$('askForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const q = $('askText').value.trim(); if (!q || S.asking) return;
  $('askText').value = '';
  const history = S.ask.slice();
  S.ask.push({ role: 'user', text: q }); S.asking = true; renderAsk();
  const r = await notch.claudeAsk(q, history);
  S.asking = false;
  S.ask.push({ role: 'claude', text: r.text || (r.ok ? '(sin respuesta)' : 'No se pudo preguntar a Claude.'), error: !r.ok });
  renderAsk();
});
$('askClear').onclick = () => { S.ask = []; renderAsk(); };

// ============ Barra lateral ============
let barStats = null;
// El agente del home-dashboard da bytes por segundo.
function fmtRate(b) { return b >= 1048576 ? `${(b / 1048576).toFixed(1)} MB/s` : `${Math.round(b / 1024)} KB/s`; }
let lastBarExe = null;
function renderBar() {
  const w = S.sys.win || {};
  $('barWinTitle').textContent = (w.title || '').replace(/\s+[—–-]\s+(Mozilla Firefox|Google Chrome|Brave|Microsoft Edge|Visual Studio Code|Discord)$/, '');
  $('barWinTitle').parentElement.title = w.title || '';
  if (w.exe !== lastBarExe) {
    lastBarExe = w.exe;
    notch.fileIcon(w.exe).then((url) => { if (lastBarExe === w.exe) $('barWinIcon').src = url || ''; });
  }
  // Media
  const m = S.media;
  const mb = $('barMedia');
  mb.hidden = !m;
  if (m) {
    const art = S.thumbs[m.key];
    $('barArt').src = art || ''; $('barArt').hidden = !art;
    $('barMediaTxt').innerHTML = `${m.playing ? '' : `<span class="paused">${icon('pause')}</span>`}${esc(m.title || '')}<span class="sub"> · ${esc(m.artist || appName(m.app))}</span>`;
    mb.classList.toggle('paused-state', !m.playing);
  }
  // Volumen e idioma
  const v = S.sys.mute ? 0 : S.sys.vol;
  $('barVol').innerHTML = `${icon(S.sys.mute ? 'volx' : 'vol')}<span>${S.sys.mute ? 'Mudo' : Math.round(v * 100) + '%'}</span>`;
  $('barLang').textContent = S.sys.lang || '—';
  scheduleFit();
}
// ---- Que nada se solape: si no cabe, se ocultan cosas por prioridad ----
let fitRaf = 0;
function scheduleFit() { cancelAnimationFrame(fitRaf); fitRaf = requestAnimationFrame(fitBar); }
function fitBar() {
  const right = document.querySelector('.bar-right');
  const trayItems = [...$('barTray').querySelectorAll('.bar-tray-item:not(.more-tray)')];
  const steps = [$('barNet'), $('barStats'), $('barMediaTxt')];
  [...steps, ...trayItems].forEach((el) => el.classList.remove('fit-hidden'));
  const over = () => right.scrollWidth > right.clientWidth + 1;
  for (const el of steps) { if (!over()) return; el.classList.add('fit-hidden'); }
  for (let i = trayItems.length - 1; i >= 0 && over(); i--) trayItems[i].classList.add('fit-hidden');
}
window.addEventListener('resize', scheduleFit);

function renderBarStats() {
  const s = barStats;
  $('barStats').hidden = !s; $('barNet').hidden = !s;
  if (!s) return;
  const g = s.gpu || {};
  const part = (k, v) => `<span class="st"><span class="k">${k}</span>${Math.round(v)}%</span>`;
  $('barStats').innerHTML = part('CPU', s.cpu) + part('RAM', (s.memUsed / s.memTotal) * 100) + (g.util != null ? part('GPU', g.util) : '');
  $('barNet').innerHTML = `<span class="st"><span class="k">↓</span>${fmtRate(s.down || 0)}</span><span class="st"><span class="k">↑</span>${fmtRate(s.up || 0)}</span>`;
  $('barNet').title = `${s.iface || 'Red'} · ${s.ip || ''}${s.linkMbps ? ` · ${s.linkMbps} Mbps` : ''}`;
  scheduleFit();
}
async function pollBarStats() { barStats = await notch.stats(); renderBarStats(); }
setInterval(pollBarStats, 3000);
function renderBarTray() {
  // Solo los que has fijado (en el orden en que los fijaste); la flecha abre la bandeja completa.
  const pins = (S.cfg && S.cfg.barTrayPins) || [];
  const shown = pins.map((p) => S.tray.find((t) => t.pin === p)).filter(Boolean);
  $('barTray').innerHTML = shown.map((t) => `<button class="bar-tray-item" data-tray="${esc(t.key)}" title="${esc(t.tip || t.exe)}">${t.icon ? `<img src="${t.icon}" alt="">` : esc((t.exe || '?')[0])}</button>`).join('')
    + `<button class="bar-tray-item more-tray" data-open-view="tray" title="Bandeja (${S.tray.length}) · fija aquí los que quieras">${icon('chevron')}</button>`;
  scheduleFit();
}
// Clics en la barra
let barTrayTimer = 0;
$('barTray').addEventListener('click', (e) => {
  const b = e.target.closest('[data-tray]'); if (!b) return;
  clearTimeout(barTrayTimer);
  barTrayTimer = setTimeout(() => notch.trayClick(b.dataset.tray, 'left'), 260);
});
$('barTray').addEventListener('dblclick', (e) => {
  const b = e.target.closest('[data-tray]'); if (!b) return;
  clearTimeout(barTrayTimer); notch.trayClick(b.dataset.tray, 'double');
});
$('bar').addEventListener('contextmenu', (e) => {
  e.preventDefault(); e.stopPropagation();
  if (e.target.closest('#barVol')) { togglePop('mixer'); return; }
  const b = e.target.closest('[data-tray]');
  if (b) notch.trayClick(b.dataset.tray, 'right'); else notch.contextMenu();
}, true);
$('bar').addEventListener('click', (e) => {
  const b = e.target.closest('[data-open-view]'); if (!b) return;
  e.stopPropagation();
  setTimeout(() => { setOpen(true); setView(b.dataset.openView); }, 0);
}, true);
$('barMedia').onclick = () => notch.native({ cmd: 'media', action: 'toggle' });
$('barMedia').addEventListener('auxclick', (e) => { if (e.button === 1) notch.native({ cmd: 'media', action: 'next' }); });
$('barVol').onclick = () => togglePop('devices');
$('barVol').addEventListener('auxclick', (e) => { if (e.button === 1) notch.native({ cmd: 'mute' }); }); // clic central: silenciar

// ============ Desplegable de audio ============
S.devices = []; S.sessions = []; S.pop = null;
const sessIcons = new Map();
let popTimer = 0, popDrag = false;
function togglePop(kind) { if (S.pop === kind) closePop(); else openPop(kind); }
function openPop(kind) {
  if (S.open) setOpen(false);
  S.pop = kind;
  notch.native({ cmd: kind === 'devices' ? 'devices' : 'sessions' });
  clearInterval(popTimer);
  if (kind === 'mixer') popTimer = setInterval(() => { if (!popDrag) notch.native({ cmd: 'sessions' }); }, 1500);
  renderPop();
  notch.panelOpen(true);
}
function closePop() {
  if (!S.pop) return;
  S.pop = null; clearInterval(popTimer);
  $('pop').hidden = true;
  notch.panelOpen(S.open);
  lastShape = ''; sendShape(shapeW, shapeH);
}
function masterRow() {
  const v = S.sys.mute ? 0 : S.sys.vol;
  return `<div class="pop-row master">
    <button class="icon-btn sm" data-pop-mute="master" title="Silenciar">${icon(S.sys.mute ? 'volx' : 'vol')}</button>
    <input type="range" min="0" max="100" value="${Math.round(v * 100)}" data-pop-vol="master" style="--v:${Math.round(v * 100)}%">
    <span class="pct">${Math.round(v * 100)}%</span></div>`;
}
function renderPop() {
  const el = $('pop');
  if (!S.pop) { el.hidden = true; return; }
  let html;
  if (S.pop === 'devices') {
    html = `<div class="pop-title">Salida de audio</div>${masterRow()}<div class="pop-sep"></div>`
      + (S.devices.map((d) => `<button class="pop-dev ${d.def ? 'on' : ''}" data-dev="${esc(d.id)}">${icon('speaker')}<span>${esc(d.name)}</span>${d.def ? icon('check') : ''}</button>`).join('')
        || '<div class="pop-empty">Buscando salidas…</div>')
      + `<div class="pop-hint">Clic derecho en el volumen: mezclador por aplicación</div>`;
  } else {
    const own = (x) => /node_modules\\electron\\dist\\electron\.exe$/i.test(x.exe || '');
    const list = S.sessions.filter((x) => !own(x));
    html = `<div class="pop-title">Mezclador</div>${masterRow()}<div class="pop-sep"></div>`
      + (list.map((x) => {
        const v = Math.round((x.mute ? 0 : x.vol) * 100);
        const ic = sessIcons.get(x.exe);
        return `<div class="pop-row">
          <span class="pop-app">${ic ? `<img src="${ic}" alt="">` : icon(x.sys ? 'bell' : 'music')}</span>
          <div class="pop-app-main"><div class="pop-name">${esc(x.name)}</div>
            <input type="range" min="0" max="100" value="${v}" data-sess="${esc(x.key)}" style="--v:${v}%" class="${x.mute ? 'muted' : ''}"></div>
          <button class="icon-btn sm ${x.mute ? 'on' : ''}" data-sess-mute="${esc(x.key)}" data-muted="${x.mute ? 1 : 0}" title="Silenciar">${icon(x.mute ? 'volx' : 'vol')}</button>
          <span class="pct">${x.mute ? '—' : v + '%'}</span></div>`;
      }).join('') || '<div class="pop-empty">Ninguna aplicación está usando el audio.</div>');
    list.forEach((x) => { if (x.exe && !sessIcons.has(x.exe)) { sessIcons.set(x.exe, null); notch.fileIcon(x.exe).then((u) => { sessIcons.set(x.exe, u); if (S.pop === 'mixer' && !popDrag) renderPop(); }); } });
  }
  el.innerHTML = html;
  el.hidden = false;
  // Colocarlo bajo el icono del volumen, sin salirse de la pantalla
  const a = $('barVol').getBoundingClientRect();
  const w = el.offsetWidth;
  el.style.left = `${Math.max(8, Math.min(window.innerWidth - w - 8, a.right - w))}px`;
  requestAnimationFrame(() => { lastShape = ''; sendShape(shapeW, shapeH); });
}
notch.onNative((m) => {
  if (m.type === 'devices') { S.devices = m.list || []; if (S.pop === 'devices') renderPop(); }
  if (m.type === 'sessions') { S.sessions = m.list || []; if (S.pop === 'mixer' && !popDrag) renderPop(); }
});
const popEl = $('pop');
popEl.addEventListener('click', (e) => {
  const d = e.target.closest('[data-dev]');
  if (d) { notch.native({ cmd: 'setdevice', id: d.dataset.dev }); S.devices.forEach((x) => { x.def = x.id === d.dataset.dev; }); renderPop(); return; }
  if (e.target.closest('[data-pop-mute]')) { notch.native({ cmd: 'mute' }); return; }
  const m = e.target.closest('[data-sess-mute]');
  if (m) { const muted = m.dataset.muted === '1'; notch.native({ cmd: 'sessset', key: m.dataset.sessMute, mute: !muted }); setTimeout(() => notch.native({ cmd: 'sessions' }), 150); }
});
let popLast = 0;
popEl.addEventListener('pointerdown', (e) => { if (e.target.matches('input[type=range]')) popDrag = true; });
window.addEventListener('pointerup', () => { if (popDrag) setTimeout(() => { popDrag = false; }, 400); });
popEl.addEventListener('input', (e) => {
  const r = e.target; if (!r.matches('input[type=range]')) return;
  r.style.setProperty('--v', `${r.value}%`);
  const pct = r.closest('.pop-row').querySelector('.pct'); if (pct) pct.textContent = `${r.value}%`;
  const now = Date.now(); if (now - popLast < 40) return; popLast = now;
  if (r.dataset.popVol) notch.native({ cmd: 'vol', v: r.value / 100 });
  else notch.native({ cmd: 'sessset', key: r.dataset.sess, v: r.value / 100 });
});
popEl.addEventListener('change', (e) => {
  const r = e.target; if (!r.matches('input[type=range]')) return;
  if (r.dataset.popVol) notch.native({ cmd: 'vol', v: r.value / 100 });
  else notch.native({ cmd: 'sessset', key: r.dataset.sess, v: r.value / 100, mute: false });
});
const volWheel = (e) => {
  const v = Math.max(0, Math.min(1, S.sys.vol + (e.deltaY < 0 ? 0.02 : -0.02)));
  S.sys.vol = v; S.sys.mute = false; notch.native({ cmd: 'vol', v }); renderBar(); showHud();
};
$('barVol').addEventListener('wheel', volWheel, { passive: true });
$('barLang').onclick = () => {
  if (!S.layouts.length) return;
  const i = S.layouts.findIndex((l) => l.code === S.sys.lang);
  switchLayout(S.layouts[(i + 1) % S.layouts.length]);
};
// Cambio de idioma: se pide al helper y se pinta ya, sin esperar a que el sistema lo confirme
let langPending = null;
function switchLayout(l) {
  if (!l) return;
  notch.native({ cmd: 'layout', hkl: l.hkl });
  langPending = { code: l.code, name: l.name, until: Date.now() + 2000 };
  S.sys = { ...S.sys, lang: l.code, langName: l.name };
  renderBar(); renderLayouts();
}

// ============ Energía / tema / acciones ============
async function loadPlans() { renderPlans(await notch.powerPlans()); }
function renderPlans(plans) {
  $('plans').innerHTML = plans.map((p) => `<button class="chip ${p.active ? 'active' : ''}" data-plan="${p.guid}">${esc(p.name)}</button>`).join('');
  const a = plans.find((p) => p.active);
  $('planLabel').textContent = a ? a.name : 'Energía';
  resize();
}
async function refreshTheme() {
  const light = await notch.themeGet();
  $('themeBtn').querySelector('i').dataset.icon = light ? 'sun' : 'moon';
  $('themeBtn').querySelector('span').textContent = light ? 'Claro' : 'Oscuro';
  hydrateIcons($('themeBtn'));
}
$('themeBtn').onclick = async () => { await notch.themeToggle(); refreshTheme(); };

const confirmNeeded = new Set(['signout', 'restart', 'shutdown']);
document.addEventListener('click', async (e) => {
  const b = e.target.closest('button'); if (!b || b.dataset.perm) return;
  const d = b.dataset;
  if (b.id === 'openHome') { notch.openHome(); setOpen(false); return; }
  if (d.view) setView(d.view);
  if (d.uri) { notch.openUri(d.uri); setOpen(false); }
  if (d.launch) { notch.launch(d.launch); setOpen(false); }
  if (d.folder !== undefined) { notch.openFolder(+d.folder); setOpen(false); }
  if (d.plan) renderPlans(await notch.setPowerPlan(d.plan));
  if (d.hkl) switchLayout(S.layouts.find((l) => l.hkl === d.hkl));
  if (d.todoToggle) applyTodos(await notch.todoToggle(d.todoToggle));
  if (d.todoDel) applyTodos(await notch.todoDelete(d.todoDel));
  if (d.power) {
    if (confirmNeeded.has(d.power) && !b.classList.contains('confirm')) {
      const span = b.querySelector('span'); const orig = span.textContent;
      b.classList.add('confirm'); span.textContent = '¿Seguro?';
      setTimeout(() => { b.classList.remove('confirm'); span.textContent = orig; }, 3000);
      return;
    }
    notch.power(d.power); setOpen(false);
  }
});

// ============ Inicio ============
(async () => {
  S.cfg = await notch.config();
  $('label').textContent = S.cfg.label || '秋田';
  $('barLabel').textContent = S.cfg.label || '秋田';
  // Borde para OLED: rim (true/false) y rimStrength (0 = invisible, 1 = normal, 2 = más marcado).
  if (S.cfg.rim === false) $('shell').classList.add('no-rim');
  $('shell').style.setProperty('--rim-k', String(S.cfg.rimStrength ?? 1));
  $('folderTiles').innerHTML = (S.cfg.folders || []).map((f, i) =>
    `<button class="tile" data-folder="${i}"><i data-icon="folder"></i><span>${esc(f.title)}</span></button>`).join('');
  hydrateIcons();
  setView('main');
  tick(); renderCalendar(); renderMedia(); renderCompact(); refreshTheme(); loadPlans();
  S.claude = await notch.claudeSessions();
  S.pending = await notch.claudePending();
  renderClaude();
  await loadTodos();
  // No avisar al arrancar de recordatorios que ya pasaron.
  for (const t of S.todos) if (t.due && new Date(t.due).getTime() <= Date.now()) S.remindAlerted.add(`${t.id}|${t.due}`);
  renderAsk(); renderTray(); renderBar(); pollBarStats();
  startViz();
  resize();
})();

// Bandeja: volver a pedir los iconos a todas las apps (por si alguno no llegó)
$('trayRescan').addEventListener('click', (e) => { e.preventDefault(); notch.native({ cmd: 'trayrescan' }); });

// ============ Buscador (Alt+S por defecto) ============
// Apps del menú Inicio, juegos de Steam y archivos del índice de Windows. Las apps y juegos se filtran
// aquí al instante; los archivos se piden al buscador del sistema con una pequeña espera al teclear.
const LS = { idx: { apps: [], games: [], usage: {} }, files: [], fileQ: '', sel: 0, items: [], seq: 0, timer: 0 };
const lsInput = $('lsInput'), lsList = $('lsList');
const lsNorm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
// Puntuación de una palabra contra un nombre: exacto > empieza > empieza palabra > iniciales > contiene > salteado
function lsWordScore(n, words, q) {
  if (n === q) return 1000;
  if (n.startsWith(q)) return 800 - n.length;
  if (words.some((w) => w.startsWith(q))) return 600 - n.length;
  if (q.length >= 2 && words.map((w) => w[0]).join('').startsWith(q)) return 550;
  const i = n.indexOf(q); return i >= 0 ? 400 - i : -1;
}
function lsScore(name, terms) {
  const n = lsNorm(name), words = n.split(/[\s\-_.()]+/).filter(Boolean);
  let total = 0;
  for (const t of terms) { const s = lsWordScore(n, words, t); if (s < 0) return -1; total += s; }
  return total;
}
const lsKey = (it) => `${it.type}:${it.id || it.path}`;
function lsCandidates(q) {
  const terms = lsNorm(q).split(/\s+/).filter(Boolean);
  const use = LS.idx.usage || {};
  const pool = [
    ...(LS.idx.games || []).map((g) => ({ type: 'game', id: g.id, name: g.name, icon: g.icon, sub: 'Juego · Steam' })),
    ...(LS.idx.apps || []).map((a) => ({ type: 'app', id: a.id, name: a.name, icon: a.icon, sub: a.id.includes('!') ? 'App · Microsoft Store' : 'App' })),
  ];
  if (!terms.length) { // sin texto: lo que más usas
    return pool.filter((it) => use[lsKey(it)]).sort((a, b) => use[lsKey(b)] - use[lsKey(a)]).slice(0, 8);
  }
  const scored = [];
  for (const it of pool) {
    const s = lsScore(it.name, terms);
    if (s >= 0) scored.push([s + Math.min(use[lsKey(it)] || 0, 20) * 25 + (it.type === 'game' ? 30 : 0), it]);
  }
  scored.sort((a, b) => b[0] - a[0]);
  const seen = new Set(); const out = [];
  for (const [, it] of scored) { const k = lsNorm(it.name); if (seen.has(k)) continue; seen.add(k); out.push(it); if (out.length >= 7) break; }
  return out;
}
function lsHighlight(name, q) {
  const terms = lsNorm(q).split(/\s+/).filter(Boolean); const n = lsNorm(name);
  const chars = [...name];
  const mark = new Array(chars.length).fill(false);
  if (n.length === chars.length) for (const t of terms) { const i = n.indexOf(t); if (i >= 0) for (let k = i; k < i + t.length; k++) mark[k] = true; }
  let html = '', open = false;
  chars.forEach((ch, k) => { if (mark[k] !== open) { html += mark[k] ? '<b>' : '</b>'; open = mark[k]; } html += esc(ch); });
  return html + (open ? '</b>' : '');
}
const lsFileIcons = new Map();
function renderLS() {
  const q = lsInput.value, qt = q.trim();
  const apps = lsCandidates(q);
  const files = qt.length >= 2 && LS.fileQ === qt
    ? LS.files.slice(0, Math.max(3, 9 - apps.length)).map((f) => ({ type: 'file', path: f.path, name: f.name, dir: f.dir, sub: f.path }))
    : [];
  LS.items = [...apps, ...files];
  if (LS.sel >= LS.items.length) LS.sel = Math.max(0, LS.items.length - 1);
  if (!LS.items.length) {
    const msg = !qt ? 'Escribe para buscar apps, juegos y archivos' : (qt.length >= 2 && LS.fileQ !== qt ? 'Buscando…' : 'Sin resultados');
    lsList.innerHTML = `<div class="ls-empty">${msg}</div>`;
    return;
  }
  let lastGroup = '';
  lsList.innerHTML = LS.items.map((it, i) => {
    const group = it.type === 'file' ? 'Archivos y carpetas' : (qt ? 'Apps y juegos' : 'Lo que más usas');
    const head = group !== lastGroup ? `<div class="ls-group">${group}</div>` : ''; lastGroup = group;
    const img = it.icon ? `<img src="${esc(it.icon)}" alt="">`
      : it.type === 'file' ? `<img data-ficon="${esc(it.path)}" alt="" hidden><i class="ls-gly">${icon(it.dir ? 'folder' : 'file')}</i>`
      : `<i class="ls-gly">${icon(it.type === 'game' ? 'game' : 'grid')}</i>`;
    return `${head}<button class="ls-item${i === LS.sel ? ' sel' : ''}" data-i="${i}">${img}<span class="ls-txt"><span class="ls-name">${lsHighlight(it.name, q)}</span><span class="ls-sub">${esc(it.sub)}</span></span><span class="ls-kbd">Enter</span></button>`;
  }).join('');
  // Iconos reales de archivos y carpetas (los da el sistema; se guardan en caché)
  lsList.querySelectorAll('img[data-ficon]').forEach((img) => {
    const p = img.dataset.ficon;
    const show = (url) => { if (url) { img.src = url; img.hidden = false; if (img.nextElementSibling) img.nextElementSibling.remove(); } };
    if (lsFileIcons.has(p)) show(lsFileIcons.get(p));
    else notch.fileIcon(p).then((url) => { lsFileIcons.set(p, url); if (img.isConnected) show(url); });
  });
  const sel = lsList.querySelector('.ls-item.sel'); if (sel) sel.scrollIntoView({ block: 'nearest' });
}
function lsQueryFiles() {
  const q = lsInput.value.trim();
  clearTimeout(LS.timer);
  if (q.length < 2) { LS.files = []; LS.fileQ = q; return; }
  LS.timer = setTimeout(async () => {
    const id = ++LS.seq;
    const list = await notch.launcherFiles(q);
    if (id !== LS.seq) return; // llegó tarde: ya hay otra búsqueda en marcha
    LS.files = list; LS.fileQ = q; renderLS();
  }, 140);
}
function lsOpen(i, reveal) {
  const it = LS.items[i]; if (!it) return;
  if (reveal && it.type === 'file') notch.launcherReveal(it.path);
  else notch.launcherOpen({ type: it.type, id: it.id, path: it.path });
  const k = lsKey(it); LS.idx.usage = LS.idx.usage || {}; LS.idx.usage[k] = (LS.idx.usage[k] || 0) + 1;
  setOpen(false);
}
lsInput.addEventListener('input', () => { LS.sel = 0; renderLS(); lsQueryFiles(); });
lsInput.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowDown' || (e.key === 'Tab' && !e.shiftKey)) { e.preventDefault(); LS.sel = Math.min(LS.items.length - 1, LS.sel + 1); renderLS(); }
  else if (e.key === 'ArrowUp' || (e.key === 'Tab' && e.shiftKey)) { e.preventDefault(); LS.sel = Math.max(0, LS.sel - 1); renderLS(); }
  else if (e.key === 'Enter') { e.preventDefault(); lsOpen(LS.sel, e.ctrlKey); }
});
lsList.addEventListener('click', (e) => { const b = e.target.closest('.ls-item'); if (b) lsOpen(+b.dataset.i, e.ctrlKey); });
lsList.addEventListener('mousemove', (e) => {
  const b = e.target.closest('.ls-item'); if (!b || +b.dataset.i === LS.sel) return;
  LS.sel = +b.dataset.i; lsList.querySelectorAll('.ls-item').forEach((x) => x.classList.toggle('sel', x === b));
});
async function lsLoadIndex() { try { LS.idx = await notch.launcherIndex(); } catch {} if (S.view === 'search') renderLS(); }
notch.onLauncherIndex((idx) => { LS.idx = { ...idx, usage: LS.idx.usage || {} }; if (S.view === 'search') renderLS(); });
notch.onLauncher(() => { if (S.open && S.view === 'search') setOpen(false); else { setOpen(true); setView('search'); } });
lsLoadIndex();
notch.config().then((c) => { $('lsKey').textContent = (c && c.launcherHotkey) || 'Alt+S'; });
