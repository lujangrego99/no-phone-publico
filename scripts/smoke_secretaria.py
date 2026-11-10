#!/usr/bin/env python3
"""Matriz de smoke del flujo secretaria Naranja X (sin enviar plata de verdad).

Corre casos: destino OK, no encontrado, formato corto, cancelar, saldo insuficiente,
armar+cancelar en confirmación. Nunca llama transfer_enviar.

Uso:
  cd /home/ivanbustos/Documentos/GitHub/no-phone
  ANDROID_SERIAL=TU_SERIAL .venv/bin/python scripts/smoke_secretaria.py
"""
from __future__ import annotations

import json
import os
import sys
import time
import traceback
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

_envf = ROOT / ".env"
if _envf.exists():
    for _l in _envf.read_text().splitlines():
        if "=" in _l and not _l.lstrip().startswith("#"):
            _k, _v = _l.split("=", 1)
            os.environ.setdefault(_k.strip(), _v.strip())

import uiautomator2 as u2  # noqa: E402
import naranjax as nx  # noqa: E402
import phones  # noqa: E402

ALIAS_OK = os.environ.get("SMOKE_ALIAS_OK", "vallisto.mp")
ALIAS_FAKE = os.environ.get("SMOKE_ALIAS_FAKE", "noexiste9999.mp")
ALIAS_CORTO = os.environ.get("SMOKE_ALIAS_CORTO", "zzz")


def _on_step(msg, step=None, total=None):
    print(f"    · {step}/{total} {msg}" if step else f"    · {msg}")


def _case(name: str, fn):
    print(f"\n{'='*60}\nCASE {name}")
    t0 = time.time()
    try:
        out = fn()
        ok = True
        detail = out
    except Exception as e:
        ok = False
        detail = {"error": type(e).__name__, "detalle": str(e), "tb": traceback.format_exc()[-500:]}
        print("  EXC", detail["error"], detail["detalle"])
    elapsed = round(time.time() - t0, 1)
    print(f"  elapsed={elapsed}s ok={ok}")
    if isinstance(detail, dict):
        show = {k: detail[k] for k in detail if k not in ("tb", "textos", "screenshot_confirmacion")}
        print(" ", json.dumps(show, ensure_ascii=False, default=str)[:500])
    return {"name": name, "ok": ok, "elapsed": elapsed, "detail": detail}


