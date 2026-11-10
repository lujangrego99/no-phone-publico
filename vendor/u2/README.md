# u2.jar parcheado: el servidor de uiautomator2 solo en 127.0.0.1

**Problema (medido 2026-11-04, Xiaomi 12T Pro):** el servidor que uiautomator2 levanta en el celu
(`app_process … com.wetest.uia2.Main -p 9008`) escucha en `::` (todas las interfaces) y sin autenticación.
Mientras corre, desde cualquier equipo de la misma WiFi `curl http://<ip-del-celu>:9008/jsonrpc/0` maneja el celu.

**Parche:** en `com/wetest/uia2/stub/AutomatorHttpServer.<init>(I)V` (classes7.dex) se cambia
`NanoHTTPD(port)` por `NanoHTTPD("127.0.0.1", port)`. Nada más. adb sigue llegando porque `adb forward` termina en el
loopback del celu.

**Verificado:** con el parche escucha en `::ffff:127.0.0.1:9008`; desde la WiFi «connection refused»; por adb anda
(info, app_current) y el flujo real `naranjax.saldo` pasa.

| | sha256 |
|---|---|
| u2.jar original (u2.jar 0.4.0, uiautomator2 3.7.0) | `0b74e83c55f443539a9f76f5ce023a51466b764b1100e4097a897053fdfc0eb6` |
| `u2-local.jar` | `a7fea82938765be058ef41c9c2c92556adcc779c23d18f2b21ad5e759f18c1a0` |

**Instalar:** `python scripts/u2_local.py` (lo corre el Dockerfile; en un venv local, una vez después de `pip install`).

**Regenerar** (si se actualiza uiautomator2; por eso está fijado en `requirements.txt`): baksmali/smali 2.5.2,
`baksmali d classes7.dex -o s7`, editar el `invoke-direct` de arriba (`const-string v0, "127.0.0.1"` +
`invoke-direct {p0, v0, p1}, …-><init>(Ljava/lang/String;I)V`), `smali a s7 -o classes7.dex --api 21`, reemplazar
`classes7.dex` dentro del jar y actualizar los hashes en `scripts/u2_local.py`.
