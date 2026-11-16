# Diseño: plugin de Claude Code para delegar en Gemini vía Antigravity CLI (`agy`)

Fecha: 2026-11-16 · Estado: borrador pendiente de aprobación

## 1. Intención y porqué

Queremos un plugin de Claude Code que haga con Gemini lo mismo que el plugin oficial de Codex (`openai-codex/codex` 1.0.6) hace con Codex: que Claude Code pueda pedir a otro agente una **revisión de código** o **delegarle una tarea**, con trabajos en segundo plano y consulta de estado/resultado.

Es para **publicarlo en GitHub** y que lo instale cualquiera con:

```
claude plugin marketplace add <owner>/<repo>
claude plugin install <plugin>@<marketplace>
```

Contexto que motiva el diseño:

- Gemini CLI se retiró el 18-jun-2026 para cuentas personales/gratuitas. Su sucesor oficial es **Antigravity CLI (`agy`)**, gratis con cuenta de Google. Decisión del usuario: **solo `agy`**.
- Ya existen `gemini-plugin-cc` (archivado, roto) y `antigravity-plugin` (v0.1.0, comandos que no hacen nada, denegaciones de permisos que se reportan como éxito, sin actividad desde mayo). Nos diferenciamos por **funcionar de verdad, estar probado y mantenerse**.

## 2. Objetivos, no-objetivos, anti-objetivos

**Objetivos (v1.0)**

- Comandos: `/gemini:setup`, `/gemini:review`, `/gemini:adversarial-review`, `/gemini:rescue`, `/gemini:status`, `/gemini:result`, `/gemini:cancel`.
- Subagente `gemini:gemini-rescue` que Claude puede usar por iniciativa propia (como `codex:codex-rescue`).
- Trabajos en primer plano y en segundo plano, con seguimiento por sesión de Claude.
- Puerta de revisión opcional al terminar cada respuesta de Claude (hook `Stop`), **desactivada por defecto**.
- Funciona en macOS, Linux y Windows (donde funcione `agy`).
- Instalación estándar por marketplace de plugins, con versiones etiquetadas y CHANGELOG.

**No-objetivos**

- Soportar Gemini CLI (`gemini`) ni llamar directamente a la API de Gemini.
- Servidor MCP, soporte para otros anfitriones (Codex CLI, `agy` como anfitrión).
- Instalar `agy` automáticamente sin preguntar.
- Transferir la sesión de Claude a `agy` (el `/codex:transfer` del original).

**Anti-objetivos (sería un fracaso aunque “funcione”)**

- Que un fallo, una denegación de permiso o un cuelgue de `agy` se presente como éxito o como salida vacía.
- Aprobar todas las acciones de `agy` (`--dangerously-skip-permissions`) por defecto.
- Parecer un producto oficial de Google o de OpenAI.
- Enviar datos del usuario a cualquier sitio que no sea el propio `agy`.

## 3. Restricciones

