"""Lugares y rutas.

Con GOOGLE_MAPS_API_KEY → Google Places API (New) + Routes API (incluye transporte público).
Sin key → Nominatim (OSM) + buscador de Mendotran para lugares; OSRM (routing.openstreetmap.de)
para caminando/auto/bici. El transporte público sin key lo resuelve el planificador de Mendotran.

La key se lee de la env o de ~/.config/no-phone/movilidad.env (chmod 600). Nunca se loguea.
"""
from __future__ import annotations

import json
import os
import re
import threading
import time
import unicodedata
from datetime import datetime, timezone
from difflib import SequenceMatcher
from pathlib import Path
from typing import Any

import httpx

from . import lugares
from .util import CENTRO, distancia_m, parse_codigo_parada, parse_latlng

CONFIG_DIR = Path(os.environ.get("XDG_CONFIG_HOME", Path.home() / ".config")) / "no-phone"
ENV_FILE = CONFIG_DIR / "movilidad.env"
LUGARES_FILE = CONFIG_DIR / "lugares.json"  # {"casa": "Calle 123, Godoy Cruz", "facu": "-32.88,-68.87"}

MODOS = {"caminando": "WALK", "auto": "DRIVE", "bici": "BICYCLE", "moto": "TWO_WHEELER", "transporte": "TRANSIT"}
OSRM_PERFIL = {"caminando": "routed-foot", "auto": "routed-car", "bici": "routed-bike"}


class MapsError(RuntimeError):
    pass


def _cargar_env() -> None:
    if ENV_FILE.exists():
        for linea in ENV_FILE.read_text().splitlines():
            if "=" in linea and not linea.lstrip().startswith("#"):
                k, v = linea.split("=", 1)
                os.environ.setdefault(k.strip(), v.strip().strip("'\""))


_VACIAS = {"de", "la", "el", "los", "las", "del", "y", "en", "mendoza", "calle", "av", "avenida"}


def _tokens(texto: str) -> set[str]:
    t = unicodedata.normalize("NFD", texto.lower())
    t = "".join(c for c in t if unicodedata.category(c) != "Mn")
    return {w for w in re.split(r"[^a-z0-9]+", t) if len(w) > 1 and w not in _VACIAS}


def _segundos(dur: str | None) -> int:
    return int(float(dur.rstrip("s"))) if dur else 0


def _latlng(loc: dict) -> tuple[float, float]:
    ll = loc.get("latLng", loc)
    return (ll["latitude"], ll["longitude"])


def _key_del_archivo() -> str | None:
    if not ENV_FILE.exists():
        return None
    for linea in ENV_FILE.read_text().splitlines():
        if linea.strip().startswith("GOOGLE_MAPS_API_KEY="):
            return linea.split("=", 1)[1].strip().strip("'\"") or None
    return None


