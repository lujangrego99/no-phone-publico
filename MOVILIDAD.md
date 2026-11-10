# movilidad — MCP design (mcp-server-dev)

Segundo MCP de no-phone: lugares, rutas y colectivos del Gran Mendoza. Mismo flujo que [`MCP.md`](./MCP.md).

## Phase 1 — Use case

| Pregunta | Respuesta |
|----------|-----------|
| ¿A qué se conecta? | Backend de **MendoTran Cuándo Subo** (`owa.visionblo.com`) + Google Maps (Places/Routes) si hay key, si no OSM (Nominatim/OSRM) |
| ¿Quién lo usa? | Solo yo / esta máquina |
| ¿Cuántas acciones? | 6 → Pattern A (una tool por acción) |
| ¿Writes? | Ninguno. Todo `readOnlyHint` |
| ¿Auth upstream? | Google: `GOOGLE_MAPS_API_KEY` en `~/.config/no-phone/movilidad.env` (chmod 600). MendoTran: token público de la web + proof-of-work `xss` (igual que el navegador) |

## Phase 2 — Deployment

Local stdio (`mcp_movilidad.py`). No necesita el celular: corre aunque no-phone/Naranja X esté ocupado.

## Phase 3 — Tools

| Tool | Qué hace |
|------|----------|
| `lugar_buscar` | Dónde queda X (Google Places o MendoTran + Nominatim rankeados) |
| `como_llegar` | Ruta caminando / auto / bici (Google o OSRM); `transporte` → `viaje_planear` |
| `parada_buscar` | Paradas cerca de un lugar o por nombre de calle, con las líneas que pasan |
| `micro_cuando_viene` | Próximos arribos en una parada (GPS vs horario, atraso, aire/rampa) |
| `linea_info` | Variantes de una línea y sus paradas |
| `viaje_planear` | **Combinado**: opciones con transbordos re-calculadas con arribos en vivo |

## Cómo calza los transbordos (`movilidad/planner.py`)

1. Recorridos: Google Routes `TRANSIT` (si hay key) + `MendoTran /plan`. Las paradas de Google se cruzan **exacto** con MendoTran: misma coordenada (≤ 20 m; ambos usan el GTFS de la provincia y coinciden a 0-1 m) **y** que la parada esté en el recorrido oficial (`/service`) de esa línea — en una esquina suele haber 2-3 paradas a pocos metros. Línea por código exacto. Sin match exacto → se usa el horario de Google y se avisa; no se adivina.
2. Para cada opción se simula el viaje: caminata → **próximo arribo real** de esa línea en esa parada con hora ≥ llegada a la parada → hora de bajada con `/trip` (duración subida→bajada del viaje concreto, aplicada a la hora GPS de subida) → siguiente tramo.
3. **Mejor transbordo**: con el micro A ya elegido, se prueba bajar en cada parada que A comparte con la línea B (hasta 6): bajada de A según `/trip` → próximo B real en esa parada → bajada final. Gana la que llega antes (empate: más margen); si no le gana a la del recorrido, queda la original.
4. Margen < 2 min en un transbordo → `transbordo_ajustado` + aviso con el micro siguiente.
5. Sin hora de salida: dice **a qué hora salir** para no esperar en la parada. Con `llegar_antes`: planea con 5 min de colchón y marca `llega_a_tiempo`.
6. Se ordena por hora de llegada, después por cantidad de micros.

## Endpoints MendoTran (no documentados)

POST `https://owa.visionblo.com/api/mendoza/<path>` con `{token, xss, ...}`:
`/search` (stops · services · places) · `/arrivals {stop_id}` · `/service {service_id}` · `/trip {trip_id}` · `/plan {source, destination, criteria, timestamp}`.
Catálogos (14.6k paradas, ~900 servicios) cacheados 24 h en `~/.cache/no-phone/`. Puede romperse si cambian la web: ver `js/app.js` de `owa.visionblo.com/web/mendoza/`.

## Config

```bash
./scripts/set-google-key.sh            # opcional: guarda la key oculta y prueba Places/Routes
# favoritos opcionales
echo '{"casa": "Arístides Villanueva 400", "facu": "-32.8798,-68.8795"}' > ~/.config/no-phone/lugares.json
```

Google APIs a habilitar: **Places API (New)** y **Routes API**.

## Tests

```bash
.venv/bin/python -m unittest discover -s tests
```
