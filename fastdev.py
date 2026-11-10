"""Device rápido: las preguntas «¿está tal cosa en pantalla?» se contestan con UN dump compartido.

Cada `d(text=…).exists` de uiautomator2 es un RPC al celu (~0,4–0,5 s por WiFi). Los flujos de Naranja X
encadenan decenas (chequear sin internet, login, biometría, en qué pantalla estoy…) y un `nx_saldo` hacía
53 RPC ≈ 25 s. Acá todas esas preguntas se responden contra el último dump (~0,7 s), que vale hasta que se
hace cualquier acción (tap, back, swipe, escribir…) o pasa `TTL` segundos. Lo que no es una pregunta
(click, wait, set_text…) va directo al celu como siempre.

Uso: `d = FastDevice(u2.connect(serial))`. Con NX_FAST_UI=0 se desactiva (queda el device crudo).
"""
from __future__ import annotations

import json
import os
import re
import time
import xml.etree.ElementTree as ET

TTL = float(os.environ.get("NX_SNAP_TTL", "0.8"))

# Métodos del device que solo leen: no invalidan el dump.
_READ_ONLY = {"window_size", "serial", "device_info", "settings", "wlan_ip"}
SCREEN_TTL = float(os.environ.get("NX_SCREEN_TTL", "8"))
RPC_ANTES_DE_DUMP = int(os.environ.get("NX_RPC_ANTES_DE_DUMP", "6"))
# Por USB (serial sin IP) un dump cuesta ~0,35 s, casi lo mismo que una RPC: conviene bajarlo enseguida.
# Medido: saldo 4,3 → 3,5 s, preview de transferencia 17 → 15 s.
RPC_ANTES_DE_DUMP_USB = int(os.environ.get("NX_RPC_ANTES_DE_DUMP_USB", "0"))

_SEL_KEYS = {"text", "textStartsWith", "textContains", "textMatches", "description", "descriptionStartsWith",
             "descriptionContains", "descriptionMatches", "resourceId", "className", "clickable", "enabled"}


def _match(n: ET.Element, sel: dict) -> bool:
    t, ds = n.get("text") or "", n.get("content-desc") or ""
    for k, v in sel.items():
        if k == "text" and t != v:
            return False
        if k == "textStartsWith" and not t.startswith(v):
            return False
        if k == "textContains" and v not in t:
            return False
        if k == "textMatches" and not re.fullmatch(v, t):
            return False
        if k == "description" and ds != v:
            return False
        if k == "descriptionStartsWith" and not ds.startswith(v):
            return False
        if k == "descriptionContains" and v not in ds:
            return False
        if k == "descriptionMatches" and not re.fullmatch(v, ds):
            return False
        if k == "resourceId" and (n.get("resource-id") or "") != v:
            return False
        if k == "className" and (n.get("class") or "") != v:
            return False
        if k in ("clickable", "enabled") and (n.get(k) == "true") != bool(v):
            return False
    return True


class _Exists:
    """Como el `exists` de u2: se usa como bool (`if el.exists:`) o se llama (`el.exists(timeout=0.3)`)."""

    def __init__(self, sel: "_FastSelector"):
        self._s = sel

    def __bool__(self):
        return self._s._check(0)

    def __call__(self, timeout: float = 0):
        return self._s._check(timeout)


