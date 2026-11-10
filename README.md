# no-phone

API HTTP + MCP para operar billeteras en un Android físico (adb + uiautomator2 + FastAPI + FastMCP).

Diseño: vault Obsidian `obsidian-personal/no-phone/` · brief MCP: [`MCP.md`](./MCP.md) (flujo **mcp-server-dev** + secretaria).

## Docker / VPS

Todo el secretario (Hermes + memoria + conectores + consola) en un `docker compose up`; el celu se alcanza por USB, `adb connect` o un adb server remoto (VPS ↔ casa por Tailscale). Ver [`DOCKER.md`](./DOCKER.md).

## Consola (`admin/`)

`http://127.0.0.1:8890` — cuatro pestañas:

- **chat**: escribirle o **llamarlo** (voz del navegador para escuchar, Piper para hablar; turnos por silencio real del micrófono). Cada herramienta se dibuja con el estilo de su app (burbuja de WhatsApp, tarjeta de Naranja X, mapa); una operación es una tarjeta que se actualiza. Las charlas siguen entre recargas y se retoman desde la columna de la izquierda. Arriba, los avisos del vigía y lo que esté caído.
- **memoria**: gente y lugares, recuerdos (corregir / descartar) y «probar qué recuerda».
- **tareas**: lo programado.
- **ajustes**: secretario (modelo, personalidad, **reglas**), conexiones (celular, WhatsApp, conectores) y personas.

La consola le pasa al secretario, en cada mensaje, lo que la memoria sabe sobre ese mensaje y las reglas vigentes (por el API de Hermes no le llegarían). Reglas para agentes: [`admin/CLAUDE.md`](./admin/CLAUDE.md).

## Quick start (HTTP)

```bash
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
cp .env.example .env   # NX_PIN / NX_PIN_MOTO / ANDROID_SERIAL (chmod 600)
# Perfiles: ~/.config/no-phone/phones.json · tools nx_phones / nx_phone_usar
# USB: adb devices → serial. WiFi: adb connect HOST:5555
ANDROID_SERIAL=TU_SERIAL \
  .venv/bin/uvicorn server:app --host 127.0.0.1 --port 8800
```

Docs: http://127.0.0.1:8800/docs

### Perfiles de teléfono

Redmi, Moto u otro: cada uno con `serial` + `pin_env` en `~/.config/no-phone/phones.json`.

- `nx_phones` — lista + estado adb  
- `nx_phone_usar moto_g5` — cambia el activo  
- `nx_phone_upsert` — cargar serial nuevo tras `adb devices`

Smoke secretaria (no envía plata):

```bash
.venv/bin/python scripts/smoke_secretaria.py
```

## MCP (Claude / Cursor / Grok)

Diseño según plugin Anthropic `mcp-server-dev`: **local stdio**, una tool por acción, read/write separados, elicitation en transferencia real. Transferencia preferida en **3 pasos** (secretaria) con progress.

```bash
ANDROID_SERIAL=TU_SERIAL .venv/bin/python mcp_server.py
```

**Claude Code:**

```bash
claude mcp add no-phone -s user -e ANDROID_SERIAL=TU_SERIAL -- \
  /home/ivanbustos/Documentos/GitHub/no-phone/.venv/bin/python \
  /home/ivanbustos/Documentos/GitHub/no-phone/mcp_server.py
```

**Grok Build** — `~/.grok/config.toml`:

```toml
[mcp_servers.no-phone]
command = "/home/ivanbustos/Documentos/GitHub/no-phone/.venv/bin/python"
args = ["/home/ivanbustos/Documentos/GitHub/no-phone/mcp_server.py"]
enabled = true
startup_timeout_sec = 30

  [mcp_servers.no-phone.env]
  ANDROID_SERIAL = "TU_SERIAL"
```

**Cursor** — `.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "no-phone": {
      "command": "/home/ivanbustos/Documentos/GitHub/no-phone/.venv/bin/python",
      "args": ["/home/ivanbustos/Documentos/GitHub/no-phone/mcp_server.py"],
      "env": { "ANDROID_SERIAL": "TU_SERIAL" }
    }
  }
}
```

### Tools

| Tool | Qué hace |
|------|----------|
| `nx_inicio` / `nx_saldo` / `nx_contactos` / `nx_actividad` | Lectura |
| `nx_movimientos(limite, actualizar)` | Lista completa (~90 días, enviadas y recibidas), scrolleando hasta `limite` (máx. 50). Lo leído queda 10 min: los seguimientos salen de ahí sin tocar el celu; `actualizar=true` relee. Se borra al transferir. |
| `device_info` | Celular / activity actual (apaga pantalla al terminar) |
| `device_screen_off` | Apagar pantalla ya |
| `nx_destino_resolver` | Paso 1 secretaria: valida alias, pregunta «¿es esta persona?» |
| `nx_transfer_armar` | Paso 2: monto + saldo → «¿mando $X?» |
| `nx_transfer_cancelar` | Abortar flujo a medias |
| `nx_transfer` | Paso 3: envío real (elicitation o `confirmado=true`) |
| `nx_transfer_y_comprobante` | Envío + PNG en un solo ciclo (más rápido) |
| `nx_transfer_preview` | Atajo one-shot dry-run |
| `nx_origen_recibida` | CVU/titular de una recibida (devolver); ambiguo si hay varias |
| `nx_comprobante_buscar` | Candidatas (persona/monto); confirmá índice |
| `nx_comprobante_guardar` | PNG en host; `recien=true` con huella + verify |

