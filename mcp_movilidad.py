"""movilidad MCP — local stdio: lugares/rutas (Google Maps u OSM) + colectivos Mendoza (MendoTran en tiempo real).

Todo es lectura (no toca el celular ni plata). La pieza combinada es `viaje_planear`:
opciones de micro con transbordos, re-calculadas con los arribos GPS del momento.

Correr:
  .venv/bin/python mcp_movilidad.py
Config (opcional): ~/.config/no-phone/movilidad.env  → GOOGLE_MAPS_API_KEY=...
                   ~/.config/no-phone/lugares.json   → {"casa": "dirección", "facu": "lat,lng"}
"""
from __future__ import annotations

import json
from concurrent.futures import ThreadPoolExecutor
from typing import Any, Literal

from fastmcp import FastMCP

from mcp_http import mcp_auth, run as run_mcp

from movilidad import lugares as _lug
from movilidad.maps import Maps, MapsError
from movilidad.mendotran import Mendotran, MendotranError
from movilidad.planner import Planificador
from movilidad.util import ahora_ms, hhmm, parse_hora

_mt = Mendotran()
_maps = Maps(_mt)
_plan = Planificador(_mt, _maps)

mcp = FastMCP(
    name="movilidad",
    auth=mcp_auth("movilidad", required_reason="usa tus API keys"),
    instructions=(
        "Movilidad en el Gran Mendoza: lugares, cómo llegar y colectivos MendoTran en tiempo real. Todo es lectura.\n\n"
        "- ¿Dónde queda X? → lugar_buscar.\n"
        "- ¿Cómo llego a X caminando/en auto/bici? → como_llegar.\n"
        "- ¿Cuándo viene el micro en tal parada? → micro_cuando_viene (parada = código tipo M1031; "
        "si el usuario da una esquina o lugar, primero parada_buscar).\n"
        "- ¿Cómo voy en micro / en colectivo / qué tomo? → viaje_planear. Ya combina recorridos con los "
        "arribos GPS del momento: respondé con la mejor opción (sali/llegas, líneas, `pasos`) y mencioná "
        "transbordos ajustados (`avisos`) y la alternativa si conviene.\n"
        "Si un punto vuelve con `otras_opciones`, confirmá con el usuario si el lugar elegido no es el que quería.\n"
        "PUNTO DE PARTIDA: si tu dueño dijo dónde está, pasalo en `origen` tal cual ('casa', 'el laburo', 'la facu', "
        "'lo de mi vieja', una dirección). Si NO lo dijo, no lo inventes: dejá `origen` vacío y la herramienta lo supone "
        "(donde iba en su último viaje de hoy, si no su casa) y lo marca en origen.supuesto. Empezá SIEMPRE la respuesta "
        "con `desde` («Desde tu casa, …»); si fue supuesto, cerrá con «si salís de otro lado, decime». 'casa', 'el laburo', "
        "'lo de X' salen de la agenda: si vuelve error lugar_desconocido, preguntale la dirección UNA vez y guardala con "
        "agenda_lugar; nunca la busques en Google.\n"
        "Recomendá la opción con `recomendada` (es la primera) y nombrá la parada de subida como viene en `pasos`: "
        "no inventes paradas ni horarios. Horas en hora de Mendoza. Hablá en español."
    ),
)

_RO = {"readOnlyHint": True, "destructiveHint": False, "openWorldHint": True}


def _dumps(data: Any) -> str:
    return json.dumps(_limpiar(data), ensure_ascii=False, indent=1, default=str)


def _limpiar(x: Any) -> Any:
    """Saca campos internos (epoch ms, ids de viaje) para no gastar tokens."""
    if isinstance(x, dict):
        return {k: _limpiar(v) for k, v in x.items()
                if not k.endswith("_ms") and k not in ("trip_id", "service_id", "llegada_estimada_por") and v is not None}
    if isinstance(x, list):
        return [_limpiar(v) for v in x]
    return x


def _err(e: Exception) -> str:
    if isinstance(e, _lug.LugarDesconocido):
        return _dumps({"error": "lugar_desconocido", "detalle": str(e)})
    return _dumps({"error": type(e).__name__, "detalle": str(e)})


def _origen(origen: str | None, destino: str) -> tuple[str, str | None]:
    """Origen dicho → tal cual. Sin origen → el supuesto (último viaje de hoy / casa) y por qué."""
    if not _lug.es_aca(origen):
        return str(origen), None
    return _lug.suponer_origen(destino)


