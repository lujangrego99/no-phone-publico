# admin/ — consola web (para agentes)

Antes de tocar cualquier cosa visual, leé `../DESIGN.md` (sistema v2, 2026-10-22). El v1 «Cracktro Scroller Queue»
quedó como historia en `../DESIGN-v1.md`: Goyo eligió evolucionarlo (negro + ámbar + Departure Mono para la marca;
superficies, colores de estado con texto y Atkinson Hyperlegible para leer).

Reglas que más se rompen:
- Una sola acción primaria (ámbar lleno) por vista. El ámbar es acción, nunca estado.
- Estado = `chip` con `data-tono` (ok/bad/info/warn/wait/off) y siempre con texto.
- Nada de `alert()`/`confirm()`: `confirmar()` para lo irreversible, `toast()` (con «deshacer» si se puede) para avisar.
- Detalle/edición que tapa la vista = `Dialog` de `components/ui.tsx` (Esc, tocar afuera, ×; hoja en el celu).
- Listas en `.filas`/superficie; ajustes en `Panel` con «guardar» que se prende solo con cambios.
- Texto que se lee en Atkinson; Departure Mono solo marca/títulos.
- Celu: tab bar abajo, 44 px con el dedo, inputs 16 px, sin scroll horizontal. Medir con kero-audit (checks.js).
- Secretos (API keys, PIN) son de solo escritura: nunca vuelven al front.

Celulares: el ÚNICO registro es `phones.json` (lo lee `phones.py`, que usan el MCP naranjax y la
API). `server/devices.ts` lo lee/escribe; no crear otra tabla. PIN = `<secretos>/<id>.env` con la
clave `pin_env` del perfil. Modos de UI: `fast|normal|safe` (los de naranjax.py).

WhatsApp: cada tenant tiene su puente (`tools.wa_bridge_url`, token opcional `wa_bridge_token`,
nunca vuelve al front). `server/whatsapp.ts` + `web/src/components/Whatsapp.tsx` (QR, código,
desvincular). Probar con un puente aparte (`-data <tmp> -addr 127.0.0.1:8802`), nunca desvinculando el real.

Verificar: `npx tsc -p tsconfig.json`, capturas a 1440 y 390 px (esperar a que desaparezca `.skeleton`) y el
`checks.js` de kero-audit (github.com/uxKero/kero-stack) en cada pantalla tocada: `hard` vacío y sin scroll horizontal.
Docs del proyecto (vault personal): `no-phone/CONSOLA.md` y `no-phone/DISENO.md`.