class Maps:
    def __init__(self, mendotran=None):
        _cargar_env()
        self._key_env = os.environ.get("GOOGLE_MAPS_API_KEY") or None
        self._key_mtime: float | None = None
        self._key_archivo: str | None = None
        self.mendotran = mendotran
        self.http = httpx.Client(timeout=20, headers={"User-Agent": "no-phone-movilidad/0.1 (uso personal)"})
        self._nominatim_lock = threading.Lock()
        self._nominatim_t = 0.0

    @property
    def key(self) -> str | None:
        """La key se relee de movilidad.env si cambió (la carga la consola): sin reiniciar el conector.
        El archivo manda sobre la env; si se borra, vuelve la de la env (o nada → OpenStreetMap)."""
        try:
            mtime = ENV_FILE.stat().st_mtime
        except OSError:
            mtime = None
        if mtime != self._key_mtime:
            self._key_mtime, self._key_archivo = mtime, _key_del_archivo() if mtime else None
        return self._key_archivo or self._key_env

    @property
    def proveedor(self) -> str:
        return "google" if self.key else "osm"

    # ── favoritos ───────────────────────────────────────────────
    def favoritos(self) -> dict[str, str]:
        if LUGARES_FILE.exists():
            try:
                return {k.lower(): v for k, v in json.loads(LUGARES_FILE.read_text()).items()}
            except json.JSONDecodeError:
                return {}
        return {}

    # ── lugares ─────────────────────────────────────────────────
    def buscar_lugar(self, consulta: str, limite: int = 5, cerca: tuple[float, float] | None = None) -> list[dict]:
        cerca = cerca or CENTRO
        if self.key:
            res = self._google_places(consulta, limite, cerca)
            if res:
                return res
        res: list[dict] = []
        if self.mendotran:
            try:
                for p in self.mendotran.buscar(consulta, ("places",))[:10]:
                    lng, lat = p["coordinates"]
                    res.append({"nombre": p.get("name"), "direccion": p.get("city"), "lat": lat, "lng": lng, "fuente": "mendotran"})
            except Exception:  # noqa: BLE001 — respaldo, seguimos con OSM
                pass
        res += self._nominatim(consulta, 5)
        for r in res:
            r["distancia_centro_m"] = round(distancia_m(cerca, (r["lat"], r["lng"])))
        # sin Google el ranking de las fuentes es flojo: primero cuántas palabras de la consulta
        # aparecen en el nombre, después cercanía al centro
        toks = _tokens(consulta)
        def score(r: dict) -> tuple:
            nombre = _tokens(f"{r.get('nombre') or ''}")
            todo = _tokens(f"{r.get('nombre') or ''} {r.get('direccion') or ''}")
            en_nombre = sum(t in nombre for t in toks)
            en_todo = sum(t in todo for t in toks)
            lejos = r["distancia_centro_m"] > 25000  # fuera del Gran Mendoza: al final
            parecido = SequenceMatcher(None, " ".join(sorted(toks)), " ".join(sorted(nombre))).ratio()
            return (en_todo == 0, lejos, -en_nombre, -en_todo, -round(parecido, 1), r["distancia_centro_m"])
        res.sort(key=score)
        if toks:  # sin Google: si ninguna palabra de lo pedido aparece, es otra cosa («Ferretería Pepe» → «Hospital Central»)
            res = [r for r in res if score(r)[0] is False]
        vistos, unicos = set(), []
        for r in res:
            k = ((r.get("nombre") or "").lower(), round(r["lat"], 3), round(r["lng"], 3))
            if k not in vistos:
                vistos.add(k)
                unicos.append(r)
        return unicos[:limite]

    def _google_places(self, consulta: str, limite: int, cerca: tuple[float, float]) -> list[dict]:
        r = self.http.post(
            "https://places.googleapis.com/v1/places:searchText",
            headers={
                "X-Goog-Api-Key": self.key,
                "X-Goog-FieldMask": "places.displayName,places.formattedAddress,places.location,places.primaryTypeDisplayName,"
                "places.currentOpeningHours.openNow,places.rating,places.googleMapsUri",
            },
            json={
                "textQuery": consulta,
                "languageCode": "es",
                "regionCode": "AR",
                "pageSize": limite,
                "locationBias": {"circle": {"center": {"latitude": cerca[0], "longitude": cerca[1]}, "radius": 40000.0}},
            },
        )
        if r.status_code >= 400:
            raise MapsError(f"Google Places {r.status_code}: {r.text[:300]}")
        out = []
        for p in r.json().get("places") or []:
            lat, lng = _latlng(p["location"])
            item = {
                "nombre": (p.get("displayName") or {}).get("text"),
                "direccion": p.get("formattedAddress"),
                "lat": lat,
                "lng": lng,
                "tipo": (p.get("primaryTypeDisplayName") or {}).get("text"),
                "fuente": "google",
                "link": p.get("googleMapsUri"),
            }
            if p.get("rating"):
                item["rating"] = p["rating"]
            if "currentOpeningHours" in p:
                item["abierto_ahora"] = p["currentOpeningHours"].get("openNow")
            out.append(item)
        return out

    def _nominatim(self, consulta: str, limite: int) -> list[dict]:
        with self._nominatim_lock:  # política Nominatim: ≤1 req/s
            espera = 1.0 - (time.time() - self._nominatim_t)
            if espera > 0:
                time.sleep(espera)
            self._nominatim_t = time.time()
            r = self.http.get(
                "https://nominatim.openstreetmap.org/search",
                params={
                    "q": consulta,
                    "format": "jsonv2",
                    "limit": limite,
                    "countrycodes": "ar",
                    "accept-language": "es",
                    "viewbox": "-69.2,-32.6,-68.5,-33.2",
                    "bounded": 0,
                },
            )
        if r.status_code >= 400:
            return []
        out = []
        for x in r.json():
            partes = [p.strip() for p in x["display_name"].split(",")]
            nombre = x.get("name") or (f"{partes[1]} {partes[0]}" if partes[0].isdigit() and len(partes) > 1 else partes[0])
            out.append({"nombre": nombre, "direccion": ", ".join(partes[:4]),
                        "lat": float(x["lat"]), "lng": float(x["lon"]), "fuente": "osm"})
        return out

    def resolver(self, texto: str) -> dict:
        """Texto libre → punto. Acepta 'lat,lng', código de parada ('M1031'), favorito ('casa') o dirección/lugar."""
        t = (texto or "").strip()
        if not t:
            raise MapsError("Punto vacío")
        ll = parse_latlng(t)
        if ll:
            return {"nombre": t, "lat": ll[0], "lng": ll[1], "fuente": "coordenadas"}
        cod = parse_codigo_parada(t)
        if cod and self.mendotran:
            s = self.mendotran.parada(cod)
            if s:
                lng, lat = s["coordinates"]
                return {"nombre": f"Parada {s['code']} — {s.get('location')}", "lat": lat, "lng": lng, "fuente": "parada", "stop_id": s["stop_id"]}
        fav = self.favoritos().get(t.lower())
        if fav:
            p = self.resolver(fav)
            p["nombre"] = f"{t} ({p.get('nombre') or fav})"
            return p
        # «casa», «el laburo», «lo de mi vieja»: de la agenda del dueño, nunca de Google («casa» → «Casa Segal»).
        lug = lugares.buscar(t)  # LugarDesconocido (ValueError) sube tal cual: el MCP lo devuelve como lugar_desconocido
        if lug:
            p = self.resolver(lug["direccion"])
            p.pop("otras_opciones", None)
            return {**p, "nombre": lug["decir"], "direccion": lug["direccion"], "fuente": "agenda", "ficha": lug["ficha"]}
        res = self.buscar_lugar(t, limite=3)
        if not res:
            raise MapsError(f"No encontré «{t}». Probá con calle y altura + departamento, o un lugar conocido.")
        p = dict(res[0])
        if len(res) > 1:
            p["otras_opciones"] = [f"{r['nombre']} — {r.get('direccion')}" for r in res[1:]]
        return p

    # ── rutas ───────────────────────────────────────────────────
    def ruta(self, origen: dict, destino: dict, modo: str = "caminando", salida_ms: int | None = None,
             alternativas: bool = True, llegada_ms: int | None = None) -> list[dict]:
        if modo not in MODOS:
            raise MapsError(f"Modo inválido: {modo}. Usá {', '.join(MODOS)}")
        if self.key:
            return self._google_routes(origen, destino, modo, salida_ms, alternativas, llegada_ms)
        if modo == "transporte":
            raise MapsError("Transporte sin Google: usar el planificador de Mendotran (viaje_planear).")
        perfil = OSRM_PERFIL.get(modo)
        if not perfil:
            raise MapsError(f"Modo {modo} requiere Google Maps API key")
        return self._osrm(origen, destino, perfil)

    def _google_routes(self, origen: dict, destino: dict, modo: str, salida_ms: int | None, alternativas: bool,
                       llegada_ms: int | None = None) -> list[dict]:
        body: dict[str, Any] = {
            "origin": {"location": {"latLng": {"latitude": origen["lat"], "longitude": origen["lng"]}}},
            "destination": {"location": {"latLng": {"latitude": destino["lat"], "longitude": destino["lng"]}}},
            "travelMode": MODOS[modo],
            "languageCode": "es-419",
            "units": "METRIC",
            "computeAlternativeRoutes": alternativas,
        }
        if modo == "auto":
            body["routingPreference"] = "TRAFFIC_AWARE"
        if llegada_ms and modo == "transporte":
            body["arrivalTime"] = _rfc3339(llegada_ms)
        elif salida_ms and (modo == "transporte" or salida_ms > time.time() * 1000):
            body["departureTime"] = _rfc3339(salida_ms)
        r = self.http.post(
            "https://routes.googleapis.com/directions/v2:computeRoutes",
            headers={
                "X-Goog-Api-Key": self.key,
                "X-Goog-FieldMask": "routes.duration,routes.distanceMeters,routes.description,"
                "routes.legs.steps.travelMode,routes.legs.steps.staticDuration,routes.legs.steps.distanceMeters,"
                "routes.legs.steps.navigationInstruction,routes.legs.steps.transitDetails,"
                "routes.legs.steps.startLocation,routes.legs.steps.endLocation",
            },
            json=body,
        )
        if r.status_code >= 400:
            raise MapsError(f"Google Routes {r.status_code}: {r.text[:300]}")
        rutas = []
        for rt in r.json().get("routes") or []:
            pasos = [s for leg in rt.get("legs") or [] for s in leg.get("steps") or []]
            rutas.append({
                "duracion_min": round(_segundos(rt.get("duration")) / 60),
                "distancia_m": rt.get("distanceMeters"),
                "por": rt.get("description"),
                "tramos": _tramos_google(pasos),
                "fuente": "google",
            })
        return rutas

    def _osrm(self, origen: dict, destino: dict, perfil: str) -> list[dict]:
        url = (f"https://routing.openstreetmap.de/{perfil}/route/v1/driving/"
               f"{origen['lng']},{origen['lat']};{destino['lng']},{destino['lat']}")
        r = self.http.get(url, params={"overview": "false", "steps": "true", "alternatives": "true"})
        if r.status_code >= 400:
            raise MapsError(f"OSRM {r.status_code}")
        rutas = []
        for rt in r.json().get("routes") or []:
            pasos = [_instruccion_osrm(s) for leg in rt["legs"] for s in leg["steps"]]
            rutas.append({
                "duracion_min": round(rt["duration"] / 60),
                "distancia_m": round(rt["distance"]),
                "tramos": [{"tipo": "camino", "instrucciones": [p for p in pasos if p]}],
                "fuente": "osm",
            })
        return rutas


