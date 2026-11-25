"""Hub de agentes: los celulares (APK no-phone) se conectan acá por WebSocket SALIENTE; el resto de no-phone
(API, MCP) les manda comandos por el puerto de control interno. Es el equivalente al «adb server», pero sin que
el celu tenga que estar en la misma red ni abrir puertos.

  :8765  /celu   → celulares. Headers: X-Celu: <id>, Authorization: Bearer <token>. Público (vía TLS del proxy).
  :8766  /ctl?celu=<id>  → control (solo red interna). Header X-Token: AGENTE_CTL_TOKEN.
         GET /estado → celus conectados.

Tokens de celus: AGENTE_DIR/celus.json guarda solo el sha256. Alta de un celu:
  python agente_hub.py alta <id>        → imprime el token (una sola vez)

Puente de PC (el celu por USB en una PC, manejado con adb/uiautomator2 completo desde acá):
  :8765  /puente → la PC (programa `puente/`). Headers: X-Puente: <id>, Authorization: Bearer <token>.
  :5037  (solo la red privada de no-phone, ver AGENTE_ADB_VECINO) → hace de «adb server» para no-phone (ANDROID_ADB_SERVER_HOST=agente): cada conexión
         TCP viaja multiplexada por el WebSocket y la PC la abre contra SU 127.0.0.1:5037. La PC no elige destino.
  Marcos binarios: 1 byte tipo (1 abrir · 2 datos · 3 cerrar · 4 abrir acelerado) + 4 bytes id de flujo + datos.
  Acelerado (si la PC dice «acelerar»): cada ida y vuelta al adb cruza el océano (~250 ms), así que el hub contesta
  solo `host:version` (con la versión que informó la PC) y la elección del celu (`host:tport:serial:X` /
  `host:transport:X`, solo si la PC informó ese celu como `device`), y manda a la PC la elección + el servicio
  juntos; la PC los hace contra su adb local y el estado REAL del servicio vuelve al cliente.
  python agente_hub.py alta-puente <id> → código de vinculación para `no-phone-puente vincular <código>`.
"""
from __future__ import annotations

import asyncio
import hashlib
import hmac
import http
import itertools
import json
import os
import secrets
import sys
import time
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlparse

DIR = Path(os.environ.get("AGENTE_DIR", "/data/agente"))
CELUS = DIR / "celus.json"
PUENTES = DIR / "puentes.json"
EVENTOS = DIR / "eventos.jsonl"
CTL_TOKEN = os.environ.get("AGENTE_CTL_TOKEN", "")
PUERTO_CELU = int(os.environ.get("AGENTE_CELU_PORT", "8765"))
PUERTO_CTL = int(os.environ.get("AGENTE_CTL_PORT", "8766"))
PUERTO_ADB = int(os.environ.get("AGENTE_ADB_PORT", "5037"))
# El contenedor también está en la red de Easypanel (la comparten TODAS las apps del VPS) y adb no tiene auth:
# el puerto adb escucha solo en la IP de la red privada de no-phone, la que lleva a AGENTE_ADB_VECINO (un servicio
# que está solo en esa red, p. ej. hindsight). Sin la variable (local/desarrollo) escucha en 127.0.0.1.
VECINO_ADB = os.environ.get("AGENTE_ADB_VECINO", "")
ABRIR, DATOS, CERRAR, ABRIR_ACELERADO = 1, 2, 3, 4


def _sha(t: str) -> str:
    return hashlib.sha256(t.encode()).hexdigest()


def _cargar(archivo: Path) -> dict:
    try:
        return json.loads(archivo.read_text())
    except (OSError, ValueError):
        return {}


def _cargar_celus() -> dict:
    return _cargar(CELUS)


def _alta_en(archivo: Path, clave: str) -> str:
    DIR.mkdir(parents=True, exist_ok=True)
    data = _cargar(archivo)
    token = secrets.token_urlsafe(32)
    data[clave] = {"sha256": _sha(token), "alta": time.strftime("%Y-%m-%d %H:%M:%S")}
    tmp = archivo.with_suffix(".tmp")
    tmp.write_text(json.dumps(data, indent=1))
    os.chmod(tmp, 0o600)
    tmp.replace(archivo)
    return token


def alta(celu: str) -> str:
    return _alta_en(CELUS, celu)