- **Licencia:** partimos de código del plugin de Codex (Apache-2.0). El repo será Apache-2.0, conservando `LICENSE` y un `NOTICE` que atribuya el original a OpenAI e indique que los archivos han sido modificados.
- **`agy` es joven y cambia rápido** (v1.5.9, diez versiones en diez días). Hay que detectar capacidades al arrancar y leer su salida de forma tolerante.
- **Fallos conocidos de `agy` en modo no interactivo:** salida vacía si stdin queda abierto (#76) y cuelgues con `-p` (#318, reportado aún en 1.4.10). Siempre cerramos stdin y aplicamos un tiempo límite propio además de `--print-timeout`.
- **Las denegaciones de permisos en `agy` son “blandas”:** la ejecución sigue y sale con código 0. Hay que detectarlas en los eventos `step_update.tool_info.error` y en stderr.
- **No existe `--cwd`:** el directorio de trabajo es el del proceso hijo.
- **Autenticación:** en modo no interactivo `agy` necesita credenciales ya guardadas; si no, sale con error. El login lo hace siempre el usuario (`!agy` en Claude Code).
- **Términos de uso (sin resolver):** no está claro si Google permite manejar `agy` desde otra herramienta con una cuenta personal. Ver §7.
- Sin dependencias de npm en tiempo de ejecución: solo Node ≥ 18.18 (como el original).

## 4. Enfoques considerados

| Enfoque | Qué es | Ventajas | Inconvenientes |
|---|---|---|---|
| **A. Un proceso `agy -p --output-format stream-json` por trabajo** *(elegido)* | Cada revisión/tarea lanza `agy` y lee sus eventos NDJSON; las continuaciones usan `--conversation <id>` | Interfaz documentada; aislamiento por trabajo; fácil de simular en tests; el id de conversación, el uso y los errores vienen en los eventos | Arranque de `agy` en cada llamada; depende de que el formato de eventos sea estable |
| B. Servidor `agy acp` persistente con intermediario (como el `app-server` de Codex) | Un proceso `agy acp` vivo por sesión, hablado por JSON-RPC | Más rápido en llamadas seguidas; más parecido al original | ACP en `agy` tiene dos semanas (v1.5.0) y sus métodos no están documentados; el intermediario es la parte más compleja y frágil del original (~900 líneas) |
| C. `agy -p` con salida de texto | Lanzar y capturar texto | Lo más simple | Sin id de conversación, sin errores estructurados, sin detección de denegaciones: repite los fallos de `antigravity-plugin` |

**Elegido A** (decisión mía, el usuario delegó el “cómo”). B queda como posible mejora futura si ACP madura; C no cumple los anti-objetivos.

## 5. Diseño

### 5.1 Estructura del repositorio

```
<repo>/
  .claude-plugin/marketplace.json      # marketplace con un plugin
  plugins/gemini/
    .claude-plugin/plugin.json
    commands/      setup, review, adversarial-review, rescue, status, result, cancel (.md)
    agents/        gemini-rescue.md
    skills/        agy-cli-runtime/, gemini-result-handling/, gemini-prompting/
    hooks/hooks.json                   # SessionStart, SessionEnd, Stop (gate)
    prompts/       adversarial-review.md, stop-review-gate.md, review.md
    schemas/       review-output.schema.json
    scripts/
      gemini-companion.mjs             # punto de entrada único (subcomandos)
      session-lifecycle-hook.mjs
      stop-review-gate-hook.mjs
      lib/  agy.mjs (nuevo), agy-events.mjs (nuevo),
            args, fs, git, job-control, process, prompts, render, state,
            tracked-jobs, workspace (adaptados del original)
  tests/           node --test + fake-agy fixture
  scripts/         bump-version, smoke.sh (prueba real opcional)
  .github/workflows/ci.yml             # tests en ubuntu, macos, windows
  README.md, CHANGELOG.md, LICENSE, NOTICE, CONTRIBUTING.md, SECURITY.md
```

Se elimina del original: `app-server*.mjs`, `broker-*.mjs`, `codex.mjs`, `claude-session-transfer.mjs`, `commands/transfer.md`.

### 5.2 Cómo se llama a `agy`

Comando base (siempre):

```
agy -p "<prompt>" --output-format stream-json --print-timeout <T> [--model M] [--effort E] [--mode X] [--conversation ID]
```

- `cwd` = raíz del espacio de trabajo; `stdin` cerrado (`ignore`); stdout se parsea línea a línea; stderr se guarda en el log del trabajo.
- Prompts: ver §5.9 (sin archivos temporales; `agy` lee el diff con `git`).
- **Tiempo límite doble:** `--print-timeout` y un temporizador propio que mata el proceso (y su árbol) si no llega el evento `result`. Valores por defecto: revisión 15 min, tarea 30 min; configurables con `--timeout`.
- **Interpretación del resultado** (`agy-events.mjs`): acumula `text_delta`, recoge `conversation_id`, `usage`, `status`, y cuenta errores de herramientas. Estados finales posibles del trabajo: `completed`, `completed-with-denials`, `failed`, `timed-out`, `cancelled`. Nunca “completado” con salida vacía: eso es `failed` con el stderr adjunto.
- Eventos desconocidos se ignoran con aviso en el log; un `result` ausente es error.

### 5.3 Comandos

| Comando | Qué hace | Modo de `agy` |
|---|---|---|
| `/gemini:setup` | Comprueba `agy` (existe, versión mínima, soporte de `--output-format`), autenticación (llamada mínima) y modelos (`agy models`). Si falta `agy`, ofrece el comando de instalación oficial para que el usuario lo ejecute o lo apruebe. `--enable-review-gate` / `--disable-review-gate`. | — |
| `/gemini:review` | Revisión del estado de git (árbol de trabajo o rama contra `--base`), `--wait`/`--background`, misma lógica de tamaño y pregunta que el original. Salida estructurada con `--json-schema` (esquema del original) y renderizado a Markdown. | por defecto + solo comandos de lectura |
| `/gemini:adversarial-review` | Igual, con texto de enfoque libre y prompt adversarial. | por defecto + solo comandos de lectura |
| `/gemini:rescue` | Vía subagente `gemini:gemini-rescue`. `--resume`/`--fresh`, `--model`, `--effort`, `--background`/`--wait`, `--read-only`. | `accept-edits` + comandos de lectura + `--allow`; `--read-only` → modo por defecto; `--auto` → `auto` (opcional) |
| `/gemini:status` | Lista trabajos de esta sesión con estado y duración. | — |
| `/gemini:result [id]` | Muestra el resultado (último por defecto), incluidas denegaciones y uso. | — |
| `/gemini:cancel [id]` | Mata el árbol de procesos del trabajo y lo marca `cancelled`. | — |

**Denegaciones:** si en `accept-edits` `agy` intenta un comando de shell y se le deniega, el resultado lo dice claramente (“3 acciones denegadas: …”) y sugiere repetir con `--auto` o configurar `permissions.allow` en `agy`. No ofrecemos `--dangerously-skip-permissions`.

### 5.4 Estado y trabajos

Se reutiliza el modelo del original: estado por espacio de trabajo bajo `${CLAUDE_PLUGIN_DATA}` (o directorio de datos del usuario), trabajos con id, pid, log, resultado y `conversation_id`; `--resume` usa el último `conversation_id` de la sesión de Claude actual. Los hooks `SessionStart`/`SessionEnd` registran la sesión y limpian trabajos huérfanos.

### 5.5 Puerta de revisión (Stop hook)

Igual que el original: desactivada por defecto; al activarla, `setup` avisa de que consume cuota de `agy` en cada respuesta. Si `agy` falla o se agota el tiempo, la puerta **no bloquea** a Claude y lo indica.

### 5.6 Pruebas

- **Unitarias/integración** con `node --test`: un `fake-agy` (script Node) que reproduce eventos `stream-json` grabados: éxito, denegaciones, error de autenticación, cuelgue sin `result`, salida vacía, evento desconocido, modelo inválido.
- **CI** en GitHub Actions: ubuntu, macos, windows × Node 18 y 22.
- **Prueba real** (`scripts/smoke.sh`, manual, no en CI): con `agy` real autenticado, lanza review y rescue en un repo de ejemplo. Se ejecuta antes de cada versión publicada.
- **Prueba de instalación:** instalar el plugin desde la carpeta local con `claude plugin marketplace add ./` y ejecutar cada comando.

### 5.7 Publicación

- README en inglés (público general), con aviso “no oficial, no afiliado a Google ni a OpenAI”, requisitos, instalación, comandos, permisos y privacidad (el código y los diffs se envían a Google a través de `agy`).
- Versionado semántico, `CHANGELOG.md`, etiquetas `vX.Y.Z` y GitHub Releases. Versión inicial pública: `0.1.0` tras la prueba real; `1.0.0` cuando haya uso de terceros sin incidencias graves.
- Plantillas de issues y `SECURITY.md`.

### 5.8 Fase 0: verificar `agy` real antes de construir

La interfaz de `agy` descrita aquí sale de su documentación oficial (`antigravity.google/docs/cli/headless.md`, `reference.md`, `modes.md`), pero nadie la ha ejecutado aún. Antes de escribir el parser o los tests, con `agy` instalado y autenticado:

- Confirmar flags (`--output-format stream-json`, `--print-timeout`, `--model`, `--effort`, `--mode`, `--conversation`, `--json-schema`, `--input-format stream-json`) y `agy models`.
- Grabar transcripciones reales de eventos para cada caso (éxito, denegación, auth, modelo inválido) y usarlas como fixtures de `fake-agy`.
- Comprobar qué hacen de verdad `plan`, `accept-edits` y `auto` en modo `-p`, y si `agy` puede leer archivos fuera del cwd.
- Cualquier supuesto que falle se corrige en este documento antes de seguir.

#### Resultados de la fase 0 (agy 1.5.9, 2026-11-16)

Grabaciones reales en `tests/fixtures/agy/` (rutas anonimizadas). Lo que cambia respecto a lo anterior:

- **Formato confirmado.** `init` lleva `conversation_id` en el nivel superior. `step_update.state` puede ser `ACTIVE`, `DONE` o `ERROR`; los errores de herramienta van en `tool_info.error`. `result` trae `status`, `response`, `error`, `finished_reason`, `structured_output` (con `--json-schema`) y **`denied_actions`** (`[{action, display_name}]`).
- **Códigos de salida:** 0 = éxito (¡también con denegaciones!), 1 = modelo inválido, 3 = `--print-timeout` agotado (`finished_reason: "print_timeout"`).
- **Una denegación termina el turno con respuesta vacía y `status: SUCCESS`.** El modelo obedece la instrucción de `agy` de no intentar alternativas. Regla: si `denied_actions` no está vacío, el resultado es `completed-with-denials`; si además la respuesta está vacía, el trabajo se presenta como **fallido por permisos**, con la lista de lo que se denegó y la sugerencia de `agy` copiada de stderr.
- **`--mode plan` no sirve para revisar:** escribe un plan en su directorio interno y pide aprobación. **La revisión usa el modo por defecto** con `--settings '{"permissions":{"allow":[...]}}'`, que permite solo comandos de lectura (`git`, `ls`, `cat`, `grep`, `find`, `rg`, `head`, `tail`, `wc`). Cualquier escritura se deniega, y eso está comprobado.
- **Rescue:** `--mode accept-edits` (las ediciones funcionan) más la misma lista de comandos de lectura. Para comandos extra, la opción `--allow <prefijo>` es repetible (por ejemplo `--allow "npm test"`) y se traduce en `command(<prefijo>)`. Los comandos que no estén en la lista se deniegan y se informa.
- **`--mode auto` no está disponible para todas las cuentas:** `agy` avisa por stderr y sigue en modo por defecto. Queda como opción explícita (`--auto`), y se detecta el aviso para decírselo al usuario.
- **Error de `agy` con enlaces simbólicos:** si el cwd pasa por un enlace (por ejemplo `/var` → `/private/var` en macOS), deniega las ediciones. **Siempre se lanza con `cwd = fs.realpathSync(workspace)`.**
- **`--settings`** existe y no toca la configuración del usuario. Lo usamos en lugar de pedirle que edite `settings.json`.
- **Modelos del plan gratuito:** `gemini-3.8-flash-{high,medium,low}`, más modelos de Claude y GPT-OSS. El esfuerzo va en el propio nombre del modelo de Gemini, así que `--effort` solo se pasa si el usuario lo pide.
- **`--conversation <id>`** continúa la conversación (`num_turns` aumenta). Sigue en `request-review` aunque se cambie de modo.

### 5.9 Respuestas a la revisión del diseño

- **Revisión normal:** `agy` no tiene revisión nativa, así que `/gemini:review` usa un prompt propio (`prompts/review.md`) con el mismo esquema que la adversarial. Es intencionado.
- **Si `--json-schema` no existe o falla:** se pide JSON en el prompt, se extrae y valida de forma tolerante; si no valida, el trabajo queda `failed` mostrando la salida en bruto. *(Decisión mía.)*
- **Prompts grandes:** no hacen falta archivos temporales. Como `git` está permitido, el prompt de revisión no incluye el diff completo: lleva el objetivo (árbol de trabajo o `base...HEAD`), la lista de archivos y `--shortstat`, y pide a `agy` que ejecute él mismo `git diff`. Las tareas de rescue llevan solo el texto del usuario. Si un prompt pasa de 100 000 caracteres, se rechaza con un error claro. *(Decisión mía, tomada tras la fase 0.)*
- **Puerta de revisión:** revisa solo los cambios del último turno de Claude, con tiempo límite propio de 5 min (el hook tiene 900 s, así que nuestro temporizador siempre llega antes) y el modelo `gemini-3.8-flash-low` si el usuario no configura otro. Si se agota, deja pasar e informa. *(Decisión mía.)*

## 6. Decisiones tomadas por mí (corregibles)

- Enfoque A (subproceso por trabajo con `stream-json`).
- Nombre del plugin `gemini` (comandos `/gemini:*`); nombre del repo `gemini-bridge-cc`; marketplace con el nombre de la cuenta de GitHub.
- Licencia Apache-2.0 con NOTICE.
- Rescue escribe por defecto en modo `accept-edits` (edita archivos, pide permiso para shell → denegado en modo no interactivo y reportado).
- Documentación pública en inglés; este diseño en español.
- Versión mínima de `agy`: la primera que soporte `--output-format stream-json` (a confirmar con `agy --help` en la implementación).

## 7. Decidido por el usuario

1. **Términos de uso de Google:** hay dudas sin respuesta oficial, así que el repo será **privado primero**. Se construye todo como si fuera a publicarse (README, licencia, versiones), y el usuario decide más tarde si lo hace público.
2. **Cuenta de GitHub:** `isaay6`. El marketplace se llama `isaay6`, así que el comando de instalación queda `claude plugin install gemini@isaay6`.
3. **`agy`:** se instala con el instalador oficial en esta máquina y el usuario inicia sesión, para la fase 0.

## 8. Lo que queda a criterio de quien lo construya

- Organización interna de los módulos y nombres de funciones.
- Textos exactos de los prompts de revisión y de las skills.
- Umbral para pasar el prompt por archivo temporal.
- Detalles del renderizado Markdown de los resultados.
