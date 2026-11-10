"""MVP: controlar un Android físico como API (adb + uiautomator2 + FastAPI).

Correr:  .venv/bin/uvicorn server:app --host 127.0.0.1 --port 8800
Docs:    http://127.0.0.1:8800/docs
"""
import hmac
import os
import threading
import time
from pathlib import Path

import uiautomator2 as u2
from fastapi import Depends, FastAPI, Header, HTTPException
from fastapi.responses import Response
from pydantic import BaseModel

_envf = Path(__file__).parent / ".env"  # KEY=VALUE, sin comillas; nunca se loguea
if _envf.exists():
    for _l in _envf.read_text().splitlines():
        if "=" in _l and not _l.lstrip().startswith("#"):
            _k, _v = _l.split("=", 1)
            os.environ.setdefault(_k.strip(), _v.strip())

import fastdev  # noqa: E402
import phones  # noqa: E402

# Token obligatorio: sin él, cualquier página abierta en un navegador de esta PC podía mandar un POST «simple» a
# 127.0.0.1:8800 (tocar, teclas, abrir apps). El header x-token además fuerza preflight CORS (que no se permite).
API_TOKEN = os.environ.get("WALLET_BOT_TOKEN") or ""
if not API_TOKEN and os.environ.get("WALLET_BOT_SIN_TOKEN") != "1":
    raise SystemExit("Falta WALLET_BOT_TOKEN (corré docker/instalar.sh). Solo para desarrollo: WALLET_BOT_SIN_TOKEN=1.")
SHOTS = Path(os.environ.get("NX_SHOTS_DIR") or Path(__file__).parent / "shots")
SHOTS.mkdir(parents=True, exist_ok=True)

def auth(x_token: str | None = Header(None)):
    if API_TOKEN and not hmac.compare_digest((x_token or "").encode(), API_TOKEN.encode()):
        raise HTTPException(401, "token")


app = FastAPI(title="wallet-bot", dependencies=[Depends(auth)])
_lock = threading.Lock()  # un solo celular → una acción a la vez
_dev = None
_dev_serial = None


def _serial():
    return phones.serial_activo()


def dev():
    global _dev, _dev_serial
    serial = _serial()
    if _dev is not None and _dev_serial != serial:
        _dev = None
        _dev_serial = None
    if _dev is None:
        _dev = fastdev.envolver(phones.conectar(serial))
        _dev_serial = serial
    return _dev


def shot(tag: str) -> str | None:
    p = SHOTS / f"{int(time.time())}_{tag}.png"
    try:
        dev().screenshot(str(p))
    except Exception as e:  # celu por APK en Android 10: no hay captura (el flujo sigue sin imagen)
        if type(e).__name__ == "ApkNoSoportado":
            return None
        raise
    return str(p)


# ---------- primitivas genéricas ----------

from contextlib import contextmanager

from device_lock import DeviceBusy, device_lock  # noqa: E402


@contextmanager
def _with_device(who: str):
    """flock entre procesos (por serial). Lanza HTTP 423 si ese celu está ocupado."""
    try:
        with device_lock(timeout=15, who=who, serial=_serial()):
            yield
    except DeviceBusy as e:
        raise HTTPException(423, {"error": "device_busy", "detalle": str(e)})


@app.get("/device")
def device_info():
    with _with_device("http:device"):
        with _lock:
            d = dev()
            return {
                "info": d.info,
                "app": d.app_current(),
                "serial": _serial(),
                "perfil": phones.activo_id(),
            }


@app.get("/screenshot", responses={200: {"content": {"image/png": {}}}})
def screenshot():
    with _with_device("http:screenshot"):
        with _lock:
            img = dev().screenshot(format="raw")
            return Response(content=img, media_type="image/png")


@app.get("/ui")
def ui_texts():
    """Elementos visibles con texto / content-desc / resource-id (para armar flujos)."""
    import xml.etree.ElementTree as ET

    with _with_device("http:ui"):
        with _lock:
            d = dev()
            # Saltear biometría antes de leer, si no el dump miente
            try:
                import naranjax as _nx
                _nx._dismiss_popups(d)
            except Exception:
                pass
            root = ET.fromstring(d.dump_hierarchy())
            out = []
            for n in root.iter("node"):
                t, desc, rid = n.get("text"), n.get("content-desc"), n.get("resource-id")
                if t or desc or rid:
                    out.append({"text": t, "desc": desc, "id": rid,
                                "clickable": n.get("clickable") == "true", "bounds": n.get("bounds")})
            return out


class Tap(BaseModel):
    text: str | None = None
    desc: str | None = None
    id: str | None = None
    x: int | None = None
    y: int | None = None
    timeout: float = 10


@app.post("/tap")
def tap(t: Tap):
    with _with_device("http:tap"):
        with _lock:
            d = dev()
            if t.x is not None and t.y is not None:
                d.click(t.x, t.y)
                return {"ok": True}
            sel = {k: v for k, v in {"textContains": t.text, "descriptionContains": t.desc,
                                     "resourceId": t.id}.items() if v}
            if not sel:
                raise HTTPException(400, "text, desc, id o x/y")
            el = d(**sel)
            if not el.wait(timeout=t.timeout):
                raise HTTPException(404, f"no encontrado: {sel}")
            el.click()
            return {"ok": True}


class TypeText(BaseModel):
    text: str
    clear: bool = True


@app.post("/type")
def type_text(b: TypeText):
    with _with_device("http:type"):
        with _lock:
            dev().send_keys(b.text, clear=b.clear)
            return {"ok": True}