def alta_puente(pid: str) -> str:
    """Token nuevo para la PC `pid` (reemplaza el anterior) y el código que se pega en `no-phone-puente vincular`."""
    import base64
    token = _alta_en(PUENTES, pid)
    host = os.environ.get("AGENTE_HOST", "")
    url = f"wss://{host}/puente" if host else f"ws://127.0.0.1:{PUERTO_CELU}/puente"
    crudo = json.dumps({"url": url, "id": pid, "token": token}, separators=(",", ":")).encode()
    return base64.urlsafe_b64encode(crudo).decode().rstrip("=")


def _credencial_ok(archivo: Path, clave: str, tok: str) -> bool:
    reg = _cargar(archivo).get(clave)
    return bool(clave and reg and hmac.compare_digest(_sha(tok), reg.get("sha256", "")))


def _log(d: dict) -> None:
    d.setdefault("t_srv", time.time())
    try:
        DIR.mkdir(parents=True, exist_ok=True)
        if EVENTOS.exists() and EVENTOS.stat().st_size > 5 * 2**20:
            EVENTOS.replace(EVENTOS.with_suffix(".jsonl.1"))
        with EVENTOS.open("a") as f:
            f.write(json.dumps(d, ensure_ascii=False) + "\n")
    except OSError:
        pass


