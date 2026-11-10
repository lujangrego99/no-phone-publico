"""Tests offline de movilidad (sin red). Correr: .venv/bin/python -m unittest discover -s tests"""
import hashlib
import unittest
from datetime import datetime

from movilidad.maps import _tokens, _tramos_google
from movilidad.mendotran import _xss
from movilidad.planner import Planificador, _dedupe, _misma_linea, _resumir
from movilidad.util import TZ, parse_codigo_parada, parse_hora, parse_latlng

MIN = 60_000


class Util(unittest.TestCase):
    def test_xss_cumple_proof_of_work(self):
        h = hashlib.md5(bytes.fromhex(_xss())).digest()
        self.assertEqual(h[14] & 15, 0)
        self.assertEqual(h[15], 0)

    def test_parse_hora(self):
        ms = parse_hora("23:59")
        self.assertEqual(datetime.fromtimestamp(ms / 1000, TZ).strftime("%H:%M"), "23:59")
        self.assertIsNone(parse_hora(None))
        with self.assertRaises(ValueError):
            parse_hora("mañana temprano")

    def test_parse_puntos(self):
        self.assertEqual(parse_latlng("-32.88, -68.87"), (-32.88, -68.87))
        self.assertIsNone(parse_latlng("Plaza España"))
        self.assertEqual(parse_codigo_parada("m1031"), "M1031")
        self.assertIsNone(parse_codigo_parada("Chile 1031"))

    def test_tokens_sin_acentos_ni_vacias(self):
        self.assertEqual(_tokens("Terminal de Ómnibus, Mendoza"), {"terminal", "omnibus"})


class Lineas(unittest.TestCase):
    def test_misma_linea(self):
        self.assertTrue(_misma_linea("201", "201"))
        self.assertTrue(_misma_linea("708a", "708A"))
        self.assertFalse(_misma_linea("708A", "708"))  # variantes distintas: exacto
        self.assertFalse(_misma_linea("2010", "201"))
        self.assertFalse(_misma_linea("201", None))


class Google(unittest.TestCase):
    def test_tramos_agrupa_caminatas_y_micro(self):
        pasos = [
            {"travelMode": "WALK", "staticDuration": "60s", "distanceMeters": 80, "navigationInstruction": {"instructions": "Caminá"}},
            {"travelMode": "WALK", "staticDuration": "30s", "distanceMeters": 40},
            {"travelMode": "TRANSIT", "staticDuration": "600s", "transitDetails": {
                "transitLine": {"nameShort": "201", "vehicle": {"type": "BUS"}}, "headsign": "Centro", "stopCount": 7,
                "stopDetails": {
                    "departureStop": {"name": "Chile y Rivadavia", "location": {"latLng": {"latitude": -32.89, "longitude": -68.84}}},
                    "arrivalStop": {"name": "UNC", "location": {"latLng": {"latitude": -32.88, "longitude": -68.87}}},
                    "departureTime": "2026-10-20T18:05:00Z", "arrivalTime": "2026-10-20T18:15:00Z"}}},
        ]
        t = _tramos_google(pasos)
        self.assertEqual([x["tipo"] for x in t], ["caminar", "micro"])
        self.assertEqual(t[0]["duracion_s"], 90)
        self.assertEqual(t[0]["distancia_m"], 120)
        self.assertEqual(t[1]["linea"], "201")
        self.assertEqual(t[1]["llega_ms"] - t[1]["sale_ms"], 10 * MIN)

    def test_tramos_auto_no_es_caminar(self):
        t = _tramos_google([{"travelMode": "DRIVE", "staticDuration": "120s", "distanceMeters": 900}])
        self.assertEqual(t[0]["tipo"], "manejar")


class _FakeMT:
    """Mendotran falso: paradas, recorridos por línea, arribos y viajes."""

    def __init__(self, arribos, viajes, paradas=None, lineas=None):
        self._a, self._v = arribos, viajes
        self._p = paradas or {}  # stop_id → {"stop_id","code","location","coordinates":[lng,lat]}
        self._l = lineas or {}  # código → set(stop_id)

    def parada(self, ref):
        return self._p.get(ref)

    def paradas_de_linea(self, codigo):
        return self._l.get(codigo, set())

    def paradas_cerca(self, lat, lng, radio_m=400, limite=8):
        from movilidad.util import distancia_m
        out = []
        for s in self._p.values():
            d = distancia_m((lat, lng), (s["coordinates"][1], s["coordinates"][0]))
            if d <= radio_m:
                out.append({"codigo": s["code"], "stop_id": s["stop_id"], "ubicacion": s["location"], "distancia_m": round(d)})
        return sorted(out, key=lambda x: x["distancia_m"])[:limite]


