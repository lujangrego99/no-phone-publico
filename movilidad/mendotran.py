"""Cliente del backend de "MendoTran Cuándo Subo" (owa.visionblo.com, app oficial Gob. Mendoza / Wara).

No hay API pública documentada: son los mismos POST JSON que hace la web
https://owa.visionblo.com/web/mendoza/. Cada request lleva el token público de la
web y un `xss` (proof-of-work liviano: timestamp ofuscado cuyo MD5 termina en 0x?0 00),
igual que el navegador. Uso personal y de bajo volumen: cachear catálogos, no pollear.

Endpoints usados:
  /search    {text, search:[stops|services|places]}  catálogo / geocoding propio
  /arrivals  {stop_id, first_time}                   próximos arribos (scheduled + predicted GPS)
  /service   {service_id}                            recorrido de una línea (stops ordenadas)
  /trip      {trip_id}                               hora estimada en cada parada de un viaje
  /plan      {source, destination, criteria, timestamp}  planificador con transbordos
"""
from __future__ import annotations

import hashlib
import json
import os
import threading
import time
from pathlib import Path
from typing import Any

import httpx

from .util import ahora_ms, distancia_m, hhmm, minutos

API = "https://owa.visionblo.com/api/mendoza"
TOKEN = os.environ.get("MENDOTRAN_TOKEN", "")  # token de la web pública de Mendotran (owa.visionblo.com)
HEADERS = {
    "Content-Type": "application/json",
    "Origin": "https://owa.visionblo.com",
    "Referer": "https://owa.visionblo.com/web/mendoza/",
    "User-Agent": "Mozilla/5.0 (X11; Linux x86_64; rv:139.0) Gecko/20100101 Firefox/139.0",
}
CATALOGO_TTL_S = 24 * 3600


class MendotranError(RuntimeError):
    pass


def _xss() -> str:
    """Mismo algoritmo que `w()` en js/app.js de la web."""
    t = ahora_ms()
    base = [int(t / d) & 255 for d in (1, 256, 65536, 16777216, 4294967296, 1099511627776)]
    for _ in range(1 << 20):
        r = os.urandom(6)
        n = bytes(base[i] ^ r[i] for i in range(6)) + r
        h = hashlib.md5(n).digest()
        if (h[14] & 15) == 0 and h[15] == 0:
            return n.hex()
    raise MendotranError("No se pudo generar xss; reintentar")