def _con_desde(r: dict, origen_texto: str, destino: str, supuesto: str | None) -> dict:
    """Marca desde dónde (para decirlo en voz alta) y anota el viaje en el historial."""
    o = r.get("origen") if isinstance(r.get("origen"), dict) else {}
    if supuesto:
        o["supuesto"] = supuesto
    r["desde"] = f"desde {o.get('nombre') or origen_texto}" + (" (supuesto)" if supuesto else "")
    ops = r.get("opciones") or []
    llegada = ops[0].get("llegada_ms") if ops else None
    _lug.registrar(o, r.get("destino") or {}, llegada, origen_texto, destino)
    return r


_RESUMEN = ("recomendada", "lineas", "sali", "sali_epoch", "llegas", "duracion_min", "caminata_min", "llega_a_tiempo", "pasos", "avisos",
            "fuente", "tambien_en", "sube")


def _a_pie_min(r: dict) -> int | None:
    """Minutos caminando en línea recta ×1,3 (calles) a 75 m/min: para avisar cuando el bondi no conviene."""
    import math

    try:
        a, b = r["origen"], r["destino"]
        la1, lo1, la2, lo2 = map(math.radians, (a["lat"], a["lng"], b["lat"], b["lng"]))
        h = math.sin((la2 - la1) / 2) ** 2 + math.cos(la1) * math.cos(la2) * math.sin((lo2 - lo1) / 2) ** 2
        metros = 2 * 6371000 * math.asin(math.sqrt(h)) * 1.3
        return max(1, round(metros / 75))
    except (KeyError, TypeError, ValueError):
        return None


def _compacto(r: dict, detalle: bool) -> dict:
    """Resumen primero; los tramos crudos solo con detalle=true. Sin las «otras_opciones» de cada punto
    (ruido para el modelo) y con cuánto se tarda a pie, para no mandar a nadie a un bondi de 40 min por 15 cuadras."""
    ops = []
    for op in r.get("opciones") or []:
        o = {k: op[k] for k in _RESUMEN if op.get(k) not in (None, [], "")}
        if detalle:
            o["tramos"] = op["tramos"]
        ops.append(o)
    out = {**r, "opciones": ops}
    for k in ("origen", "destino"):
        if isinstance(out.get(k), dict) and not detalle:
            out[k] = {kk: vv for kk, vv in out[k].items() if kk not in ("otras_opciones", "fuente", "ficha")}
    pie = (r.get("caminando") or {}).get("duracion_min") or _a_pie_min(r)
    if pie:

        def _min(hhmm: str | None) -> int | None:
            try:
                h, m = map(int, str(hhmm).split(":")[:2])
                return h * 60 + m
            except (ValueError, AttributeError):
                return None

        ahora = _min(r.get("consultado"))
        llegadas = [x for x in (_min(o.get("llegas")) for o in ops) if x is not None]
        if ahora is not None and llegadas:
            mejor = min((x - ahora) % 1440 for x in llegadas)  # minutos hasta llegar en bondi (desde ahora)
            if pie <= mejor + 5:
                out["sugerencia"] = f"Caminando llegás en ~{pie} min; en bondi, en ~{mejor} min (contando la espera)."
        elif not ops:
            out["sugerencia"] = f"No hay bondi útil; caminando son ~{pie} min."
    return out


@mcp.tool(title="Buscar lugar", annotations=_RO)
def lugar_buscar(consulta: str, limite: int = 5) -> str:
    """Find a place or address in Mendoza ("Hospital Central", "Arístides 500", "farmacia cerca de plaza España").
    Returns name, address, lat/lng (and with Google: rating, open now, Maps link). limite 1–10."""
    try:
        res = _maps.buscar_lugar(consulta, max(1, min(int(limite), 10)))
        return _dumps({"proveedor": _maps.proveedor, "resultados": res})
    except (MapsError, MendotranError) as e:
        return _err(e)