def _stop(sid, code, lat, lng):
    return {"stop_id": sid, "code": code, "location": code, "coordinates": [lng, lat]}


class MatchParada(unittest.TestCase):
    def test_elige_la_de_la_linea_no_la_mas_cercana(self):
        # caso real San Juan 601: M9707 a 0 m (no pasa el 940), M15723 a ~6 m (sí pasa)
        mt = _FakeMT({}, {}, paradas={1: _stop(1, "M9707", -32.895695, -68.837802),
                                      2: _stop(2, "M15723", -32.895650, -68.837780)},
                     lineas={"940": {2}})
        p = Planificador(mt, maps=None)._mapear_parada({"nombre": "San Juan 601", "lat": -32.895695, "lng": -68.837802}, "940")
        self.assertEqual(p["codigo"], "M15723")

    def test_sin_parada_de_la_linea_no_inventa(self):
        mt = _FakeMT({}, {}, paradas={1: _stop(1, "M1", -32.89, -68.84),
                                      2: _stop(2, "M2", -32.8915, -68.84)},  # ~170 m: fuera de rango
                     lineas={"500": {2}})
        p = Planificador(mt, maps=None)._mapear_parada({"nombre": "X", "lat": -32.89, "lng": -68.84}, "500")
        self.assertTrue(p["sin_match"])
        self.assertNotIn("stop_id", p)