_TIPO_PASO = {"WALK": "caminar", "DRIVE": "manejar", "BICYCLE": "bici", "TWO_WHEELER": "moto"}


def _tramos_google(pasos: list[dict]) -> list[dict]:
    """Agrupa pasos de Google: pasos consecutivos del mismo modo → un tramo; cada paso TRANSIT → un tramo micro."""
    tramos: list[dict] = []
    for s in pasos:
        td = s.get("transitDetails")
        if td:
            sd = td.get("stopDetails") or {}
            dep, arr = sd.get("departureStop") or {}, sd.get("arrivalStop") or {}
            line = td.get("transitLine") or {}
            tramos.append({
                "tipo": "micro",
                "linea": (line.get("nameShort") or line.get("name") or "").strip(),
                "cartel": td.get("headsign") or line.get("name"),
                "vehiculo": ((line.get("vehicle") or {}).get("type") or "").lower(),
                "sube": {"nombre": dep.get("name"), **_ll(dep.get("location"))},
                "baja": {"nombre": arr.get("name"), **_ll(arr.get("location"))},
                "sale_ms": _ms(sd.get("departureTime")),
                "llega_ms": _ms(sd.get("arrivalTime")),
                "paradas": td.get("stopCount"),
                "duracion_s": _segundos(s.get("staticDuration")),
            })
            continue
        instr = (s.get("navigationInstruction") or {}).get("instructions")
        tipo = _TIPO_PASO.get(s.get("travelMode") or "WALK", "caminar")
        if tramos and tramos[-1]["tipo"] == tipo:
            t = tramos[-1]
        else:
            t = {"tipo": tipo, "duracion_s": 0, "distancia_m": 0, "instrucciones": []}
            tramos.append(t)
        t["duracion_s"] += _segundos(s.get("staticDuration"))
        t["distancia_m"] += s.get("distanceMeters") or 0
        if instr:
            t["instrucciones"].append(instr.replace("\n", " "))
    return tramos