@mcp.tool(title="Cómo llegar", annotations=_RO)
def como_llegar(destino: str, origen: str | None = None,
                modo: Literal["caminando", "auto", "bici", "moto", "transporte"] = "caminando",
                salida: str | None = None) -> str:
    """Directions between two points (address, place, 'lat,lng', stop code, or the owner's own places: 'casa',
    'el laburo', 'la facu', 'lo de X' — those come from the agenda). origen: only if the owner SAID where he is;
    empty → assumed (last trip today / home) and flagged in origen.supuesto. Start the answer with `desde`.
    modo: caminando | auto | bici | moto (Google only) | transporte (delegates to viaje_planear).
    salida: 'HH:MM', 'en 20' or ISO (optional). Returns duration, distance and turn-by-turn steps."""
    try:
        salida_ms = parse_hora(salida)
        origen_t, supuesto = _origen(origen, destino)
        if modo == "transporte":
            r = _plan.planear(origen_t, destino, salida_ms=salida_ms)
            return _dumps(_compacto(_con_desde(r, origen_t, destino, supuesto), False))
        o, d = _maps.resolver(origen_t), _maps.resolver(destino)
        rutas = _maps.ruta(o, d, modo, salida_ms=salida_ms)
        r = {"origen": o, "destino": d, "modo": modo, "proveedor": _maps.proveedor, "rutas": rutas[:3]}
        return _dumps(_con_desde(r, origen_t, destino, supuesto))
    except (MapsError, MendotranError, ValueError, _lug.LugarDesconocido) as e:
        return _err(e)


@mcp.tool(title="Buscar parada", annotations=_RO)
def parada_buscar(cerca_de: str | None = None, texto: str | None = None, radio_m: int = 400,
                  limite: int = 6, con_lineas: bool = True) -> str:
    """Find MendoTran bus stops. cerca_de: any place/address/'lat,lng' → nearest stops by distance.
    texto: match on the stop's street names ("San Martín y Garibaldi"). con_lineas adds which lines are
    arriving there now (one live call per stop). Use the returned `codigo` (e.g. M1031) with micro_cuando_viene."""
    try:
        limite = max(1, min(int(limite), 12))
        punto = None
        if cerca_de:
            punto = _maps.resolver(cerca_de)
            paradas = _mt.paradas_cerca(punto["lat"], punto["lng"], radio_m=max(50, min(int(radio_m), 1500)), limite=limite)
        elif texto:
            paradas = _mt.buscar_paradas_texto(texto, limite)
        else:
            return _err(ValueError("Pasá cerca_de o texto"))
        if con_lineas and paradas:
            def lineas(p):
                try:
                    arr = _mt.arribos(p["stop_id"])
                except MendotranError:
                    return p
                p["lineas"] = sorted({a["linea"] for a in arr if a["linea"]})
                return p
            with ThreadPoolExecutor(max_workers=6) as ex:
                paradas = list(ex.map(lineas, paradas))
        return _dumps({"cerca_de": punto, "paradas": paradas})
    except (MapsError, MendotranError, ValueError) as e:
        return _err(e)


@mcp.tool(title="Cuándo viene el micro", annotations=_RO)
def micro_cuando_viene(parada: str, linea: str | None = None, limite: int = 8) -> str:
    """Next arrivals at a MendoTran stop. parada: stop code ('M1031', '1031', 'L1001').
    linea: optional filter ('201', '606'). Each arrival: line, sign, time, minutes away,
    tiempo_real (GPS) vs scheduled, atraso_min (>0 late), AC/ramp when known."""
    try:
        s = _mt.parada(parada)
        if not s:
            return _err(MendotranError(f"No existe la parada {parada}. Buscala con parada_buscar."))
        arr = _mt.arribos(s["stop_id"])
        if linea:
            l = linea.strip().upper()
            arr = [a for a in arr if (a["linea"] or "").upper() == l or (a["linea"] or "").upper().startswith(l)]
        return _dumps({
            "parada": _mt.parada_publica(s),
            "consultado": hhmm(ahora_ms()),
            "consultado_epoch": round(ahora_ms() / 1000),
            "arribos": arr[: max(1, min(int(limite), 30))],
            **({"nota": f"No hay próximos arribos del {linea} en esta parada"} if linea and not arr else {}),
        })
    except MendotranError as e:
        return _err(e)


@mcp.tool(title="Info de línea", annotations=_RO)
def linea_info(linea: str, con_paradas: bool = False) -> str:
    """Variants (route signs) of a MendoTran line ('201', '100' = metrotranvía). con_paradas=true lists
    the ordered stops of each variant (codes + streets) — useful for "¿el 201 pasa por X?"."""
    try:
        vars_ = _mt.lineas(linea)
        if not vars_:
            return _err(MendotranError(f"No encontré la línea {linea}"))
        out = []
        for v in vars_[:6]:
            item = {"linea": v["code"], "cartel": v.get("name"), "modo": v.get("mode")}
            if con_paradas:
                svc = _mt.servicio(v["service_id"])
                paradas = [_mt.parada(int(sid)) for sid in svc.get("stops") or []]
                item["paradas"] = [f"{p['code']} {p.get('location')}" for p in paradas if p]
            out.append(item)
        return _dumps({"variantes": out})
    except MendotranError as e:
        return _err(e)


