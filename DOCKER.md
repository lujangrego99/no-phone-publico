# no-phone en Docker

Todo el secretario en un `docker compose up`, en cualquier PC con Docker (o un VPS):

```
                         red interna «no-phone» (nada se publica fuera de 127.0.0.1)
┌──────────┐   adb    ┌──────────────────────────────┐   HTTP+token   ┌───────────┐
│   adb    │◄────────►│ nophone-mcp        :8810 NX  │◄──────────────►│  hermes   │ el secretario
│ (USB/    │          │ nophone-mcp-whatsapp :8811   │                │  gateway  │ (chat + tareas)
│  WiFi)   │          │ nophone-mcp-movilidad :8812  │                │  API :8642│ (solo red interna)
└──────────┘          │ nophone-mcp-reglas :8813     │                └─────┬─────┘
                      │ nophone-api  127.0.0.1:8800  │                      │ memoria
                      └──────────────┬───────────────┘                ┌─────▼─────┐
                                     │ wa.db + token                  │ hindsight │ UI 127.0.0.1:9999
                               ┌─────▼─────┐                          └───────────┘
                               │ whatsapp  │ puente whatsmeow        stt (audios → texto) · tts (voz)
                               └───────────┘
            admin (consola) 127.0.0.1:8890 → chat/llamada con el secretario y ajustes de todo lo de arriba
```

| Servicio | Imagen | Qué hace |
|---|---|---|
| `adb` | `no-phone-app` | El **único** adb server. `ADB_MODE=usb` toma el USB del celu; `connect` va por WiFi (`ADB_CONNECT=ip:5555`). No se publica: adb no tiene auth. |
| `nophone-mcp`, `-whatsapp`, `-movilidad`, `-reglas` | `no-phone-app` | Los conectores MCP por HTTP en `/mcp`, con `Authorization: Bearer $MCP_HTTP_TOKEN`; sin token, 401 (`mcp_http.py`). El de WhatsApp además corre el **vigía** (vigilancias «avisame si X me escribe» y avisos de tareas, sin IA) y lee `hermes-data` en solo lectura. El de `reglas` maneja las reglas (`HINDSIGHT_BANK`). |
| `stt` | `no-phone-stt` | Notas de voz → texto con faster-whisper `small`, local (lee `wa-data` en solo lectura). Lo usa `wa_transcribir`. |
| `tts` | `no-phone-tts` | Voz del secretario en la llamada (Piper, `PIPER_VOZ`, por defecto `es_MX-ald-medium`). Lo pide la consola. |
| `nophone-api` | `no-phone-app` | API HTTP de Naranja X (`server.py`), `127.0.0.1:8800`. |
| `whatsapp` | `no-phone-whatsapp` (Go) | Puente whatsmeow con `WA_BRIDGE_TOKEN`. La sesión vive en el volumen `wa-data`: si se pierde, hay que volver a vincular desde la consola. |
| `hindsight` | `ghcr.io/vectorize-io/hindsight` | Memoria. Necesita `HINDSIGHT_API_LLM_API_KEY` para aprender. |
| `init` | `no-phone-app` | Una sola vez por arranque: prepara el `HERMES_HOME` (`docker/init_hermes.py`), con los conectores por HTTP, la memoria en `hindsight:8888` y el SOUL. No pisa lo que cambiaste. |
| `hermes` | `no-phone-hermes` (se compila del repo de Hermes, commit fijo `HERMES_REF`) | El secretario: `gateway run` (programador de tareas + API `:8642` con `API_SERVER_KEY`, solo red interna, que usa el chat de la consola). |
| `admin` | `no-phone-admin` (sobre la imagen de Hermes + adb) | La consola web, `127.0.0.1:8890`: chat con llamada, memoria, tareas y ajustes. Comparte el espacio de procesos con `hermes` para ver el programador. |

Todas las imágenes propias corren con el uid **10000**: comparten volúmenes sin problemas de permisos.

## Instalar en una PC

```bash
git clone git@github.com:lujangrego99/no-phone-publico.git && cd no-phone-publico
./docker/instalar.sh          # crea .env con tokens nuevos y levanta todo
```

1. Abrí **http://127.0.0.1:8890** y creá tu usuario (setup inicial).
2. **Herramientas → celulares → agregar celular**: el serial de `adb devices`. El modelo se detecta solo. Después cargá el PIN de Naranja X.
3. **Herramientas → whatsapp**: escaneá el QR o vinculá con tu número.
4. **Secretario → modelo**: la API key del modelo. Para la memoria, poné `HINDSIGHT_API_LLM_API_KEY` en `.env` y corré `docker compose up -d hindsight`.