def _rfc3339(ms: int) -> str:
    return datetime.fromtimestamp(ms / 1000, timezone.utc).isoformat().replace("+00:00", "Z")


def _ll(loc: dict | None) -> dict:
    if not loc:
        return {}
    lat, lng = _latlng(loc)
    return {"lat": lat, "lng": lng}


def _ms(iso: str | None) -> int | None:
    if not iso:
        return None
    return int(datetime.fromisoformat(iso.replace("Z", "+00:00")).timestamp() * 1000)


_GIRO = {"left": "a la izquierda", "right": "a la derecha", "slight left": "levemente a la izquierda",
         "slight right": "levemente a la derecha", "sharp left": "fuerte a la izquierda",
         "sharp right": "fuerte a la derecha", "straight": "derecho", "uturn": "en U"}


def _instruccion_osrm(s: dict) -> str | None:
    man = s.get("maneuver") or {}
    tipo, mod = man.get("type"), man.get("modifier")
    calle = s.get("name") or ""
    dist = round(s.get("distance") or 0)
    sobre = f" por {calle}" if calle else ""
    if tipo == "depart":
        return f"Salí{sobre} ({dist} m)"
    if tipo == "arrive":
        return "Llegaste a destino"
    if tipo in ("roundabout", "rotary"):
        return f"En la rotonda tomá la salida {man.get('exit', '')}{sobre} ({dist} m)"
    if tipo in ("turn", "end of road", "fork", "on ramp", "off ramp", "new name", "continue"):
        giro = _GIRO.get(mod or "", "")
        verbo = "Seguí" if tipo in ("new name", "continue") or mod == "straight" else "Doblá"
        return f"{verbo} {giro}{sobre} ({dist} m)".replace("  ", " ")
    return f"Seguí{sobre} ({dist} m)" if dist else None