@app.post("/key/{key}")
def key(key: str):
    """back, home, enter, recent, ..."""
    with _with_device("http:key"):
        with _lock:
            dev().press(key)
            return {"ok": True}


@app.post("/app/{package}/start")
def app_start(package: str, stop: bool = False):
    with _with_device("http:app_start"):
        with _lock:
            dev().app_start(package, stop=stop)
            return {"ok": True}


@app.get("/apps")
def apps():
    with _with_device("http:apps"):
        with _lock:
            return dev().app_list()


# ---------- flujos por billetera ----------

import naranjax  # noqa: E402


def _nx_call(fn, *args, **kwargs):
    # flock entre procesos (MCP+HTTP) + lock in-process
    try:
        with device_lock(timeout=20, who=f"http:{getattr(fn, '__name__', fn)}", serial=_serial()):
            with _lock:
                d = dev()
                naranjax.despertar(d)
                try:
                    out = fn(d, *args, **kwargs)
                except naranjax.SesionBloqueada as e:
                    naranjax.apagar_pantalla(d)
                    raise HTTPException(423, {"error": "sesion_bloqueada", "detalle": str(e)})
                except naranjax.SaldoInsuficiente as e:
                    naranjax.apagar_pantalla(d)
                    raise HTTPException(402, {"error": "saldo_insuficiente", "detalle": str(e)})
                except naranjax.FlowError as e:
                    naranjax.apagar_pantalla(d)
                    raise HTTPException(409, {"error": e.code, "detalle": str(e), "screenshot": shot("nx_error")})
                if isinstance(out, dict):
                    if naranjax.apagar_pantalla_si_libre(d, out):
                        out = {**out, "pantalla_apagada": True}
                else:
                    naranjax.apagar_pantalla(d)
                return out
    except DeviceBusy as e:
        raise HTTPException(423, {"error": "device_busy", "detalle": str(e)})


class Transferencia(BaseModel):
    destino: str  # alias, CBU o CVU
    monto: float
    confirmar: bool = False  # False = dry run: llega a la confirmación y vuelve


@app.get("/naranjax/inicio")
def nx_inicio():
    """Home: saldo hablado, quick actions y atajos."""
    return _nx_call(naranjax.inicio)


_prep = {"corriendo": False}


def _preparar_en_fondo():
    try:
        with device_lock(timeout=1, who="http:preparar", serial=_serial()):
            with _lock:
                naranjax.preparar_transferir(dev())
    except Exception:
        pass  # es solo un precalentamiento: si el celu está ocupado o algo falla, el preview hace el camino normal
    finally:
        _prep["corriendo"] = False
    # Si nadie lo usó (el modelo terminó haciendo otra cosa), no queda la app abierta con la pantalla prendida.
    time.sleep(45)
    try:
        with device_lock(timeout=1, who="http:preparar_fin", serial=_serial()):
            with _lock:
                d = dev()
                if naranjax.en_transferir_sin_tocar(d):
                    naranjax.apagar_pantalla(d)
    except Exception:
        pass


@app.post("/naranjax/preparar")
def nx_preparar():
    """Precalentar una transferencia (vuelve enseguida; trabaja en fondo). No escribe ni envía nada."""
    if _prep["corriendo"]:
        return {"estado": "ya_preparando"}
    _prep["corriendo"] = True
    threading.Thread(target=_preparar_en_fondo, daemon=True).start()
    return {"estado": "preparando"}


def _cancelar_en_fondo():
    try:
        with device_lock(timeout=60, who="http:cancelar", serial=_serial()):
            with _lock:
                d = dev()
                naranjax.transfer_cancelar(d)
                naranjax.apagar_pantalla(d)
    except Exception:
        pass


@app.post("/naranjax/cancelar")
def nx_cancelar():
    """La consola cancela una transferencia que esperaba el sí (lo que dijo el dueño no fue un sí claro).
    La marca vale al instante para el MCP (no envía ni re-arma); el celu sale de la pantalla en fondo."""
    naranjax.marcar_transfer_cancelada()
    threading.Thread(target=_cancelar_en_fondo, daemon=True).start()
    return {"estado": "cancelada"}


@app.get("/naranjax/saldo")
def nx_saldo():
    """Tab Cuentas: pesos, dólares, rendimientos y preview de movimientos."""
    return _nx_call(naranjax.saldo)


@app.get("/naranjax/movimientos")
def nx_movimientos(limite: int = 20, detalle: bool = False):
    """Lista de movimientos (90 días). detalle=true abre el primero."""
    limite = max(1, min(limite, 50))
    return _nx_call(naranjax.movimientos, limite=limite, detalle=detalle)


@app.get("/naranjax/contactos")
def nx_contactos(seccion: str = "Sugeridos"):
    """Contactos en Transferir: Sugeridos | Favoritos | Grupos."""
    return _nx_call(naranjax.contactos, seccion=seccion)


@app.get("/naranjax/actividad")
def nx_actividad(limite: int = 20):
    """Tab Actividad de Transferir (envíos recientes)."""
    limite = max(1, min(limite, 50))
    return _nx_call(naranjax.actividad, limite=limite)


@app.post("/naranjax/transferir")
def nx_transferir(t: Transferencia):
    if t.monto <= 0:
        raise HTTPException(400, "monto inválido")
    return _nx_call(naranjax.transferir, t.destino, t.monto, confirmar=t.confirmar, shot=shot)