La primera vez tarda: compila Hermes. Calculá unos **8 GB libres** de disco.

### El celular

| Situación | `.env` | Cómo se levanta |
|---|---|---|
| Por USB a esta PC (por defecto) | `ADB_MODE=usb` | `docker compose up -d`. En el host **no** puede haber otro adb server (`adb kill-server`). |
| Por WiFi, misma red | `ADB_MODE=connect`, `ADB_CONNECT=192.168.1.50:5555` | El celu tiene que estar en `adb tcpip 5555`. Después de cada reinicio del celu, repetirlo por USB. |
| Enchufado en otra máquina (VPS ↔ casa) | `ANDROID_ADB_SERVER_HOST=<ip-tailscale-de-casa>` | `docker compose -f compose.yaml -f compose.adb-remoto.yaml up -d`. En casa: `scripts/adb-gateway.sh <ip-tailscale>`. |

La primera vez que el contenedor habla con el celu, aceptá «¿Permitir depuración USB?» en la pantalla. La clave queda en el volumen `adb-keys`.

## Operación

```bash
docker compose ps                         # estado
docker compose logs -f hermes             # el secretario
docker compose up -d --build              # actualizar después de un git pull
docker compose run --rm init              # re-sincronizar conectores en Hermes (p. ej. si cambiaste MCP_HTTP_TOKEN)
docker compose up -d --build --no-deps admin   # rearmar SOLO la consola
```

**Ojo al reiniciar:**
- `admin` depende de `hermes`: `up --build admin` **sin `--no-deps` reinicia también `init` y `hermes`** y corta lo que el secretario esté haciendo (una transferencia, un envío). Para tocar un servicio solo: `--no-deps`.
- Reiniciar `hermes` deja `admin` caído (comparten el espacio de procesos): después, `docker compose up -d --no-deps admin`.
- Si el build falla con `error getting credentials` o `network is unreachable` (Docker Hub por IPv6), reintentar: la imagen base ya está en caché.

Para hablarle desde la terminal: `docker compose exec hermes hermes` (CLI de Hermes dentro del contenedor).

**Volúmenes** (respaldar estos):

| Volumen | Contenido |
|---|---|
| `hermes-data` | config, SOUL, sesiones, tareas |
| `hindsight-data` | memoria |
| `wa-data` | sesión de WhatsApp y mensajes |
| `app-data` | `phones.json`, PIN por celular, agenda y comprobantes |
| `admin-data` | usuarios y tenants de la consola |
| `adb-keys` | autorización adb del celu |
| `stt-models`, `tts-voces` | modelo de Whisper y voz de Piper (se bajan solos la primera vez) |

**`.env`:** además de los tokens que genera `instalar.sh` (`MCP_HTTP_TOKEN`, `WA_BRIDGE_TOKEN`, `API_SERVER_KEY`):
`OPENROUTER_API_KEY` (modelo del secretario y de la memoria, si no tiene key propia), `HINDSIGHT_LLM_*` / `HERMES_MODEL_*` (proveedor y modelo), `HINDSIGHT_BANK` (id del banco de memoria del secretario, lo usan las reglas), `PIPER_VOZ`, `ADB_MODE`/`ADB_CONNECT`.

**Puertos:** todos en `127.0.0.1`. Se cambian en `.env`: `ADMIN_PORT`, `API_PORT`, `HINDSIGHT_UI_PORT`. Para llegar desde otra máquina: Tailscale o un túnel SSH, nunca `0.0.0.0`.

## Límites conocidos

- **Multi-tenant en Docker:** la consola crea secretarios nuevos (perfiles de Hermes) en el mismo volumen. Pero los conectores HTTP son uno por compose: un tenant más, con otro celu y otro WhatsApp, necesita su propio puente y sus propios conectores. Por ahora: un compose por persona, con `-p <nombre>` y puertos distintos.
- **Hermes** se compila desde su repo en un commit fijo (`HERMES_REF` en `.env` para cambiarlo). Actualizarlo es cambiar ese valor y correr `docker compose build hermes admin`.
- `compose.hindsight.yaml` queda solo para la instalación sin Docker completo, con Hermes y la app en el host.
