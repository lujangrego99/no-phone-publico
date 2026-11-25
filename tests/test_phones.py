"""phones: un perfil con adb_server propio usa ese adb server aunque haya uno global (celu por túnel en el VPS)."""
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock


class TestAdbServerPorPerfil(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        archivo = Path(self.dir.name) / "phones.json"
        archivo.write_text(json.dumps({"activo": "x12", "perfiles": {
            "x12": {"serial": "172.19.0.1:15555", "adb_server": "adb-tunel:5037"},
            "redmi7": {"serial": "TU_SERIAL"},
        }}))
        self.env = mock.patch.dict(os.environ, {"NX_PHONES_FILE": str(archivo), "ANDROID_ADB_SERVER_HOST": "agente-adb"})
        self.env.start()

    def tearDown(self):
        self.env.stop()
        self.dir.cleanup()

    def test_perfil_con_adb_server_gana_al_global(self):
        import phones

        c = phones._cliente_adb(phones._perfil_de_serial("172.19.0.1:15555"))
        self.assertEqual((c.host, c.port), ("adb-tunel", 5037))

    def test_perfil_sin_adb_server_usa_el_global(self):
        import adbutils
        import phones

        self.assertIs(phones._cliente_adb(phones._perfil_de_serial("TU_SERIAL")), adbutils.adb)
        self.assertIsNone(phones._perfil_de_serial("otro"))


if __name__ == "__main__":
    unittest.main()
