"""Naranja X (com.tarjetanaranja.ncuenta) — flujos mapeados 2026-10-19/20 (app ~v4.126).

Pantallas:
  Inicio (MainActivity): card "Cuenta en pesos", atajos, bottom nav home/accounts/cards/more.
  Cuentas (tab accounts): saldos Pesos/Dólares, rendimientos, preview movimientos → "Ver más".
  Movimientos (AccountsMovementsActivity): lista 90 días; tap → detalle (AccountsDynamicActionsActivity).
  Transferir (transfers HomeActivity): tabs Transferir/Actividad; contactos Sugeridos/Favoritos/Grupos.
  Transferencia: alias → Validar → titular → monto → confirmar → 2FA → CongratsActivity.
"""
from __future__ import annotations

import json
import os
import re
import time
import unicodedata
import xml.etree.ElementTree as ET
from pathlib import Path

PKG = "com.tarjetanaranja.ncuenta"

# Popups / onboarding que hay que saltear (biometría incluida).
_DISMISS_TEXTS = (
    "Omitir",           # Activá la biometría
    "En otro momento",
    "Ahora no",
    "Cerrar",
    "Entendido",
    "No, gracias",
)
_BIOMETRIA_MARKERS = (
    "Activá la biometría",
    "Activa la biometria",
    "huella",
    "biometr",
)


# ---------------------------------------------------------------- errores

class FlowError(Exception):
    code = "flujo"


class SesionBloqueada(FlowError):
    code = "sesion_bloqueada"


class SaldoInsuficiente(FlowError):
    code = "saldo_insuficiente"


class DestinoInvalido(FlowError):
    code = "destino_invalido"


class SinInternet(FlowError):
    code = "sin_internet"


# ---------------------------------------------------------------- utilidades UI

def _norm(s: str) -> str:
    return unicodedata.normalize("NFKD", s or "").encode("ascii", "ignore").decode().lower().strip()


def _nodes(d, include_blank_clickable: bool = False) -> list[dict]:
    """Nodos con texto/desc. Enmascara PIN / campos password.

    include_blank_clickable=True también trae Views/Buttons clickable sin texto
    (el contenedor real de Continuar/Validar en Compose).
    """
    out = []
    for n in ET.fromstring(d.dump_hierarchy()).iter("node"):
        rid = n.get("resource-id") or ""
        if "systemui" in rid or "inputmethod" in rid:
            continue
        t, ds = n.get("text") or "", n.get("content-desc") or ""
        if ds.startswith("Notificación"):
            continue
        if n.get("password") == "true" or re.fullmatch(r"\d{6}", t or ""):
            t = "***"
        b = list(map(int, re.findall(r"\d+", n.get("bounds") or "[0,0][0,0]")))
        while len(b) < 4:
            b.append(0)
        clickable = n.get("clickable") == "true"
        enabled = n.get("enabled") != "false"
        if t or ds or (include_blank_clickable and clickable):
            out.append({
                "text": t, "desc": ds, "id": rid,
                "clickable": clickable,
                "enabled": enabled,
                "cls": (n.get("class") or "").split(".")[-1],
                "x1": b[0], "y1": b[1], "x2": b[2], "y2": b[3],
            })
    return out


def _es_apk(d) -> bool:
    """Celu manejado por la APK de no-phone (sin shell): algunas cosas van por otro camino."""
    return bool(getattr(d, "es_apk", False) or getattr(getattr(d, "_d", None), "es_apk", False))


def _crudo(d):
    return getattr(d, "_d", d)


def _texts(d) -> list[str]:
    return [(n["text"] or n["desc"]) for n in _nodes(d)]


def _emit(on_step, msg: str, step: int | None = None, total: int | None = None) -> None:
    """Feedback de progreso (MCP/HTTP). Nunca rompe el flujo si el callback falla."""
    if not on_step:
        return
    try:
        on_step(msg, step, total)
    except TypeError:
        try:
            on_step(msg)
        except Exception:
            pass
    except Exception:
        pass


def _ui_mode_perfil() -> str | None:
    try:
        from phones import ui_mode_activo

        return ui_mode_activo()
    except Exception:
        return None


def _ui_speed_factor() -> float:
    """<1 acelera sleeps. NX_UI_MODE=fast (default) | normal | safe."""
    mode = (os.environ.get("NX_UI_MODE") or _ui_mode_perfil() or "fast").strip().lower()
    if mode in ("normal", "1", "1.0"):
        return 1.0
    if mode in ("safe", "slow"):
        return 1.25
    # fast
    try:
        override = os.environ.get("NX_UI_SPEED")
        if override:
            return max(0.25, min(1.5, float(override)))
    except ValueError:
        pass
    return 0.45


def _pause(sec: float = 0.12) -> None:
    time.sleep(max(0.04, sec * _ui_speed_factor()))


def _ui_sleep(sec: float) -> None:
    """Sleeps de navegación (antes time.sleep fijos en flujos largos)."""
    _pause(sec)


def _wait(d, timeout=10, **sel):
    el = d(**sel)
    if not el.wait(timeout=timeout):
        _dismiss_popups(d, rounds=1)
        check_login(d)
        _dismiss_popups(d, rounds=1)
        if el.exists(timeout=0):
            return el
        # Señal útil si debajo del overlay ya está el error de saldo
        if _saldo_insuficiente_en_ui(d):
            raise SaldoInsuficiente(_saldo_insuficiente_msg(d))
        raise FlowError(f"no apareció {sel} (activity={d.app_current().get('activity')})")
    return el


def _wait_any(d, timeout: float = 6.0, interval: float = 0.2, predicates=None):
    """Espera hasta que alguna predicción (callable d→bool) sea True. Más barato que sleep fijo."""
    predicates = predicates or []
    deadline = time.time() + timeout
    while time.time() < deadline:
        for pred in predicates:
            try:
                if pred():
                    return True
            except Exception:
                pass
        _pause(interval)
    return False