@mcp.tool(title="Planear viaje en micro", annotations=_RO)
def viaje_planear(destino: str, origen: str | None = None, salida: str | None = None,
                  llegar_antes: str | None = None, opciones: int = 4, detalle: bool = False,
                  modo: str | None = None) -> str:
    """Best bus trips (with transfers) between two points, re-timed with live GPS arrivals so transfers
    actually connect. origen/destino: address, place, 'lat,lng', stop code, or the owner's places ('casa', 'el laburo',
    'la facu', 'lo de X', from the agenda). origen only if the owner SAID where he is; empty → assumed (last trip
    today / home), flagged in origen.supuesto. Start the answer with `desde`. The first option is `recomendada`.
    salida: leave at 'HH:MM' / 'en 20' / ISO (default: now → tells you when to leave to not wait).
    llegar_antes: arrive by 'HH:MM'. Each option: lineas, sali, llegas, duracion_min, caminata_min,
    pasos (human steps), avisos (tight transfers, missing service). Sorted by arrival.
    detalle=true adds raw legs (stops, coordinates, walking turn-by-turn). It is always by bus: `modo` is ignored.
    caminando = walking it all; if `sugerencia` says walking is as fast, tell the owner.
    Report walking as minutes (not «cuadras»)."""
    try:
        origen_t, supuesto = _origen(origen, destino)
        r = _plan.planear(origen_t, destino, salida_ms=parse_hora(salida),
                          llegar_antes_ms=parse_hora(llegar_antes),
                          max_opciones=max(1, min(int(opciones), 6)))
        return _dumps(_compacto(_con_desde(r, origen_t, destino, supuesto), detalle))
    except (MapsError, MendotranError, ValueError, _lug.LugarDesconocido) as e:
        return _err(e)


# ---------- API interna para la consola (tarjetas interactivas: sin pasar por el modelo) ----------
import os as _os  # noqa: E402

from starlette.requests import Request  # noqa: E402
from starlette.responses import JSONResponse  # noqa: E402

_TOKEN = _os.environ.get("MCP_HTTP_TOKEN", "")


def _autorizado(req: Request) -> bool:
    return bool(_TOKEN) and req.headers.get("authorization") == f"Bearer {_TOKEN}"


def _json(texto: str) -> JSONResponse:
    return JSONResponse(json.loads(texto))


@mcp.custom_route("/movilidad/viaje", methods=["POST"])
async def r_viaje(req: Request) -> JSONResponse:
    """La tarjeta cambia el origen («salgo del laburo») o actualiza: mismo resultado que viaje_planear."""
    if not _autorizado(req):
        return JSONResponse({"error": "no_autorizado"}, status_code=401)
    b = await req.json()
    fn = getattr(viaje_planear, "fn", viaje_planear)
    import anyio
    return _json(await anyio.to_thread.run_sync(lambda: fn(destino=str(b.get("destino") or ""), origen=b.get("origen") or None,
                                                         salida=b.get("salida") or None)))


@mcp.custom_route("/movilidad/arribos", methods=["GET"])
async def r_arribos(req: Request) -> JSONResponse:
    if not _autorizado(req):
        return JSONResponse({"error": "no_autorizado"}, status_code=401)
    fn = getattr(micro_cuando_viene, "fn", micro_cuando_viene)
    import anyio
    q = req.query_params
    return _json(await anyio.to_thread.run_sync(lambda: fn(parada=q.get("parada", ""), linea=q.get("linea") or None)))


@mcp.custom_route("/movilidad/lugares", methods=["GET"])
async def r_lugares(req: Request) -> JSONResponse:
    if not _autorizado(req):
        return JSONResponse({"error": "no_autorizado"}, status_code=401)
    try:
        ls = _lug.mis_lugares()
    except Exception:  # noqa: BLE001 — sin agenda, la tarjeta no ofrece cambiar el origen
        ls = []
    return JSONResponse({"lugares": [{"nombre": l["nombre"], "apodos": l.get("apodos") or [], "direccion": l.get("direccion")} for l in ls]})


if __name__ == "__main__":
    run_mcp(mcp, default_port=8812)
