"""Perfiles de teléfonos para no-phone (Redmi, Moto, …).

Archivo: ~/.config/no-phone/phones.json (override NX_PHONES_FILE).
Activo: campo `activo` o env NX_PHONE=<id>.

Cada perfil:
  id, label, serial, pin_env (nombre de var en .env, default NX_PIN)
  opcionales (los escribe la consola web, admin/): kind, adb_server (host:puerto),
  ui_mode (fast|normal|safe), hw {fabricante, modelo, android, resolucion}

Es el ÚNICO registro de celulares: lo usan el MCP naranjax, la API y la consola.

PIN: primero el archivo de secretos del perfil (<NX_PHONE_SECRETS_DIR>/<id>.env,
600, lo escribe la consola; clave = pin_env), después la env `pin_env`, después NX_PIN.
"""
from __future__ import annotations

import json
import os
import re
import subprocess
from pathlib import Path
from typing import Any

_CONFIG_DIR = Path(os.environ.get("XDG_CONFIG_HOME") or Path.home() / ".config") / "no-phone"
_DEFAULT_FILE = _CONFIG_DIR / "phones.json"

# Estado en proceso (tras nx_phone_usar); None = usar archivo/env
_override_activo: str | None = None


def secrets_dir() -> Path:
    raw = os.environ.get("NX_PHONE_SECRETS_DIR")
    return Path(raw) if raw else _CONFIG_DIR / "devices"


def _secret_file(perfil_id: str) -> dict[str, str]:
    path = secrets_dir() / f"{perfil_id}.env"
    out: dict[str, str] = {}
    try:
        for line in path.read_text(encoding="utf-8").splitlines():
            if "=" in line and not line.lstrip().startswith("#"):
                k, v = line.split("=", 1)
                out[k.strip()] = v.strip()
    except OSError:
        pass
    return out


def pin_de(perfil: dict[str, Any]) -> str:
    """PIN de un perfil: archivo de secretos > env pin_env > NX_PIN."""
    key = str(perfil.get("pin_env") or "NX_PIN")
    pid = str(perfil.get("id") or "")
    if pid:
        v = _secret_file(pid).get(key)
        if v:
            return v
    return os.environ.get(key, "") or os.environ.get("NX_PIN", "")


def phones_path() -> Path:
    raw = os.environ.get("NX_PHONES_FILE")
    return Path(raw) if raw else _DEFAULT_FILE


def _seed_from_env() -> dict[str, Any]:
    serial = (os.environ.get("ANDROID_SERIAL") or "").strip() or "CHANGEME"
    return {
        "activo": "redmi7" if serial != "CHANGEME" else "default",
        "perfiles": {
            "redmi7": {
                "label": "Redmi 7",
                "serial": serial if serial != "CHANGEME" else "TU_SERIAL",
                "pin_env": "NX_PIN",
                "notas": "Perfil por defecto (Omarchy)",
            },
            "moto_g5": {
                "label": "Moto G5 Plus",
                "serial": "",
                "pin_env": "NX_PIN_MOTO",
                "notas": "Completá serial tras adb devices; PIN en .env como NX_PIN_MOTO",
            },
        },
    }


def load() -> dict[str, Any]:
    path = phones_path()
    if not path.is_file():
        data = _seed_from_env()
        save(data)
        return data
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        data = _seed_from_env()
        save(data)
        return data
    if not isinstance(data, dict):
        data = _seed_from_env()
    data.setdefault("perfiles", {})
    data.setdefault("activo", next(iter(data["perfiles"]), "default"))
    return data


def save(data: dict[str, Any]) -> None:
    path = phones_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    try:
        path.chmod(0o600)
    except OSError:
        pass


def list_perfiles() -> list[dict[str, Any]]:
    data = load()
    activo = activo_id()
    out = []
    for pid, p in (data.get("perfiles") or {}).items():
        if not isinstance(p, dict):
            continue
        row = {
            "id": pid,
            "label": p.get("label") or pid,
            "serial": (p.get("serial") or "").strip(),
            "pin_env": p.get("pin_env") or "NX_PIN",
            "activo": pid == activo,
            "notas": p.get("notas"),
            "adb_server": p.get("adb_server"),
            "ui_mode": p.get("ui_mode"),
        }
        out.append(row)
    return out


def activo_id() -> str:
    if _override_activo:
        return _override_activo
    env = (os.environ.get("NX_PHONE") or "").strip()
    if env:
        return env
    return str(load().get("activo") or "redmi7")