class _FastSelector:
    def __init__(self, dev: "FastDevice", sel: dict):
        self._dev, self._sel = dev, sel
        self._raw = None

    @property
    def raw(self):
        if self._raw is None:
            self._raw = self._dev._d(**self._sel)
        return self._raw

    def _check(self, timeout: float) -> bool:
        timeout = max(0.0, float(timeout or 0))
        if not set(self._sel) <= _SEL_KEYS:
            return self.raw.exists(timeout=timeout)
        dev = self._dev
        if not dev._fresh():
            # Sin dump vigente, las primeras preguntas van por RPC (~0,2 s c/u, poco payload) y recién desde la
            # RPC_ANTES_DE_DUMP-ésima conviene bajar el dump entero (~1 s por WiFi lenta) y contestar todo de ahí.
            if dev._misses < dev._rpc_antes_de_dump:
                dev._misses += 1
                return bool(self.raw.exists(timeout=timeout))
        if any(_match(n, self._sel) for n in dev._tree().iter("node")):
            return True
        # No está en la pantalla de recién. Esperas cortas: no vale un dump nuevo. Largas: que espere el celu
        # (una sola RPC que vuelve apenas aparece), no un dump por vuelta.
        if timeout <= 0.6:
            return False
        return bool(self.raw.exists(timeout=timeout))

    @property
    def exists(self):
        return _Exists(self)

    def click(self, *a, **k):
        """Tap en el centro del nodo del dump vigente (1 RPC) en vez de wait+info+click de u2 (3 RPC)."""
        if not a and not k and set(self._sel) <= _SEL_KEYS and self._dev._fresh():
            for n in self._dev._tree().iter("node"):
                if _match(n, self._sel):
                    b = list(map(int, re.findall(r"\d+", n.get("bounds") or "")))
                    if len(b) == 4 and b[2] > b[0] and b[3] > b[1]:
                        self._dev.click((b[0] + b[2]) // 2, (b[1] + b[3]) // 2)
                        return None
                    break
        try:
            try:
                return self.raw.click(*a, **k)
            except Exception as e:  # noqa: BLE001
                # La pantalla se redibujó entre encontrar el nodo y tocarlo (StaleObjectException): buscarlo de nuevo.
                if "StaleObject" not in str(e):
                    raise
                time.sleep(0.2)
                return self.raw.click(*a, **k)
        finally:
            self._dev.invalidate()

    def __getattr__(self, name):
        attr = getattr(self.raw, name)
        if callable(attr) and name not in ("info", "get_text", "bounds", "count"):
            def call(*a, **k):
                try:
                    return attr(*a, **k)
                finally:
                    self._dev.invalidate()
            return call
        return attr


_WS: dict[str, tuple] = {}  # serial → (ancho, alto)


class FastDevice:
    def __init__(self, d):
        self._d = d
        serial = getattr(d, "serial", "") or ""
        self._rpc_antes_de_dump = RPC_ANTES_DE_DUMP if re.match(r"\d+\.\d+\.\d+\.\d+:", serial) else RPC_ANTES_DE_DUMP_USB
        self._xml: str | None = None
        self._root: ET.Element | None = None
        self._at = 0.0
        self.stats = {"dumps": 0, "hits": 0}
        self._app = None
        self._screen_on_at = 0.0
        self._misses = 0
        self._directo: bool | None = None

    # --- dump compartido
    def invalidate(self):
        self._xml = None
        self._root = None
        self._app = None
        self._misses = 0

    def app_current(self):
        """App en primer plano. u2 lee `dumpsys window` entero por adb (~1,3 s por WiFi); acá se filtra en el celu
        (~0,1 s). Vale lo mismo que el dump (hasta la próxima acción o TTL)."""
        if self._app is not None and (time.time() - self._app[0]) < TTL:
            self.stats["hits"] += 1
            return dict(self._app[1])
        r = None
        try:
            out = self._d.shell("dumpsys window | grep -m1 mCurrentFocus").output
            m = re.search(r"u0 ([\w.]+)/([\w.$]+)\}", out or "")
            if m:
                pkg, act = m.group(1), m.group(2)
                r = {"package": pkg, "activity": pkg + act if act.startswith(".") else act}
        except Exception:
            r = None
        if r is None:
            r = self._d.app_current()
        self._app = (time.time(), r)
        return dict(r)

    def screen_on(self):
        """Prender la pantalla cuesta 3 RPC; si la prendimos hace poco (y nadie la apagó), no hace falta."""
        if time.time() - self._screen_on_at < SCREEN_TTL:
            return None
        r = self._d.screen_on()
        self._screen_on_at = time.time()
        return r

    def screen_off(self):
        self._screen_on_at = 0.0
        self.invalidate()
        return self._d.screen_off()

    def window_size(self):
        """El tamaño de pantalla no cambia (app vertical): u2 lo pide por RPC en cada swipe_ext (~0,7 s por WiFi)."""
        key = getattr(self._d, "serial", "") or ""
        if key not in _WS:
            _WS[key] = tuple(self._d.window_size())
        return _WS[key]

    def swipe_ext(self, direction, scale: float = 0.9, box=None, **kw):
        if box is None:
            w, h = self.window_size()
            box = (0, 0, w, h)
        try:
            return self._d.swipe_ext(direction, scale, box=box, **kw)
        finally:
            self.invalidate()


    def _fresh(self) -> bool:
        return self._xml is not None and (time.time() - self._at) < TTL

    def dump_hierarchy(self, *a, **k) -> str:
        if a or k:
            return self._d.dump_hierarchy(*a, **k)
        if self._fresh():
            self.stats["hits"] += 1
            return self._xml  # type: ignore[return-value]
        self._xml = self._dump_directo() or self._d.dump_hierarchy()
        self._at = time.time()
        self._root = None
        self.stats["dumps"] += 1
        return self._xml

    def _dump_directo(self) -> str | None:
        """Celu por WiFi: el server de uiautomator escucha en :9008 de la LAN; pedirle el dump directo por HTTP
        (~0,9 s) evita el túnel de adb (~1,4 s para los mismos 90 KB). Si no responde, se usa el túnel."""
        if self._directo is False:
            return None
        serial = getattr(self._d, "serial", "") or ""
        m = re.fullmatch(r"(\d+\.\d+\.\d+\.\d+):\d+", serial)
        if not m or os.environ.get("NX_U2_DIRECTO", "1") == "0":
            self._directo = False
            return None
        import json
        import urllib.request

        try:
            body = json.dumps({"jsonrpc": "2.0", "id": 1, "method": "dumpWindowHierarchy", "params": [False, 50]}).encode()
            req = urllib.request.Request(f"http://{m.group(1)}:9008/jsonrpc/0", body, {"content-type": "application/json"})
            with urllib.request.urlopen(req, timeout=10) as r:
                xml = json.loads(r.read()).get("result")
            if isinstance(xml, str) and xml.startswith("<?xml"):
                self._directo = True
                return xml
        except Exception:
            pass
        self._directo = False  # no anda: túnel adb para siempre (en este proceso)
        return None

    def _tree(self) -> ET.Element:
        xml = self.dump_hierarchy()
        if self._root is None:
            self._root = ET.fromstring(xml)
        return self._root

    # --- selectores
    def __call__(self, **sel):
        return _FastSelector(self, sel)

    # --- todo lo demás va al device real; las acciones invalidan el dump
    def __getattr__(self, name):
        attr = getattr(self._d, name)
        if callable(attr) and name not in _READ_ONLY:
            def call(*a, **k):
                try:
                    return attr(*a, **k)
                finally:
                    self.invalidate()
            return call
        return attr


def envolver(d):
    if os.environ.get("NX_FAST_UI", "1") == "0" or isinstance(d, FastDevice):
        return d
    _rpc_directo()
    return FastDevice(d)


_rpc_parcheado = False
# RPC de uiautomator que solo leen: se pueden repetir sin efectos en el celu.
_RPC_LECTURA = frozenset({
    "exist", "waitForExists", "waitUntilGone", "dumpWindowHierarchy", "deviceInfo", "getInfo", "objInfo",
    "count", "getText", "getLastToast", "windowSize", "getClipboard", "ping",
})


def _rpc_directo() -> None:
    """Celu por WiFi: todas las RPC de uiautomator2 van directo al server del celu (:9008 en la LAN) con una
    conexión que se reusa, en vez de abrir un túnel adb nuevo por llamada. Medido: deviceInfo 0,1 s vs 0,2 s;
    exists 0,1 s vs 0,25 s. Si el celu no responde directo, esa llamada (y las siguientes) vuelven al túnel."""
    global _rpc_parcheado
    if _rpc_parcheado or os.environ.get("NX_U2_DIRECTO", "1") == "0":
        return
    _rpc_parcheado = True
    import http.client
    import threading

    from uiautomator2 import core

    original = core._http_request
    conns: dict[str, http.client.HTTPConnection] = {}
    malos: dict[str, float] = {}  # host → hasta cuándo no probar directo
    lock = threading.Lock()

    def por_tunel(dev, device_port, method, path, data, timeout, print_request):
        # Por el túnel adb (USB) el server de uiautomator a veces corta una conexión sin responder
        # (RemoteDisconnected, ~1 de cada 100 RPC). Reintentar una vez SOLO lecturas: un click repetido no.
        rpc = (data or {}).get("method") if isinstance(data, dict) else None
        try:
            return original(dev, device_port, method, path, data, timeout, print_request)
        except (http.client.RemoteDisconnected, ConnectionResetError, BrokenPipeError):
            if rpc not in _RPC_LECTURA:
                raise
            time.sleep(0.15)
            return original(dev, device_port, method, path, data, timeout, print_request)

    def directo(dev, device_port, method, path, data=None, timeout=10.0, print_request=False):
        serial = getattr(dev, "serial", "") or ""
        m = re.fullmatch(r"(\d+\.\d+\.\d+\.\d+):\d+", serial)
        if not m or malos.get(m.group(1), 0) > time.time():
            return por_tunel(dev, device_port, method, path, data, timeout, print_request)
        host = m.group(1)
        headers = {"User-Agent": "uiautomator2", "Accept-Encoding": "", "Content-Type": "application/json"}
        body = None if not data else json.dumps(data)
        with lock:
            for intento in range(2):
                c = conns.get(host)
                if c is None:
                    c = conns[host] = http.client.HTTPConnection(host, device_port, timeout=timeout)
                try:
                    c.timeout = timeout
                    if c.sock is not None:
                        c.sock.settimeout(timeout)
                    c.request(method, path, body, headers)
                    r = c.getresponse()
                    content = r.read()
                    if r.status != 200:
                        raise core.HTTPError(f"HTTP request failed: {r.status} {r.reason}")
                    return core.HTTPResponse(bytearray(content))
                except core.HTTPError:
                    raise
                except Exception:
                    try:
                        c.close()
                    except Exception:
                        pass
                    conns.pop(host, None)
                    if intento == 1:
                        malos[host] = time.time() + 60
        return original(dev, device_port, method, path, data, timeout, print_request)

    core._http_request = directo
