"""Planificador combinado: opciones de Mendotran /plan (+ Google transit si hay key),
re-simuladas con arribos en tiempo real para que los transbordos calcen.

Para cada opción:
  t = hora de salida
  caminar → t += duración
  micro   → próximo arribo de ESA línea en ESA parada con hora ≥ t (GPS si hay, si no horario)
            bajada = hora estimada del mismo viaje (/trip) en la parada de bajada
            t = bajada
La espera en cada micro posterior al primero es el margen del transbordo.
"""
from __future__ import annotations

import threading
from concurrent.futures import ThreadPoolExecutor
from typing import Any, Callable

from .maps import Maps, MapsError
from .mendotran import Mendotran, MendotranError
from .util import ahora_ms, distancia_m, hhmm, minutos

TRANSBORDO_AJUSTADO_MIN = 2  # menos que esto = riesgo de perderlo
TOLERANCIA_MS = 30_000  # un micro que pasa 30s "antes" de que llegues todavía se alcanza
COLCHON_LLEGADA_MS = 5 * 60_000  # "llegar antes de": se planea para llegar 5 min antes
MATCH_PARADA_M = 20  # parada Google ↔ MendoTran: mismas coordenadas GTFS (medido: 0-1 m)
MAX_CANDIDATOS_TRANSBORDO = 6


class _Memo:
    """Cache por request (arribos por parada, viajes por trip_id) segura entre threads."""

    def __init__(self, fn: Callable[[Any], Any]):
        self.fn, self.data, self.lock = fn, {}, threading.Lock()

    def __call__(self, key):
        with self.lock:
            if key in self.data:
                return self.data[key]
        try:
            val = self.fn(key)
        except MendotranError:
            val = None
        with self.lock:
            self.data[key] = val
        return val