def get_perfil(perfil_id: str | None = None) -> dict[str, Any]:
    pid = (perfil_id or activo_id()).strip()
    data = load()
    perfiles = data.get("perfiles") or {}
    p = perfiles.get(pid)
    if not isinstance(p, dict):
        # fallback: ANDROID_SERIAL crudo como perfil sintético
        serial = (os.environ.get("ANDROID_SERIAL") or "").strip()
        if serial:
            return {
                "id": "env",
                "label": "ANDROID_SERIAL",
                "serial": serial,
                "pin_env": "NX_PIN",
                "activo": True,
            }
        raise KeyError(f"perfil desconocido: {pid!r}. nx_phones para listar.")
    return {
        "id": pid,
        "label": p.get("label") or pid,
        "serial": (p.get("serial") or "").strip(),
        "pin_env": p.get("pin_env") or "NX_PIN",
        "notas": p.get("notas"),
        "adb_server": (p.get("adb_server") or "").strip() or None,
        "ui_mode": p.get("ui_mode"),
        "activo": pid == activo_id(),
    }


def _aplicar_adb_server(p: dict[str, Any]) -> None:
    """Si el perfil vive detrás de un adb server remoto, apuntar adbutils/u2 ahí."""
    hp = p.get("adb_server")
    if hp and ":" in hp and not os.environ.get("ANDROID_ADB_SERVER_HOST"):
        host, port = hp.rsplit(":", 1)
        os.environ["ANDROID_ADB_SERVER_HOST"] = host
        os.environ["ANDROID_ADB_SERVER_PORT"] = port


def _cliente_adb(p: dict[str, Any] | None):
    """adb server del perfil (`adb_server`) aunque haya uno global: en el VPS el global es el puente de casa
    (agente-adb) y un celu por túnel (Xiaomi 12T) vive en otro adb server. Sin `adb_server`, el global."""
    import adbutils

    hp = (p or {}).get("adb_server")
    if hp and ":" in hp:
        host, port = hp.rsplit(":", 1)
        return adbutils.AdbClient(host=host, port=int(port))
    return adbutils.adb


def _perfil_de_serial(serial: str | None) -> dict[str, Any] | None:
    if not serial:
        return None
    for pid, p in (load().get("perfiles") or {}).items():
        if isinstance(p, dict) and (p.get("serial") or "").strip() == serial:
            return get_perfil(pid)
    return None


_serial_cache: tuple[float, str, str] | None = None  # (cuando, configurado, real)


def _serial_vivo(serial: str, p: dict[str, Any]) -> str:
    """Si el serial del perfil es una IP vieja (el celu cambió de WiFi) y adb tiene enchufado UN celu del mismo
    modelo, usar ese. Así un cambio de red no deja al secretario sin celu. Cache 30 s (adb devices ~0,1 s)."""
    global _serial_cache
    import time as _t

    if _serial_cache and _serial_cache[1] == serial and _t.time() - _serial_cache[0] < 30:
        return _serial_cache[2]
    real = serial
    try:
        devs = [d for d in _cliente_adb(p).device_list()]
        if serial not in {d.serial for d in devs}:
            modelo = ((p.get("hw") or {}).get("modelo") or "").replace(" ", "_").lower()
            candidatos = []
            for d in devs:
                try:
                    m = (d.prop.model or "").replace(" ", "_").lower()
                except Exception:
                    m = ""
                if not modelo or m == modelo:
                    candidatos.append(d.serial)
            # preferir el que dice ADB_CONNECT (WiFi) para no pelear con el USB de otra máquina
            pref = (os.environ.get("ADB_CONNECT") or "").strip()
            if pref in candidatos:
                real = pref
            elif len(candidatos) == 1:
                real = candidatos[0]
    except Exception:
        pass
    _serial_cache = (_t.time(), serial, real)
    return real


def serial_activo() -> str | None:
    """Serial del perfil activo, o ANDROID_SERIAL, o None (u2 elige el único)."""
    try:
        p = get_perfil()
        _aplicar_adb_server(p)
        if p.get("serial"):
            if str(p["serial"]).startswith("apk:"):
                return str(p["serial"])  # celu por la APK de no-phone (hub de agentes), no por adb
            return _serial_vivo(str(p["serial"]), p)
    except KeyError:
        pass
    return (os.environ.get("ANDROID_SERIAL") or "").strip() or None


