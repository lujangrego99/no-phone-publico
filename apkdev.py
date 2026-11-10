"""Driver de celular por la APK de no-phone (accesibilidad), con la misma interfaz que usa no-phone de
uiautomator2. El celu está conectado al hub (agente_hub.py) por WebSocket saliente; acá se le mandan comandos
por el puerto de control del hub. Serial de un celu por APK: «apk:<id>» (ver phones.conectar).

Lo que la APK no puede hacer sin permisos de shell (force-stop, keyevents crudos, `dumpsys`) levanta
ApkNoSoportado: los flujos que lo usan tienen camino alternativo (ver naranjax).
"""
from __future__ import annotations

import base64
import gzip
import json
import os
import re
import threading
import time
from typing import Any


class ApkNoSoportado(RuntimeError):
    """La operación necesita permisos de shell/adb que la APK no tiene."""


class ApkDesconectado(ConnectionError):
    """El celu no está conectado al hub (sin red, apagado o accesibilidad desactivada)."""


class UiObjectNotFoundError(Exception):
    """Mismo nombre que la de uiautomator2: el elemento no apareció."""


class ShellResponse:
    def __init__(self, output: str, exit_code: int = 0):
        self.output, self.exit_code = output, exit_code

    def __iter__(self):  # u2 permite `out, code = d.shell(...)`
        return iter((self.output, self.exit_code))


ESPERA_DEFECTO = float(os.environ.get("APK_WAIT_TIMEOUT", "10"))


class _Exists:
    def __init__(self, s: "ApkSelector"):
        self._s = s

    def __bool__(self):
        return self._s._dev._op("exists", sel=self._s._sel) is True

    def __call__(self, timeout: float = 0):
        return self._s._dev._op("exists", sel=self._s._sel, timeout=int(float(timeout or 0) * 1000)) is True