def _click_label(d, label: str) -> bool:
    """Tap por centro del bounds.

    En Naranja X (Compose) Validar/Continuar/Transferir suelen venir
    enabled=true pero clickable=false: el .click() de uiautomator2 no pega;
    hay que tocar coordenadas del contenedor clickable.
    """
    nodes = _nodes(d, include_blank_clickable=True)
    targets = [n for n in nodes if n["text"] == label or n["desc"] == label]
    for t in targets:
        cx, cy = (t["x1"] + t["x2"]) // 2, (t["y1"] + t["y2"]) // 2
        containers = [
            n for n in nodes
            if n.get("clickable") and n.get("enabled", True)
            and n["x1"] <= cx <= n["x2"] and n["y1"] <= cy <= n["y2"]
            and (n["x2"] - n["x1"]) >= (t["x2"] - t["x1"])
        ]
        if containers:
            containers.sort(key=lambda n: (n["x2"] - n["x1"]) * (n["y2"] - n["y1"]))
            n = containers[0]
            d.click((n["x1"] + n["x2"]) // 2, (n["y1"] + n["y2"]) // 2)
            return True
        d.click(cx, cy)
        return True
    for n in nodes:
        if (n["text"] or "").startswith(label) or (n["desc"] or "").startswith(label):
            d.click((n["x1"] + n["x2"]) // 2, (n["y1"] + n["y2"]) // 2)
            return True
    return False


def _continuar_estado(d) -> str:
    """'enabled' | 'disabled' | 'missing' — el View clickable que envuelve Continuar."""
    nodes = _nodes(d, include_blank_clickable=True)
    label = next((n for n in nodes if n["text"] == "Continuar"), None)
    if not label:
        return "missing"
    cx, cy = (label["x1"] + label["x2"]) // 2, (label["y1"] + label["y2"]) // 2
    candidates = [
        n for n in nodes
        if n.get("clickable") and n["x1"] <= cx <= n["x2"] and n["y1"] <= cy <= n["y2"]
    ]
    if not candidates:
        return "enabled"
    candidates.sort(key=lambda n: (n["x2"] - n["x1"]) * (n["y2"] - n["y1"]))
    return "enabled" if candidates[0].get("enabled", True) else "disabled"


def _saldo_insuficiente_en_ui(d, texts: list[str] | None = None) -> bool:
    blob = " ".join(_norm(t) for t in (texts if texts is not None else _texts(d)))
    return "agrega dinero a tu cuenta" in blob or "necesitas tener" in blob


def _saldo_insuficiente_msg(d, texts: list[str] | None = None) -> str:
    texts = texts if texts is not None else _texts(d)
    detalle = next((t for t in texts if t.startswith("Necesitás tener") or t.startswith("Necesitas tener")), None)
    disp = next((t for t in texts if t.startswith("Dinero en cuenta")), None)
    return f"saldo_insuficiente: {detalle or 'Agregá dinero a tu cuenta'} ({disp})"


def _en_hoja_titular(d) -> bool:
    return d(textStartsWith="CUIL").exists(timeout=0) and d(text="Continuar").exists(timeout=0)


def _en_pantalla_monto(d) -> bool:
    return d(textStartsWith="¿Cuánto vas a transferir").exists(timeout=0)


def _en_confirmacion(d) -> bool:
    return d(descriptionStartsWith="Vas a transferir").exists(timeout=0)


def pantalla_confirmacion(d) -> dict:
    """¿Sigue abierta la confirmación «Vas a transferir…»? (para no rearmar si no hace falta)."""
    return {"estado": "en_confirmacion" if _en_confirmacion(d) else "fuera", "mantener_pantalla": True}


def _en_sin_internet(d) -> bool:
    act = (d.app_current().get("activity") or "").lower()
    if "crash_handler" in act:
        return True
    if d(text="No tenés internet").exists(timeout=0) or d(text="No tienes internet").exists(timeout=0):
        return True
    if d(textStartsWith="Revisa tu conexión").exists(timeout=0) or d(textStartsWith="Revisá tu conexión").exists(timeout=0):
        return True
    return False


def _ensure_online(d) -> None:
    if _en_sin_internet(d):
        raise SinInternet(
            "sin_internet: Naranja X no tiene red en el celu "
            "(«No tenés internet»). Activá Wi‑Fi/datos y reintentá."
        )


# Estados de transferencia a medias: la pantalla DEBE quedar encendida
# para el siguiente paso de la secretaria.
_KEEP_SCREEN_ON_ESTADOS = frozenset({
    "destino_resuelto",
    "listo_para_enviar",
    "candidatos",  # buscar / ambiguo: usuario elige
    "ambiguo",
    "no_coincide",
    "huella_vencida",
    "sin_huella",
    "origen_resuelto",  # nx_origen_recibida: confirmar antes de resolver destino
})
_KEEP_SCREEN_ON_PANTALLAS = frozenset({
    "hoja_titular",
    "confirmacion",
    "pantalla_monto",
})

# Huella de la última enviada (para comprobante recien=true). Persiste en disco.
_LAST_ENVIADA_MAX_AGE_S = 30 * 60
_last_enviada: dict | None = None


def _last_enviada_path() -> Path:
    xdg = os.environ.get("XDG_DATA_HOME") or str(Path.home() / ".local" / "share")
    p = Path(xdg) / "no-phone"
    p.mkdir(parents=True, exist_ok=True)
    return p / "last_enviada.json"


# Cancelación compartida entre procesos (la consola cancela por la API HTTP; el MCP es otro proceso con su propio
# estado del preview). Si la marca es posterior al armado, ese preview ya no se puede enviar ni re-armar.
def _cancelado_path() -> Path:
    return _last_enviada_path().with_name("transfer_cancelada.txt")


def marcar_transfer_cancelada() -> None:
    try:
        _cancelado_path().write_text(str(time.time()), encoding="utf-8")
    except OSError:
        pass


def _falla_de_prueba() -> str | None:
    """QA: `test_falla_envio.txt` con «desconocido» o «error» simula una falla justo después de enviar. Una vez."""
    p = _last_enviada_path().with_name("test_falla_envio.txt")
    try:
        v = p.read_text(encoding="utf-8").strip()
        p.unlink()
        return v or "error"
    except OSError:
        return None


def marcar_comprobante_para(contacto: str, archivo: str) -> None:
    """El combo aprobado fija a quién va el comprobante; WhatsApp solo acepta `ya_confirmado` para ese contacto."""
    try:
        p = _last_enviada_path().with_name("comprobante_para.json")
        p.write_text(json.dumps({"contacto": contacto, "archivo": archivo, "at": time.time()}), encoding="utf-8")
    except OSError:
        pass


def _autorizada_path() -> Path:
    return _last_enviada_path().with_name("transfer_autorizada.txt")


def marcar_transfer_autorizada() -> None:
    """La consola oyó el nombre del titular (cuenta nueva): recién ahí se puede enviar."""
    try:
        _autorizada_path().write_text(str(time.time()), encoding="utf-8")
    except OSError:
        pass


def transfer_autorizada_desde(ts: float | None) -> bool:
    try:
        return ts is not None and float(_autorizada_path().read_text(encoding="utf-8")) >= float(ts)
    except (OSError, ValueError):
        return False


def transfer_cancelada_desde(ts: float | None) -> bool:
    try:
        return ts is not None and float(_cancelado_path().read_text(encoding="utf-8")) >= float(ts)
    except (OSError, ValueError):
        return False


def registrar_enviada(huella: dict) -> dict:
    """Guarda huella de la última transferencia enviada (memoria + disco)."""
    global _last_enviada
    h = {**huella, "ts": float(huella.get("ts") or time.time())}
    _last_enviada = h
    try:
        _last_enviada_path().write_text(
            json.dumps(h, ensure_ascii=False, indent=2), encoding="utf-8"
        )
    except OSError:
        pass
    return h


def cargar_last_enviada(*, max_age_s: float | None = None) -> dict | None:
    """Lee huella vigente o None si no hay / venció."""
    global _last_enviada
    max_age = _LAST_ENVIADA_MAX_AGE_S if max_age_s is None else max_age_s
    h = _last_enviada
    if h is None:
        try:
            raw = _last_enviada_path().read_text(encoding="utf-8")
            h = json.loads(raw)
        except (OSError, json.JSONDecodeError, TypeError):
            h = None
    if not isinstance(h, dict):
        return None
    ts = float(h.get("ts") or 0)
    if ts <= 0 or (time.time() - ts) > max_age:
        return None
    _last_enviada = h
    return h


def actualizar_last_enviada(**fields) -> dict | None:
    h = cargar_last_enviada()
    if not h:
        return None
    h = {**h, **fields}
    return registrar_enviada(h)


# ---------------------------------------------------------------- agenda local (nombre → CVU)

_AGENDA_SEED: list[dict] = []  # contactos propios: se cargan en la agenda local


def _agenda_path() -> Path:
    xdg = os.environ.get("XDG_DATA_HOME") or str(Path.home() / ".local" / "share")
    p = Path(xdg) / "no-phone"
    p.mkdir(parents=True, exist_ok=True)
    return p / "agenda.json"


def agenda_load() -> list[dict]:
    path = _agenda_path()
    if not path.is_file():
        agenda_save(list(_AGENDA_SEED))
        return list(_AGENDA_SEED)
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        entries = data.get("entries") if isinstance(data, dict) else data
        if not isinstance(entries, list):
            entries = list(_AGENDA_SEED)
        # merge seed if missing known cvus
        have = {str(e.get("cvu")) for e in entries if isinstance(e, dict)}
        for s in _AGENDA_SEED:
            if s["cvu"] not in have:
                entries.append(dict(s))
        return entries
    except (OSError, json.JSONDecodeError, TypeError):
        return list(_AGENDA_SEED)


def agenda_save(entries: list[dict]) -> None:
    try:
        _agenda_path().write_text(
            json.dumps({"entries": entries}, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
    except OSError:
        pass


def agenda_lookup(query: str) -> dict | None:
    """Busca por nombre parcial o alias. None si no hay match único útil."""
    q = _norm(query)
    if not q or _parece_cvu_cbu(query):
        return None
    hits = []
    for e in agenda_load():
        if not isinstance(e, dict) or not e.get("cvu"):
            continue
        alias = _norm(e.get("alias") or "")
        if alias and (q == alias or alias == q):
            hits.append(e)
            continue
        for nom in e.get("nombres") or []:
            n = _norm(nom)
            if not n:
                continue
            if q == n or q in n or n in q:
                hits.append(e)
                break
        titular = _norm(e.get("titular") or "")
        if titular and (q in titular or titular in q) and e not in hits:
            hits.append(e)
    if not hits:
        return None
    # si varios, preferir match más largo de nombre
    def score(e):
        best = 0
        for nom in e.get("nombres") or []:
            n = _norm(nom)
            if q == n:
                best = max(best, 1000 + len(n))
            elif q in n or n in q:
                best = max(best, len(n))
        return best

    hits.sort(key=score, reverse=True)
    return hits[0]


def agenda_remember(destinatario: dict | None, nombres_extra: list[str] | None = None, enviada: bool = False) -> None:
    """Upsert tras un resolve/transfer OK. enviada=True suma un envío (historial para avisar cuentas nuevas)."""
    if not destinatario:
        return
    cvu = destinatario.get("cvu_cbu") or destinatario.get("cbu_cvu")
    if not cvu:
        return
    titular = destinatario.get("titular") or ""
    alias = destinatario.get("alias") or ""
    nombres = []
    if titular:
        nombres.append(titular)
    for x in nombres_extra or []:
        if x:
            nombres.append(x)
    entries = agenda_load()
    found = None
    for e in entries:
        if str(e.get("cvu")) == str(cvu):
            found = e
            break
    if found is None:
        found = {
            "nombres": [],
            "cvu": str(cvu),
            "alias": alias,
            "titular": titular,
            "entidad": destinatario.get("entidad"),
            "envios": 0,  # cuenta nueva: hasta el primer envío OK, la confirmación avisa que es nueva
        }
        entries.append(found)
    else:
        if alias:
            found["alias"] = alias
        if titular:
            found["titular"] = titular
        if destinatario.get("entidad"):
            found["entidad"] = destinatario.get("entidad")
    have = {_norm(n) for n in found.get("nombres") or []}
    for n in nombres:
        if _norm(n) and _norm(n) not in have:
            found.setdefault("nombres", []).append(n)
            have.add(_norm(n))
    if enviada:
        found["envios"] = int(found.get("envios") or 0) + 1
        found["ultimo_envio"] = time.strftime("%Y-%m-%d")
    agenda_save(entries)


def historial_destino(destinatario: dict | None) -> dict:
    """¿Ya se le transfirió a esta cuenta? Para la pregunta de confirmación (aviso si es nueva)."""
    cvu = str((destinatario or {}).get("cvu_cbu") or (destinatario or {}).get("cbu_cvu") or "")
    e = next((x for x in agenda_load() if isinstance(x, dict) and cvu and str(x.get("cvu")) == cvu), None)
    if not e:
        return {"conocida": False, "envios": 0}
    nueva = e.get("envios") == 0  # sin la clave = cuenta de antes del historial (ya usada)
    return {"conocida": not nueva, "envios": e.get("envios"), "ultimo_envio": e.get("ultimo_envio")}


def _parece_cvu_cbu(s: str) -> bool:
    digits = re.sub(r"\D", "", s or "")
    return len(digits) >= 20


def deberia_mantener_pantalla(result: dict | None) -> bool:
    """True si el resultado deja el flujo a medias (siguiente tool del humano)."""
    if not isinstance(result, dict):
        return False
    if result.get("mantener_pantalla") is True:
        return True
    if result.get("estado") in _KEEP_SCREEN_ON_ESTADOS:
        return True
    if result.get("pantalla") in _KEEP_SCREEN_ON_PANTALLAS:
        return True
    return False


def despertar(d) -> None:
    """Enciende pantalla y, si quedó en la pantalla de bloqueo, la desbloquea con el PIN del celu (DEVICE_PIN)."""
    # screen_on de u2 ya hace wakeUp; volver a preguntar d.info (2 RPC más) no agregaba nada.
    try:
        d.screen_on()
    except Exception:
        return
    try:
        desbloquear(d)
    except Exception:
        pass


# Un PIN que ya falló no se reintenta (bloquearía el celu por intentos): se espera a que el dueño cargue otro.
_pin_bloqueo_fallido: str | None = None


def _bloqueado(d) -> bool:
    try:
        out = d.shell(["dumpsys", "window"]).output
    except Exception:
        return False
    return "isKeyguardShowing=true" in out or "mDreamingLockscreen=true" in out


def desbloquear(d) -> dict:
    """Pasa la pantalla de bloqueo con el PIN del perfil activo. Un intento por PIN: si falla, no reintenta."""
    global _pin_bloqueo_fallido
    if not _bloqueado(d):
        return {"estado": "desbloqueado"}
    try:
        from phones import pin_desbloqueo_activo

        pin = pin_desbloqueo_activo()
    except Exception:
        pin = ""
    if not pin:
        return {"estado": "bloqueado_sin_pin",
                "mensaje": "El celu está bloqueado y no tengo su PIN de desbloqueo: cargalo en la consola (Ajustes → Conexiones → celular)."}
    if pin == _pin_bloqueo_fallido:
        return {"estado": "bloqueado_pin_incorrecto",
                "mensaje": "El PIN de desbloqueo cargado no anduvo y no lo reintento: revisalo en la consola."}
    # Deslizar hacia arriba para que aparezca el teclado del PIN.
    try:
        w, h = d.window_size()
    except Exception:
        w, h = 1080, 2400
    d.shell(["input", "swipe", str(w // 2), str(int(h * 0.85)), str(w // 2), str(int(h * 0.3)), "200"])
    _pause(0.8)
    for ch in pin:
        d.shell(["input", "keyevent", str(7 + int(ch))])
        _pause(0.05)
    d.shell(["input", "keyevent", "66"])
    for _ in range(10):
        _pause(0.4)
        if not _bloqueado(d):
            return {"estado": "desbloqueado"}
    _pin_bloqueo_fallido = pin
    return {"estado": "bloqueado_pin_incorrecto",
            "mensaje": "No pude desbloquear el celu con el PIN cargado (no lo reintento para no trabarlo): revisalo en la consola."}


# Lo que nunca se cierra: la billetera, el robot de UI, el sistema/launcher/teclado, Google y WhatsApp.
_NO_CERRAR = (PKG, "com.github.uiautomator", "com.miui.home", "com.android.", "android.", "com.google.android.gms",
              "com.google.android.inputmethod", "com.google.android.ext", "com.google.android.webview", "com.whatsapp",
              "com.qualcomm", "com.qti", "com.miui.securitycenter", "com.lbe.security", "com.miui.powerkeeper",
              "com.xiaomi.xmsf", "com.miui.hybrid", "com.sohu.inputmethod", "com.miui.system",
              "com.termux")  # Termux: el túnel SSH por el que el VPS llega al celu (android/termux)
# Con más RAM que esto no se limpia nada: es el celu de uso diario del dueño (Xiaomi 12T, 12 GB), no el Redmi de 3 GB.
_RAM_SIN_LIMPIEZA_MB = 6000
_ultima_limpieza = 0.0


def liberar_memoria(d, forzar: bool = False) -> dict:
    """Cierra apps de fondo para que Naranja X arranque y responda sin trabarse (celu de 3 GB).

    `am kill-all` mata los procesos en caché; después se fuerzan las apps de usuario que sigan vivas (salvo
    _NO_CERRAR). Como mucho una vez cada 10 min salvo forzar=True. Nunca toca Naranja X (cerrarla pide login)."""
    global _ultima_limpieza
    if not forzar and time.time() - _ultima_limpieza < 600:
        return {"estado": "reciente", "hace_s": int(time.time() - _ultima_limpieza)}
    _ultima_limpieza = time.time()

    def mem() -> int | None:
        try:
            m = re.search(r"MemAvailable:\s+(\d+)", d.shell("cat /proc/meminfo").output)
            return int(m.group(1)) // 1024 if m else None
        except Exception:
            return None

    if _es_apk(d):
        # Sin shell: la APK cierra las apps de usuario en segundo plano (killBackgroundProcesses).
        try:
            r = _crudo(d).liberar(list(_NO_CERRAR))
            return {"estado": "ok", "cerradas": r.get("intentadas", []), "mem_libre_mb_antes": r.get("mem_libre_mb_antes"),
                    "mem_libre_mb_despues": r.get("mem_libre_mb_despues")}
        except Exception as e:  # nunca romper el flujo por esto
            return {"estado": "error", "detalle": str(e)[:200]}
    try:
        m = re.search(r"MemTotal:\s+(\d+)", d.shell("cat /proc/meminfo").output)
        if m and int(m.group(1)) // 1024 > _RAM_SIN_LIMPIEZA_MB:
            return {"estado": "no_hace_falta", "ram_mb": int(m.group(1)) // 1024}
    except Exception:
        pass
    antes = mem()
    cerradas = []
    try:
        d.shell("am kill-all")
        lru = d.shell("dumpsys activity lru").output
        vivos = set(re.findall(r"\d+:([a-zA-Z0-9_.]+)(?::[\w.]+)?/u0a\d+", lru))
        terceros = set(d.shell("pm list packages -3").output.replace("package:", "").split())
        for pkg in sorted(vivos & terceros):
            if pkg.startswith(_NO_CERRAR):
                continue
            d.shell(f"am force-stop {pkg}")
            cerradas.append(pkg)
    except Exception as e:  # nunca romper el flujo por esto
        return {"estado": "error", "detalle": str(e)[:200]}
    return {"estado": "ok", "cerradas": cerradas, "mem_libre_mb_antes": antes, "mem_libre_mb_despues": mem()}


def apagar_pantalla(d) -> bool:
    """Apaga la pantalla del celu. True si mandó screen_off."""
    try:
        d.screen_off()
        return True
    except Exception:
        return False


def apagar_pantalla_si_libre(d, result: dict | None = None) -> bool:
    """Apaga al terminar una acción, salvo pasos intermedios de secretaria."""
    if deberia_mantener_pantalla(result):
        return False
    return apagar_pantalla(d)


def _dismiss_popups(d, rounds: int = 2) -> list[str]:
    """Cierra popups / biometría.

    Cada exists() es un RPC al celu (~0.3–0.8s). Por eso: 1) solo Omitir por RPC;
    2) si no, UN dump y matchear labels en memoria.
    """
    skipped = []
    for _ in range(rounds):
        if d(text="Omitir").exists(timeout=0):
            d(text="Omitir").click()
            skipped.append("Omitir")
            time.sleep(0.3)
            continue
        labels = set()
        for n in _nodes(d):
            if n["text"]:
                labels.add(n["text"])
            if n["desc"]:
                labels.add(n["desc"])
        acted = False
        for txt in _DISMISS_TEXTS:
            if txt == "Omitir":
                continue
            if txt in labels:
                if _click_label(d, txt):
                    skipped.append(txt)
                    acted = True
                    time.sleep(0.25)
                    break
        if not acted and "Cerrar alerta" in labels:
            d(description="Cerrar alerta").click()
            skipped.append("Cerrar alerta")
            acted = True
            time.sleep(0.25)
        if not acted:
            break
    return skipped


def _scroll(d, direction: str = "up"):
    d.swipe_ext(direction, 0.6)
    _pause(0.45)


# --- montos: "$ 1.540,10", "- $ 0,10", "pesos 0 con 10 centavos", "cero con nueve centavos"

_UNI = {
    "cero": 0, "un": 1, "uno": 1, "una": 1, "dos": 2, "tres": 3, "cuatro": 4, "cinco": 5,
    "seis": 6, "siete": 7, "ocho": 8, "nueve": 9, "diez": 10, "once": 11, "doce": 12,
    "trece": 13, "catorce": 14, "quince": 15, "dieciseis": 16, "diecisiete": 17,
    "dieciocho": 18, "diecinueve": 19, "veinte": 20, "veintiun": 21, "veintiuno": 21,
    "veintidos": 22, "veintitres": 23, "veinticuatro": 24, "veinticinco": 25,
    "veintiseis": 26, "veintisiete": 27, "veintiocho": 28, "veintinueve": 29,
    "treinta": 30, "cuarenta": 40, "cincuenta": 50, "sesenta": 60, "setenta": 70,
    "ochenta": 80, "noventa": 90, "cien": 100, "ciento": 100, "doscientos": 200,
    "trescientos": 300, "cuatrocientos": 400, "quinientos": 500, "seiscientos": 600,
    "setecientos": 700, "ochocientos": 800, "novecientos": 900,
}


def _palabras_a_int(tokens: list[str]) -> int:
    total, actual = 0, 0
    for tk in tokens:
        if re.fullmatch(r"[\d.]+", tk):
            actual += int(tk.replace(".", ""))
        elif tk in _UNI:
            actual += _UNI[tk]
        elif tk == "mil":
            total += (actual or 1) * 1000
            actual = 0
        elif tk in ("millon", "millones"):
            total = (total + (actual or 1)) * 1_000_000
            actual = 0
    return total + actual


def parse_monto(s: str | None) -> float | None:
    """Parsea montos en $ / hablados. Devuelve None si no reconoce."""
    if not s:
        return None
    raw = s.strip()
    neg = bool(re.search(r"(^-|\bmenos\b|\benviad)", _norm(raw))) or raw.lstrip().startswith("-")
    n = _norm(raw)

    # "$ 1.540,10" / "- $ 0,10" / "$ 0,00"
    m = re.search(r"\$\s*([\d.]+),(\d{2})", raw.replace("\xa0", " "))
    if m:
        enteros = int(m.group(1).replace(".", ""))
        val = enteros + int(m.group(2)) / 100
        return -val if neg or "-" in raw.split("$")[0] else val

    # "pesos 0 con 10 centavos" / "Dinero disponible pesos cero con nueve centavos"
    m = re.search(
        r"(?:pesos|dolares|dolares|usd)?\s*([\w.\s]+?)\s*con\s+([\w.\s]+?)\s*centavos?",
        n,
    )
    if m:
        enteros = _palabras_a_int(m.group(1).split())
        cent = _palabras_a_int(m.group(2).split())
        val = enteros + cent / 100
        return -val if neg else val

    # "cero con 9 centavos" (sin "pesos")
    m = re.search(r"^([\w.\s]+?)\s*con\s+([\w.\s]+?)\s*centavos?$", n)
    if m:
        enteros = _palabras_a_int(m.group(1).split())
        cent = _palabras_a_int(m.group(2).split())
        return enteros + cent / 100

    # solo "cero" / "doce"
    toks = [t for t in re.findall(r"[a-z0-9.]+", n) if t not in ("pesos", "dolares", "dolar", "usd")]
    if toks and all(t in _UNI or re.fullmatch(r"[\d.]+", t) or t in ("mil", "millon", "millones") for t in toks):
        return float(_palabras_a_int(toks))

    return None


def _monto_str(monto: float) -> str:
    return f"{monto:.2f}".replace(".", ",")


# ---------------------------------------------------------------- sesión / navegación

def _en_pantalla_clave(d) -> bool:
    """La pantalla donde se TIPEA la clave (no la de arranque)."""
    act = (d.app_current().get("activity") or "").lower()
    return "selflogin" in act or d(resourceId=f"{PKG}:id/pinInput").exists


def _cargando_login(d) -> bool:
    act = (d.app_current().get("activity") or "").lower()
    return "startup" in act or d(className="android.widget.ProgressBar").exists


_ERROR_CLAVE = ("incorrect", "no es correcta", "no coincide", "intentos", "bloquead", "invalida", "inválida")


def _error_clave(d) -> bool:
    blob = " ".join(_norm(t) for t in _texts(d))
    return any(_norm(m) in blob for m in _ERROR_CLAVE)


def _largo_campo_pin(d) -> int | None:
    """Cuántos caracteres tiene el campo de la clave (solo el largo; nunca el contenido)."""
    try:
        et = d(className="android.widget.EditText")
        return len(et.get_text() or "") if et.exists(timeout=0) else None
    except Exception:  # noqa: BLE001
        return None


def _guardar_diagnostico_login(d, largo_tipeado, segundos) -> None:
    """Para entender un fallo sin re-tipear: qué había en pantalla (sin el campo de la clave), cuánto tardó."""
    try:
        act = d.app_current().get("activity")
        textos = [t for t in _texts(d) if not t.isdigit()][:25]
        diag = {"at": time.strftime("%Y-%m-%dT%H:%M:%S"), "actividad": act, "segundos": round(segundos, 1),
                "largo_tras_tipear": largo_tipeado, "largo_al_final": _largo_campo_pin(d),
                "cargando": _cargando_login(d), "error_clave_visible": _error_clave(d), "textos": textos}
        _last_enviada_path().with_name("login_fallo.json").write_text(json.dumps(diag, ensure_ascii=False, indent=1),
                                                                       encoding="utf-8")
    except Exception:  # noqa: BLE001
        pass


def _en_login(d) -> bool:
    act = (d.app_current().get("activity") or "").lower()
    if "selflogin" in act or "startup" in act:
        return True
    return d(resourceId=f"{PKG}:id/pinInput").exists


def _en_biometria(d) -> bool:
    blob = " ".join(_norm(t) for t in _texts(d))
    return any(m in blob for m in (_norm(x) for x in _BIOMETRIA_MARKERS))


def _ingresar_pin(d, pin: str, prefer_edit: bool = True) -> None:
    """Escribe el PIN sin loguearlo. Preferí EditText.set_text; fallback keyevents / shell."""
    et = d(className="android.widget.EditText")
    # Recién despierta la pantalla, el campo aparece antes de aceptar texto: esperarlo y darle foco.
    if prefer_edit and et.wait(timeout=3.0):
        _pause(0.5)
        et.click()
        _pause(0.15)
        try:
            et.clear_text()
        except Exception:
            pass
        et.set_text(pin)
        _pause(0.2)
        return
    box = d(resourceId=f"{PKG}:id/pinInput")
    if box.exists(timeout=0):
        box.click()
        _pause(0.15)
    if _es_apk(d):
        # Sin keyevents crudos: escribir en el campo con foco (ACTION_SET_TEXT).
        _crudo(d)._op("set_text", text=pin)
        if hasattr(d, "invalidate"):
            d.invalidate()
        _pause(0.2)
        return
    # keyevent por dígito (KEYCODE_0 = 7 … KEYCODE_9 = 16) — más fiable que `input text` en Compose
    for ch in pin:
        d.shell(["input", "keyevent", str(7 + int(ch))])
        _pause(0.05)


def _nx_pin() -> str:
    """PIN del perfil de teléfono activo (phones.pin_env) o NX_PIN."""
    try:
        from phones import pin_activo

        return pin_activo()
    except Exception:
        return os.environ.get("NX_PIN", "")


def _sin_red_en_login(d) -> bool:
    """«No tenés internet» en el login: tocar Reintentar una vez y esperar. True si sigue sin red."""
    if not _en_sin_internet(d):
        return False
    if d(text="Reintentar").exists(timeout=0):
        d(text="Reintentar").click()
    _wait_any(d, timeout=10.0, interval=0.5, predicates=[lambda: not _en_sin_internet(d)])
    return _en_sin_internet(d)


_PIN_FALLO_ESPERA_S = 600


def _pin_fallo_path() -> Path:
    return _last_enviada_path().with_name("pin_fallo.txt")


def _marcar_pin_fallo() -> None:
    try:
        _pin_fallo_path().write_text(str(time.time()), encoding="utf-8")
    except OSError:
        pass


def _pin_fallo_reciente() -> float | None:
    """Segundos desde el último intento de clave fallido, si fue hace menos de 10 min."""
    try:
        hace = time.time() - float(_pin_fallo_path().read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    return hace if 0 <= hace < _PIN_FALLO_ESPERA_S else None


def check_login(d):
    """Ingresa el PIN del perfil activo si hace falta y saltea biometría. Nunca loguea el PIN.
    Sin red no se tipea nada (y no se dice «clave rechazada»): sale con SinInternet."""
    despertar(d)
    _dismiss_popups(d, rounds=1)
    if not _en_login(d):
        return
    if _sin_red_en_login(d):
        raise SinInternet("sin_internet: Naranja X no tiene red en el celu («No tenés internet»). No se tipeó la clave.")
    if not _en_login(d):
        return
    pin = _nx_pin()
    if not (pin.isdigit() and len(pin) == 6):
        raise SesionBloqueada(
            "sesion_bloqueada: la app pide la clave y el PIN del perfil "
            "(pin_env / NX_PIN) no está configurado"
        )
    # Un intento fallido frena los siguientes 10 min (entre procesos): encadenar intentos puede bloquear la cuenta.
    falla = _pin_fallo_reciente()
    if falla is not None:
        raise SesionBloqueada(
            f"sesion_bloqueada: la clave falló hace {int(falla // 60)} min y no la vuelvo a tipear sola "
            "(para no bloquear la cuenta). Hay que entrar a Naranja X a mano en el celu."
        )
    t0 = time.monotonic()
    _ingresar_pin(d, pin)
    largo_tipeado = _largo_campo_pin(d)
    # Esperar que salga del login. OJO: después de una clave CORRECTA, NX pasa por su pantalla de arranque
    # («startup», a veces con spinner) y con red lenta tarda; eso NO es «clave rechazada». Antes se contaba como login
    # y a los 15 s se declaraba fallo (y se apagaba la pantalla con la app a medias).
    fin = time.monotonic() + 40.0
    confirmado = False
    while time.monotonic() < fin:
        if _en_sin_internet(d):
            raise SinInternet(
                "sin_internet: después de la clave Naranja X dijo «No tenés internet» (la clave no fue rechazada). "
                "Reintentá en un rato."
            )
        _dismiss_popups(d, rounds=1)
        if not _en_pantalla_clave(d) and not _en_biometria(d) and not _cargando_login(d):
            return
        if _en_pantalla_clave(d) and not _cargando_login(d) and time.monotonic() - t0 > 6 and _error_clave(d):
            break  # NX dijo explícitamente que la clave no es
        # Mismo intento, no uno nuevo: la clave puesta de una (set_text) a veces no dispara el envío automático que sí
        # dispara el teclado dígito a dígito. Como en la transferencia (que toca «confirmar» después de tipear),
        # se confirma explícitamente: botón si lo hay, si no «enter» del teclado. Una sola vez.
        if (not confirmado and time.monotonic() - t0 > 2.5 and _en_pantalla_clave(d) and not _cargando_login(d)
                and (largo_tipeado in (None, len(pin)))):
            confirmado = True
            boton = d(resourceId=f"{PKG}:id/primary_button")
            if boton.exists(timeout=0) and boton.info.get("enabled"):
                boton.click()
            else:
                d.press("enter")
        _pause(0.4)
    if _en_login(d):
        _guardar_diagnostico_login(d, largo_tipeado, time.monotonic() - t0)
        _marcar_pin_fallo()
        raise SesionBloqueada(
            "sesion_bloqueada: después de la clave Naranja X sigue en el login "
            "(no reintentes en loop — ojo bloqueo; diagnóstico en login_fallo.json)"
        )


def ir_al_inicio(d):
    """Vuelve al home de NX sin matar la app (stop dispara login)."""
    # Con la pantalla apagada el dump sale vacío y los keyevents del PIN se pierden.
    despertar(d)
    # Pantalla de éxito de una transferencia («Transferiste…», CongratsActivity): con «atrás» no se sale (quedaba
    # trabado tras una falla en el medio del envío y no se podían ver los movimientos). Se sale por «Ir a Inicio».
    act = d.app_current()
    if act.get("package") == PKG and ("congrats" in (act.get("activity") or "").lower()
                                      or d(textStartsWith="Transferiste").exists(timeout=0)):
        if d(text="Ir a Inicio").exists(timeout=0.8):
            d(text="Ir a Inicio").click()
            _ui_sleep(0.55)
            _dismiss_popups(d, rounds=1)
    # Atajo: NX ya en su pantalla principal → home está a un toque (o ya estamos). Si no cuadra, camino largo.
    act = d.app_current()
    if act.get("package") == PKG and "MainActivity" in (act.get("activity") or ""):
        if d(description="Transferir.").exists(timeout=0):
            return
        if d(resourceId="home").exists(timeout=0):
            d(resourceId="home").click()
            if _wait_any(d, timeout=3.0, predicates=[lambda: d(description="Transferir.").exists(timeout=0)]):
                return
    elif act.get("package") == PKG and not any(x in (act.get("activity") or "").lower() for x in ("selflogin", "startup")):
        # Otra pantalla de NX (movimientos, transferir, detalle…): un back suele dejar en la principal.
        for _ in range(3):
            d.press("back")
            _pause(0.25)
            a = d.app_current()
            if a.get("package") != PKG:
                break
            if "MainActivity" in (a.get("activity") or ""):
                if d(description="Transferir.").exists(timeout=0):
                    return
                if d(resourceId="home").exists(timeout=0):
                    d(resourceId="home").click()
                    if _wait_any(d, timeout=3.0, predicates=[lambda: d(description="Transferir.").exists(timeout=0)]):
                        return
                break
    for i in range(6):
        if d.app_current().get("package") != PKG:
            if i == 0:
                liberar_memoria(d)  # NX va a arrancar/volver al frente: que tenga memoria
            d.app_start(PKG)
            _wait_any(
                d,
                timeout=4.0,
                interval=0.25,
                predicates=[
                    lambda: d.app_current().get("package") == PKG,
                ],
            )
        _ensure_online(d)
        if i == 0:
            _dismiss_popups(d, rounds=1)
            check_login(d)
            _ensure_online(d)
        else:
            # Tras mucho rato sin uso la app pide la clave recién después de abrir (no en la primera mirada):
            # con «atrás» no se sale de ahí, hay que ingresarla.
            if _en_login(d):
                check_login(d)
                _ensure_online(d)
                continue
            if d(text="Omitir").exists(timeout=0):
                d(text="Omitir").click()
                _pause(0.2)
        if d(text="Ir a Inicio").exists(timeout=0):  # pantalla de éxito de una transferencia
            d(text="Ir a Inicio").click()
            _pause(0.5)
            continue
        if d(description="Transferir.").exists(timeout=0.25):
            return
        if d(descriptionStartsWith="Dinero disponible").exists(timeout=0.15):
            return
        if d(resourceId="home").exists(timeout=0.15):
            d(resourceId="home").click()
            _pause(0.35)
            continue
        if d(text="Inicio").exists(timeout=0.15):
            d(text="Inicio").click()
            _pause(0.35)
            continue
        # Pantalla de error de red con botón reintento
        if d(text="Intentar de nuevo").exists(timeout=0):
            d(text="Intentar de nuevo").click()
            _pause(1.0)
            _ensure_online(d)
            continue
        d.press("back")
        _pause(0.22)
    _ensure_online(d)
    raise FlowError("no pude volver al inicio de Naranja X")


def _unwind_transfers(d, max_backs: int = 5):
    """Sale de pantallas a medias (monto/confirm/alias) hasta el hub Transferir o Inicio."""
    if d(text="Omitir").exists(timeout=0):
        d(text="Omitir").click()
        _pause(0.18)
    for _ in range(max_backs):
        if d(text="A una nueva cuenta").exists(timeout=0):
            return "transfer_hub"
        if d(description="Transferir.").exists(timeout=0):
            return "home"
        if d(resourceId="home").exists(timeout=0):
            d(resourceId="home").click()
            _pause(0.3)
            continue
        d.press("back")
        _pause(0.18)
    return "unknown"


def _abrir_transferir_nueva_cuenta(d, on_step=None):
    """Entra a 'A una nueva cuenta' sin dar vueltas si ya estamos en Transferir."""
    _dismiss_popups(d, rounds=1)
    if d(text="A una nueva cuenta").exists(timeout=0.35):
        d(text="A una nueva cuenta").click()
        return
    # ¿Pantalla a medias de una transferencia anterior?
    act = (d.app_current().get("activity") or "").lower()
    if any(x in act for x in ("insertamount", "confirm", "transfer", "alias", "newcontact", "recipient")):
        _emit(on_step, "Saliendo de una transferencia a medias…")
        where = _unwind_transfers(d)
        if where == "transfer_hub" and d(text="A una nueva cuenta").exists(timeout=0.4):
            d(text="A una nueva cuenta").click()
            return
    # Tab Transferir dentro de transfers HomeActivity
    if d(description="Transferir").exists(timeout=0.3) and not d(description="Transferir.").exists(timeout=0.15):
        d(description="Transferir").click()
        if _wait_any(d, timeout=2.5, predicates=[lambda: d(text="A una nueva cuenta").exists(timeout=0)]):
            d(text="A una nueva cuenta").click()
            return
    _emit(on_step, "Yendo al Inicio → Transferir…")
    ir_al_inicio(d)
    d(description="Transferir.").click()
    # Un toque que cae mal (pantalla aún cargando) abre otra cosa (p. ej. «Ingresar dinero»): atrás y una vez más.
    if not _wait_any(d, timeout=6.0, interval=0.25, predicates=[lambda: d(text="A una nueva cuenta").exists(timeout=0)]):
        d.press("back")
        _pause(0.4)
        ir_al_inicio(d)
        _pause(0.3)
        d(description="Transferir.").click()
    _wait(d, text="A una nueva cuenta", timeout=6).click()


# Transferencias a medias (monto, confirmación «Vas a transferir…», hoja del titular): no se tocan nunca al preparar.
_A_MEDIAS = ("insertamount", "confirm", "alias", "newcontact", "recipient")


def preparar_transferir(d) -> dict:
    """Precalienta un pedido de transferencia mientras el modelo piensa: despierta, chequea login y deja Naranja X
    en Transferir con «A una nueva cuenta» a la vista. No escribe ni elige nada: el preview arranca desde ahí."""
    t0 = time.time()
    despertar(d)
    if d(text="A una nueva cuenta").exists(timeout=0):
        return {"estado": "listo", "s": 0.0}
    act = d.app_current()
    if act.get("package") == PKG and any(x in (act.get("activity") or "").lower() for x in _A_MEDIAS):
        return {"estado": "a_medias"}  # hay un preview esperando el sí: no se toca
    if _en_confirmacion(d) or _en_pantalla_monto(d) or _en_hoja_titular(d):
        return {"estado": "a_medias"}
    # Acotado (tiene el celu bloqueado mientras el preview real espera): solo pasos cortos y seguros. Si la app está
    # en otro lado no se recorre nada; el preview hace su camino normal.
    if act.get("package") != PKG:
        d.app_start(PKG)  # que vaya arrancando (lo lento en frío); el preview sigue desde ahí
        return {"estado": "abriendo", "s": round(time.time() - t0, 2)}
    if _en_login(d):
        # Nunca tipear la clave desde el precalentamiento: si fallara, el preview la tipearía otra vez (dos intentos
        # por pedido acercan el bloqueo de la cuenta). La clave la pone solo el flujo real, una vez.
        return {"estado": "pide_clave", "s": round(time.time() - t0, 2)}
    if d(description="Transferir.").exists(timeout=0):
        d(description="Transferir.").click()
        if not _wait_any(d, timeout=3.0, interval=0.2, predicates=[lambda: d(text="A una nueva cuenta").exists(timeout=0)]):
            d.press("back")  # cayó en otra pantalla: dejarla como estaba; el preview hace su camino
            return {"estado": "toque_fallido", "s": round(time.time() - t0, 2)}
        return {"estado": "listo", "s": round(time.time() - t0, 2)}
    return {"estado": "no_en_inicio", "s": round(time.time() - t0, 2)}


def en_transferir_sin_tocar(d) -> bool:
    """True si quedó en el hub de Transferir (preparado y nadie lo usó)."""
    try:
        return bool(d(text="A una nueva cuenta").exists(timeout=0))
    except Exception:
        return False


def _ir_a_cuentas(d):
    # Atajo: si NX ya está en su pantalla principal con la barra de abajo, ir directo a la tab (sin pasar por
    # ir_al_inicio, que verifica login/red/popups con varias consultas). Si estaba en Cuentas, se sale y se
    # vuelve para que refresque el saldo. Si algo no cuadra, cae al camino largo.
    act = d.app_current()
    if act.get("package") == PKG and "MainActivity" in (act.get("activity") or "") and d(resourceId="accounts").exists(timeout=0):
        if d(text="Tus cuentas").exists(timeout=0) and d(resourceId="home").exists(timeout=0):
            d(resourceId="home").click()
            _pause(0.3)
        d(resourceId="accounts").click()
        # Cuentas trae el saldo de la red: tarda ~2–4 s en pintar. Con 4 s de margen a veces no llegaba y caía al
        # camino largo (+7 s); la espera vuelve apenas aparece.
        if _wait_any(d, timeout=8.0, predicates=[lambda: d(text="Tus cuentas").exists(timeout=0) or d(text="Pesos").exists(timeout=0)]):
            return
    ir_al_inicio(d)
    if d(resourceId="accounts").exists(timeout=0):
        d(resourceId="accounts").click()
    else:
        _wait(d, text="Cuentas", timeout=4).click()
    if not _wait_any(
        d,
        timeout=8.0,
        predicates=[
            lambda: d(text="Tus cuentas").exists(timeout=0) or d(text="Pesos").exists(timeout=0),
        ],
    ):
        _dismiss_popups(d, rounds=1)
        # El toque pudo caer mientras NX terminaba de dibujar el Inicio (pasa con red lenta): un reintento.
        if d(resourceId="accounts").exists(timeout=0):
            d(resourceId="accounts").click()
            _wait_any(d, timeout=8.0, predicates=[lambda: d(text="Tus cuentas").exists(timeout=0) or d(text="Pesos").exists(timeout=0)])
    if not d(text="Tus cuentas").exists(timeout=0) and not d(text="Pesos").exists(timeout=0):
        raise FlowError("no abrí la tab Cuentas")


def _ir_a_transferir(d):
    ir_al_inicio(d)
    if d(description="Transferir.").exists(timeout=0):
        d(description="Transferir.").click()
    else:
        _wait(d, text="Transferir", timeout=4).click()
    _dismiss_popups(d, rounds=1)
    _wait(d, text="A una nueva cuenta", timeout=6)


# ---------------------------------------------------------------- lecturas

def inicio(d) -> dict:
    """Resumen del home: saldo hablado, atajos, quick actions."""
    ir_al_inicio(d)
    nodes = _nodes(d)
    texts = [(n["text"] or n["desc"]) for n in nodes]

    saldo_raw = next((t for t in texts if t.startswith("Dinero disponible")), None)
    card = next((t for t in texts if t.startswith("Cuenta en pesos")), None)
    atajos = []
    for n in nodes:
        ds = n["desc"]
        if ds.startswith("Presioná para") or ds == "accesibilidad prestamos":
            atajos.append(ds)

    return {
        "pantalla": "inicio",
        "cuenta_card": card,
        "saldo_raw": saldo_raw,
        "saldo": parse_monto(saldo_raw),
        "quick_actions": [t for t in ("Agregar dinero.", "Transferir.", "Ver Alias y cebeu.") if any(t in x for x in texts)],
        "atajos": atajos,
        "activity": d.app_current().get("activity"),
    }


def saldo(d) -> dict:
    """Saldos Pesos/Dólares + rendimientos del mes (tab Cuentas)."""
    _ir_a_cuentas(d)
    nodes = _nodes(d)
    texts = [(n["text"] or n["desc"]) for n in nodes]

    pesos_raw = next((n["desc"] or n["text"] for n in nodes
                      if n["y1"] < 400 and parse_monto(n["desc"] or n["text"]) is not None
                      and "rinde" not in _norm(n["text"] + n["desc"])), None)
    # Preferir content-desc tipo "cero con 9 centavos" cerca de Pesos
    for n in nodes:
        label = _norm(n["text"] + " " + n["desc"])
        if "centavo" in label or label in ("cero",):
            if n["x1"] < 400:  # columna pesos
                pesos_raw = n["desc"] or n["text"]
                break

    dolares_raw = None
    for n in nodes:
        val = n["desc"] or n["text"]
        if n["x1"] >= 600 and parse_monto(val) is not None and "transferir" not in _norm(val):
            dolares_raw = val
            break

    rinde = next((t for t in texts if t.startswith("Rinde")), None)
    rend_mes = None
    for i, t in enumerate(texts):
        if t == "Rendimientos del mes" and i + 1 < len(texts):
            rend_mes = texts[i + 1]
            break

    preview = []
    for i, t in enumerate(texts):
        if t in ("Transferencia enviada", "Transferencia recibida") or t.endswith("enviada") or t.endswith("recibida"):
            item = {"tipo": t}
            if i > 0 and re.search(r"\d", texts[i - 1]):
                item["fecha"] = texts[i - 1]
            if i + 1 < len(texts) and re.search(r"\$|pesos|centavo", texts[i + 1], re.I):
                item["monto_raw"] = texts[i + 1]
                item["monto"] = parse_monto(texts[i + 1])
            if i + 2 < len(texts) and not re.search(r"\$|Ver más|Movimientos", texts[i + 2]):
                item["contraparte"] = texts[i + 2]
            preview.append(item)

    return {
        "pantalla": "cuentas",
        "pesos_raw": pesos_raw,
        "pesos": parse_monto(pesos_raw),
        "dolares_raw": dolares_raw,
        "dolares": parse_monto(dolares_raw),
        "rinde": rinde,
        "rendimientos_mes_raw": rend_mes,
        "rendimientos_mes": parse_monto(rend_mes),
        "movimientos_preview": preview,
        "activity": d.app_current().get("activity"),
    }


_RE_FECHA = re.compile(r"(\d{1,2} de \w+|\d{1,2}/\w+/\d{4}.*|hoy|ayer)", re.I)


def _es_tipo_mov(t: str | None) -> bool:
    if not t:
        return False
    n = _norm(t)
    return any(k in t for k in ("Transferencia", "Pago", "enviada", "recibida")) or any(k in n for k in ("compra", "recarga", "cobro", "debito", "credito", "reintegro", "rendimiento"))


def _parse_lista_movimientos(nodes: list[dict]) -> list[dict]:
    """Movimientos de la pantalla. Sirve para las dos formas de la app: cada movimiento con su fecha
    («21 de octubre · Transferencia enviada · - $ 1,00 · Bernabe…») o varios bajo una misma fecha."""
    texts = [(n["text"] or n["desc"]) or "" for n in nodes]
    out = []
    fecha = None
    i = 0
    while i < len(texts):
        t = texts[i].strip()
        if _RE_FECHA.fullmatch(t):
            fecha = t
            i += 1
            continue
        monto_raw = texts[i + 1].strip() if i + 1 < len(texts) else ""
        if _es_tipo_mov(t) and "$" in monto_raw:
            contraparte = texts[i + 2].strip() if i + 2 < len(texts) else None
            if not contraparte or "$" in contraparte or _RE_FECHA.fullmatch(contraparte) or _es_tipo_mov(contraparte) or contraparte.startswith(("Ver ", "Estos son", "Hybrid")) or contraparte in ("Filtros", "Movimientos", "Inicio"):
                contraparte = None
            out.append({"fecha": fecha, "tipo": t, "monto_raw": monto_raw, "monto": parse_monto(monto_raw), "contraparte": contraparte})
            i += 3 if contraparte else 2
            continue
        i += 1
    return out


def movimientos(d, limite: int = 20, detalle: bool = False) -> dict:
    """Lista de movimientos (últimos 90 días), desde la LISTA COMPLETA (no la vista previa de 3 de Cuentas, que
    era lo que leía antes: nunca llegaba al «Ver más» porque queda fuera de pantalla). Si detalle=True, abre el primero."""
    items = _abrir_movimientos_lista(d)
    # scrollear un poco si piden más
    # Scrollear y empalmar cada pantalla por donde se superpone con lo ya leído (no por «iguales»: dos
    # transferencias idénticas el mismo día son dos movimientos). Para cuando no aparece nada nuevo (fin de lista).
    clave = lambda m: (m.get("fecha"), m.get("tipo"), m.get("monto_raw"), m.get("contraparte"))  # noqa: E731

    def igual(x: dict, y: dict) -> bool:
        # Las filas cortadas en el borde de la pantalla vienen sin fecha o sin contraparte: None empata con todo.
        return all(a is None or b is None or a == b for a, b in zip(clave(x), clave(y)))

    fin = lambda: d(textStartsWith="Estos son todos tus movimientos").exists(timeout=0)  # noqa: E731  (pie de la lista)
    vio_fin = fin()
    while len(items) < limite and not vio_fin:
        before = len(items)
        _scroll(d, "up")
        more = _parse_lista_movimientos(_nodes(d))
        solape = next((k for k in range(min(len(items), len(more)), 0, -1)
                       if all(igual(x, y) for x, y in zip(items[-k:], more[:k]))), 0)
        for x, y in zip(items[len(items) - solape:], more[:solape]):
            for f, v in y.items():
                if x.get(f) is None and v is not None:
                    x[f] = v  # completar la fila que había quedado cortada
        items.extend(more[solape:])
        vio_fin = fin()
        if len(items) == before:
            vio_fin = True
            break
    hay_mas = not vio_fin and len(items) >= limite
    items = items[:limite]

    detalle_data = None
    if detalle and items:
        # tap primer movimiento por tipo
        tipo = items[0]["tipo"]
        if d(text=tipo).exists:
            d(text=tipo).click()
            time.sleep(2)
            detalle_data = movimiento_detalle(d, ya_abierto=True)

    return {
        "pantalla": "movimientos",
        "cantidad": len(items),
        "lista_completa": True,
        "hay_mas": hay_mas,  # si es False, no hay más en los ~90 días; si es True, pedí más con limite
        "movimientos": items,
        "detalle": detalle_data,
        "activity": d.app_current().get("activity"),
    }


_DETALLE_NOISE = (
    "vibración", "vibracion", "hybrid icon", "icon", "notificación", "notificacion",
)


def movimiento_detalle(d, ya_abierto: bool = False) -> dict:
    """Lee la pantalla de detalle del movimiento actual."""
    if not ya_abierto:
        raise FlowError("movimiento_detalle espera la pantalla ya abierta (o usa movimientos(detalle=True))")
    texts = [
        t for t in _texts(d)
        if t and _norm(t) not in _DETALLE_NOISE and not _norm(t).startswith("notificacion de")
    ]

    def after(label):
        for i, t in enumerate(texts):
            if t == label and i + 1 < len(texts):
                return texts[i + 1]
        return None

    titulo = next(
        (t for t in texts if "Transferencia" in t or "Pago" in t or "compra" in _norm(t)),
        texts[0] if texts else None,
    )
    monto_raw = next((t for t in texts if "centavo" in _norm(t) or t.startswith("pesos") or t.startswith("$")), None)
    monto = parse_monto(monto_raw)
    if monto is not None and titulo and "enviada" in _norm(titulo) and monto > 0:
        monto = -monto

    # Enviada: destino / Recibida: origen (mismos slots unificados en cbu_cvu / contraparte)
    entidad_destino = after("Entidad de destino")
    entidad_origen = after("Entidad de origen")
    transferido_a = after("Transferido a")
    transferido_por = after("Transferido por")
    cbu_destino = after("CBU/CVU de destino")
    cbu_origen = after("CBU/CVU de origen")
    cuit_destino = after("CUIT/CUIL de destino")
    cuit_origen = after("CUIT/CUIL de origen")

    return {
        "titulo": titulo,
        "fecha_hora": next((t for t in texts if re.search(r"\d{1,2}/\w+/\d{4}", t)), None),
        "monto_raw": monto_raw,
        "monto": monto,
        "nro_operacion": next((t.split(":", 1)[1].strip() for t in texts if t.startswith("N° de operación")), None),
        "entidad_destino": entidad_destino,
        "entidad_origen": entidad_origen,
        "transferido_a": transferido_a,
        "transferido_por": transferido_por,
        "cbu_cvu": cbu_destino or cbu_origen,
        "cbu_cvu_destino": cbu_destino,
        "cbu_cvu_origen": cbu_origen,
        "coelsa_id": after("COELSA ID"),
        "cuit_cuil": cuit_destino or cuit_origen,
        "cuit_cuil_destino": cuit_destino,
        "cuit_cuil_origen": cuit_origen,
        "contraparte": transferido_a or transferido_por,
        "entidad": entidad_destino or entidad_origen,
        "activity": d.app_current().get("activity"),
    }


def contactos(d, seccion: str = "Sugeridos") -> dict:
    """Lista contactos en Transferir: Sugeridos | Favoritos | Grupos."""
    seccion = seccion.capitalize()
    if seccion not in ("Sugeridos", "Favoritos", "Grupos"):
        raise FlowError(f"sección inválida: {seccion}")
    _ir_a_transferir(d)
    # tab Transferir (no Actividad)
    if d(text="Transferir").exists:
        # el tab superior también se llama Transferir; click description si hace falta
        pass
    if d(text=seccion).exists:
        d(text=seccion).click()
        time.sleep(1.2)

    nodes = _nodes(d)
    texts = [(n["text"] or n["desc"]) for n in nodes]
    vacio = next((t for t in texts if "Todavía no" in t or "Organizá tus contactos" in t), None)

    nombres = []
    skip = {
        "Transferir", "Actividad", "A una nueva cuenta", "Buscá por nombre o apodo",
        "Sugeridos", "Favoritos", "Grupos", "Tus cuentas", "Agregar favoritos", "Crear grupo",
        "faqs",
    }
    for n in nodes:
        t, ds = n["text"], n["desc"]
        # iniciales tipo "JG" / nombre completo con content-desc igual
        if t in skip or ds in skip:
            continue
        if re.fullmatch(r"[A-Z]{1,3}", t or ""):
            continue
        if t and len(t) > 3 and t == ds and t[0].isupper():
            nombres.append(t)
        elif t and len(t) > 8 and " " in t and t[0].isupper() and t not in skip and "todavia" not in _norm(t):
            nt = _norm(t)
            if any(x in nt for x in ("agrega", "crea grupo", "organiza", "favorito", "transferir mas", "buscá", "busca por")):
                continue
            if t not in nombres and not t.startswith("Buscá") and "grupo" not in nt:
                nombres.append(t)

    # dedupe preservando orden
    seen = set()
    lista = []
    for n in nombres:
        if n not in seen:
            seen.add(n)
            lista.append(n)
    if vacio:
        lista = []

    return {
        "pantalla": "transferir_contactos",
        "seccion": seccion,
        "vacio": vacio,
        "contactos": lista,
        "activity": d.app_current().get("activity"),
    }


def actividad(d, limite: int = 20) -> dict:
    """Tab Actividad dentro de Transferir (transferencias recientes)."""
    _ir_a_transferir(d)
    if d(description="Actividad").exists:
        d(description="Actividad").click()
    elif d(text="Actividad").exists:
        d(text="Actividad").click()
    time.sleep(2)
    _dismiss_popups(d)

    nodes = _nodes(d)
    texts = [(n["text"] or n["desc"]) for n in nodes]
    items = []
    i = 0
    while i < len(texts) and len(items) < limite:
        t = texts[i]
        if re.fullmatch(r"\d{1,2} de \w+", t or "", re.I):
            fecha = t
            nombre = texts[i + 1] if i + 1 < len(texts) else None
            monto_raw = texts[i + 2] if i + 2 < len(texts) else None
            destino = texts[i + 3] if i + 3 < len(texts) else None
            estado = texts[i + 4] if i + 4 < len(texts) else None
            if nombre and parse_monto(monto_raw) is not None:
                items.append({
                    "fecha": fecha,
                    "nombre": nombre,
                    "monto_raw": monto_raw,
                    "monto": parse_monto(monto_raw),
                    "destino": destino,
                    "estado": estado,
                })
                i += 5
                continue
        i += 1

    return {
        "pantalla": "transferir_actividad",
        "cantidad": len(items),
        "actividad": items,
        "activity": d.app_current().get("activity"),
    }


# ---------------------------------------------------------------- transferencia

_SKIP_DEST = {
    "Cerrar hoja", "cerrar modal", "Cerrar", "Continuar", "Validar",
    "Agregar apodo", "Agregar a Contactos", "Agregar a contactos",
}
_ENTIDADES_HINT = (
    "Mercado Pago", "Naranja X", "Naranja", "Ualá", "Uala", "Brubank", "Prex",
    "Lemon", "Belo", "Reba", "AstroPay", "Personal Pay", "Cuenta DNI",
    "Banco", "Galicia", "Santander", "BBVA", "Macro", "ICBC", "HSBC",
    "Credicoop", "Supervielle", "Provincia", "Nación", "Ciudad", "Patagonia",
)


def _parse_destinatario(texts: list[str]) -> dict:
    """Hoja post-Validar: titular, entidad (ej. Mercado Pago), CUIL, CVU/CBU, alias."""
    i_cuil = next((i for i, t in enumerate(texts) if t.startswith("CUIL")), None)
    titular = None
    if i_cuil is not None:
        titular = next(
            (t for t in reversed(texts[:i_cuil]) if t and t not in _SKIP_DEST and not t.startswith(("CUIL", "CVU", "CBU", "Alias"))),
            None,
        )

    entidad = None
    for i, t in enumerate(texts):
        if t.startswith(("CVU", "CBU")) and i > 0:
            prev = texts[i - 1]
            if prev and prev not in _SKIP_DEST and not prev.startswith(("CUIL", "CVU", "CBU", "Alias", "Agregar")):
                entidad = prev
                break
    if not entidad:
        entidad = next((t for t in texts if any(h.lower() in t.lower() for h in _ENTIDADES_HINT)
                        and not t.startswith(("CUIL", "CVU", "CBU", "Alias"))), None)

    alias = next((t.split(":", 1)[1].strip() for t in texts if t.startswith("Alias:")), None)
    cuil = next((t.split(":", 1)[1].strip() for t in texts if t.startswith("CUIL")), None)
    cvu_cbu = next((t.split(":", 1)[1].strip() for t in texts if t.startswith(("CVU", "CBU"))), None)

    if titular and entidad:
        etiqueta = f"{titular} — {entidad}"
    elif titular:
        etiqueta = titular
    elif entidad:
        etiqueta = entidad
    else:
        etiqueta = alias or "destinatario desconocido"

    return {
        "titular": titular,
        "entidad": entidad,
        "etiqueta": etiqueta,
        "cuil": cuil,
        "cvu_cbu": cvu_cbu,
        "alias": alias,
    }


def _preview_texto(destinatario: dict, monto: float, disp: float | None, puede: bool, faltante: float | None) -> str:
    dest = destinatario.get("etiqueta") or destinatario.get("titular") or "?"
    saldo_s = f"${disp:.2f}" if disp is not None else "desconocido"
    if puede:
        return f"Preview: {dest} · ${monto:.2f} · saldo {saldo_s} · OK para transferir"
    falt = f" · faltan ${faltante:.2f}" if faltante is not None else ""
    return f"Preview: {dest} · ${monto:.2f} · saldo {saldo_s} · NO alcanza{falt}"


_DESTINO_ERROR_MARKERS = (
    "Revisá el CBU, CVU o Alias",
    "Revisa el CBU, CVU o Alias",
    "No encontramos",
    "no encontramos",
    "No existe",
    "inválido",
    "invalido",
)


def _destino_error_en_ui(texts: list[str]) -> str | None:
    for t in texts:
        for m in _DESTINO_ERROR_MARKERS:
            if m.lower() in t.lower():
                return t
    return None


def destino_resolver(d, destino: str, on_step=None) -> dict:
    """Paso 1 secretaria: pone el alias/CBU/CVU, valida y DEJA la hoja del titular abierta.

    El agente debe mostrarle al usuario `pregunta` (¿es Juan — Mercado Pago?) y
    recién después llamar `transfer_armar`.

    Si Naranja no encuentra el destino: estado=destino_no_encontrado (no exception),
    para que la secretaria lo diga en español.
    """
    destino_pedido = (destino or "").strip()
    if not destino_pedido:
        return {
            "estado": "destino_invalido",
            "paso": "destino",
            "destino_pedido": destino_pedido,
            "pregunta": None,
            "mensaje": "No me pasaste alias/CBU/CVU. ¿A quién le transferimos?",
            "siguiente": "Pedile el destino al usuario y reintentá nx_destino_resolver.",
        }

    # Agenda local: nombre → CVU (el alias corto tipo juan.ars a veces no valida en NX)
    ag = agenda_lookup(destino_pedido)
    destino = destino_pedido
    via_agenda = False
    if ag and not _parece_cvu_cbu(destino_pedido):
        destino = str(ag.get("cvu") or ag.get("alias") or destino_pedido)
        via_agenda = True
        _emit(
            on_step,
            f"Agenda: «{destino_pedido}» → {ag.get('titular') or destino}…",
            1,
            4,
        )

    _emit(on_step, "Abriendo Transferir → nueva cuenta…", 1, 4)
    _abrir_transferir_nueva_cuenta(d, on_step=on_step)

    _emit(on_step, f"Escribiendo «{destino}»…", 2, 4)
    campo = _wait(d, className="android.widget.EditText", timeout=6)
    _dismiss_popups(d, rounds=1)
    if d(text="Cerrar").exists(timeout=0):
        d(text="Cerrar").click()
        _pause(0.15)
    # set_text ya reemplaza el contenido (el clear_text previo costaba ~0,7 s y el campo viene vacío).
    campo.set_text(destino)
    d.press("back")  # cerrar teclado para que Validar reciba el tap
    _pause(0.15)

    _emit(on_step, "Validando en Naranja X…", 3, 4)
    if not _click_label(d, "Validar"):
        raise FlowError("no pude tocar Validar")

    # Éxito = hoja CUIL · Error = snack/texto (dura poco) · Formato corto = a veces no pasa nada.
    # Sondear con RPC chiquitas (~0,15 s) la hoja o el error, y bajar el dump (~1 s) solo cuando apareció algo.
    crudo = getattr(d, "_d", d)
    err_re = "(?is).*(revis[aá] el cbu|no encontramos|no existe|inv[aá]lido).*"
    deadline = time.time() + 12.0
    texts: list[str] = []
    while time.time() < deadline:
        vio = vio_error = False
        try:
            vio = bool(crudo(textStartsWith="CUIL").exists(timeout=0))
            if not vio:
                vio = vio_error = bool(crudo(textMatches=err_re).exists(timeout=0))
        except Exception:
            vio = True
        if not vio:
            time.sleep(0.15)
            continue
        if hasattr(d, "invalidate"):
            d.invalidate()
        texts = _texts(d)
        if any(t.startswith("CUIL") for t in texts):
            break
        err = _destino_error_en_ui(texts) or ("Revisá el CBU, CVU o Alias que ingresaste." if vio_error else None)
        if err:
            _emit(on_step, f"Destino no válido: {err}", 4, 4)
            return {
                "estado": "destino_no_encontrado",
                "paso": "destino",
                "destino_pedido": destino_pedido,
                "destino_enviado": destino,
                "via_agenda": via_agenda,
                "destinatario": None,
                "pregunta": None,
                "mensaje": (
                    f"Puse «{destino}»"
                    + (f" (agenda de «{destino_pedido}»)" if via_agenda else "")
                    + f" y Naranja X respondió: «{err}». "
                    "No encontré a nadie con ese alias/CBU/CVU. Nada se envió."
                ),
                "siguiente": "Decile que ese alias no existe y pedile otro. No reintentes con otra herramienta.",
                "detalle_ui": err,
                "pantalla": "alias_form",
            }
        _pause(0.25)
    else:
        # Sigue en el form sin CUIL ni error explícito (formato demasiado corto, etc.)
        texts = _texts(d)
        _emit(on_step, "Naranja no resolvió ese destino", 4, 4)
        return {
            "estado": "destino_no_encontrado",
            "paso": "destino",
            "destino_pedido": destino_pedido,
            "destino_enviado": destino,
            "via_agenda": via_agenda,
            "destinatario": None,
            "pregunta": None,
            "mensaje": (
                f"Puse «{destino}» pero Naranja X no encontró a nadie con ese alias/CBU/CVU. Nada se envió."
            ),
            "siguiente": "Decile que ese alias no existe y pedile otro. No reintentes con otra herramienta.",
            "pantalla": "alias_form",
            "textos": [t for t in texts if t and "teclado" not in t.lower()][:15],
        }

    destinatario = _parse_destinatario(texts)
    etiqueta = destinatario.get("etiqueta") or destino
    historial = historial_destino(destinatario)  # antes de anotarla: ¿ya le mandamos plata alguna vez?
    agenda_remember(destinatario, nombres_extra=[destino_pedido] if via_agenda else None)

    _emit(on_step, f"Encontré: {etiqueta}", 4, 4)
    return {
        "estado": "destino_resuelto",
        "historial": historial,
        "paso": "confirmar_identidad",
        "destino_pedido": destino_pedido,
        "destino_enviado": destino,
        "via_agenda": via_agenda,
        "destinatario": destinatario,
        "pregunta": f"¿Es {etiqueta}?",
        "mensaje": (
            (f"Agenda «{destino_pedido}» → " if via_agenda else f"Puse «{destino}» y ")
            + f"Naranja X muestra {etiqueta}"
            + (f" · CUIL {destinatario['cuil']}" if destinatario.get("cuil") else "")
            + ". Nada se envió; la hoja del titular quedó abierta."
        ),
        "siguiente": (
            "Mostrá `pregunta` al usuario. Si confirma la identidad, llamá "
            "nx_transfer_armar(monto=…). Si dice que no, nx_transfer_cancelar."
        ),
        "pantalla": "hoja_titular",
    }


def transfer_armar(d, monto: float, destino: str | None = None, on_step=None, shot=None) -> dict:
    """Paso 2 secretaria: Continuar → monto → chequeo de saldo → pantalla de confirmación.

    No envía plata. Si no alcanza, vuelve atrás y corta.
    """
    monto = float(monto)
    if monto <= 0:
        raise FlowError("monto debe ser > 0")

    destinatario: dict = {}
    destino_pedido = (destino or "").strip() or None

    if _en_hoja_titular(d):
        _emit(on_step, "Identidad OK — sigo al monto…", 1, 4)
        texts = _texts(d)
        destinatario = _parse_destinatario(texts)
        if not _click_label(d, "Continuar"):
            raise FlowError("no pude tocar Continuar en la hoja del titular")
    elif _en_pantalla_monto(d):
        _emit(on_step, "Ya estoy en monto…", 1, 4)
    elif destino_pedido:
        res = destino_resolver(d, destino_pedido, on_step=on_step)
        if res.get("estado") != "destino_resuelto":
            return {
                **res,
                "monto": monto,
                "puede_transferir": False,
                "estado": res.get("estado") or "destino_no_encontrado",
            }
        destinatario = res.get("destinatario") or {}
        destino_pedido = res.get("destino_pedido")
        _emit(on_step, "Identidad leída — sigo al monto…", 1, 4)
        if not _click_label(d, "Continuar"):
            raise FlowError("no pude tocar Continuar en la hoja del titular")
    else:
        raise FlowError(
            "no estoy en la hoja del titular ni en monto; "
            "llamá primero nx_destino_resolver(destino) o pasá destino acá"
        )

    _emit(on_step, "Leyendo saldo disponible…", 2, 4)
    _wait(d, textStartsWith="¿Cuánto vas a transferir", timeout=8)
    texts = _texts(d)
    disponible = next((t for t in texts if t.startswith("Dinero en cuenta")), None)
    disp_monto = parse_monto(disponible)
    puede = disp_monto is not None and monto <= disp_monto + 0.005
    faltante = None if puede or disp_monto is None else round(monto - disp_monto, 2)
    if not destinatario:
        destinatario = {"etiqueta": destino_pedido or "destinatario", "titular": None, "entidad": None}

    base = {
        "destino_pedido": destino_pedido,
        "destinatario": destinatario,
        "monto": monto,
        "disponible": disponible,
        "disponible_monto": disp_monto,
        "puede_transferir": puede,
        "faltante": faltante,
        "preview_texto": _preview_texto(destinatario, monto, disp_monto, puede, faltante),
    }

    if not puede:
        _emit(on_step, f"Saldo insuficiente (disp {disp_monto})", 3, 4)
        _unwind_transfers(d, max_backs=5)
        base["estado"] = "saldo_insuficiente"
        base["paso"] = "saldo"
        base["pregunta"] = None
        base["mensaje"] = (
            f"No alcanza: querés mandar ${monto:.2f} a {destinatario.get('etiqueta')} "
            f"y hay ${disp_monto if disp_monto is not None else '?'}. No se envió nada."
        )
        base["siguiente"] = "Avisale al usuario. No llames nx_transfer."
        return base

    _emit(on_step, f"Saldo OK (${disp_monto:.2f}) — armando ${monto:.2f}…", 3, 4)
    d(className="android.widget.EditText").set_text(_monto_str(monto))
    d.press("back")
    _pause(0.35)

    # Naranja deshabilita Continuar con montos muy chicos (en práctica < $0,10)
    # o cuando el monto no cierra con el medio de pago.
    cont = _continuar_estado(d)
    texts_monto = _texts(d)
    alerta_otro_medio = next(
        (
            t
            for t in texts_monto
            if "otro medio de pago" in t.lower() or "programarla para otro día" in t.lower()
        ),
        None,
    )
    if cont == "disabled":
        _emit(on_step, "Continuar deshabilitado para ese monto", 4, 4)
        _unwind_transfers(d, max_backs=5)
        base["estado"] = "monto_rechazado"
        base["puede_transferir"] = False
        base["paso"] = "monto"
        base["pregunta"] = None
        base["mensaje"] = (
            f"Naranja X no habilita Continuar con ${monto:.2f} "
            f"(saldo ${disp_monto:.2f}). Suele pasar con montos menores a $0,10. "
            "Nada se envió."
        )
        base["siguiente"] = "Pedile otro monto (≥ $0,10) o avisá. No llames nx_transfer."
        return base
    if alerta_otro_medio and not puede:
        _emit(on_step, "La app ofrece otro medio / programar — cortamos", 4, 4)
        _unwind_transfers(d, max_backs=5)
        base["estado"] = "saldo_insuficiente"
        base["puede_transferir"] = False
        base["paso"] = "saldo"
        base["mensaje"] = (
            f"Con ${monto:.2f} y saldo ${disp_monto:.2f} Naranja muestra: «{alerta_otro_medio}». "
            "No seguimos por otro medio de pago. Nada se envió."
        )
        base["siguiente"] = "Avisale al usuario. No llames nx_transfer."
        return base

    if not _click_label(d, "Continuar"):
        raise FlowError("no pude tocar Continuar en la pantalla de monto")

    for _ in range(16):
        # Esperar la confirmación con el celu (vuelve apenas aparece) antes de bajar dumps para buscar errores.
        d(descriptionStartsWith="Vas a transferir").wait(timeout=2.5)
        if d(text="Omitir").exists(timeout=0):
            d(text="Omitir").click()
            _pause(0.15)
        if _en_confirmacion(d):
            break
        texts_now = _texts(d)
        if _saldo_insuficiente_en_ui(d, texts_now) or any(
            t.startswith("Agregá dinero a tu cuenta") for t in texts_now
        ):
            msg = _saldo_insuficiente_msg(d, texts_now)
            _unwind_transfers(d, max_backs=5)
            base["estado"] = "saldo_insuficiente"
            base["puede_transferir"] = False
            base["paso"] = "saldo"
            base["mensaje"] = msg
            base["preview_texto"] = _preview_texto(destinatario, monto, disp_monto, False, faltante)
            base["siguiente"] = "Avisale al usuario. No llames nx_transfer."
            return base
        if _en_pantalla_monto(d) and _continuar_estado(d) == "enabled":
            _click_label(d, "Continuar")
        _pause(0.28)
    else:
        raise FlowError("no llegó la pantalla de confirmación")

    resumen = d(descriptionStartsWith="Vas a transferir").info["contentDescription"]
    _emit(on_step, "Listo para confirmar el envío", 4, 4)
    out = {
        **base,
        "estado": "listo_para_enviar",
        "paso": "confirmar_envio",
        "resumen": resumen,
        "pregunta": f"¿Mando ${monto:.2f} a {destinatario.get('etiqueta')}?",
        "mensaje": (
            f"Armé la transferencia: {destinatario.get('etiqueta')} · ${monto:.2f} · "
            f"saldo ${disp_monto:.2f}. Nada se envió todavía."
        ),
        "siguiente": (
            "Mostrá `pregunta` / `preview_texto`. Si el usuario dice que sí, "
            "nx_transfer(confirmado=true) SIN repetir destino/monto."
        ),
        "pantalla": "confirmacion",
        "screenshot_confirmacion": shot("nx_confirm") if shot else None,
    }
    return out


def transfer_cancelar(d, on_step=None) -> dict:
    """Abortar una transferencia a medias (hoja titular / monto / confirm)."""
    _emit(on_step, "Cancelando transferencia a medias…")
    where = _unwind_transfers(d, max_backs=6)
    return {
        "estado": "cancelado",
        "pantalla": where,
        "mensaje": "Listo, salí del flujo de transferencia. No se envió nada.",
    }


def transfer_enviar(
    d,
    on_step=None,
    shot=None,
    destinatario: dict | None = None,
    monto: float | None = None,
    salir: bool = True,
) -> dict:
    """Paso 3 secretaria: desde 'Vas a transferir' → Transferir → PIN → comprobante."""
    if not _en_confirmacion(d):
        raise FlowError(
            "no estoy en la confirmación (Vas a transferir…). "
            "Primero nx_transfer_armar y que el usuario confirme."
        )

    etiqueta = (destinatario or {}).get("etiqueta") or "?"
    _emit(on_step, f"Enviando a {etiqueta}…", 1, 3)
    if not _click_label(d, "Transferir"):
        # a veces el botón es solo description
        if not _click_label(d, "Transferir."):
            raise FlowError("no pude tocar el botón Transferir de confirmación")

    pin_box = d(resourceId=f"{PKG}:id/eqPinInputComposeView")
    if pin_box.wait(timeout=8):
        _emit(on_step, "Ingresando 2FA…", 2, 3)
        pin = _nx_pin()
        if not (pin.isdigit() and len(pin) == 6):
            raise SesionBloqueada(
                "segundo_factor: la app pide la clave y el PIN del perfil no está configurado"
            )
        pin_box.click()
        _pause(0.2)
        _ingresar_pin(d, pin)
        d.press("back")
        _pause(0.2)
        _wait(d, resourceId=f"{PKG}:id/primary_button", timeout=4).click()

    # Prueba de «falla en el medio» (solo si existe el archivo; se consume): la plata ya salió y el flujo no lo sabe.
    falla = _falla_de_prueba()
    if falla == "desconocido":
        time.sleep(3)
        return {"estado": "desconocido", "mensaje": "No vi la pantalla de éxito; revisá el celu.", "textos": []}
    if falla:
        raise FlowError("se cortó la comunicación con el celu justo después de enviar (falla de prueba)")

    _dismiss_popups(d, rounds=1)
    ok = d(textStartsWith="Transferiste")
    if not ok.wait(timeout=20):
        return {
            "estado": "desconocido",
            "mensaje": "No vi la pantalla de éxito; revisá el celu.",
            "textos": [t for t in _texts(d) if not t.isdigit()][:30],
        }
    texts = _texts(d)
    _emit(on_step, "Transferencia OK", 3, 3)
    comprobante_txt = ok.get_text()
    codigo = next(
        (t.split(":", 1)[1].strip() for t in texts if t.startswith("Código de transacción")),
        None,
    )
    monto_ok = monto
    if monto_ok is None:
        # "Transferiste $ 10 a …" / "Transferiste $10,00 a …"
        m = re.search(r"\$\s*([\d.]+(?:,\d+)?)", comprobante_txt or "")
        if m:
            monto_ok = parse_monto(m.group(0))
    dest = destinatario or {}
    huella = registrar_enviada(
        {
            "codigo_transaccion": codigo,
            "nro_operacion": None,  # se completa al abrir el detalle del comprobante
            "monto": abs(float(monto_ok)) if monto_ok is not None else None,
            "contraparte": dest.get("titular") or dest.get("etiqueta"),
            "titular": dest.get("titular"),
            "entidad": dest.get("entidad"),
            "cvu_cbu": dest.get("cvu_cbu"),
            "alias": dest.get("alias"),
            "cuil": dest.get("cuil"),
            "comprobante": comprobante_txt,
        }
    )
    agenda_remember(destinatario, enviada=True)
    out = {
        "estado": "ok",
        "comprobante": comprobante_txt,
        "codigo_transaccion": codigo,
        "destinatario": destinatario,
        "huella": huella,
        "screenshot_resultado": shot("nx_ok") if shot else None,
        "mensaje": f"Listo: transferiste a {etiqueta}." if etiqueta != "?" else "Transferencia OK.",
        "mantener_pantalla": True,  # encadenar nx_comprobante_guardar(recien=true)
        "siguiente": (
            "nx_comprobante_guardar(recien=true) o nx_transfer_y_comprobante. "
            "Huella verificada; si ambiguo no adivines."
        ),
    }
    # Post-éxito: salir del Congrats y dejar listo el camino a Movimientos
    if salir:
        _salir_exito_hacia_cuentas(d)
    return out


def _comprobante_desde_exito(d, on_step=None) -> dict:
    """Comprobante desde la pantalla de éxito («Compartir comprobante» abre el mismo recibo que «Ver comprobante»
    de Movimientos). Es el recibo de la transferencia que se acaba de hacer: no hace falta buscarla en la lista
    (~20 s menos). Si algo no cuadra, FlowError y se usa el camino largo."""
    if not d(text="Compartir comprobante").exists(timeout=2):
        raise FlowError("no estoy en la pantalla de éxito")
    _abrir_pantalla_comprobante(d, on_step=on_step, boton="Compartir comprobante")
    texts = [t for t in _texts(d) if t]
    nro = None
    for i, t in enumerate(texts):
        if "operaci" in _norm(t):
            cand = re.sub(r"\D", "", t) or (re.sub(r"\D", "", texts[i + 1]) if i + 1 < len(texts) else "")
            if len(cand) >= 6:
                nro = cand
                break
    det = {"nro_operacion": nro, "fuente": "pantalla_exito"}
    return _capturar_png_recibo(d, det, on_step=on_step, ya_abierto=True)


def _unwind_exito(d) -> None:
    try:
        _salir_exito_hacia_cuentas(d)
    except Exception:
        pass


def _salir_exito_hacia_cuentas(d) -> None:
    """Desde CongratsActivity → tab Cuentas (sin paseo largo por home)."""
    if d(text="Ir a Inicio").exists(timeout=0.8):
        d(text="Ir a Inicio").click()
        _ui_sleep(0.55)
    _dismiss_popups(d, rounds=1)
    try:
        _ir_a_cuentas(d)
    except FlowError:
        # fallback: bottom nav accounts
        if d(resourceId="accounts").exists(timeout=0):
            d(resourceId="accounts").click()
            _ui_sleep(0.45)


def transfer_y_comprobante(
    d,
    on_step=None,
    shot=None,
    destinatario: dict | None = None,
    monto: float | None = None,
) -> dict:
    """Enviar (desde confirmación) + guardar PNG en el mismo ciclo (un solo lock).

    Preferí esto cuando el usuario ya dijo sí al envío y quiere el comprobante ya.
    """
    sent = transfer_enviar(
        d, on_step=on_step, shot=shot, destinatario=destinatario, monto=monto, salir=False
    )
    if sent.get("estado") != "ok":
        return sent
    _emit(on_step, "Encadenando comprobante…")
    try:
        comp = _comprobante_desde_exito(d, on_step=on_step)
    except FlowError:
        # camino largo: salir del éxito y buscar la transferencia en Movimientos (con huella)
        _unwind_exito(d)
        comp = comprobante_guardar(d, recien=True, on_step=on_step)
    out = {
        **sent,
        "comprobante_png": comp,
        "archivo": comp.get("archivo") if isinstance(comp, dict) else None,
    }
    if comp.get("estado") == "ok":
        out["estado"] = "ok"
        out["mantener_pantalla"] = False
        out["mensaje"] = (
            f"{sent.get('mensaje', 'Transfer OK.')} "
            f"Comprobante: {comp.get('archivo')}"
        )
        out["siguiente"] = "wa_enviar_preview(destino, archivo=…) → wa_enviar."
    else:
        out["estado"] = f"transfer_ok_comprobante_{comp.get('estado')}"
        out["mantener_pantalla"] = True
        out["mensaje"] = (
            f"Transfer OK, pero el comprobante quedó en {comp.get('estado')}: "
            f"{comp.get('mensaje')}"
        )
        out["siguiente"] = comp.get("siguiente") or "nx_comprobante_guardar con filtros."
    return out


def _monto_dicho(monto: float) -> str:
    """Monto para decir en voz alta, con la moneda explícita («diez pesos», no «$10»): por teléfono no se ve nada."""
    m = round(float(monto), 2)
    pesos, cent = int(m), int(round((m - int(m)) * 100))
    if pesos == 0:
        return f"{cent} centavos"
    p = f"{pesos:,}".replace(",", ".") + (" peso" if pesos == 1 else " pesos")
    return p + (f" con {cent} centavos" if cent else "")


def pregunta_transferencia(arm: dict) -> str:
    """La única confirmación, pensada para escucharse (llamada): titular TAL COMO LO VALIDÓ Naranja X (no el apodo que
    entendió el modelo), billetera y monto con moneda. Cuenta nueva → aviso y que confirme diciendo el nombre."""
    d = arm.get("destinatario") or {}
    quien = d.get("titular") or d.get("etiqueta") or arm.get("destino_pedido") or "?"
    donde = f", de {d['entidad']}" if d.get("entidad") else ""
    monto = _monto_dicho(arm.get("monto") or 0)
    if (arm.get("historial") or {}).get("conocida") is False:
        return (f"Ojo, es una cuenta nueva: nunca le mandaste plata. Es de {quien}{donde}. "
                f"Si es esa persona, decime su nombre y le paso {monto}.")
    return f"¿Le paso {monto} a {quien}{donde}?"


def transferir(
    d, destino: str, monto: float, confirmar: bool = False, shot=None, on_step=None, quedarse: bool = False
) -> dict:
    """Compat HTTP / one-shot: resolver → armar → (opcional) enviar.

    quedarse=True (preview del secretario): sin confirmar, queda en «Vas a transferir…» con la pantalla
    prendida, así con el sí solo falta tocar Transferir + PIN (transfer_enviar).
    """
    res = destino_resolver(d, destino, on_step=on_step)
    if res.get("estado") != "destino_resuelto":
        # alias inexistente / inválido: devolverlo tal cual (mensaje claro), sin intentar armar
        return res
    arm = transfer_armar(d, monto, on_step=on_step, shot=shot)
    # transfer_armar ya reparsea titular; merge destino_pedido
    arm.setdefault("destino_pedido", res.get("destino_pedido"))
    arm["historial"] = res.get("historial")
    if arm.get("estado") == "saldo_insuficiente":
        if confirmar:
            raise SaldoInsuficiente(arm.get("mensaje") or "saldo_insuficiente")
        return arm

    if not confirmar and quedarse:
        arm["estado"] = "listo_para_enviar"
        arm["pregunta"] = pregunta_transferencia(arm)
        arm["mantener_pantalla"] = True
        arm["siguiente"] = (
            "Mostrá el preview y esperá el sí. Con el sí → nx_transfer(confirmado=true) o "
            "nx_transfer_y_comprobante(confirmado=true), sin destino ni monto. Nada más."
        )
        return arm

    if not confirmar:
        # dry-run: salir de la confirmación para no dejar la UI colgada
        d.press("back")
        _pause(0.15)
        arm["estado"] = "dry_run"
        arm["mensaje"] = (
            f"Dry-run OK. {arm.get('preview_texto')}. Resumen: {arm.get('resumen')}. "
            "Nada se envió. Para enviar de verdad usá el flujo secretaria o confirmar=true."
        )
        arm["siguiente"] = "Si el usuario confirma, nx_destino_resolver + nx_transfer_armar + nx_transfer."
        return arm

    sent = transfer_enviar(d, on_step=on_step, shot=shot, destinatario=arm.get("destinatario"))
    return {**arm, **sent}


# ---------------------------------------------------------------- comprobante (nodo NX)

def _comprobantes_dir() -> Path:
    """PNG capturados viven en el host del MCP (no en el celu ni en un VPS NX)."""
    base = os.environ.get("NX_COMPROBANTES_DIR")
    if base:
        p = Path(base)
    else:
        xdg = os.environ.get("XDG_DATA_HOME") or str(Path.home() / ".local" / "share")
        p = Path(xdg) / "no-phone" / "comprobantes"
    p.mkdir(parents=True, exist_ok=True)
    return p


def _en_lista_movimientos(d) -> bool:
    return (
        d(textStartsWith="Buscá por movimientos").exists(timeout=0)
        or d(textContains="Buscá por movimientos").exists(timeout=0)
        or "AccountsMovementsActivity" in ((d.app_current() or {}).get("activity") or "")
    )


def _recibo_pintado(d) -> bool:
    """Recibo listo para capturar: activity + título «Comprobante» (no framebuffer viejo).

    TransferReceiptActivity aparece *antes* de dibujar; un screenshot temprano
    sigue mostrando la lista de movimientos debajo.
    """
    if _en_lista_movimientos(d) or d(text="Ver comprobante").exists(timeout=0):
        return False
    act = (d.app_current() or {}).get("activity") or ""
    if "TransferReceiptActivity" not in act:
        return False
    return _tiene_label(d, "Comprobante")


def _tiene_label(d, label: str) -> bool:
    """True si el dump tiene el texto (más fiable que exists() tras scroll Compose)."""
    return any((n.get("text") or n.get("desc") or "") == label for n in _nodes(d))


def _abrir_movimientos_lista(d) -> list[dict]:
    """Abre AccountsMovementsActivity (lista 90 días), no el preview de Cuentas."""
    act0 = (d.app_current() or {}).get("activity") or ""
    if "AccountsMovementsActivity" in act0 or d(textStartsWith="Buscá por movimientos").exists(timeout=0):
        # La lista abierta puede estar scrolleada (o vieja): volver a Cuentas y reabrirla desde arriba.
        d.press("back")
        _wait_any(d, timeout=3.0, predicates=[lambda: "AccountsMovementsActivity" not in ((d.app_current() or {}).get("activity") or "")
                                              and not d(textStartsWith="Buscá por movimientos").exists(timeout=0)])
        # Se vuelve a Cuentas: esperar que pinte (si no, se re-navegaba entera desde Inicio). Queda scrolleada hasta
        # «Ver más» (de la vez anterior): eso también es estar en Cuentas.
        _wait_any(d, timeout=4.0, predicates=[lambda: d(text="Tus cuentas").exists(timeout=0) or d(text="Pesos").exists(timeout=0)
                                              or d(text="Ver más").exists(timeout=0)])
        act0 = (d.app_current() or {}).get("activity") or ""

    # Ya en Cuentas (p.ej. post-éxito) → no re-navegar desde Inicio
    if not (
        d(text="Tus cuentas").exists(timeout=0)
        or d(text="Pesos").exists(timeout=0)
        or d(text="Ver más").exists(timeout=0)
        or "AccountsHome" in act0
        or "accounts" in act0.lower()
    ):
        _ir_a_cuentas(d)
    # «Ver más» queda abajo de la pantalla: que el celu scrollee hasta él (UiScrollable, una sola RPC) en vez de
    # bajar un dump por cada intento. Si eso falla, el camino de antes.
    crudo = getattr(d, "_d", d)
    try:
        if not d(text="Ver más").exists(timeout=0):
            crudo(scrollable=True).scroll.to(text="Ver más")
            if hasattr(d, "invalidate"):
                d.invalidate()
    except Exception:
        pass
    for _ in range(5):
        if _tiene_label(d, "Ver más"):
            break
        _scroll(d, "up")
        _ui_sleep(0.22)
    if not _tiene_label(d, "Ver más"):
        raise FlowError("no encontré «Ver más» en Cuentas (¿lista de movimientos vacía?)")
    if not _click_label(d, "Ver más"):
        if d(text="Ver más").exists(timeout=0.5):
            d(text="Ver más").click()
        else:
            raise FlowError("vi «Ver más» en el dump pero no pude tapeárlo")
    # Esperar lista en vez de sleep fijo 2s
    _wait_any(
        d,
        timeout=4.0,
        interval=0.15,
        predicates=[
            lambda: d(textStartsWith="Buscá por movimientos").exists(timeout=0),
            lambda: "AccountsMovementsActivity" in ((d.app_current() or {}).get("activity") or ""),
        ],
    )
    act = (d.app_current() or {}).get("activity") or ""
    if "AccountsMovementsActivity" not in act:
        _dismiss_popups(d)  # algo tapa la lista (solo entonces: cuesta un dump)
        act = (d.app_current() or {}).get("activity") or ""
    if "AccountsMovementsActivity" not in act and not d(textStartsWith="Buscá por movimientos").exists(timeout=0):
        items_try = _parse_lista_movimientos(_nodes(d))
        if not items_try:
            raise FlowError(f"no abrí Movimientos (activity={act})")
    # La activity cambia antes de que carguen las filas (esqueleto): esperar filas, no solo la pantalla.
    items: list[dict] = []
    deadline = time.time() + 6.0
    while True:
        items = _parse_lista_movimientos(_nodes(d))
        if items or time.time() >= deadline:
            break
        _pause(0.3)
    if not items:
        raise FlowError("Movimientos abierto pero sin filas parseables")
    return items


def _filtrar_movimientos(
    items: list[dict],
    *,
    contraparte: str | None = None,
    monto: float | None = None,
    solo_enviadas: bool = True,
) -> list[dict]:
    cand = list(items)
    if solo_enviadas:
        enviadas = [i for i in cand if "enviada" in _norm(i.get("tipo") or "")]
        if enviadas:
            cand = enviadas
    if contraparte:
        q = _norm(contraparte)
        matched = [i for i in cand if q in _norm(i.get("contraparte") or "")]
        if not matched:
            return []
        cand = matched
    if monto is not None:
        # Lista muestra egresos negativos; el usuario suele decir el valor absoluto.
        target = abs(float(monto))
        matched = []
        for i in cand:
            m = i.get("monto")
            if m is None:
                continue
            if abs(abs(float(m)) - target) < 0.009:
                matched.append(i)
        cand = matched
    return cand


def _elegir_movimiento(
    items: list[dict],
    *,
    contraparte: str | None = None,
    monto: float | None = None,
    indice: int = 0,
    solo_enviadas: bool = True,
) -> dict:
    """Elige un ítem. indice=0 = más reciente del filtro."""
    cand = _filtrar_movimientos(
        items, contraparte=contraparte, monto=monto, solo_enviadas=solo_enviadas
    )
    if not cand:
        raise FlowError(
            "comprobante: ningún movimiento coincide "
            f"(contraparte={contraparte!r} monto={monto!r}; visibles={len(items)})"
        )
    if indice < 0 or indice >= len(cand):
        raise FlowError(
            f"comprobante: indice={indice} fuera de rango (hay {len(cand)} candidatos)"
        )
    return cand[indice]


def _esperar_detalle_movimiento(d, timeout: float = 8.0) -> None:
    deadline = time.time() + timeout
    while time.time() < deadline:
        if d(text="Ver comprobante").exists(timeout=0) or d(textStartsWith="N° de operación").exists(timeout=0):
            return
        act = (d.app_current() or {}).get("activity") or ""
        if "DynamicActions" in act and d(textContains="Transferencia").exists(timeout=0):
            return
        time.sleep(0.35)
    raise FlowError("timeout esperando detalle de movimiento (Ver comprobante)")


def _abrir_detalle_movimiento(d, item: dict) -> dict:
    """Tap de la fila (contraparte o tipo) y lee detalle."""
    name = item.get("contraparte")
    tipo = item.get("tipo")
    if name and d(text=name).exists(timeout=0):
        d(text=name).click()
    elif tipo and d(text=tipo).exists(timeout=0):
        d(text=tipo).click()
    else:
        raise FlowError(f"comprobante: no pude tapeár la fila {item!r}")
    _esperar_detalle_movimiento(d)
    _dismiss_popups(d, rounds=1)
    det = movimiento_detalle(d, ya_abierto=True)
    if not det.get("nro_operacion") and not det.get("transferido_a"):
        time.sleep(0.6)
        det = movimiento_detalle(d, ya_abierto=True)
    return det


def _abrir_pantalla_comprobante(d, on_step=None, boton: str = "Ver comprobante") -> None:
    """Desde detalle (o desde la pantalla de éxito, boton='Compartir comprobante'): → (chooser?) →
    TransferReceiptActivity *pintada*."""
    _emit(on_step, "Abriendo comprobante…", 2, 4)
    if not _click_label(d, boton):
        raise FlowError(f"no encontré «{boton}»")

    # A veces: Chooser encima. A veces: TransferReceiptActivity vacía y después chooser.
    # Nunca capturar en el primer frame de TransferReceiptActivity (framebuffer viejo).
    deadline = time.time() + 15
    saw_chooser = False
    while time.time() < deadline:
        act = (d.app_current() or {}).get("activity") or ""
        if "ChooserActivity" in act or _tiene_label(d, "Compartir Comprobante"):
            saw_chooser = True
            break
        if _recibo_pintado(d):
            return
        time.sleep(0.35)

    if saw_chooser:
        if d(text="Cancelar").exists(timeout=0):
            d(text="Cancelar").click()
        else:
            d.press("back")
        _ui_sleep(0.45)

    deadline = time.time() + 10
    while time.time() < deadline:
        if _recibo_pintado(d):
            _ui_sleep(0.35)
            if _recibo_pintado(d):
                return
        _ui_sleep(0.2)

    raise FlowError(
        "no llegó el recibo pintado (título Comprobante); "
        f"activity={(d.app_current() or {}).get('activity')} "
        f"texts={[t for t in _texts(d) if t][:12]}"
    )


def _nombre_coincide(esperado: str | None, visto: str | None) -> bool:
    if not esperado:
        return True
    if not visto:
        return False
    a, b = _norm(esperado), _norm(visto)
    return a in b or b in a


def _monto_coincide(esperado: float | None, visto: float | None, eps: float = 0.009) -> bool:
    if esperado is None:
        return True
    if visto is None:
        return False
    return abs(abs(float(visto)) - abs(float(esperado))) < eps


def _verificar_detalle_contra_huella(det: dict, huella: dict) -> tuple[bool, list[str]]:
    """Compara detalle abierto vs huella esperada. No adivina: lista mismatches."""
    mismatches: list[str] = []
    if huella.get("nro_operacion"):
        if str(det.get("nro_operacion") or "") != str(huella["nro_operacion"]):
            mismatches.append(
                f"nro_operacion: esperado {huella['nro_operacion']}, "
                f"vi {det.get('nro_operacion')}"
            )
    if huella.get("monto") is not None and not _monto_coincide(huella.get("monto"), det.get("monto")):
        mismatches.append(f"monto: esperado {huella.get('monto')}, vi {det.get('monto')}")
    nombre_esp = huella.get("contraparte") or huella.get("titular")
    nombre_visto = det.get("contraparte") or det.get("transferido_a") or det.get("transferido_por")
    if nombre_esp and not _nombre_coincide(nombre_esp, nombre_visto):
        mismatches.append(f"contraparte: esperado ≈ {nombre_esp!r}, vi {nombre_visto!r}")
    if huella.get("cvu_cbu"):
        cvu = det.get("cbu_cvu") or det.get("cbu_cvu_destino") or det.get("cbu_cvu_origen")
        if cvu and str(cvu) != str(huella["cvu_cbu"]):
            mismatches.append(f"cvu: esperado {huella['cvu_cbu']}, vi {cvu}")
    return (len(mismatches) == 0, mismatches)


def _hora_del_detalle(det: dict) -> tuple[int, int] | None:
    """(día, minuto del día) de «21/OCT/2026 - 01:29 h»."""
    m = re.search(r"(\d{1,2})/\w+/\d{4}\D+(\d{1,2}):(\d{2})", det.get("fecha_hora") or "")
    return (int(m.group(1)), int(m.group(2)) * 60 + int(m.group(3))) if m else None


def _elegir_por_hora(d, items: list[dict], ts: float, tolerancia_min: int = 3) -> tuple[dict | None, list[str | None]]:
    """Abre el detalle de cada ítem (más nuevo primero) hasta dar con el de la hora `ts`. Devuelve
    (detalle abierto o None, horas vistas «HH:MM»). Si no encuentra, vuelve a la lista."""
    t = time.localtime(ts)
    dia, minuto = t.tm_mday, t.tm_hour * 60 + t.tm_min
    horas: list[str | None] = []
    for item in items:
        det = _abrir_detalle_movimiento(d, item)
        h = _hora_del_detalle(det)
        horas.append(f"{h[1] // 60:02d}:{h[1] % 60:02d}" if h else None)
        if h and h[0] == dia and abs(h[1] - minuto) <= tolerancia_min:
            return det, horas
        d.press("back")
        time.sleep(0.7)
    return None, horas


def _indexar_candidatos(cand: list[dict]) -> list[dict]:
    out = []
    for i, c in enumerate(cand):
        row = dict(c)
        row["indice"] = i
        out.append(row)
    return out


_RUIDO_RECIBO = {"Compartir", "Compartir comprobante", "Compartir Comprobante", "Descargar", "Volver", "Atrás",
                 "Navegar hacia arriba", "Cerrar"}


def _render_comprobante(textos: list[str], path: Path) -> None:
    """PNG del comprobante armado con los textos que muestra Naranja X (camino APK, sin captura de pantalla).
    Dice explícitamente que es una transcripción, para que nadie lo tome por la imagen original del banco."""
    from PIL import Image, ImageDraw, ImageFont

    lineas = []
    for t in textos:
        t = " ".join(str(t).split())
        if t and t not in _RUIDO_RECIBO and t not in lineas:
            lineas.append(t)

    def fuente(tam: int, negrita: bool = False):
        for f in (("DejaVuSans-Bold.ttf" if negrita else "DejaVuSans.ttf"),
                  "/usr/share/fonts/truetype/dejavu/" + ("DejaVuSans-Bold.ttf" if negrita else "DejaVuSans.ttf")):
            try:
                return ImageFont.truetype(f, tam)
            except OSError:
                continue
        return ImageFont.load_default()

    ancho, margen = 900, 48
    f_tit, f_txt, f_pie = fuente(40, True), fuente(30), fuente(22)
    import textwrap
    filas: list[tuple[str, object]] = [("Comprobante de transferencia", f_tit), ("Naranja X", f_txt), ("", f_txt)]
    for t in lineas:
        for parte in textwrap.wrap(t, 48) or [""]:
            filas.append((parte, f_txt))
    filas += [("", f_txt), ("Transcripción de la pantalla de Naranja X hecha por no-phone", f_pie),
              (time.strftime("%d/%m/%Y %H:%M"), f_pie)]
    alto = margen * 2 + sum(52 if f is f_tit else (34 if f is f_pie else 44) for _, f in filas)
    img = Image.new("RGB", (ancho, alto), "white")
    dib = ImageDraw.Draw(img)
    dib.rectangle([0, 0, ancho, 16], fill=(255, 102, 0))
    y = margen
    for txt, f in filas:
        dib.text((margen, y), txt, fill=(20, 20, 20) if f is not f_pie else (110, 110, 110), font=f)
        y += 52 if f is f_tit else (34 if f is f_pie else 44)
    img.save(path, "PNG")


def _capturar_png_recibo(d, det: dict, on_step=None, ya_abierto: bool = False) -> dict:
    """Desde detalle ya abierto y verificado: Ver comprobante → PNG. ya_abierto=True: el recibo ya está en pantalla."""
    if not ya_abierto:
        _abrir_pantalla_comprobante(d, on_step=on_step)
    _emit(on_step, "Guardando PNG en el host…", 3, 4)
    for _ in range(4):
        act = (d.app_current() or {}).get("activity") or ""
        if "ChooserActivity" in act or _tiene_label(d, "Compartir Comprobante"):
            if d(text="Cancelar").exists(timeout=0):
                d(text="Cancelar").click()
            else:
                d.press("back")
            _ui_sleep(0.5)
            continue
        if _recibo_pintado(d):
            break
        _ui_sleep(0.22)
    else:
        raise FlowError(
            f"no estoy en el recibo pintado al capturar "
            f"(activity={(d.app_current() or {}).get('activity')})"
        )
    if _en_lista_movimientos(d):
        raise FlowError("iba a capturar la lista de Movimientos en vez del comprobante")

    nro = det.get("nro_operacion") or "sin_nro"
    stamp = time.strftime("%Y%m%d_%H%M%S")
    path = _comprobantes_dir() / f"{stamp}_{nro}.png"
    transcripto = False
    if _es_apk(d):
        # La APK no puede capturar la pantalla en Android 10: el comprobante se arma con los textos del recibo.
        textos = [t for t in _texts(d) if t and t != "***"]
        _render_comprobante(textos, path)
        transcripto = True
    else:
        d.screenshot(str(path))
    size = path.stat().st_size if path.is_file() else 0
    if not transcripto and size < 80_000:
        path.unlink(missing_ok=True)
        raise FlowError(
            f"screenshot sospechoso ({size} bytes): parece que el recibo no terminó de pintar. Reintentá."
        )
    _emit(on_step, "Listo", 4, 4)
    d.press("back")
    _ui_sleep(0.25)
    d.press("back")
    _ui_sleep(0.18)
    if det.get("nro_operacion"):
        actualizar_last_enviada(nro_operacion=str(det["nro_operacion"]))
    return {
        "estado": "ok",
        "archivo": str(path.resolve()),
        "bytes": size,
        "transcripto": transcripto,
        "detalle": det,
        "huella_usada": cargar_last_enviada(),
        "mensaje": (
            f"Comprobante guardado ({path.name}, {size} bytes). "
            "Para mandarlo: wa_enviar_preview(destino, archivo=esta_ruta) → wa_enviar."
        ),
        "siguiente": "wa_enviar_preview → wa_enviar (MCP whatsapp).",
    }


def comprobante_buscar(
    d,
    contraparte: str | None = None,
    monto: float | None = None,
    limite: int = 8,
    on_step=None,
) -> dict:
    """Lista candidatas (enviadas) para que el usuario confirme cuál abrir.

    Soft estado: `candidatos` + `pregunta`. No abre detalle ni guarda PNG.
    """
    _emit(on_step, "Listando movimientos…", 1, 1)
    items = _abrir_movimientos_lista(d)
    cand = _filtrar_movimientos(items, contraparte=contraparte, monto=monto, solo_enviadas=True)
    cand = _indexar_candidatos(cand[: max(1, min(int(limite), 20))])
    if not cand:
        return {
            "estado": "sin_candidatos",
            "candidatos": [],
            "filtros": {"contraparte": contraparte, "monto": monto},
            "mensaje": "No encontré transferencias enviadas con esos filtros. Probá otro nombre/monto.",
            "siguiente": "Pedile otros filtros o nx_movimientos.",
        }
    top = cand[0]
    return {
        "estado": "candidatos",
        "candidatos": cand,
        "filtros": {"contraparte": contraparte, "monto": monto},
        "pregunta": (
            f"¿Es esta? [{top['indice']}] {top.get('fecha')} · {top.get('contraparte')} · "
            f"{top.get('monto_raw')} — o decime otro índice / filtros."
        ),
        "mensaje": f"{len(cand)} candidata(s). Confirmá índice (0=más reciente del filtro).",
        "siguiente": "nx_comprobante_guardar(indice=N, contraparte=…, monto=…) → archivo PNG.",
    }


def comprobante_guardar(
    d,
    contraparte: str | None = None,
    nro_operacion: str | None = None,
    monto: float | None = None,
    indice: int = 0,
    recien: bool = False,
    on_step=None,
) -> dict:
    """Nodo NX: abre el comprobante de una enviada y guarda PNG en el host.

    recien=True: usa huella de la última nx_transfer OK. Si hay varias filas que
    matchean monto+nombre y aún no tenemos nro_operacion → estado=ambiguo (no adivina).
    Tras abrir detalle, verifica huella; si no coincide → estado=no_coincide.
    """
    _emit(on_step, "Buscando movimiento…", 1, 4)
    huella_esperada: dict | None = None

    if recien:
        huella_esperada = cargar_last_enviada()
        if not huella_esperada:
            return {
                "estado": "sin_huella",
                "mensaje": (
                    "No hay huella de una transferencia reciente (o venció >30 min). "
                    "Pasá contraparte/monto/nro_operacion o volvé a transferir."
                ),
                "siguiente": "nx_comprobante_buscar o nx_comprobante_guardar con filtros explícitos.",
            }
        contraparte = contraparte or huella_esperada.get("contraparte") or huella_esperada.get("titular")
        if monto is None:
            monto = huella_esperada.get("monto")
        if not nro_operacion:
            nro_operacion = huella_esperada.get("nro_operacion")

    # Huella explícita también desde args (sin recien)
    if huella_esperada is None and (contraparte or monto is not None or nro_operacion):
        huella_esperada = {
            "contraparte": contraparte,
            "monto": abs(float(monto)) if monto is not None else None,
            "nro_operacion": nro_operacion,
        }

    items = _abrir_movimientos_lista(d)
    enviadas = _filtrar_movimientos(
        items, contraparte=contraparte, monto=monto, solo_enviadas=True
    )

    # --- resolución segura ---
    det = None
    if nro_operacion:
        pool = enviadas or [i for i in items if "enviada" in _norm(i.get("tipo") or "")]
        if not pool:
            raise FlowError("comprobante: no hay transferencias enviadas en la lista")
        for item in pool[:12]:
            cand_det = _abrir_detalle_movimiento(d, item)
            if str(cand_det.get("nro_operacion") or "") == str(nro_operacion):
                det = cand_det
                break
            d.press("back")
            time.sleep(0.7)
        if det is None:
            return {
                "estado": "no_coincide",
                "esperado": huella_esperada,
                "mensaje": f"No encontré N° de operación {nro_operacion} en las enviadas visibles.",
                "siguiente": "nx_comprobante_buscar o revisá Movimientos a mano.",
            }
    else:
        if not enviadas:
            raise FlowError(
                "comprobante: ningún movimiento coincide "
                f"(contraparte={contraparte!r} monto={monto!r})"
            )
        # recien sin nro y varias filas iguales (mismo monto y nombre): la que se acaba de hacer es la que tiene
        # la hora de la huella. Se abren de la más nueva a la más vieja; si ninguna coincide, NO adivinar.
        if recien and len(enviadas) > 1 and huella_esperada.get("ts"):
            det, horas = _elegir_por_hora(d, enviadas[:4], float(huella_esperada["ts"]))
            if det is None:
                cand = _indexar_candidatos(enviadas[: len(horas)])
                for c, h in zip(cand, horas):
                    c["hora"] = h
                lista = " y ".join(h or "?" for h in horas)
                return {
                    "estado": "ambiguo",
                    "candidatos": cand,
                    "esperado": huella_esperada,
                    "pregunta": f"Hay {len(cand)} transferencias {f'de ${monto:g} ' if monto is not None else ''}a {contraparte}: a las {lista}. ¿Cuál mando?",
                    "mensaje": "Ninguna coincide con la hora de la transferencia recién hecha.",
                    "siguiente": "Mostrá `pregunta` (con las horas, nunca índices) y con la respuesta "
                                 "nx_comprobante_guardar(recien=true, indice=N) según la hora elegida.",
                }
        elif recien and len(enviadas) > 1:
            cand = _indexar_candidatos(enviadas[:12])
            return {
                "estado": "ambiguo",
                "candidatos": cand,
                "esperado": huella_esperada,
                "pregunta": f"Hay {len(cand)} transferencias {f'de ${monto:g} ' if monto is not None else ''}a {contraparte} hoy. ¿Cuál mando?",
                "mensaje": "Ambiguo: confirmá cuál antes de guardar el PNG.",
                "siguiente": "Preguntá sin mostrar índices; después nx_comprobante_guardar(recien=true, indice=N).",
            }
        # indice explícito sobre el filtro (o 0 si una sola / no-recien)
        if int(indice) < 0 or int(indice) >= len(enviadas):
            return {
                "estado": "ambiguo",
                "candidatos": _indexar_candidatos(enviadas[:12]),
                "esperado": huella_esperada,
                "mensaje": f"indice={indice} fuera de rango ({len(enviadas)} candidatas).",
                "pregunta": "¿Qué índice usamos?",
                "siguiente": "nx_comprobante_guardar(…, indice=N)",
            }
        # Si no es recien y hay varias y el caller dejó indice=0 sin más filtros fuertes:
        # seguir (comportamiento previo), pero si recien ya manejamos ambiguo arriba.
        if det is None:
            item = enviadas[int(indice)]
            det = _abrir_detalle_movimiento(d, item)

    if not det.get("nro_operacion") and not det.get("transferido_a") and not det.get("contraparte"):
        raise FlowError(
            "comprobante: el detalle no tiene datos (¿pantalla equivocada?). "
            f"titulo={det.get('titulo')!r}"
        )

    if huella_esperada:
        ok_h, mismatches = _verificar_detalle_contra_huella(det, huella_esperada)
        if not ok_h:
            d.press("back")
            time.sleep(0.4)
            return {
                "estado": "no_coincide",
                "esperado": huella_esperada,
                "detalle": det,
                "mismatches": mismatches,
                "mensaje": (
                    "El detalle abierto NO coincide con la huella esperada. "
                    "No guardé PNG. " + "; ".join(mismatches)
                ),
                "siguiente": "nx_comprobante_buscar / pasar nro_operacion / revisar Movimientos.",
            }

    return _capturar_png_recibo(d, det, on_step=on_step)


def origen_recibida(
    d,
    monto: float | None = None,
    contraparte: str | None = None,
    nro_operacion: str | None = None,
    indice: int | None = None,
    limite: int = 8,
    on_step=None,
) -> dict:
    """Origen (CVU/titular) de una transferencia *recibida* — para devolver.

    Si hay varias candidatas y no pasás indice/nro → estado=ambiguo (no adivina).
    Al abrir el detalle verifica monto/nombre/nro antes de devolver el CVU.
    """
    _emit(on_step, "Buscando recibida…", 1, 2)
    items = _abrir_movimientos_lista(d)
    recibidas = [i for i in items if "recibida" in _norm(i.get("tipo") or "")]
    cand = recibidas
    if contraparte:
        q = _norm(contraparte)
        cand = [i for i in cand if q in _norm(i.get("contraparte") or "")]
    if monto is not None:
        cand = [
            i
            for i in cand
            if i.get("monto") is not None and _monto_coincide(monto, i.get("monto"))
        ]
    cand = _indexar_candidatos(cand[: max(1, min(int(limite), 20))])

    if not cand:
        return {
            "estado": "sin_candidatos",
            "candidatos": [],
            "filtros": {"contraparte": contraparte, "monto": monto, "nro_operacion": nro_operacion},
            "mensaje": "No hay transferencias recibidas con esos filtros.",
            "siguiente": "Ampliá filtros o nx_movimientos.",
        }

    esperado = {
        "contraparte": contraparte,
        "monto": abs(float(monto)) if monto is not None else None,
        "nro_operacion": nro_operacion,
    }

    if nro_operacion:
        det = None
        for item in cand:
            det = _abrir_detalle_movimiento(d, item)
            if str(det.get("nro_operacion") or "") == str(nro_operacion):
                break
            d.press("back")
            time.sleep(0.7)
            det = None
        if det is None:
            # también probar recibidas sin filtro de nombre por si el parse truncó
            for item in recibidas[:10]:
                det = _abrir_detalle_movimiento(d, item)
                if str(det.get("nro_operacion") or "") == str(nro_operacion):
                    break
                d.press("back")
                time.sleep(0.7)
                det = None
        if det is None:
            return {
                "estado": "no_coincide",
                "esperado": esperado,
                "mensaje": f"No encontré recibida con N° {nro_operacion}.",
                "siguiente": "nx_movimientos o otro nro.",
            }
    else:
        if len(cand) > 1 and indice is None:
            top = cand[0]
            return {
                "estado": "ambiguo",
                "candidatos": cand,
                "filtros": esperado,
                "pregunta": (
                    f"Hay {len(cand)} recibidas. ¿Es [{top['indice']}] "
                    f"{top.get('fecha')} · {top.get('contraparte')} · {top.get('monto_raw')}? "
                    "Decime índice; no tomo una a ciegas."
                ),
                "mensaje": "Ambiguo: confirmá cuál recibida usar como origen.",
                "siguiente": "nx_origen_recibida(…, indice=N) o nro_operacion=…",
            }
        idx = 0 if indice is None else int(indice)
        if idx < 0 or idx >= len(cand):
            return {
                "estado": "ambiguo",
                "candidatos": cand,
                "mensaje": f"indice={idx} fuera de rango.",
                "pregunta": "¿Qué índice?",
                "siguiente": "nx_origen_recibida(…, indice=N)",
            }
        det = _abrir_detalle_movimiento(d, cand[idx])

    ok_h, mismatches = _verificar_detalle_contra_huella(det, esperado)
    # esperado puede tener campos None: _verificar ya los ignora
    if not ok_h:
        d.press("back")
        time.sleep(0.3)
        return {
            "estado": "no_coincide",
            "esperado": esperado,
            "detalle": det,
            "mismatches": mismatches,
            "mensaje": "El detalle no matchea los filtros. " + "; ".join(mismatches),
            "siguiente": "Otro indice/filtros.",
        }

    cvu = det.get("cbu_cvu") or det.get("cbu_cvu_origen")
    if not cvu:
        d.press("back")
        return {
            "estado": "no_coincide",
            "detalle": det,
            "mensaje": "Abrí la recibida pero no vi CBU/CVU de origen en el detalle.",
            "siguiente": "Revisá a mano o nx_movimientos(detalle).",
        }

    _emit(on_step, "Origen OK", 2, 2)
    # dejar en lista (no en detalle) para el siguiente destino_resolver
    d.press("back")
    time.sleep(0.3)

    origen = {
        "titular": det.get("transferido_por") or det.get("contraparte"),
        "entidad": det.get("entidad_origen") or det.get("entidad"),
        "cbu_cvu": cvu,
        "cuit_cuil": det.get("cuit_cuil_origen") or det.get("cuit_cuil"),
        "nro_operacion": det.get("nro_operacion"),
        "monto": det.get("monto"),
        "fecha_hora": det.get("fecha_hora"),
    }
    return {
        "estado": "origen_resuelto",
        "origen": origen,
        "detalle": det,
        "pregunta": (
            f"¿Devolvemos a {origen.get('titular')} — {origen.get('entidad')} "
            f"(CVU …{str(cvu)[-4:]})?"
        ),
        "mensaje": (
            f"Origen de la recibida: {origen.get('titular')} · {origen.get('entidad')} · "
            f"CVU {cvu}. Nada transferido."
        ),
        "siguiente": "Si confirma → nx_destino_resolver(origen.cbu_cvu) → armar → transfer.",
    }