class Planificador:
    def __init__(self, mendotran: Mendotran, maps: Maps):
        self.mt = mendotran
        self.maps = maps

    # ── normalización de opciones ───────────────────────────────
    def _desde_mendotran(self, plan: list[dict]) -> list[dict]:
        opciones = []
        for op in plan:
            tramos = []
            for leg in op.get("legs") or []:
                dep, arr = leg.get("departure") or {}, leg.get("arrival") or {}
                d_ms = dep.get("predicted") or dep.get("scheduled")
                a_ms = arr.get("predicted") or arr.get("scheduled")
                if leg.get("mode") == "walk":
                    ins = leg.get("instructions") or []
                    tramos.append({
                        "tipo": "caminar",
                        "duracion_s": round((a_ms - d_ms) / 1000) if d_ms and a_ms else 0,
                        "distancia_m": round(sum(i.get("distance") or 0 for i in ins)),
                        "instrucciones": [i["text"] for i in ins if i.get("text")],
                    })
                    continue
                svc = leg.get("service") or {}
                tramos.append({
                    "tipo": "micro",
                    "linea": svc.get("code"),
                    "cartel": " ".join((svc.get("name") or "").split()),
                    "vehiculo": leg.get("mode"),
                    "sube": self._parada_tramo(dep),
                    "baja": self._parada_tramo(arr),
                    "sale_ms": d_ms,
                    "llega_ms": a_ms,
                    "paradas": len(leg.get("intermediate_stops") or []) + 1,
                })
            opciones.append({"fuente": "mendotran", "tramos": tramos})
        return opciones

    def _parada_tramo(self, p: dict) -> dict:
        stop = p.get("stop") or {}
        lng, lat = stop.get("coordinates") or (None, None)
        s = self.mt.parada(int(p["stop_id"])) if p.get("stop_id") else None
        return {"stop_id": p.get("stop_id"), "codigo": stop.get("code"), "nombre": (s or {}).get("location"), "lat": lat, "lng": lng}

    def _desde_google(self, rutas: list[dict]) -> list[dict]:
        opciones = []
        for r in rutas:
            tramos = [dict(t) for t in r["tramos"]]
            if not any(t["tipo"] == "micro" for t in tramos):
                continue
            for t in tramos:
                if t["tipo"] == "micro":
                    t["sube"] = self._mapear_parada(t["sube"], t["linea"])
                    t["baja"] = self._mapear_parada(t["baja"], t["linea"])
            opciones.append({"fuente": "google", "tramos": tramos})
        return opciones

    def _mapear_parada(self, p: dict, linea: str | None) -> dict:
        """Parada de Google → parada MendoTran exacta: misma coordenada (≤ MATCH_PARADA_M, el GTFS es el
        mismo y coinciden a 0-1 m) Y que esté en el recorrido oficial de esa línea. En una esquina suele
        haber 2-3 paradas a pocos metros (una por sentido/grupo de líneas): sin la línea no se puede elegir."""
        if p.get("lat") is None:
            return {**p, "sin_match": True}
        cerca = self.mt.paradas_cerca(p["lat"], p["lng"], radio_m=MATCH_PARADA_M, limite=6)
        de_linea = self.mt.paradas_de_linea(linea) if linea else set()
        for c in cerca:
            if c["stop_id"] in de_linea:
                return {**p, "stop_id": c["stop_id"], "codigo": c["codigo"], "nombre_mendotran": c["ubicacion"]}
        return {**p, "sin_match": True}

    # ── re-simulación con tiempo real ───────────────────────────
    def _simular_micro(self, linea: str, sube: dict, baja: dict, llego_ms: int, duracion_fallback: int | None) -> dict | None:
        """Próximo micro de `linea` en `sube` con hora ≥ llego_ms y su hora de bajada en `baja`."""
        if not sube.get("stop_id"):
            return None
        prox = [a for a in (self._arribos(sube["stop_id"]) or [])
                if _misma_linea(a["linea"], linea) and a["hora_ms"] >= llego_ms - TOLERANCIA_MS]
        if not prox:
            return None
        a = prox[0]
        llega = self._hora_bajada(a["trip_id"], sube, baja, a["hora_ms"])
        por = "viaje"
        if llega is None and duracion_fallback is not None:
            llega, por = a["hora_ms"] + duracion_fallback, "horario"
        return {"arribo": a, "siguiente": prox[1] if len(prox) > 1 else None, "llega_ms": llega, "por": por}

    def _aplicar_micro(self, tr: dict, sim: dict) -> None:
        a = sim["arribo"]
        tr["sale_ms"] = a["hora_ms"]
        tr["tiempo_real"] = a["tiempo_real"]
        tr["horario_de"] = "mendotran"
        tr.pop("atraso_min", None)
        if "atraso_min" in a:
            tr["atraso_min"] = a["atraso_min"]
        tr["trip_id"] = a["trip_id"]
        if a.get("cartel"):  # Google pone la última parada como cartel; usar el de MendoTran
            tr["cartel"] = a["cartel"]
        tr["siguiente"] = hhmm(sim["siguiente"]["hora_ms"]) if sim["siguiente"] else None
        tr["llega_ms"] = sim["llega_ms"]
        tr["llegada_estimada_por"] = sim["por"]

    def _mejor_transbordo(self, A: dict, B: dict, caminata_s: int, actual: dict | None) -> dict | None:
        """Prueba transbordar en cada parada que comparten el micro A (ya elegido) y la línea B:
        bajarse ahí → próximo B en esa misma parada → bajada final. Devuelve la mejor si le gana
        a la actual (llega antes, o igual con más margen)."""
        viaje = self._viaje(A.get("trip_id")) if A.get("trip_id") else None
        paradas_a = [p for p in ((viaje or {}).get("stops") or []) if p.get("timestamp") is not None]
        i_sube = self._indice_parada(paradas_a, A["sube"], 0) if paradas_a else None
        if i_sube is None:
            return None
        de_b = self.mt.paradas_de_linea(B["linea"])
        i_baja = self._indice_parada(paradas_a, A["baja"], i_sube + 1)
        cands = [k for k in range(i_sube + 1, len(paradas_a)) if paradas_a[k]["stop_id"] in de_b]
        if i_baja is not None:
            cands.sort(key=lambda k: abs(k - i_baja))
        mejor = None
        for k in cands[:MAX_CANDIDATOS_TRANSBORDO]:
            s = self.mt.parada(int(paradas_a[k]["stop_id"]))
            if not s:
                continue
            parada = {"stop_id": s["stop_id"], "codigo": s["code"], "nombre": s.get("location"),
                      "lat": s["coordinates"][1], "lng": s["coordinates"][0]}
            baja_a = A["sale_ms"] + paradas_a[k]["timestamp"] - paradas_a[i_sube]["timestamp"]
            sim = self._simular_micro(B["linea"], parada, B["baja"], baja_a, None)
            if not sim or sim["llega_ms"] is None or sim["por"] != "viaje":
                continue
            margen = sim["arribo"]["hora_ms"] - baja_a
            cand = {"parada": parada, "baja_a_ms": baja_a, "sim": sim, "margen_ms": margen,
                    "score": (sim["llega_ms"], -min(margen, 10 * 60_000))}
            if mejor is None or cand["score"] < mejor["score"]:
                mejor = cand
        if mejor is None:
            return None
        if actual and actual.get("llega_ms") is not None:
            margen_actual = actual["arribo"]["hora_ms"] - (A["llega_ms"] + caminata_s * 1000)
            if mejor["score"] >= (actual["llega_ms"], -min(margen_actual, 10 * 60_000)):
                return None
        return mejor

    def _refinar(self, op: dict, salida_ms: int, salida_libre: bool) -> dict:
        t = salida_ms
        caminata_previa_s = 0
        caminata_desde_micro_s = 0
        primer_micro = None
        anterior = None  # último micro, para optimizar el transbordo
        caminatas_entre: list[dict] = []
        avisos: list[str] = []
        for tr in op["tramos"]:
            if tr["tipo"] == "caminar":
                t += tr["duracion_s"] * 1000
                if primer_micro is None:
                    caminata_previa_s += tr["duracion_s"]
                else:
                    caminata_desde_micro_s += tr["duracion_s"]
                    caminatas_entre.append(tr)
                continue
            duracion = (tr["llega_ms"] - tr["sale_ms"]) if tr.get("llega_ms") is not None and tr.get("sale_ms") is not None else None
            sim = self._simular_micro(tr["linea"], tr.get("sube") or {}, tr.get("baja") or {}, t, duracion)
            if anterior is not None and anterior.get("trip_id"):
                mejor = self._mejor_transbordo(anterior, tr, caminata_desde_micro_s, sim)
                if mejor:
                    original = anterior["baja"].get("codigo") or anterior["baja"].get("nombre")
                    anterior["baja"] = dict(mejor["parada"])
                    anterior["llega_ms"] = mejor["baja_a_ms"]
                    tr["sube"] = dict(mejor["parada"])
                    for c in caminatas_entre:  # misma parada: no hay que caminar
                        c.update(duracion_s=0, distancia_m=0, instrucciones=[])
                    t = mejor["baja_a_ms"]
                    sim = mejor["sim"]
                    tr["transbordo_optimizado"] = f"en vez de {original}"
            llego_parada = t
            if sim:
                self._aplicar_micro(tr, sim)
            else:
                tr["tiempo_real"] = False
                tr["horario_de"] = "google" if op["fuente"] == "google" else "plan"
                if (tr.get("sube") or {}).get("sin_match"):
                    avisos.append(f"No pude identificar con exactitud la parada del {tr['linea']} en «{tr['sube'].get('nombre')}»: "
                                  "horario de Google, sin GPS de MendoTran.")
                elif tr.get("sale_ms") is None or tr["sale_ms"] < llego_parada - TOLERANCIA_MS:
                    avisos.append(f"No encontré próximos arribos del {tr['linea']} en {tr['sube'].get('codigo') or 'la parada'}; "
                                  "puede que no haya más servicio.")
            tr["espera_min"] = max(0, minutos(llego_parada, tr["sale_ms"])) if tr.get("sale_ms") else None
            if primer_micro is None:
                primer_micro = tr
            else:
                tr["transbordo"] = True
                if tr["espera_min"] is not None and tr["espera_min"] < TRANSBORDO_AJUSTADO_MIN:
                    tr["transbordo_ajustado"] = True
                    avisos.append(f"Transbordo ajustado al {tr['linea']}: {tr['espera_min']} min de margen" +
                                  (f" (si lo perdés, el siguiente pasa {tr['siguiente']})" if tr.get("siguiente") else ""))
            t = tr.get("llega_ms") or tr.get("sale_ms") or t
            anterior, caminata_desde_micro_s, caminatas_entre = tr, 0, []
        op["llegada_ms"] = t
        if primer_micro and salida_libre and primer_micro.get("sale_ms"):
            # con salida flexible: salí justo para no esperar en la parada (+1 min de colchón)
            op["salida_ms"] = primer_micro["sale_ms"] - caminata_previa_s * 1000 - 60_000
            primer_micro["espera_min"] = 1
        else:
            op["salida_ms"] = salida_ms
        op["avisos"] = avisos
        return op

    def _hora_bajada(self, trip_id: str | None, sube: dict, baja: dict, sale_ms: int) -> int | None:
        """Hora de bajada usando el viaje concreto (/trip): duración subida→bajada del viaje,
        aplicada a la hora real de subida (los timestamps de /trip no traen el atraso GPS)."""
        if not trip_id:
            return None
        v = self._viaje(trip_id)
        paradas = [p for p in ((v or {}).get("stops") or []) if p.get("timestamp") is not None]
        if not paradas:
            return None
        i_sube = self._indice_parada(paradas, sube, 0)
        i_baja = self._indice_parada(paradas, baja, (i_sube + 1) if i_sube is not None else 0)
        if i_baja is None:
            return None
        if i_sube is not None:
            return sale_ms + (paradas[i_baja]["timestamp"] - paradas[i_sube]["timestamp"])
        ts = paradas[i_baja]["timestamp"]
        return ts if ts > sale_ms else None

    def _indice_parada(self, paradas: list[dict], ref: dict, desde: int) -> int | None:
        sid = ref.get("stop_id")
        for i in range(desde, len(paradas)):
            if paradas[i].get("stop_id") == sid:
                return i
        if ref.get("lat") is None:
            return None
        mejor = None  # misma esquina con otro stop_id
        for i in range(desde, len(paradas)):
            s = self.mt.parada(int(paradas[i]["stop_id"]))
            if not s:
                continue
            d = distancia_m((ref["lat"], ref["lng"]), (s["coordinates"][1], s["coordinates"][0]))
            if d < 200 and (mejor is None or d < mejor[0]):
                mejor = (d, i)
        return mejor[1] if mejor else None

    # ── API pública ─────────────────────────────────────────────
    def planear(self, origen: str, destino: str, salida_ms: int | None = None,
                llegar_antes_ms: int | None = None, max_opciones: int = 4) -> dict:
        self._arribos = _Memo(self.mt.arribos)
        self._viaje = _Memo(self.mt.viaje)
        o = self.maps.resolver(origen)
        d = self.maps.resolver(destino)
        salida_libre = salida_ms is None and llegar_antes_ms is None
        base_ms = salida_ms or ahora_ms()

        opciones: list[dict] = []
        errores: list[str] = []
        try:
            if llegar_antes_ms:
                plan = self.mt.planear((o["lat"], o["lng"]), (d["lat"], d["lng"]), llegar_antes_ms - COLCHON_LLEGADA_MS, "arrival")
            else:
                plan = self.mt.planear((o["lat"], o["lng"]), (d["lat"], d["lng"]), base_ms, "departure")
            opciones += self._desde_mendotran(plan)
        except MendotranError as e:
            errores.append(f"mendotran: {e}")
        if self.maps.key:
            try:
                rutas = self.maps.ruta(o, d, "transporte", salida_ms=salida_ms or base_ms,
                                       llegada_ms=llegar_antes_ms - COLCHON_LLEGADA_MS if llegar_antes_ms else None)
                opciones += self._desde_google(rutas)
            except MapsError as e:
                errores.append(f"google: {e}")

        opciones = _dedupe(opciones)
        with ThreadPoolExecutor(max_workers=6) as ex:
            inicio = {id(op): (_inicio_planificado(op) if llegar_antes_ms else base_ms) for op in opciones}
            opciones = list(ex.map(lambda op: self._refinar(op, inicio[id(op)], salida_libre), opciones))
        if llegar_antes_ms:
            for op in opciones:
                op["llega_a_tiempo"] = op["llegada_ms"] <= llegar_antes_ms
        opciones.sort(key=lambda op: (
            not op.get("llega_a_tiempo", True),
            op["llegada_ms"],
            sum(1 for t in op["tramos"] if t["tipo"] == "micro"),
        ))
        opciones = _recomendar(opciones[:max_opciones])
        for op in opciones:
            _resumir(op)

        caminando = None
        if distancia_m((o["lat"], o["lng"]), (d["lat"], d["lng"])) < 2500:
            try:
                r = self.maps.ruta(o, d, "caminando", alternativas=False)
                if r:
                    caminando = {"duracion_min": r[0]["duracion_min"], "distancia_m": r[0]["distancia_m"]}
            except MapsError:
                pass

        return {
            "origen": _punto_publico(o),
            "destino": _punto_publico(d),
            "consultado": hhmm(ahora_ms()),
            "consultado_epoch": round(ahora_ms() / 1000),
            "opciones": opciones,
            "caminando": caminando,
            "fuentes": ["mendotran"] + (["google"] if self.maps.key else []),
            **({"errores": errores} if errores else {}),
        }