class _Scroll:
    def __init__(self, s: "ApkSelector"):
        self._s = s

    def to(self, **objetivo) -> bool:
        return bool(self._s._dev._op("scroll_to", sel=self._s._sel, objetivo=objetivo, max=20))

    def forward(self, steps: int = 1, **_):
        return bool(self._s._dev._op("scroll", sel=self._s._sel, dir="forward", pasos=max(1, int(steps) // 50 or 1)))

    def backward(self, steps: int = 1, **_):
        return bool(self._s._dev._op("scroll", sel=self._s._sel, dir="backward", pasos=max(1, int(steps) // 50 or 1)))

    def toEnd(self, max_swipes: int = 20, **_):
        return bool(self._s._dev._op("scroll", sel=self._s._sel, dir="forward", pasos=max_swipes))

    def toBeginning(self, max_swipes: int = 20, **_):
        return bool(self._s._dev._op("scroll", sel=self._s._sel, dir="backward", pasos=max_swipes))

    @property
    def vert(self):
        return self

    def __call__(self, steps: int = 1):
        return self.forward(steps)


class ApkSelector:
    def __init__(self, dev: "ApkDevice", sel: dict):
        self._dev, self._sel = dev, sel

    @property
    def exists(self):
        return _Exists(self)

    def wait(self, exists: bool = True, timeout: float | None = None) -> bool:
        t = int(1000 * (ESPERA_DEFECTO if timeout is None else float(timeout)))
        return self._dev._op("wait" if exists else "wait_gone", sel=self._sel, timeout=t) is True

    def wait_gone(self, timeout: float | None = None) -> bool:
        return self.wait(exists=False, timeout=timeout)

    def click(self, timeout: float | None = None, offset=None):
        t = int(1000 * (ESPERA_DEFECTO if timeout is None else float(timeout)))
        if not self._dev._op("click", sel=self._sel, timeout=t):
            raise UiObjectNotFoundError(json.dumps(self._sel, ensure_ascii=False))

    def click_exists(self, timeout: float = 0) -> bool:
        return self._dev._op("click", sel=self._sel, timeout=int(float(timeout) * 1000)) is True

    def long_click(self, duration: float = 0.7, timeout: float | None = None):
        t = int(1000 * (ESPERA_DEFECTO if timeout is None else float(timeout)))
        if not self._dev._op("long_click", sel=self._sel, timeout=t, ms=int(duration * 1000)):
            raise UiObjectNotFoundError(json.dumps(self._sel, ensure_ascii=False))

    def set_text(self, text: str, timeout: float | None = None):
        t = int(1000 * (ESPERA_DEFECTO if timeout is None else float(timeout)))
        if not self._dev._op("set_text", sel=self._sel, text=str(text), timeout=t):
            raise UiObjectNotFoundError(json.dumps(self._sel, ensure_ascii=False))

    send_keys = set_text

    def clear_text(self, timeout: float | None = None):
        self.set_text("", timeout=timeout)

    def get_text(self, timeout: float | None = None):
        t = int(1000 * (ESPERA_DEFECTO if timeout is None else float(timeout)))
        r = self._dev._op("get_text", sel=self._sel, timeout=t)
        if r is None:
            raise UiObjectNotFoundError(json.dumps(self._sel, ensure_ascii=False))
        return r

    @property
    def info(self) -> dict:
        r = self._dev._op("info_nodo", sel=self._sel, timeout=int(ESPERA_DEFECTO * 1000))
        if r is None:
            raise UiObjectNotFoundError(json.dumps(self._sel, ensure_ascii=False))
        return r

    def bounds(self):
        b = self.info["bounds"]
        return b["left"], b["top"], b["right"], b["bottom"]

    def center(self):
        l, t, r, b = self.bounds()
        return (l + r) // 2, (t + b) // 2

    @property
    def count(self) -> int:
        return int(self._dev._op("count", sel=self._sel) or 0)

    def __len__(self):
        return self.count

    @property
    def scroll(self):
        return _Scroll(self)


class ApkDevice:
    es_apk = True

    def __init__(self, celu: str, hub: str | None = None, token: str | None = None):
        self.celu = celu
        self.serial = f"apk:{celu}"
        self._hub = (hub or os.environ.get("AGENTE_HUB_URL") or "ws://agente:8766").rstrip("/")
        self._token = token or os.environ.get("AGENTE_CTL_TOKEN") or ""
        self._ws = None
        self._lock = threading.Lock()
        self._wh: tuple[int, int] | None = None
        self.settings: dict[str, Any] = {"wait_timeout": ESPERA_DEFECTO}

    # ------------------------------------------------------------ transporte
    def _conectar(self):
        from websockets.sync.client import connect
        self._ws = connect(f"{self._hub}/ctl?celu={self.celu}", additional_headers={"X-Token": self._token},
                           max_size=32 * 2**20, open_timeout=10, close_timeout=2)

    def _op(self, op: str, **kw):
        cmd = {"op": op, **kw}
        with self._lock:
            for intento in (1, 2):
                try:
                    if self._ws is None:
                        self._conectar()
                    self._ws.send(json.dumps(cmd, ensure_ascii=False))
                    r = json.loads(self._ws.recv(timeout=float(kw.get("timeout") or 0) / 1000 + 40))
                    break
                except Exception as e:  # noqa: BLE001  (hub caído o conexión vieja: una reconexión)
                    try:
                        if self._ws is not None:
                            self._ws.close()
                    except Exception:
                        pass
                    self._ws = None
                    if intento == 2 or op not in _OPS_LECTURA:
                        raise ApkDesconectado(f"hub de agentes inaccesible ({op}): {e}") from e
        if not r.get("ok"):
            err = str(r.get("err") or "")
            if err in ("celu_no_conectado", "celu_desconectado", "timeout"):
                raise ApkDesconectado(f"celu {self.celu}: {err}")
            if "no_soportado" in err or "UnsupportedOperation" in err:
                raise ApkNoSoportado(err)
            raise RuntimeError(f"agente {op}: {err}")
        return r.get("r")

    # ------------------------------------------------------------ interfaz tipo u2
    def __call__(self, **sel) -> ApkSelector:
        return ApkSelector(self, sel)

    def app_current(self) -> dict:
        r = self._op("app_current") or {}
        pkg = r.get("package") or r.get("ventana_pkg") or ""
        act = r.get("activity") or ""
        if r.get("ventana_pkg") and r.get("ventana_pkg") != pkg:
            pkg, act = r["ventana_pkg"], ""  # cambió la ventana sin evento de activity (diálogo/sistema)
        return {"package": pkg, "activity": act}

    def app_start(self, pkg: str, activity: str | None = None, wait: bool = False, stop: bool = False, **_):
        if not self._op("app_start", pkg=pkg):
            raise RuntimeError(f"no pude abrir {pkg} (¿instalada? ¿permiso MIUI de ventanas en segundo plano?)")
        if wait:
            self(packageName=pkg).wait(timeout=15)

    def app_stop(self, pkg: str):
        raise ApkNoSoportado("no_soportado: force-stop necesita shell")

    def press(self, key: str):
        k = {"KEYCODE_BACK": "back", "KEYCODE_HOME": "home", "KEYCODE_ENTER": "enter"}.get(str(key), str(key).lower())
        return self._op("press", key=k)

    def click(self, x, y):
        x, y = self._abs(x, y)
        return self._op("click", x=x, y=y)

    def long_click(self, x, y, duration: float = 0.7):
        x, y = self._abs(x, y)
        return self._op("long_click", x=x, y=y, ms=int(duration * 1000))

    def swipe(self, fx, fy, tx, ty, duration: float | None = None, steps: int | None = None):
        fx, fy = self._abs(fx, fy)
        tx, ty = self._abs(tx, ty)
        ms = int((duration if duration is not None else 0.2) * 1000)
        return self._op("swipe", x1=fx, y1=fy, x2=tx, y2=ty, ms=max(50, ms))

    def swipe_ext(self, direction: str, scale: float = 0.9, box=None, duration: float | None = None, **_):
        lx, ly, rx, ry = box or (0, 0, *self.window_size())
        w, h = rx - lx, ry - ly
        ho, vo = int(w * (1 - scale)) // 2, int(h * (1 - scale)) // 2
        cx, cy = (lx + rx) // 2, (ly + ry) // 2
        izq, der, arr, aba = (lx + ho, cy), (rx - ho, cy), (cx, ly + vo), (cx, ry - vo)
        a, b = {"up": (aba, arr), "down": (arr, aba), "left": (der, izq), "right": (izq, der)}[direction]
        return self.swipe(*a, *b, duration=duration if duration is not None else 0.25)

    def window_size(self) -> tuple[int, int]:
        if self._wh is None:
            w, h = self._op("window_size")
            self._wh = (int(w), int(h))
        return self._wh

    def _abs(self, x, y):
        if isinstance(x, float) and x < 1 and isinstance(y, float) and y < 1:
            w, h = self.window_size()
            return int(x * w), int(y * h)
        return int(x), int(y)

    def dump_hierarchy(self, compressed: bool = False, pretty: bool = False, max_depth=None) -> str:
        b64 = self._op("dump", gz=True)
        return gzip.decompress(base64.b64decode(b64)).decode("utf-8")

    def screen_on(self):
        self._op("wake")

    def screen_off(self):
        self._op("screen_off")

    @property
    def info(self) -> dict:
        return self._op("info") or {}

    def screenshot(self, filename: str | None = None, format: str = "pillow"):
        png = base64.b64decode(self._op("screenshot"))
        if filename:
            with open(filename, "wb") as f:
                f.write(png)
            return filename
        if format == "raw":
            return png
        from io import BytesIO

        from PIL import Image
        return Image.open(BytesIO(png))

    def shell(self, cmd, timeout: float = 60, **_) -> ShellResponse:
        c = " ".join(cmd) if isinstance(cmd, (list, tuple)) else str(cmd)
        if re.search(r"dumpsys window .*mCurrentFocus", c):
            a = self.app_current()
            return ShellResponse(f"  mCurrentFocus=Window{{0 u0 {a['package']}/{a['activity']}}}\n" if a["package"] else "")
        if c.strip() == "cat /proc/meminfo":
            m = self._op("meminfo") or {}
            return ShellResponse(f"MemTotal: {int(m.get('total_mb', 0)) * 1024} kB\nMemAvailable: {int(m.get('libre_mb', 0)) * 1024} kB\n")
        raise ApkNoSoportado(f"no_soportado: shell «{c[:60]}» (la APK no tiene shell)")

    # extras de la APK
    def liberar(self, no_cerrar: list[str]) -> dict:
        return self._op("liberar", no_cerrar=list(no_cerrar)) or {}

    def textos(self) -> list[str]:
        return self._op("textos") or []

    def ping(self) -> float:
        t = time.perf_counter()
        self._op("ping")
        return (time.perf_counter() - t) * 1000


_OPS_LECTURA = frozenset({"ping", "info", "window_size", "dump", "textos", "app_current", "exists", "count",
                          "info_nodo", "get_text", "meminfo", "pantalla_prendida"})


def estado_hub(hub: str | None = None, token: str | None = None) -> dict:
    """GET /estado del hub (celus conectados)."""
    import urllib.request
    base = (hub or os.environ.get("AGENTE_HUB_URL") or "ws://agente:8766").replace("ws://", "http://").replace("wss://", "https://")
    req = urllib.request.Request(base.rstrip("/") + "/estado", headers={"X-Token": token or os.environ.get("AGENTE_CTL_TOKEN", "")})
    with urllib.request.urlopen(req, timeout=5) as r:
        return json.loads(r.read())
