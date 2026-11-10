"""Tests offline de lugares del dueño y punto de partida supuesto (sin red). Agenda en un archivo temporal."""
import os
import tempfile
import time
import unittest

_tmp = tempfile.mkdtemp()
os.environ["AGENDA_DB"] = os.path.join(_tmp, "agenda.db")

import agenda as A  # noqa: E402
from movilidad import lugares as L  # noqa: E402
from movilidad.planner import _recomendar  # noqa: E402

MIN = 60_000


class Lugares(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        con = A.conectar()
        A.guardar_lugar(con, "Casa", "Calle Falsa 123, Guaymallén, Mendoza", ["casa", "mi casa"], origen="consola")
        A.guardar_lugar(con, "Laburo", "Av. San Martín 1000, Mendoza", ["laburo", "trabajo", "oficina"], origen="consola")
        fid = A.crear(con, "Vero Del Valle", estado="confirmado", origen="consola")
        A.agregar_apodo(con, fid, "mi vieja")
        cls.vero = fid
        con.close()

    def setUp(self):
        p = L._historial_path()
        if p.exists():
            p.unlink()

    def test_casa_sale_de_la_agenda(self):
        for t in ("casa", "mi casa", "Casa", "la casa"):
            r = L.buscar(t)
            self.assertEqual(r["direccion"], "Calle Falsa 123, Guaymallén, Mendoza", t)
            self.assertEqual(r["decir"], "tu casa")

    def test_frases_de_donde_esta(self):
        self.assertEqual(L.buscar("estoy en mi casa")["decir"], "tu casa")
        self.assertEqual(L.buscar("salgo del laburo")["decir"], "tu laburo")
        self.assertTrue(L.es_aca("estoy acá"))

    def test_ficha_con_otro_nombre_se_dice_como_la_nombra(self):
        con = A.conectar()
        A.guardar_lugar(con, "casa de Juan Pérez", "Otra 1", ["depto"], origen="consola")
        con.close()
        self.assertEqual(L.buscar("mi depto")["decir"], "tu depto")

    def test_laburo_con_articulo(self):
        self.assertEqual(L.buscar("el laburo")["decir"], "tu laburo")

    def test_personal_desconocido_no_adivina(self):
        with self.assertRaises(L.LugarDesconocido):
            L.buscar("la facu")
        with self.assertRaises(L.LugarDesconocido):
            L.buscar("lo de Pepín")

    def test_lo_de_persona_con_direccion(self):
        with self.assertRaises(L.LugarDesconocido):  # sin dirección todavía
            L.buscar("lo de mi vieja")
        con = A.conectar()
        A.guardar_lugar(con, "", "Calle Falsa 123", ficha_id=self.vero)
        con.close()
        r = L.buscar("lo de mi vieja")
        self.assertEqual(r["direccion"], "Calle Falsa 123")
        self.assertEqual(r["decir"], "lo de Vero Del Valle")

    def test_lugar_comun_no_es_de_agenda(self):
        self.assertIsNone(L.buscar("Garage Libertad"))
        self.assertIsNone(L.buscar("Casa de Gobierno"))

    def test_origen_sin_historial_es_casa(self):
        texto, por = L.suponer_origen("Garage Libertad")
        self.assertEqual(texto, "casa")
        self.assertIn("no me dijiste", por)

    def test_origen_es_donde_iba(self):
        L.registrar({"nombre": "tu casa"}, {"nombre": "tu laburo"}, None, "casa", "el laburo")
        texto, por = L.suponer_origen("Garage Libertad")
        self.assertEqual(texto, "el laburo")
        self.assertIn("ibas para tu laburo", por)

    def test_mismo_viaje_mismo_origen(self):
        L.registrar({"nombre": "tu laburo"}, {"nombre": "Garage Libertad"}, None, "el laburo", "Garage Libertad")
        texto, _ = L.suponer_origen("Garage Libertad")
        self.assertEqual(texto, "el laburo")

    def test_historial_viejo_no_cuenta(self):
        L.registrar({"nombre": "tu casa"}, {"nombre": "tu laburo"}, None, "casa", "el laburo")
        texto, _ = L.suponer_origen("Garage Libertad", ahora=time.time() + 7 * 3600)
        self.assertEqual(texto, "casa")

    def test_ir_a_casa_sin_origen_pregunta(self):
        with self.assertRaises(L.LugarDesconocido):
            L.suponer_origen("mi casa")


def _op(llega_min, camina_min, micros=1):
    tramos = [{"tipo": "caminar", "duracion_s": camina_min * 60}] + [{"tipo": "micro"}] * micros
    return {"llegada_ms": llega_min * MIN, "tramos": tramos}


class Recomendada(unittest.TestCase):
    def test_camina_menos_si_llega_casi_igual(self):
        a, b = _op(40, 7), _op(41, 2)
        ops = _recomendar([a, b])
        self.assertIs(ops[0], b)
        self.assertTrue(b["recomendada"])

    def test_no_si_llega_mucho_despues(self):
        a, b = _op(40, 7), _op(50, 1)
        self.assertIs(_recomendar([a, b])[0], a)


if __name__ == "__main__":
    unittest.main()