class Mendotran:
    def __init__(self, cache_dir: Path | None = None):
        self.cache_dir = cache_dir or Path(os.environ.get("XDG_CACHE_HOME", Path.home() / ".cache")) / "no-phone"
        self.cache_dir.mkdir(parents=True, exist_ok=True)
        self.http = httpx.Client(timeout=25, headers=HEADERS)
        self._lock = threading.Lock()
        self._stops: list[dict] | None = None
        self._stops_by_id: dict[int, dict] = {}
        self._stops_by_code: dict[str, dict] = {}
        self._services: list[dict] | None = None
        self._paradas_linea: dict[str, set[int]] = {}

    # ── transporte ──────────────────────────────────────────────
    def _post(self, path: str, body: dict) -> Any:
        last: Exception | None = None
        for intento in range(2):
            try:
                r = self.http.post(API + path, json={"token": TOKEN, "xss": _xss(), **body})
                r.raise_for_status()
                return r.json()
            except (httpx.HTTPError, json.JSONDecodeError) as e:
                last = e
                time.sleep(0.5 * (intento + 1))
        raise MendotranError(f"Mendotran {path}: {last}")

    # ── catálogos (cache en disco 24h) ──────────────────────────
    def _catalogo(self, kind: str) -> list[dict]:
        f = self.cache_dir / f"mendotran-{kind}.json"
        if f.exists() and time.time() - f.stat().st_mtime < CATALOGO_TTL_S:
            return json.loads(f.read_text())
        data = self._post("/search", {"text": "", "search": [kind], "no_favorites": True}).get("search") or []
        if not data:
            if f.exists():  # server raro: mejor catálogo viejo que nada
                return json.loads(f.read_text())
            raise MendotranError(f"Catálogo {kind} vacío")
        f.write_text(json.dumps(data, ensure_ascii=False))
        return data

    def stops(self) -> list[dict]:
        with self._lock:
            if self._stops is None:
                self._stops = self._catalogo("stops")
                for s in self._stops:
                    self._stops_by_id[s["stop_id"]] = s
                    self._stops_by_code.setdefault(s["code"].upper(), s)
            return self._stops

    def services(self) -> list[dict]:
        with self._lock:
            if self._services is None:
                self._services = self._catalogo("services")
            return self._services

    def parada(self, ref: str | int) -> dict | None:
        """Por stop_id (int) o código ('M1031', 'L1001' o '1031')."""
        self.stops()
        if isinstance(ref, int):
            return self._stops_by_id.get(ref)
        code = str(ref).strip().upper()
        s = self._stops_by_code.get(code) or self._stops_by_code.get("M" + code) or self._stops_by_code.get("L" + code)
        if s is None and code.isdigit():
            s = self._stops_by_id.get(int(code))
        return s

    @staticmethod
    def parada_publica(s: dict, desde: tuple[float, float] | None = None) -> dict:
        lng, lat = s["coordinates"]
        out = {"codigo": s["code"], "stop_id": s["stop_id"], "ubicacion": s.get("location"), "lat": lat, "lng": lng}
        if desde:
            out["distancia_m"] = round(distancia_m(desde, (lat, lng)))
        return out

    def paradas_cerca(self, lat: float, lng: float, radio_m: float = 400, limite: int = 8) -> list[dict]:
        cand = []
        for s in self.stops():
            slng, slat = s["coordinates"]
            if abs(slat - lat) > 0.02 or abs(slng - lng) > 0.02:
                continue
            d = distancia_m((lat, lng), (slat, slng))
            if d <= radio_m:
                cand.append((d, s))
        cand.sort(key=lambda x: x[0])
        return [self.parada_publica(s, (lat, lng)) for _, s in cand[:limite]]

    def buscar_paradas_texto(self, texto: str, limite: int = 8) -> list[dict]:
        toks = [t for t in texto.lower().replace(",", " ").split() if len(t) > 1]
        hits = [s for s in self.stops() if all(t in (s.get("location") or "").lower() for t in toks)]
        return [self.parada_publica(s) for s in hits[:limite]]

    def lineas(self, codigo: str) -> list[dict]:
        c = codigo.strip().upper()
        return [s for s in self.services() if s["code"].upper() == c]

    def paradas_de_linea(self, codigo: str) -> set[int]:
        """stop_ids del recorrido oficial (/service) de todas las variantes de una línea."""
        c = codigo.strip().upper()
        with self._lock:
            if c in self._paradas_linea:
                return self._paradas_linea[c]
        f = self.cache_dir / "mendotran-lineas.json"
        disco: dict[str, list[int]] = {}
        if f.exists() and time.time() - f.stat().st_mtime < CATALOGO_TTL_S:
            disco = json.loads(f.read_text())
        if c in disco:
            ids = set(disco[c])
        else:
            ids = set()
            for svc in self.lineas(c):
                try:
                    ids |= set(self.servicio(svc["service_id"]).get("stops") or [])
                except MendotranError:
                    pass
            if ids:
                with self._lock:  # releer: otro thread pudo haber escrito
                    actual = json.loads(f.read_text()) if f.exists() else {}
                    actual[c] = sorted(ids)
                    f.write_text(json.dumps(actual))
        with self._lock:
            self._paradas_linea[c] = ids
        return ids

    # ── tiempo real ─────────────────────────────────────────────
    def buscar(self, texto: str, tipos: tuple[str, ...] = ("places", "stops")) -> list[dict]:
        return self._post("/search", {"text": texto, "search": list(tipos)}).get("search") or []

    def arribos(self, stop_id: int) -> list[dict]:
        """Próximos arribos normalizados, ordenados por hora (predicted si hay GPS, si no scheduled)."""
        data = self._post("/arrivals", {"stop_id": stop_id, "first_time": True})
        refs = (data.get("references") or {}).get("services") or {}
        vehs = (data.get("references") or {}).get("vehicles") or {}
        now = ahora_ms()
        out = []
        for a in data.get("arrivals") or []:
            svc = refs.get(str(a["service_id"])) or {}
            hora = a.get("predicted") or a.get("scheduled")
            if not hora:
                continue
            item = {
                "linea": svc.get("code"),
                "cartel": " ".join((svc.get("name") or "").split()),
                "modo": svc.get("mode"),
                "service_id": a["service_id"],
                "trip_id": a.get("trip_id"),
                "hora_ms": hora,
                "hora": hhmm(hora),
                "en_min": max(0, minutos(now, hora)),
                "tiempo_real": bool(a.get("predicted")),
            }
            if a.get("predicted") and a.get("scheduled"):
                # >0 = viene atrasado respecto del horario
                item["atraso_min"] = minutos(a["scheduled"], a["predicted"])
            v = vehs.get(str(a.get("vehicle_id"))) if a.get("vehicle_id") else None
            if v:
                item["aire"] = bool(v.get("air_conditioning"))
                item["rampa"] = bool(v.get("wheelchair_access"))
            out.append(item)
        out.sort(key=lambda x: x["hora_ms"])
        return out

    def servicio(self, service_id: int) -> dict:
        return self._post("/service", {"service_id": service_id}).get("service") or {}

    def viaje(self, trip_id: str) -> dict:
        return self._post("/trip", {"trip_id": trip_id}).get("trip") or {}

    def planear(self, origen: tuple[float, float], destino: tuple[float, float], ts_ms: int, criterio: str = "departure") -> list[dict]:
        body = {
            "source": {"coordinates": [origen[1], origen[0]]},
            "destination": {"coordinates": [destino[1], destino[0]]},
            "criteria": criterio,
            "timestamp": ts_ms,
        }
        return self._post("/plan", body).get("plan") or []