class Hub:
    def __init__(self):
        self.celus: dict[str, Any] = {}       # id → websocket
        self.info: dict[str, dict] = {}          # id → hola + desde
        self.pend: dict[int, tuple[str, asyncio.Future]] = {}
        self.ids = itertools.count(1)
        self.puente: Any = None                  # websocket de la PC puente conectada (una sola)
        self.puente_info: dict = {}
        self.flujos: dict[int, asyncio.StreamWriter] = {}
        self.fids = itertools.count(1)

    async def conexion(self, ws):
        if urlparse(ws.request.path).path == "/puente":
            await self.puente_ws(ws)
        else:
            await self.celu(ws)

    # ---------------------------------------------------------------- celulares
    async def celu(self, ws):
        h = ws.request.headers
        cid = (h.get("X-Celu") or "").strip()
        tok = (h.get("Authorization") or "").removeprefix("Bearer ").strip()
        reg = _cargar_celus().get(cid)
        if not cid or not reg or not hmac.compare_digest(_sha(tok), reg.get("sha256", "")):
            _log({"ev": "rechazado", "celu": cid, "peer": str(ws.remote_address)})
            await ws.close(4401, "credenciales")
            return
        viejo = self.celus.get(cid)
        if viejo is not None:
            await viejo.close(4000, "reemplazado")
        self.celus[cid] = ws
        self.info[cid] = {"desde": time.time()}
        _log({"ev": "conectado", "celu": cid, "peer": str(ws.remote_address)})
        try:
            async for m in ws:
                d = json.loads(m)
                rid = d.get("id")
                if rid is not None and rid in self.pend:
                    self.pend.pop(rid)[1].set_result(d)
                    continue
                if d.get("ev") == "hola":
                    self.info[cid].update(d)
                d["celu"] = cid
                _log(d)
        except Exception as e:  # noqa: BLE001
            _log({"ev": "error_celu", "celu": cid, "err": repr(e)[:300]})
        finally:
            if self.celus.get(cid) is ws:
                self.celus.pop(cid, None)
                self.info.pop(cid, None)
            for rid, (c, fut) in list(self.pend.items()):
                if c == cid and not fut.done():
                    fut.set_result({"ok": False, "err": "celu_desconectado"})
                    self.pend.pop(rid, None)
            _log({"ev": "desconectado", "celu": cid})

    # ---------------------------------------------------------------- puente de PC (adb por WebSocket)
    async def puente_ws(self, ws):
        h = ws.request.headers
        pid = (h.get("X-Puente") or "").strip()
        tok = (h.get("Authorization") or "").removeprefix("Bearer ").strip()
        if not _credencial_ok(PUENTES, pid, tok):
            _log({"ev": "puente_rechazado", "puente": pid, "peer": str(ws.remote_address)})
            await ws.close(4401, "credenciales")
            return
        if self.puente is not None:
            await self.puente.close(4000, "reemplazado")
        self._cerrar_flujos()
        self.puente = ws
        self.puente_info = {"id": pid, "desde": time.time()}
        _log({"ev": "puente_conectado", "puente": pid, "peer": str(ws.remote_address)})
        try:
            async for m in ws:
                if isinstance(m, str):  # estado que manda la PC: {"ev":"hola","version":…,"adb":[…]}
                    d = json.loads(m)
                    if d.get("ev") == "hola":
                        self.puente_info.update({k: v for k, v in d.items() if k != "ev"}, visto=time.time())
                    continue
                if len(m) < 5:
                    continue
                tipo, fid = m[0], int.from_bytes(m[1:5], "big")
                w = self.flujos.get(fid)
                if w is None:
                    continue
                if tipo == DATOS:
                    w.write(m[5:])
                    try:
                        await w.drain()
                    except ConnectionError:
                        self._cerrar_flujo(fid)
                elif tipo == CERRAR:
                    self._cerrar_flujo(fid)
        except Exception as e:  # noqa: BLE001
            _log({"ev": "error_puente", "puente": pid, "err": repr(e)[:300]})
        finally:
            if self.puente is ws:
                self.puente = None
                self.puente_info = {}
                self._cerrar_flujos()
            _log({"ev": "puente_desconectado", "puente": pid})

    def _cerrar_flujo(self, fid: int) -> None:
        w = self.flujos.pop(fid, None)
        if w is not None:
            w.close()

    def _cerrar_flujos(self) -> None:
        for fid in list(self.flujos):
            self._cerrar_flujo(fid)

    def _celu_en_linea(self, serial: str) -> dict | None:
        """El celu que la PC informó como «device» en su último estado (cada 25 s)."""
        if time.time() - self.puente_info.get("visto", 0) > 75:
            return None
        return next((c for c in self.puente_info.get("adb") or [] if c.get("serial") == serial and c.get("estado") == "device"), None)

    async def adb_cliente(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter):
        """Una conexión de no-phone al «adb server»: viaja a la PC como un flujo del puente."""
        ws = self.puente
        if ws is None:
            writer.close()
            return
        fid = next(self.fids)
        cab = lambda t: bytes([t]) + fid.to_bytes(4, "big")  # noqa: E731
        apertura, inicial = cab(ABRIR), b""
        try:
            if "acelerar" in (self.puente_info.get("capacidades") or []):
                crudo, txt = await _leer_pedido(reader)
                ver = self.puente_info.get("adb_version") or ""
                serial = next((txt[len(p):] for p in ("host:tport:serial:", "host:transport:") if txt.startswith(p)), "")
                celu = self._celu_en_linea(serial) if serial else None
                if txt == "host:version" and len(ver) == 4:
                    writer.write(b"OKAY0004" + ver.encode())
                    await writer.drain()
                    writer.close()
                    return
                if celu is not None:
                    tport = txt.startswith("host:tport:")
                    tid = int(celu.get("transport_id") or 0)
                    writer.write(b"OKAY" + (tid.to_bytes(8, "little") if tport else b""))
                    await writer.drain()
                    servicio, _ = await _leer_pedido(reader)
                    apertura = cab(ABRIR_ACELERADO) + bytes([1 if tport else 0]) + crudo + servicio
                else:
                    inicial = crudo
            self.flujos[fid] = writer
            await ws.send(apertura)
            if inicial:
                await ws.send(cab(DATOS) + inicial)
            while chunk := await reader.read(65536):
                if self.flujos.get(fid) is not writer:
                    break
                await ws.send(cab(DATOS) + chunk)
        except Exception:  # noqa: BLE001
            pass
        finally:
            if self.flujos.pop(fid, None) is not None:
                try:
                    await ws.send(cab(CERRAR))
                except Exception:  # noqa: BLE001
                    pass
            writer.close()

    # ---------------------------------------------------------------- control
    async def ctl(self, ws):
        q = parse_qs(urlparse(ws.request.path).query)
        cid = (q.get("celu") or [""])[0]
        async for m in ws:
            cmd = json.loads(m)
            r = await self.mandar(cid or cmd.pop("celu", ""), cmd)
            await ws.send(json.dumps(r, ensure_ascii=False))

    async def mandar(self, cid: str, cmd: dict) -> dict:
        ws = self.celus.get(cid)
        if ws is None:
            return {"ok": False, "err": "celu_no_conectado", "celu": cid}
        rid = next(self.ids)
        cmd["id"] = rid
        fut = asyncio.get_running_loop().create_future()
        self.pend[rid] = (cid, fut)
        t0 = time.perf_counter()
        try:
            await ws.send(json.dumps(cmd, ensure_ascii=False))
            r = await asyncio.wait_for(fut, timeout=float(cmd.get("timeout") or 0) / 1000 + 30)
        except asyncio.TimeoutError:
            r = {"ok": False, "err": "timeout"}
        except Exception as e:  # noqa: BLE001
            r = {"ok": False, "err": f"envio: {e!r}"[:300]}
        finally:
            self.pend.pop(rid, None)
        r["rtt_ms"] = round((time.perf_counter() - t0) * 1000, 1)
        return r

    def estado(self) -> dict:
        ahora = time.time()
        return {"celus": {c: {**{k: v for k, v in i.items() if k not in ("ev", "id")},
                               "conectado_hace_s": int(ahora - i.get("desde", ahora))}
                          for c, i in self.info.items()},
                "registrados": sorted(_cargar_celus()),
                "puente": ({**{k: v for k, v in self.puente_info.items() if k not in ("desde", "visto")},
                            "conectado_hace_s": int(ahora - self.puente_info.get("desde", ahora)),
                            "flujos": len(self.flujos)} if self.puente is not None else None),
                "puentes_registrados": sorted(_cargar(PUENTES))}