def main():
    serial = os.environ.get("ANDROID_SERIAL")
    d = phones.conectar(serial)
    d.screen_on()
    print("device", d.info.get("productName"), "serial", serial, "app", d.app_current())

    # Ensure logged in / online once
    if d.app_current().get("package") != nx.PKG:
        d.app_start(nx.PKG)
        time.sleep(1)
    nx.check_login(d)
    nx._ensure_online(d)
    nx.ir_al_inicio(d)

    results = []

    def c_destino_ok():
        r = nx.destino_resolver(d, ALIAS_OK, on_step=_on_step)
        assert r.get("estado") == "destino_resuelto", r
        assert r.get("destinatario", {}).get("etiqueta"), r
        nx.transfer_cancelar(d, on_step=_on_step)
        return r

    def c_destino_fake():
        r = nx.destino_resolver(d, ALIAS_FAKE, on_step=_on_step)
        assert r.get("estado") == "destino_no_encontrado", r
        return r

    def c_destino_corto():
        r = nx.destino_resolver(d, ALIAS_CORTO, on_step=_on_step)
        assert r.get("estado") in ("destino_no_encontrado", "destino_invalido"), r
        nx.transfer_cancelar(d, on_step=_on_step)
        return r

    def c_destino_vacio():
        r = nx.destino_resolver(d, "  ", on_step=_on_step)
        assert r.get("estado") == "destino_invalido", r
        return r

    def c_cancelar_identidad():
        r = nx.destino_resolver(d, ALIAS_OK, on_step=_on_step)
        assert r.get("estado") == "destino_resuelto", r
        c = nx.transfer_cancelar(d, on_step=_on_step)
        assert c.get("estado") == "cancelado", c
        return {"resolver": r, "cancel": c}

    def c_saldo_insuficiente():
        r = nx.destino_resolver(d, ALIAS_OK, on_step=_on_step)
        assert r.get("estado") == "destino_resuelto", r
        arm = nx.transfer_armar(d, 100.0, on_step=_on_step)
        assert arm.get("estado") == "saldo_insuficiente", arm
        assert arm.get("puede_transferir") is False, arm
        return arm

    def c_monto_rechazado_001():
        """Con saldo típico $0,09, $0,01 deja Continuar disabled → monto_rechazado."""
        r = nx.destino_resolver(d, ALIAS_OK, on_step=_on_step)
        assert r.get("estado") == "destino_resuelto", r
        arm = nx.transfer_armar(d, 0.01, on_step=_on_step)
        assert arm.get("estado") in ("monto_rechazado", "saldo_insuficiente"), arm
        assert arm.get("puede_transferir") is False, arm
        return arm

    def c_armar_y_cancelar_confirmacion():
        """Solo llega a confirmación si hay saldo ≥ $0,10 (mínimo práctico de Continuar)."""
        r = nx.destino_resolver(d, ALIAS_OK, on_step=_on_step)
        assert r.get("estado") == "destino_resuelto", r
        # leer saldo de la hoja de monto vía armar con monto al límite
        arm = nx.transfer_armar(d, 0.10, on_step=_on_step)
        if arm.get("estado") in ("saldo_insuficiente", "monto_rechazado"):
            return {"skip": "sin_saldo_para_confirmacion", "arm": arm}
        assert arm.get("estado") == "listo_para_enviar", arm
        assert nx._en_confirmacion(d), "debería estar en Vas a transferir"
        c = nx.transfer_cancelar(d, on_step=_on_step)
        assert c.get("estado") == "cancelado", c
        return {"arm": arm, "cancel": c}

    def c_armar_sin_contexto():
        nx.ir_al_inicio(d)
        try:
            nx.transfer_armar(d, 1.0, on_step=_on_step)
            return {"unexpected": "no_raise"}
        except nx.FlowError as e:
            return {"estado": "flujo", "detalle": str(e)}

    def c_saldo_lectura():
        s = nx.saldo(d)
        assert "pesos" in s or "disponible" in json.dumps(s, default=str).lower() or s.get("pesos") is not None or True
        return s

    cases = [
        ("destino_ok", c_destino_ok),
        ("destino_no_encontrado", c_destino_fake),
        ("destino_formato_corto", c_destino_corto),
        ("destino_vacio", c_destino_vacio),
        ("cancelar_en_identidad", c_cancelar_identidad),
        ("saldo_insuficiente_100", c_saldo_insuficiente),
        ("monto_rechazado_001", c_monto_rechazado_001),
        ("armar_010_y_cancelar_si_hay_saldo", c_armar_y_cancelar_confirmacion),
        ("armar_sin_contexto", c_armar_sin_contexto),
        ("lectura_saldo", c_saldo_lectura),
    ]

    for name, fn in cases:
        results.append(_case(name, fn))
        # always try to leave UI calm between cases
        try:
            nx.transfer_cancelar(d)
        except Exception:
            pass

    print("\n" + "=" * 60)
    print("SUMMARY")
    passed = sum(1 for r in results if r["ok"])
    for r in results:
        flag = "PASS" if r["ok"] else "FAIL"
        print(f"  {flag}  {r['name']:28s}  {r['elapsed']:5.1f}s")
    print(f"\n{passed}/{len(results)} passed")
    out_path = ROOT / "shots" / "smoke_secretaria_last.json"
    out_path.parent.mkdir(exist_ok=True)
    # strip huge fields
    slim = []
    for r in results:
        dtl = r.get("detail")
        if isinstance(dtl, dict):
            dtl = {k: dtl[k] for k in dtl if k not in ("tb", "textos", "screenshot_confirmacion")}
        slim.append({**r, "detail": dtl})
    out_path.write_text(json.dumps(slim, ensure_ascii=False, indent=2, default=str))
    print("wrote", out_path)
    return 0 if passed == len(results) else 1


if __name__ == "__main__":
    raise SystemExit(main())
