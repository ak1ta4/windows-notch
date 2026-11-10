// Hook de Claude Code -> notch (127.0.0.1:47321).
// - Eventos normales: los reenvía y sale enseguida.
// - PermissionRequest: espera a que pulses Permitir/Denegar en el notch y se lo dice a Claude.
//   Si el notch no está abierto, no respondes a tiempo o contestas en la terminal, no decide nada
//   y Claude muestra su diálogo de siempre.
// Nunca bloquea a Claude: ante cualquier error sale con código 0 sin decidir.
const http = require('http');

// Las preguntas hechas desde el propio notch (claude -p) no se muestran como sesiones.
if (process.env.AKITA_NOTCH_CHILD) process.exit(0);

const done = (out) => { if (out) process.stdout.write(JSON.stringify(out)); process.exit(0); };
let raw = '';
process.stdin.on('data', (c) => { raw += c; });
process.stdin.on('end', () => {
  let ev; try { ev = JSON.parse(raw); } catch { return done(); }
  const perm = ev.hook_event_name === 'PermissionRequest';
  // Solo lo necesario: nada de salidas de herramientas ni contenido de archivos.
  const i = ev.tool_input || {};
  const body = JSON.stringify({
    hook_event_name: ev.hook_event_name, session_id: ev.session_id, cwd: ev.cwd,
    tool_name: ev.tool_name, message: ev.message, notification_type: ev.notification_type,
    tool_input: {
      file_path: i.file_path, notebook_path: i.notebook_path,
      command: i.command ? String(i.command).slice(0, perm ? 300 : 80) : undefined,
      pattern: i.pattern, url: i.url, query: i.query, description: i.description,
    },
  });
  const req = http.request({
    host: '127.0.0.1', port: 47321, path: perm ? '/cc/permission' : '/cc', method: 'POST',
    timeout: perm ? 115000 : 400,
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
  }, (res) => {
    if (!perm) return done();
    let out = '';
    res.on('data', (c) => { out += c; });
    res.on('end', () => {
      let decision = null; try { decision = JSON.parse(out).decision; } catch {}
      if (decision === 'allow') return done({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } });
      if (decision === 'deny') return done({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'deny', message: 'Denegado desde el notch' } } });
      done();
    });
  });
  req.on('error', () => done());
  req.on('timeout', () => { req.destroy(); done(); });
  req.end(body);
  setTimeout(() => done(), perm ? 117000 : 1500);
});
