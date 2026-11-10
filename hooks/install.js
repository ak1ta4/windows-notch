// Añade (o actualiza) los hooks del notch en ~/.claude/settings.json.
// La primera vez guarda una copia en settings.json.bak-notch (no la vuelve a pisar).
const fs = require('fs'); const path = require('path'); const os = require('os');
const file = path.join(os.homedir(), '.claude', 'settings.json');
const cmd = `node "${path.join(__dirname, 'cc-hook.js').split(path.sep).join('/')}"`;
let s = {};
if (fs.existsSync(file)) {
  if (!fs.existsSync(file + '.bak-notch')) fs.copyFileSync(file, file + '.bak-notch');
  s = JSON.parse(fs.readFileSync(file, 'utf8'));
}
s.hooks = s.hooks || {};
// [usa matcher, timeout en segundos]
const events = {
  SessionStart: [false, 5], UserPromptSubmit: [false, 5], PreToolUse: [true, 5], PostToolUse: [true, 5],
  Notification: [false, 5], Stop: [false, 5], SessionEnd: [false, 5],
  PermissionRequest: [true, 120], // espera tu respuesta en el notch
};
const isOurs = (h) => /cc-hook\.js/.test(h.command || '');
for (const [ev, [matcher, timeout]] of Object.entries(events)) {
  const list = s.hooks[ev] = s.hooks[ev] || [];
  // Quita entradas antiguas del notch (otra ruta u otro timeout) y deja una sola actualizada.
  for (const g of list) g.hooks = (g.hooks || []).filter((h) => !isOurs(h));
  s.hooks[ev] = list.filter((g) => g.hooks.length);
  s.hooks[ev].push({ ...(matcher ? { matcher: '*' } : {}), hooks: [{ type: 'command', command: cmd, timeout }] });
}
fs.mkdirSync(path.dirname(file), { recursive: true });
fs.writeFileSync(file, JSON.stringify(s, null, 2));
console.log('Hooks del notch actualizados en', file);
