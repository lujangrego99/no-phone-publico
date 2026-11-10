"""Pone el u2.jar parcheado (escucha solo en 127.0.0.1) en el uiautomator2 instalado.

El servidor de uiautomator2 (u2.jar 0.4.0, de uiautomator2 3.7.0) abre el puerto 9008 en TODAS las interfaces y sin
contraseña: mientras corre, cualquiera en la misma WiFi que el celu lo maneja. El parche (vendor/u2/README.md) lo deja
en 127.0.0.1; adb llega igual (forward al loopback del celu). uiautomator2 sube su asset si el md5 del celu no
coincide, así que se reemplaza el asset del paquete instalado.

Uso: python scripts/u2_local.py   (idempotente; falla si el jar instalado no es el original conocido)
"""
import hashlib
import shutil
import sys
from pathlib import Path

import uiautomator2

ORIGINAL = "0b74e83c55f443539a9f76f5ce023a51466b764b1100e4097a897053fdfc0eb6"  # u2.jar 0.4.0 de uiautomator2 3.7.0
PARCHEADO = "a7fea82938765be058ef41c9c2c92556adcc779c23d18f2b21ad5e759f18c1a0"

asset = Path(uiautomator2.__file__).parent / "assets" / "u2.jar"
nuevo = Path(__file__).resolve().parent.parent / "vendor" / "u2" / "u2-local.jar"


def sha(p: Path) -> str:
    return hashlib.sha256(p.read_bytes()).hexdigest()


if sha(nuevo) != PARCHEADO:
    sys.exit(f"{nuevo}: no es el jar parcheado esperado")
actual = sha(asset)
if actual == PARCHEADO:
    print("u2.jar ya parcheado (127.0.0.1)")
elif actual == ORIGINAL:
    shutil.copyfile(nuevo, asset)
    print(f"u2.jar parcheado: {asset}")
else:
    sys.exit(f"{asset}: versión desconocida ({actual[:12]}…); revisar el parche antes de actualizar uiautomator2")