class Refinar(unittest.TestCase):
    def _plan(self, arribos, viajes):
        p = Planificador(_FakeMT(arribos, viajes), maps=None)
        p._arribos = lambda sid: arribos.get(sid, [])
        p._viaje = lambda tid: viajes.get(tid)
        return p

    def _op(self):
        return {"fuente": "mendotran", "tramos": [
            {"tipo": "caminar", "duracion_s": 300, "instrucciones": []},
            {"tipo": "micro", "linea": "201", "sube": {"stop_id": 1, "codigo": "M1"}, "baja": {"stop_id": 2, "codigo": "M2"},
             "sale_ms": 0, "llega_ms": 10 * MIN},
            {"tipo": "caminar", "duracion_s": 60, "instrucciones": []},
            {"tipo": "micro", "linea": "606", "sube": {"stop_id": 3, "codigo": "M3"}, "baja": {"stop_id": 4, "codigo": "M4"},
             "sale_ms": 0, "llega_ms": 5 * MIN},
        ]}

    def test_transbordo_calza_con_tiempo_real_y_offset_de_viaje(self):
        t0 = 1_000 * MIN
        arribos = {
            # el 201 que pasa antes de llegar a la parada no sirve; se toma el de t0+8
            1: [{"linea": "201", "hora_ms": t0 + 2 * MIN, "tiempo_real": True, "trip_id": "a"},
                {"linea": "201", "hora_ms": t0 + 8 * MIN, "tiempo_real": True, "trip_id": "b", "atraso_min": 3},
                {"linea": "201", "hora_ms": t0 + 20 * MIN, "tiempo_real": False, "trip_id": "c"}],
            3: [{"linea": "606", "hora_ms": t0 + 21 * MIN, "tiempo_real": True, "trip_id": "x"},
                {"linea": "606", "hora_ms": t0 + 35 * MIN, "tiempo_real": False, "trip_id": "y"}],
        }
        # /trip sin el atraso: subida 0, bajada +11 → se aplica a la hora real de subida
        viajes = {"b": {"stops": [{"stop_id": 1, "timestamp": 5}, {"stop_id": 2, "timestamp": 5 + 11 * MIN}]}}
        op = self._plan(arribos, viajes)._refinar(self._op(), t0, salida_libre=False)
        m1, m2 = op["tramos"][1], op["tramos"][3]
        self.assertEqual(m1["sale_ms"], t0 + 8 * MIN)
        self.assertEqual(m1["llega_ms"], t0 + 19 * MIN)  # 8 + 11 del viaje
        self.assertEqual(m1["siguiente"] is not None, True)
        # llega a parada 3 en t0+20 → el 606 de t0+21 → 1 min de margen = ajustado
        self.assertEqual(m2["sale_ms"], t0 + 21 * MIN)
        self.assertEqual(m2["espera_min"], 1)
        self.assertTrue(m2.get("transbordo_ajustado"))
        self.assertTrue(op["avisos"])
        self.assertEqual(op["llegada_ms"], t0 + 26 * MIN)  # 21 + 5 de horario

    def test_salida_libre_dice_cuando_salir(self):
        t0 = 1_000 * MIN
        arribos = {1: [{"linea": "201", "hora_ms": t0 + 30 * MIN, "tiempo_real": True, "trip_id": "b"}]}
        op = {"fuente": "mendotran", "tramos": self._op()["tramos"][:2]}
        op = self._plan(arribos, {})._refinar(op, t0, salida_libre=True)
        # micro t0+30, caminata 5 min, colchón 1 min → salir t0+24
        self.assertEqual(op["salida_ms"], t0 + 24 * MIN)
        _resumir(op)
        self.assertEqual(op["lineas"], "201")
        self.assertTrue(op["pasos"][0].startswith("Caminá"))

    def test_mejor_transbordo_en_parada_compartida(self):
        # A (201) pasa por 10 → 11 → 12 (plan: bajar en 12 y caminar a 13 para el 606).
        # El 606 también pasa por 11: bajarse en 11 permite tomar un 606 antes.
        t0 = 1_000 * MIN
        paradas = {i: _stop(i, f"M{i}", -32.89 + i * 0.001, -68.84) for i in (10, 11, 12, 13, 20)}
        arribos = {
            10: [{"linea": "201", "hora_ms": t0 + 5 * MIN, "tiempo_real": True, "trip_id": "a"}],
            11: [{"linea": "606", "hora_ms": t0 + 12 * MIN, "tiempo_real": True, "trip_id": "p"}],
            13: [{"linea": "606", "hora_ms": t0 + 30 * MIN, "tiempo_real": True, "trip_id": "q"}],
        }
        viajes = {
            "a": {"stops": [{"stop_id": 10, "timestamp": 0}, {"stop_id": 11, "timestamp": 5 * MIN}, {"stop_id": 12, "timestamp": 10 * MIN}]},
            "p": {"stops": [{"stop_id": 11, "timestamp": 0}, {"stop_id": 13, "timestamp": 6 * MIN}, {"stop_id": 20, "timestamp": 15 * MIN}]},
            "q": {"stops": [{"stop_id": 13, "timestamp": 0}, {"stop_id": 20, "timestamp": 9 * MIN}]},
        }
        mt = _FakeMT(arribos, viajes, paradas=paradas, lineas={"606": {11, 13, 20}, "201": {10, 11, 12}})
        p = Planificador(mt, maps=None)
        p._arribos = lambda sid: arribos.get(sid, [])
        p._viaje = lambda tid: viajes.get(tid)
        op = {"fuente": "google", "tramos": [
            {"tipo": "micro", "linea": "201", "sube": {"stop_id": 10, "codigo": "M10"}, "baja": {"stop_id": 12, "codigo": "M12"},
             "sale_ms": t0, "llega_ms": t0 + 10 * MIN},
            {"tipo": "caminar", "duracion_s": 120, "distancia_m": 150, "instrucciones": ["x"]},
            {"tipo": "micro", "linea": "606", "sube": {"stop_id": 13, "codigo": "M13"}, "baja": {"stop_id": 20, "codigo": "M20"},
             "sale_ms": t0 + 20 * MIN, "llega_ms": t0 + 29 * MIN},
        ]}
        op = p._refinar(op, t0, salida_libre=False)
        a, cam, b = op["tramos"]
        self.assertEqual(a["baja"]["codigo"], "M11")
        self.assertEqual(b["sube"]["codigo"], "M11")
        self.assertEqual(cam["duracion_s"], 0)
        self.assertEqual(b["sale_ms"], t0 + 12 * MIN)
        self.assertEqual(op["llegada_ms"], t0 + 27 * MIN)  # vs t0+39 transbordando en M12→M13
        self.assertIn("M12", b["transbordo_optimizado"])

    def test_dedupe_por_lineas_y_paradas(self):
        a = self._op()
        b = {**self._op(), "fuente": "google"}
        out = _dedupe([a, b])
        self.assertEqual(len(out), 1)
        self.assertEqual(out[0]["tambien_en"], ["google"])


if __name__ == "__main__":
    unittest.main()