def conectar(serial: str | None):
    """Device para un serial: «apk:<id>» → APK de no-phone vía hub de agentes; si no, uiautomator2 por adb.
    Es el único lugar donde se elige el transporte: API, MCP y scripts pasan por acá."""
    if serial and serial.startswith("apk:"):
        import apkdev

        return apkdev.ApkDevice(serial[4:])
    import uiautomator2 as u2

    p = _perfil_de_serial(serial) if serial else None
    if p and p.get("adb_server"):
        return u2.connect(_cliente_adb(p).device(serial))
    return u2.connect(serial)


def pin_activo() -> str:
    """PIN Naranja X del perfil activo (ver pin_de)."""
    try:
        return pin_de(get_perfil())
    except KeyError:
        return os.environ.get("NX_PIN", "")


def pin_desbloqueo_activo() -> str:
    """PIN de la pantalla de bloqueo del perfil activo (DEVICE_PIN en su archivo de secretos; lo carga la consola)."""
    try:
        p = get_perfil()
    except KeyError:
        return ""
    return _secret_file(str(p.get("id") or "")).get("DEVICE_PIN", "") if p.get("id") else ""


def ui_mode_activo() -> str | None:
    """Modo de UI del perfil activo (fast|normal|safe), si lo tiene."""
    try:
        m = get_perfil().get("ui_mode")
    except KeyError:
        return None
    return str(m) if m in ("fast", "normal", "safe") else None


def set_activo(perfil_id: str, *, persist: bool = True) -> dict[str, Any]:
    global _override_activo
    pid = perfil_id.strip()
    data = load()
    if pid not in (data.get("perfiles") or {}):
        raise KeyError(f"perfil desconocido: {pid!r}")
    p = get_perfil(pid)
    if not p.get("serial"):
        raise ValueError(
            f"perfil {pid!r} sin serial. Completá serial en {phones_path()} "
            "después de `adb devices`."
        )
    _override_activo = pid
    if persist:
        data["activo"] = pid
        save(data)
    # Exponer serial al resto del proceso (adb, u2)
    os.environ["ANDROID_SERIAL"] = str(p["serial"])
    _aplicar_adb_server(p)
    return get_perfil(pid)


def upsert_perfil(
    perfil_id: str,
    *,
    label: str | None = None,
    serial: str | None = None,
    pin_env: str | None = None,
    notas: str | None = None,
) -> dict[str, Any]:
    data = load()
    perfiles = data.setdefault("perfiles", {})
    cur = dict(perfiles.get(perfil_id) or {})
    if label is not None:
        cur["label"] = label
    if serial is not None:
        cur["serial"] = serial.strip()
    if pin_env is not None:
        cur["pin_env"] = pin_env.strip() or "NX_PIN"
    if notas is not None:
        cur["notas"] = notas
    cur.setdefault("label", perfil_id)
    cur.setdefault("serial", "")
    cur.setdefault("pin_env", "NX_PIN")
    perfiles[perfil_id] = cur
    save(data)
    return get_perfil(perfil_id)


def adb_devices() -> list[dict[str, str]]:
    """Lista `adb devices` → [{serial, estado}]."""
    try:
        out = subprocess.check_output(
            ["adb", "devices"], text=True, stderr=subprocess.DEVNULL, timeout=8
        )
    except (OSError, subprocess.SubprocessError):
        return []
    rows = []
    for line in out.splitlines()[1:]:
        line = line.strip()
        if not line:
            continue
        parts = line.split()
        if len(parts) >= 2:
            rows.append({"serial": parts[0], "estado": parts[1]})
    return rows


def enrich_con_adb(perfiles: list[dict[str, Any]] | None = None) -> dict[str, Any]:
    """Junta perfiles + adb para que el agente vea qué está enchufado."""
    perfiles = perfiles if perfiles is not None else list_perfiles()
    devices = adb_devices()
    by_serial = {d["serial"]: d["estado"] for d in devices}
    for p in perfiles:
        s = p.get("serial") or ""
        p["adb"] = by_serial.get(s, "no_conectado")
        p["pin_configurado"] = bool(pin_de(p))
    # devices sin perfil
    known = {p.get("serial") for p in perfiles if p.get("serial")}
    huerfanos = [d for d in devices if d["serial"] not in known]
    return {
        "activo": activo_id(),
        "archivo": str(phones_path()),
        "perfiles": perfiles,
        "adb_devices": devices,
        "sin_perfil": huerfanos,
        "serial_en_uso": serial_activo(),
    }


def lock_suffix(serial: str | None = None) -> str:
    """Sufijo seguro para archivo de lock por aparato."""
    s = (serial or serial_activo() or "default").strip()
    return re.sub(r"[^\w.-]+", "_", s)[:80]
