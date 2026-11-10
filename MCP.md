# no-phone — MCP design (mcp-server-dev)

Diseño siguiendo el plugin oficial Anthropic **`mcp-server-dev`** / skill `build-mcp-server`.

## Phase 1 — Use case

| Pregunta | Respuesta |
|----------|-----------|
| ¿A qué se conecta? | Android físico + app Naranja X vía adb/uiautomator2 + `.env` local |
| ¿Quién lo usa? | Solo yo / esta máquina |
| ¿Cuántas acciones? | ~12 → Pattern A (una tool por acción) |
| ¿Input mid-call? | Sí: identidad + monto + envío real → chat entre tools + elicitation en `nx_transfer` |
| ¿Auth upstream? | PIN por perfil (`pin_env` → var en `.env`); nunca via elicitation |
| ¿Varios celus? | `~/.config/no-phone/phones.json` · `nx_phones` / `nx_phone_usar` |
| ¿Comprobante? | Nodo NX guarda PNG en el **host del MCP**; WhatsApp (whatsmeow) es otro nodo |

## Phase 2 — Deployment

**Local stdio** (prototipo personal).

No remote HTTP: el server *debe* tocar el celular/adb en esta máquina.

Upgrade path: **MCPB** (`build-mcpb`) cuando quiera instalarlo en Claude Desktop sin depender del venv path.

## Phase 3 — Tool pattern (secretaria)

One tool per action. Reads vs writes separados. Transferencia en **3 pasos** para feedback humano:

| Tool | Rol | Annotations |
|------|-----|-------------|
| `nx_inicio` | read | readOnlyHint |
| `nx_saldo` | read | readOnlyHint |
| `nx_movimientos` | read | readOnlyHint |
| `nx_contactos` | read | readOnlyHint |
| `nx_actividad` | read | readOnlyHint |
| `device_info` | read | readOnlyHint |
| `nx_destino_resolver` | write-safe · paso 1 | openWorldHint · progress |
| `nx_transfer_armar` | write-safe · paso 2 | openWorldHint · progress |
| `nx_transfer_cancelar` | write-safe | openWorldHint |
| `nx_transfer` | write destructive · paso 3 | destructiveHint + elicitation |
| `nx_transfer_y_comprobante` | envío + PNG mismo lock | destructiveHint + elicitation |
| `nx_transfer_preview` | atajo one-shot dry-run | openWorldHint |
| `nx_comprobante_buscar` | candidatas (contraparte/monto) + pregunta | openWorldHint |
| `nx_comprobante_guardar` | PNG del recibo en el host (`archivo`) | openWorldHint · progress |

### Devolver una recibida

`nx_origen_recibida(monto?, contraparte?)` → si `ambiguo`, confirmá índice → `origen_resuelto` → `nx_destino_resolver(cbu_cvu)`. Verifica detalle vs filtros. No adivinar entre varias recibidas; no usar el teléfono de WA como destino NX.

### Velocidad

- `nx_transfer_y_comprobante`: un `device_lock`, post-éxito → Cuentas → Movimientos (sin re-despertar).
- Agenda `~/.local/share/no-phone/agenda.json`: «Juan Pérez» / Juancho → CVU/alias al resolver.
- `NX_UI_MODE=fast` (default) acorta sleeps; `normal` / `safe` si flaquea el UI.

### Huella / recien (anti-equivocación)

Tras `nx_transfer` OK se guarda huella (`~/.local/share/no-phone/last_enviada.json`: monto, titular, código, nro…).  
`nx_comprobante_guardar(recien=true)` exige match en el detalle. Si hay varias enviadas parecidas sin `nro_operacion` → `ambiguo`. Si el detalle no matchea → `no_coincide` (no guarda PNG). Vigencia 30 min. Pantalla se mantiene encendida tras transfer OK para encadenar.

### Comprobante = dos nodos

Casos típicos (conversacional):

- «el de recién» → `buscar` (o guardar indice=0) → confirmás → `guardar` → `wa_enviar_preview`
- «$1 a Emiliano» → `buscar(contraparte=Emiliano, monto=1)` → confirmás índice → `guardar`
- «N° 1519…» → `guardar(nro_operacion=…)`

1. **no-phone** `nx_comprobante_buscar` / `nx_comprobante_guardar` → detalle → «Ver comprobante» → (cancela chooser si aparece) → espera título «Comprobante» en `TransferReceiptActivity` → PNG en `~/.local/share/no-phone/comprobantes/` (`NX_COMPROBANTES_DIR`).
2. **whatsapp** `wa_enviar_preview(destino, archivo=<path>)` → confirmación → `wa_enviar`.

El PNG oficial de NX vive en cache privada del celu; ADB no lo lee. La copia usable es la captura en el host. No automatizar el chooser → WhatsApp del Redmi.

### Estados que la secretaria debe narrar

| `estado` | Qué decir |
|----------|-----------|
| `destino_resuelto` | «Puse X y sale **Titular — Entidad**. ¿Es este?» |
| `destino_no_encontrado` / `destino_invalido` | «No encontré a nadie / destino vacío» → pedir otro |
| `saldo_insuficiente` | «Querés $Y y hay $Z» → parar |
| `monto_rechazado` | «Naranja no habilita Continuar con ese monto (mín ~$0,10)» |
| `listo_para_enviar` | «¿Mando $Y a Titular?» |
| `ok` | Comprobante / código |
| `device_busy` / `sin_internet` | Avisar y no apilar |

## Phase 4 — Framework

**FastMCP** (Python) — mismo lenguaje que `naranjax.py` / FastAPI.  
Progress: `ctx.report_progress` + `ctx.info` vía callback `on_step`.

## Phase 5 — Scaffold

Archivo: `mcp_server.py` (stdio). Entrypoint: `python mcp_server.py`.  
Smoke: `scripts/smoke_secretaria.py`.

## Phase 6 — Clients

```bash
# Claude Code (Omarchy)
claude mcp add no-phone -e ANDROID_SERIAL=TU_SERIAL -- \
  /home/ivanbustos/Documentos/GitHub/no-phone/.venv/bin/python \
  /home/ivanbustos/Documentos/GitHub/no-phone/mcp_server.py

# Inspector
npx @modelcontextprotocol/inspector \
  /home/ivanbustos/Documentos/GitHub/no-phone/.venv/bin/python \
  /home/ivanbustos/Documentos/GitHub/no-phone/mcp_server.py
```

Grok Build (`~/.grok/config.toml`):

```toml
[mcp_servers.no-phone]
command = "/home/ivanbustos/Documentos/GitHub/no-phone/.venv/bin/python"
args = ["/home/ivanbustos/Documentos/GitHub/no-phone/mcp_server.py"]
enabled = true
startup_timeout_sec = 30

  [mcp_servers.no-phone.env]
  ANDROID_SERIAL = "TU_SERIAL"
```

## No aplica (aún)

- Remote streamable-HTTP / Cloudflare Workers
- MCP app widgets (`build-mcp-app`)
- MCPB pack (`build-mcpb`) — pendiente cuando se quiera distribuir
- Directory submission
