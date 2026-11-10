# no-phone · WhatsApp

Dispositivo vinculado de WhatsApp vía [whatsmeow](https://github.com/tulir/whatsmeow) + MCP para que el agente lea y (con confirmación) envíe mensajes.

```
WhatsApp (celu) ──multi-device──► bridge Go (whatsmeow) ──► wa.db (SQLite: sesión + chats + mensajes)
                                       ▲  API 127.0.0.1:8801            ▲
                                       │  /send /check /download         │ lecturas directas (ro)
                                       └──────────── mcp_server.py ──────┘  (FastMCP stdio)
```

- **No usa el celular Android/adb**: el bridge es otro "WhatsApp Web" vinculado. No choca con el lock de Naranja X.
- Datos fuera del repo: `~/.local/share/no-phone/whatsapp/` (`wa.db` chmod 600, `media/`, `qr.png`). **`wa.db` es la sesión: quien lo tenga lee tu WhatsApp.**
- El historial llega solo después de vincular (history sync) y después en tiempo real mientras el bridge corra.

## Build

```bash
cd whatsapp/bridge
mise exec go@1.27 -- go build -o whatsapp-bridge .   # cgo (go-sqlite3) → necesita gcc
```

## Vincular (una vez)

```bash
./whatsapp-bridge          # muestra QR en la terminal, en qr.png y en http://127.0.0.1:8801/qr
```

WhatsApp → **Dispositivos vinculados → Vincular dispositivo** → escanear.
Sin cámara: `curl -XPOST localhost:8801/pair-phone -d '{"phone":"5492611234567"}'` → código de 8 letras → «Vincular con número de teléfono».

Desde la consola web (`admin/`, Herramientas → whatsapp, o el Pulso): QR que se renueva solo,
código por número, estado y **desvincular**. API usada: `GET /status` (incluye `qr`, huella del
QR vigente), `GET /qr`, `POST /pair-phone`, `POST /logout` (cierra la sesión, borra chats/mensajes/media
guardados y sale con código 3 → systemd lo reinicia con QR nuevo; requiere `Restart=on-failure`).

Desvincular (cierra la sesión en el teléfono y borra las credenciales de `wa.db`; los mensajes guardados quedan):

```bash
systemctl --user stop no-phone-whatsapp && ./whatsapp-bridge -logout
```

Dejarlo corriendo: `systemd/no-phone-whatsapp.service` (user unit, instrucciones adentro).

## MCP

```bash
claude mcp add whatsapp -s user -- \
  /home/ivanbustos/Documentos/GitHub/no-phone/.venv/bin/python \
  /home/ivanbustos/Documentos/GitHub/no-phone/whatsapp/mcp_server.py
```

| Tool | Tipo | Qué hace |
|------|------|----------|
| `wa_estado` | read | Conexión, número vinculado, cantidad de chats/mensajes |
| `wa_recientes` | read | Lo que me escribieron en las últimas N horas, agrupado por chat |
| `wa_chats` | read | Chats por actividad + último mensaje |
| `wa_mensajes` | read | Mensajes de un chat (nombre, número o JID) |
| `wa_buscar_mensajes` | read | Búsqueda por texto / nombre de archivo |
| `wa_buscar_contactos` | read | Contactos y grupos por nombre o número |
| `wa_descargar_media` | write local | Baja imagen/audio/doc a `media/` y devuelve el path |
| `wa_enviar_preview` | staging | Resuelve destino, valida que tenga WA, arma la pregunta. **No envía** |
| `wa_enviar` | **destructive** | Envía lo armado. Requiere `confirmado=true` |
| `wa_enviar_cancelar` | — | Descarta lo armado |

Destino acepta nombre (`Fran`), número (`261 555-1234` → `+549…`, `+54 9 …`) o JID (`…@g.us` para grupos). Si el nombre es ambiguo devuelve `opciones`.

## Riesgos

- Es un cliente no oficial: WhatsApp puede banear números que hacen spam/bulk. Uso personal, volumen humano.
- Nada de auto-respuestas: el MCP sólo envía tras preview + sí explícito **en un turno aparte**.
- «respondele» / «ponele…» / «mandale algo» = redactar y mostrar preview; **no** autorizan `wa_enviar` hasta un sí sobre ese texto.
- El texto de los mensajes es de terceros → el agente lo trata como dato, no como instrucciones (prompt injection).