HUB = Hub()


def _auth_ctl(connection, request):
    from websockets.datastructures import Headers
    p = urlparse(request.path).path
    if not CTL_TOKEN or not hmac.compare_digest((request.headers.get("X-Token") or "").encode(), CTL_TOKEN.encode()):
        return connection.respond(http.HTTPStatus.UNAUTHORIZED, "token\n")
    if p == "/estado":
        body = json.dumps(HUB.estado(), ensure_ascii=False).encode()
        resp = connection.respond(http.HTTPStatus.OK, "")
        resp.body = body
        resp.headers = Headers([("Content-Type", "application/json"), ("Content-Length", str(len(body)))])
        return resp
    if p != "/ctl":
        return connection.respond(http.HTTPStatus.NOT_FOUND, "no\n")
    return None


def _ruta_celu(connection, request):
    p = urlparse(request.path).path
    if p == "/salud":
        return connection.respond(http.HTTPStatus.OK, "ok\n")
    if p not in ("/celu", "/puente"):
        return connection.respond(http.HTTPStatus.NOT_FOUND, "no\n")
    return None


async def _leer_pedido(reader: asyncio.StreamReader) -> tuple[bytes, str]:
    """Un pedido del protocolo de adb: 4 dígitos hex de largo + texto. Devuelve (crudo, texto)."""
    cab = await asyncio.wait_for(reader.readexactly(4), 30)
    cuerpo = await asyncio.wait_for(reader.readexactly(int(cab, 16)), 30)
    return cab + cuerpo, cuerpo.decode("utf-8", "replace")


async def _ip_privada(vecino: str) -> str:
    """IP propia en la red que lleva a `vecino` (espera a que el nombre resuelva: puede arrancar después)."""
    import socket
    for _ in range(120):
        try:
            ip = socket.gethostbyname(vecino)
            with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as u:
                u.connect((ip, 9))
                return u.getsockname()[0]
        except OSError:
            await asyncio.sleep(5)
    raise SystemExit(f"AGENTE_ADB_VECINO={vecino} no resuelve: no abro el puerto adb")


async def main():
    import websockets
    if not CTL_TOKEN:
        raise SystemExit("Falta AGENTE_CTL_TOKEN")
    bind_adb = await _ip_privada(VECINO_ADB) if VECINO_ADB else "127.0.0.1"
    adb = await asyncio.start_server(HUB.adb_cliente, bind_adb, PUERTO_ADB)
    async with adb, websockets.serve(HUB.conexion, "0.0.0.0", PUERTO_CELU, process_request=_ruta_celu,
                                max_size=32 * 2**20, ping_interval=20, ping_timeout=20), \
            websockets.serve(HUB.ctl, "0.0.0.0", PUERTO_CTL, process_request=_auth_ctl,
                             max_size=32 * 2**20, ping_interval=None):
        print(f"agente-hub: celus :{PUERTO_CELU}/celu, puente :{PUERTO_CELU}/puente → adb {bind_adb}:{PUERTO_ADB}, "
              f"control :{PUERTO_CTL}/ctl", flush=True)
        await asyncio.Future()


if __name__ == "__main__":
    if len(sys.argv) == 3 and sys.argv[1] == "alta":
        print(alta(sys.argv[2]))
    elif len(sys.argv) == 3 and sys.argv[1] == "alta-puente":
        print(alta_puente(sys.argv[2]))
    else:
        asyncio.run(main())