RECOMENDAR_MARGEN_MS = 3 * 60_000  # si llega ≤ 3 min después y camina menos, conviene esa


def _caminata_s(op: dict) -> int:
    return sum(t.get("duracion_s") or 0 for t in op["tramos"] if t["tipo"] == "caminar")


def _recomendar(opciones: list[dict]) -> list[dict]:
    """La recomendada va primera y marcada: entre las que llegan a tiempo y a ≤ 3 min de la más rápida, la que menos
    camina (después, menos micros). Así la tarjeta y lo que dice el secretario son la misma opción."""
    if not opciones:
        return opciones
    validas = [op for op in opciones if op.get("llega_a_tiempo", True)] or opciones
    primera = min(op["llegada_ms"] for op in validas)
    cerca = [op for op in validas if op["llegada_ms"] <= primera + RECOMENDAR_MARGEN_MS]
    mejor = min(cerca, key=lambda op: (_caminata_s(op) // 60, sum(1 for t in op["tramos"] if t["tipo"] == "micro"), op["llegada_ms"]))
    mejor["recomendada"] = True
    return [mejor] + [op for op in opciones if op is not mejor]


def _misma_linea(a: str | None, b: str | None) -> bool:
    if not a or not b:
        return False
    return a.strip().upper() == b.strip().upper()


def _inicio_planificado(op: dict) -> int:
    t0 = None
    caminata = 0
    for tr in op["tramos"]:
        if tr["tipo"] == "micro":
            t0 = tr.get("sale_ms")
            break
        caminata += tr["duracion_s"]
    return (t0 - caminata * 1000) if t0 else ahora_ms()


def _firma(op: dict) -> tuple:
    return tuple((t["linea"], (t.get("sube") or {}).get("codigo")) for t in op["tramos"] if t["tipo"] == "micro")


def _dedupe(opciones: list[dict]) -> list[dict]:
    vistos: dict[tuple, dict] = {}
    for op in opciones:
        f = _firma(op)
        if f not in vistos:
            vistos[f] = op
        else:
            vistos[f].setdefault("tambien_en", []).append(op["fuente"])
    return list(vistos.values())


def _punto_publico(p: dict) -> dict:
    out = {k: p[k] for k in ("nombre", "direccion", "lat", "lng", "fuente") if p.get(k) is not None}
    if p.get("otras_opciones"):
        out["otras_opciones"] = p["otras_opciones"]
    return out


def _nombre_parada(p: dict) -> str:
    nombre = p.get("nombre_mendotran") or p.get("nombre")
    if p.get("codigo"):
        return f"parada {p['codigo']}" + (f" ({nombre})" if nombre else "")
    return f"«{nombre or '?'}» (sin código MendoTran)"


def _resumir(op: dict) -> None:
    micros = [t for t in op["tramos"] if t["tipo"] == "micro"]
    op["lineas"] = " + ".join(t["linea"] for t in micros) or "caminando"
    if micros:
        s = micros[0].get("sube") or {}
        op["sube"] = {k: v for k, v in {"codigo": s.get("codigo"), "nombre": s.get("nombre_mendotran") or s.get("nombre"),
                                        "lat": s.get("lat"), "lng": s.get("lng")}.items() if v is not None}
    op["sali"] = hhmm(op["salida_ms"])
    op["sali_epoch"] = round(op["salida_ms"] / 1000) if op.get("salida_ms") else None  # la tarjeta cuenta regresiva
    op["llegas"] = hhmm(op["llegada_ms"])
    op["duracion_min"] = minutos(op["salida_ms"], op["llegada_ms"])
    op["caminata_min"] = round(sum(t["duracion_s"] for t in op["tramos"] if t["tipo"] == "caminar") / 60)
    pasos = []
    for i, t in enumerate(op["tramos"]):
        if t["tipo"] == "caminar":
            if t["duracion_s"] < 30:
                continue
            sig = next((x for x in op["tramos"][i + 1:] if x["tipo"] == "micro"), None)
            hasta = _nombre_parada(sig["sube"]) if sig else "destino"
            pasos.append(f"Caminá {t.get('distancia_m') or '?'} m (~{max(1, round(t['duracion_s'] / 60))} min) hasta {hasta}")
            continue
        estado = "GPS" if t.get("tiempo_real") else ("horario Google" if t.get("horario_de") == "google" else "horario")
        if t.get("atraso_min"):
            estado += f", {abs(t['atraso_min'])} min {'atrasado' if t['atraso_min'] > 0 else 'adelantado'}"
        sube = (f"Transbordá al {t['linea']}" if t.get("transbordo") else f"Tomá el {t['linea']}")
        # La parada de subida SIEMPRE nombrada: si la caminata previa es < 30 s no hay paso «caminá hasta…» y el
        # secretario inventaba dónde subirse.
        linea = (f"{sube} ({t.get('cartel') or ''}) en {_nombre_parada(t.get('sube') or {})} "
                 f"a las {hhmm(t.get('sale_ms')) or '?'} [{estado}]")
        if t.get("transbordo") and t.get("espera_min") is not None:
            linea += f" — esperás {t['espera_min']} min" + (" ⚠️ ajustado" if t.get("transbordo_ajustado") else "")
        if t.get("siguiente"):
            linea += f" · siguiente {t['siguiente']}"
        if t.get("transbordo_optimizado"):
            linea += f" · mejor transbordo ({t['transbordo_optimizado']})"
        pasos.append(linea)
        n = t.get("paradas")
        pasos.append(f"Bajate en {_nombre_parada(t.get('baja') or {})}"
                     + (f" ~{hhmm(t.get('llega_ms'))}" if t.get("llega_ms") else "")
                     + (f" ({n} parada{'s' if n != 1 else ''})" if n else ""))
    op["pasos"] = pasos