Velocidad: `NX_UI_MODE=fast` (default) · agenda `~/.local/share/no-phone/agenda.json` (nombre→CVU) · post-éxito va a Cuentas/Movimientos.

Al terminar una acción se **apaga la pantalla**, salvo pasos a medias (`destino_resuelto` / `listo_para_enviar`).

### Transferir + mandar comprobante (dos MCPs)

```
nx_destino_resolver → nx_transfer_armar → nx_transfer
        ↓
nx_comprobante_buscar(contraparte?, monto?)  →  confirmás «la 0»
        ↓
nx_comprobante_guardar(indice=0, …)  →  { archivo: ~/.local/share/no-phone/comprobantes/….png }
        ↓
wa_enviar_preview(destino, archivo=…) → wa_enviar   # MCP whatsapp
```

## WhatsApp

Bridge whatsmeow (Go) + MCP `whatsapp` (leer chats, enviar con preview+confirmación). Ver [`whatsapp/README.md`](./whatsapp/README.md).

| Tool | Qué hace |
|------|----------|
| `wa_recientes` / `wa_chats` / `wa_mensajes` / `wa_buscar_*` | Lectura (búsqueda sin tildes ni mayúsculas, también por pedazos del número) |
| `wa_transcribir` | Escucha una nota de voz (Whisper local, servicio `stt`); queda en caché y `wa_mensajes` la muestra como `transcripcion` |
| `wa_ver_imagen` | Mira una imagen o sticker con un modelo de visión de OpenRouter (`WA_VISION_MODEL`); Hermes no ve el volumen de WhatsApp, así que `vision_analyze` no sirve para esto |
| `wa_enviar_preview` → `wa_enviar(confirmado=true)` | Enviar en dos pasos; un adjunto de otra herramienta (comprobante) se copia a `salientes/` para que el bridge lo lea |
| `wa_vigilar` / `wa_vigilancias` / `wa_vigilancia_cancelar` | «Avisame si X me escribe»: un vigía sin IA mira `wa.db` cada 5 s y avisa en la bandeja de la consola (al WhatsApp propio solo si se pidió explícito: `por_whatsapp`). Se ven y se cancelan en la pestaña **tareas** (son de tu WhatsApp, no de una charla). **No usar cron para esto.** |
| `mision_preparar` / `mision_estado` / `mision_listar` / `mision_cancelar` | **Misiones**: encargos largos que el secretario sigue solo («hablale a Pepín y quedá para el finde», «cuando Agus me transfiera, pasale 30 a Manu»). Arrancan con el sí del dueño a la propuesta (lo oye la consola); la consola las despierta sin IA (mensajes de sus chats, hora, silencio, vencimiento, ingresos de Naranja X) y corre cada turno en la charla donde se pidieron. Sin sí puntual solo sale lo que la misión cubre: WhatsApp a sus contactos y la plata exacta que se previsualizó al crearla. Ver/pausar/cancelar en **tareas**. Diseño: vault `no-phone/MISIONES.md`. |

## MCP reglas

`reglas_listar` / `regla_preparar` → `regla_guardar(confirmado=true)` / `regla_quitar`: lo que el dueño pide sobre cómo comportarse («no uses herramientas si no te lo pido») queda como regla, la misma que ajustes → reglas. Se guardan como directivas de Hindsight y la consola se las hace llegar a Hermes (en cada mensaje y en un bloque del `SOUL.md`).

## MCP movilidad (Maps + MendoTran)

Lugares, rutas y colectivos del Gran Mendoza en tiempo real; `viaje_planear` combina recorridos con arribos GPS para que los transbordos calcen. No usa el celular. Diseño: [`MOVILIDAD.md`](./MOVILIDAD.md).

```bash
./scripts/set-google-key.sh   # opcional (sin key usa OpenStreetMap)
claude mcp add movilidad -s user -- \
  "$PWD/.venv/bin/python" "$PWD/mcp_movilidad.py"
```

| Tool | Qué hace |
|------|----------|
| `lugar_buscar` / `como_llegar` | Dónde queda X · ruta caminando/auto/bici |
| `parada_buscar` / `micro_cuando_viene` / `linea_info` | Paradas, próximos arribos, recorridos |
| `viaje_planear` | Qué micros tomar, cuándo salir, transbordos con margen real |
