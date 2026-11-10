# windows-notch

Un **notch tipo "Dynamic Island" para Windows 11** que sustituye a barras como YASB. Es una franja negra a todo
el ancho de la parte superior de la pantalla con una isla en el centro que muestra la hora y se expande en un panel
con reproductor, bandeja del sistema, estadísticas, tareas, buscador de apps y una integración con
[Claude Code](https://claude.com/claude-code) que permite aprobar sus permisos desde la propia isla.

Pensado para pantallas OLED (negro puro con un borde sutil) y para convivir con el gestor de ventanas en mosaico
[GlazeWM](https://github.com/glzr-io/glazewm).

Hecho con **Electron** y un helper nativo en **Windows PowerShell 5.1** (C# compilado al vuelo con WinRT, CoreAudio
y Win32). No necesita compilar nada ni instalar herramientas de desarrollo: solo Node.js.

---

## Índice
- [Qué hace](#qué-hace)
- [Requisitos](#requisitos)
- [Instalación](#instalación)
- [Uso](#uso)
- [Configuración](#configuración)
- [Integración con Claude Code](#integración-con-claude-code)
- [Cómo funciona por dentro](#cómo-funciona-por-dentro)
- [Estructura del proyecto](#estructura-del-proyecto)
- [Solución de problemas](#solución-de-problemas)
- [Limitaciones conocidas](#limitaciones-conocidas)
- [Licencia](#licencia)

---

## Qué hace

### Barra
Ocupa la franja superior del monitor principal y **reserva ese espacio** como lo haría la barra de tareas, así que
las ventanas maximizadas o en mosaico se colocan debajo.

| Zona | Contenido |
|------|-----------|
| Izquierda | Etiqueta (menú de carpetas, apps y energía) y título de la ventana activa con su icono |
| Centro | La isla (hora y fecha, o lo que esté pasando) |
| Derecha | Lo que suena · CPU/RAM/GPU · velocidad de red · iconos de bandeja fijados · volumen · idioma del teclado |

- **Volumen**: clic → elegir la salida de audio predeterminada · clic derecho → mezclador con el volumen de cada
  aplicación · rueda → volumen general · clic central → silenciar.
- **Multimedia**: clic → reproducir / pausar · clic central → siguiente.
- **Iconos de bandeja**: solo los que fijes con la chincheta en la pestaña Bandeja.
- Si no cabe todo, se van ocultando por prioridad (red, estadísticas, texto de la canción, iconos).

### Isla (compacta)
- Hora y fecha.
- Carátula y visualizador de audio cuando suena algo.
- HUD al cambiar el volumen.
- Estado de Claude Code (trabajando / necesita algo / listo) y **botones ✓ ✕ para sus permisos**.
- Recordatorios que vencen pronto, con aviso y sonido.
- Rueda: volumen · clic central: play/pausa · clic: abrir el panel.

### Panel expandido (pestañas)
| Pestaña | Contenido |
|---------|-----------|
| 🔍 Buscar | Buscador de apps, juegos y archivos (ver abajo) |
| Inicio | Reproductor con carátula y barra de progreso, calendario, volumen y micro, captura, tema claro/oscuro, plan de energía |
| Sistema | CPU por núcleo, GPU, VRAM, RAM, red, discos y procesos |
| Bandeja | Todos los iconos de la bandeja del sistema; clic, doble clic y clic derecho funcionan como en la barra de tareas |
| Tareas | Lista de tareas con recordatorios (+15 min, +1 h, esta noche, mañana) |
| Claude | "Pregúntale a Claude", permisos pendientes y sesiones activas |

El panel se cierra al hacer clic fuera o con Esc.

### Buscador (Ctrl+Q)
Un lanzador al estilo Spotlight/Flow Launcher dentro del notch:
- **Apps** del menú Inicio, incluidas las de Microsoft Store, con su icono real.
- **Juegos de Steam** de todas tus bibliotecas.
- **Archivos y carpetas** del índice de Windows Search.
- ↑↓ o Tab para elegir, Enter para abrir, Ctrl+Enter para abrir la carpeta de un archivo, Esc para cerrar.
- Busca por palabras en cualquier orden, sin importar tildes, y entiende iniciales (`lol` → League of Legends).
- Sin texto muestra lo que más usas; lo que abres a menudo sube en los resultados.

### Convivencia con el sistema
- **No roba el foco**: los clics llegan sin activar la ventana; solo acepta teclado mientras escribes.
- **Pantalla completa**: se aparta cuando un juego o vídeo ocupa el monitor principal (también al hacer Alt+Tab).
- **GlazeWM**: no la gestiona ni la oculta al cambiar de escritorio (ver [Instalación](#instalación)).
- **Bandeja de Windows**: sigue funcionando igual; el notch solo escucha una copia de los iconos.

---

## Requisitos
- **Windows 11** (en Windows 10 debería funcionar casi todo, pero no está probado).
- **[Node.js](https://nodejs.org/) 18 o superior** (solo para instalar las dependencias).
- Windows PowerShell 5.1 (viene con Windows).
- Opcional:
  - [GlazeWM](https://github.com/glzr-io/glazewm) para el mosaico de ventanas.
  - [Claude Code](https://claude.com/claude-code) para la integración con Claude.
  - [homepage-dashboard](https://github.com/ak1ta4/homepage-dashboard) para las estadísticas del sistema, la red y
    las tareas (ver [Estadísticas y tareas](#estadísticas-y-tareas-homepage-dashboard)). Sin él, la barra y el panel
    funcionan igual pero sin la pestaña Sistema, las velocidades de red ni las tareas.

---

## Instalación

```bash
git clone https://github.com/ak1ta4/windows-notch.git
cd windows-notch
npm install
```

> En PowerShell, si `npm` falla por la política de ejecución de scripts, usa `npm.cmd install`.

Arranca con doble clic en **`Arrancar notch.cmd`** o desde una terminal con `npm start` (`npm.cmd start` en
PowerShell). La primera vez se crea `config.json` con los valores por defecto.

### Arrancar con Windows
```bash
powershell -ExecutionPolicy Bypass -File install-autostart.ps1
```
Crea un acceso directo en la carpeta Inicio. Para quitarlo, añade `-Remove`.

Si usabas otra barra (YASB, Zebar…), quítala del arranque para que no se pisen la franja de arriba.

### GlazeWM
Añade esta regla en `~/.glzr/glazewm/config.yaml`, dentro de `window_rules`, para que GlazeWM ignore la ventana del notch:

```yaml
window_rules:
  - commands: ['ignore']
    match:
      - window_process: { equals: 'electron' }
        window_title: { equals: 'Notch' }
```

Recarga la configuración de GlazeWM. El espacio de arriba lo reserva el propio notch, así que GlazeWM coloca las
ventanas debajo sin tocar sus márgenes.

---

## Uso

| Acción | Cómo |
|--------|------|
| Abrir el panel | Clic en la isla |
| Cerrar el panel | Clic fuera o Esc |
| Buscador | **Ctrl+Q** desde cualquier sitio, o la lupa del panel |
| Volumen | Rueda sobre la isla o sobre el icono de volumen |
| Cambiar salida de audio | Clic en el icono de volumen |
| Mezclador por app | Clic derecho en el icono de volumen |
| Fijar un icono de bandeja en la barra | Pestaña Bandeja → chincheta del icono |
| Recargar, DevTools, config o salir | Clic derecho en la isla o en una zona vacía de la barra |

---

## Configuración
Todo está en `config.json` (en la carpeta del proyecto). Hay un ejemplo comentado abajo y en
[`config.example.json`](config.example.json). Las opciones nuevas se añaden solas al archivo sin tocar las tuyas.
Tras cambiarlo, recarga el notch (clic derecho → Recargar) o reinícialo para el atajo de teclado.

| Opción | Por defecto | Qué hace |
|--------|-------------|----------|
| `label` | `"秋田"` | Texto de la etiqueta de la izquierda |
| `clock24h` | `true` | Reloj de 24 h |
| `folders` | Inicio, Descargas… | Carpetas del menú de la etiqueta (`~` = tu carpeta de usuario) |
| `chime` | `true` | Sonido al vencer un recordatorio |
| `mediaIgnore` | `["Claude"]` | Apps cuyo audio no se muestra como "lo que suena" |
| `appBar` | `true` | Reservar la franja superior para que las ventanas no la tapen |
| `appBarHeight` | `42` | Alto reservado, en píxeles lógicos |
| `homeServer` | `http://127.0.0.1:47800` | Dirección del agente de [homepage-dashboard](https://github.com/ak1ta4/homepage-dashboard) |
| `artworkLookup` | `true` | Buscar la carátula en iTunes si la app no la da (envía artista y título a Apple) |
| `tray` | `true` | Copiar los iconos de la bandeja del sistema |
| `barTrayPins` | `[]` | Iconos fijados en la barra (se rellena desde la pestaña Bandeja) |
| `launcherHotkey` | `"Alt+S"` | Atajo del buscador, en [formato de Electron](https://www.electronjs.org/docs/latest/api/accelerator) (`"Ctrl+Q"`, `"Ctrl+Shift+Space"`…) |
| `rim` | `true` | Borde visible alrededor del negro (útil en OLED) |
| `rimStrength` | `1` | Intensidad del borde: `0.5` suave, `1` normal, `2` marcado |
| `claudeCli` | `""` | Ruta a `claude.exe` para "Pregúntale a Claude" (vacío = `~/.local/bin/claude.exe`) |

### Estadísticas y tareas (homepage-dashboard)
La pestaña Sistema, las velocidades de red de la barra y las tareas vienen del agente de
**[homepage-dashboard](https://github.com/ak1ta4/homepage-dashboard)** (`server.py`), el mismo que alimenta la
página de inicio del navegador y el wallpaper. Así las tareas son las mismas en los tres sitios.

Instálalo siguiendo su README. En resumen:

```bash
git clone https://github.com/ak1ta4/homepage-dashboard.git
cd homepage-dashboard
python -m pip install --target .deps -r requirements.txt
python server.py
```

y, para que arranque con Windows, `powershell -NoProfile -ExecutionPolicy Bypass -File .\install-autostart.ps1`.
Escucha solo en `127.0.0.1:47800`, que es el valor por defecto de `homeServer`.

Lo que usa el notch:

| Petición | Para qué |
|----------|----------|
| `GET /api/stats` | CPU por núcleo, GPU, VRAM, RAM, red (bytes/s), discos y procesos. La barra lo pide cada 3 s |
| `GET /api/data` | Leer las tareas: `{ todos: [{ id, text, done, created, due, notified, doneAt }] }`, con `due` en formato `YYYY-MM-DDTHH:MM` |
| `PUT /api/data` | Guardar las tareas. El notch lee los datos, cambia solo la tarea afectada y los vuelve a escribir, así no pisa los marcadores ni los campos que gestiona el servidor (`notified`, `doneAt`) |

Las peticiones llevan la cabecera `X-Home: 1`, que el servidor exige para escribir. La pestaña Sistema tiene un botón
para abrir el dashboard en el navegador, y la de Tareas también cuando hay más de 8.

Si el servidor no está en marcha, esas partes simplemente no aparecen. Si lo tienes en otro puerto, cambia
`homeServer` en `config.json`.

> **Recordatorios:** el servidor también avisa de las tareas que vencen (con su propia ventana emergente). Si no
> quieres el aviso doble, desactiva el sonido del notch con `chime: false`.

---

## Integración con Claude Code
El notch muestra lo que hacen tus sesiones de Claude Code y deja responder a sus peticiones de permiso con botones
en la isla.

```bash
node hooks/install.js
```

Añade los hooks del notch a `~/.claude/settings.json`. La primera vez guarda una copia en
`settings.json.bak-notch`. Si mueves la carpeta del proyecto, vuelve a ejecutarlo para actualizar la ruta.

- Los eventos (inicio de sesión, herramientas, fin…) se envían a un servidor local en `127.0.0.1:47321`.
- El hook de `PermissionRequest` espera hasta ~110 s a que pulses **Permitir** o **Denegar**. Si el notch está
  cerrado, no contestas o respondes en la terminal, Claude muestra su diálogo normal.
- En **modo auto** Claude no pide permisos, así que no verás los botones; aparecen en las sesiones en modo normal.
- **"Pregúntale a Claude"** usa tu CLI (`claude -p`) sin herramientas ni historial guardado.

---

## Cómo funciona por dentro
Algunos detalles no evidentes, por si quieres modificarlo:

- **Ventana con forma** (`setShape`): la ventana es transparente y ocupa el ancho del monitor, pero para Windows
  solo existen la barra y la isla. Fuera de ellas los clics van directos a la app de debajo.
- **Nunca `hide()`**: tras ocultar y volver a mostrar, Electron deja de entregar clics a la página. En pantalla
  completa la ventana se mueve fuera de la pantalla y luego se devuelve.
- **Clics sin activar**: con `focusable: false`, Chromium responde a `WM_MOUSEACTIVATE` con "no activar y descartar
  el clic", y solo llega el soltar del botón. Se intercepta el mensaje con [koffi](https://koffi.dev/) para
  responder "no activar" y que el clic llegue entero.
- **Primer plano**: si una ventana pide ponerse delante y Windows se lo niega, la barra de tareas oculta asoma. El
  notch se engancha al hilo de la ventana activa para que Windows lo acepte, y al cerrar devuelve el foco a la
  ventana que lo tenía.
- **Bandeja del sistema**: el helper crea una ventana `Shell_TrayWnd` falsa por encima de la real. Las apps le
  envían sus iconos, el notch se queda una copia y lo reenvía todo a la barra de tareas real. Al arrancar pide a
  las apps que vuelvan a registrar sus iconos (el mismo aviso `TaskbarCreated` que usa Windows al reiniciar el
  explorador) y lo repite a los 10 s, al minuto y cuando el explorador se reinicia.
- **Menús de las apps de la bandeja**: las apps Electron (Discord…) solo abren su menú si consiguen ponerse en
  primer plano; el helper se lo da antes de enviarles el clic.
- **Espacio reservado**: se registra como *AppBar* (`SHAppBarMessage`), igual que la barra de tareas.
- **Pantalla completa**: se busca la primera ventana de aplicación en el orden Z del monitor principal y se comprueba
  si lo cubre (con 4 px de tolerancia; Valorant encoge 1 px al hacer Alt+Tab) y no está maximizada.
- **Multimedia**: controles multimedia de Windows (SMTC, WinRT). Spotify, si no publica ahí, se lee del título de su
  ventana y se controla con las teclas multimedia.
- **Audio**: CoreAudio para volumen, salidas (`IPolicyConfig`) y mezclador por aplicación (`IAudioSessionManager2`).
- **Buscador**: `Get-StartApps` + `IShellItemImageFactory` para las apps y sus iconos, manifiestos `.acf` para Steam y
  el proveedor OLE DB de Windows Search para los archivos.

---

## Estructura del proyecto
```
├── main.js                 Proceso principal: ventana, forma, foco, IPC, servidor de Claude, buscador
├── preload.js              API expuesta a la interfaz (window.notch)
├── renderer/
│   ├── index.html          Barra, isla y panel
│   ├── app.js              Lógica de la interfaz
│   ├── style.css           Estilos (por capas v2…v11)
│   ├── icons.js            Iconos SVG
│   ├── dev.html, mock.js   La interfaz con datos simulados, para un navegador normal
├── native/
│   ├── helper.ps1          Helper nativo: audio, multimedia, bandeja, AppBar, pantalla completa, idioma
│   └── search.ps1          Índice de apps (con iconos) y búsqueda de archivos
├── hooks/
│   ├── cc-hook.js          Hook de Claude Code (reenvía eventos y espera decisiones de permiso)
│   └── install.js          Instala los hooks en ~/.claude/settings.json
├── Arrancar notch.cmd      Arranque con doble clic
├── install-autostart.ps1   Acceso directo en la carpeta Inicio
└── config.example.json     Configuración de ejemplo
```

### Desarrollar la interfaz
`renderer/dev.html` carga la interfaz con datos simulados (`mock.js`) en cualquier navegador, sin Electron.
Para depurar la app real: clic derecho → Herramientas de desarrollo.

---

## Solución de problemas
El notch escribe un registro en **`%TEMP%\akita-notch.log`**: cuándo se aparta por pantalla completa (y qué ventana
lo provocó), los clics, la bandeja, los eventos de Claude y los errores. Es lo primero que hay que mirar.

| Problema | Qué hacer |
|----------|-----------|
| No arranca con `npm` en PowerShell | Usa `npm.cmd start` o `Arrancar notch.cmd` |
| El atajo del buscador no funciona | Otra app lo usa; en el registro aparece "NO DISPONIBLE". Cambia `launcherHotkey` |
| Faltan iconos en la bandeja | Pestaña Bandeja → "¿Falta alguno? Actualizar". Algunas apps solo registran el icono al abrirse |
| Se esconde sin motivo | Busca "fullscreen" en el registro para ver qué ventana lo detectó |
| Las ventanas tapan la franja | Comprueba `appBar: true` y la regla de GlazeWM |
| No salen los botones de permiso de Claude | Las sesiones en modo auto no piden permiso; ejecuta `node hooks/install.js` si moviste la carpeta |

---

## Limitaciones conocidas
- Solo el **monitor principal** tiene barra y notch.
- El buscador de archivos solo ve lo que indexa Windows Search (por defecto, tu carpeta de usuario).
- Los iconos de bandeja de apps que ignoran `TaskbarCreated` solo aparecen si la app se abre después que el notch.
- Usa APIs no documentadas de Windows (`IPolicyConfig`, la ventana `Shell_TrayWnd`), que una actualización podría cambiar.

---

## Licencia
[MIT](LICENSE)
