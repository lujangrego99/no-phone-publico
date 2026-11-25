#!/usr/bin/env python3
"""Banco de misiones: encargos difíciles que se le piden al secretario (por la consola, como el dueño) y se puntúan.

Nunca aprueba nada: cada caso queda en la propuesta (no arranca ni manda). Con --ensayo además ensaya la propuesta
(los MCP simulan todo lo que sale) y mira cómo cierra cada rama.

  NP_URL=http://127.0.0.1:8890 NP_EMAIL=qa@local NP_PASSWORD=… NP_TENANT=miguel \\
    python3 scripts/banco_misiones.py [--ensayo] [--solo id,id] [--salida dir]

Sirve para «entrenar»: cada vez que una misión sale mal en la vida real, se suma el caso a tests/misiones_banco.json
y se corre esto antes y después de cambiar el prompt o el código. Resultado: tabla + JSON en --salida.
"""
from __future__ import annotations

import argparse
import http.cookiejar
import json
import os
import sys
import time
import unicodedata
import urllib.request
from pathlib import Path

AQUI = Path(__file__).resolve().parent.parent
URL = os.environ.get("NP_URL", "http://127.0.0.1:8890").rstrip("/")
TENANT = os.environ.get("NP_TENANT", "miguel")
NIEGA = ("no puedo", "no tengo forma", "no me es posible", "no está a mi alcance", "no puedo hacer")

cj = http.cookiejar.CookieJar()
op = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cj))


def req(method: str, path: str, body=None, timeout=60):
    data = json.dumps(body).encode() if body is not None else None
    r = urllib.request.Request(URL + path, data=data, method=method,
                               headers={"content-type": "application/json", "x-np": "1"} if data else {"x-np": "1"})
    return op.open(r, timeout=timeout)


def login():
    email, pw = os.environ.get("NP_EMAIL"), os.environ.get("NP_PASSWORD")
    if not email or not pw:
        sys.exit("Falta NP_EMAIL / NP_PASSWORD (usuario de QA de la consola).")
    req("POST", "/api/login", {"email": email, "password": pw}).read()


def decir(sesion: str, texto: str) -> dict:
    """Un mensaje como el dueño → herramientas usadas (con resultado) y respuesta."""
    r = req("POST", f"/api/t/{TENANT}/llamada", {"sessionId": sesion, "text": texto, "voz": False}, timeout=420)
    ev, tools, partes = None, {}, []
    for raw in r:
        line = raw.decode("utf-8", "replace").rstrip("\n")
        if line.startswith("event:"):
            ev = line[6:].strip()
        elif line.startswith("data:"):
            d = json.loads(line[5:].strip())
            if ev == "delta":
                partes.append(d.get("text", ""))
            elif ev == "tool":
                tools[d["id"]] = {"name": d["name"].split("__")[-1], "args": d.get("args")}
            elif ev == "tool_done":
                tools.setdefault(d["id"], {"name": d["name"].split("__")[-1], "args": d.get("args")})["result"] = d.get("result")
    return {"tools": list(tools.values()), "respuesta": "".join(partes).strip()}


def _n(s: str) -> str:
    return "".join(c for c in unicodedata.normalize("NFKD", s or "") if not unicodedata.combining(c)).lower()


def evaluar(caso: dict, out: dict) -> list[tuple[str, bool, str]]:
    e = caso["espera"]
    prep = next((t for t in out["tools"] if t["name"] == "mision_preparar" and (t.get("result") or {}).get("estado") == "listo_para_autorizar"), None)
    m = (prep or {}).get("result", {}).get("mision", {}) if prep else {}
    checks: list[tuple[str, bool, str]] = []
    niega = any(x in _n(out["respuesta"]) for x in NIEGA) and not prep
    checks.append(("no se niega", not niega, out["respuesta"][:120] if niega else ""))
    if e.get("prepara"):
        err = next((t.get("result") for t in out["tools"] if t["name"] == "mision_preparar" and (t.get("result") or {}).get("error")), None)
        checks.append(("prepara la misión", bool(prep), json.dumps(err, ensure_ascii=False)[:160] if err else ""))
    if e.get("prepara_o_preview"):
        hizo = bool(prep) or any(t["name"] == "nx_transfer_preview" for t in out["tools"])
        checks.append(("prepara (o intenta el preview)", hizo, ""))
    if not m:
        return checks
    nombres = " ".join(_n(c.get("nombre", "")) for c in m.get("contactos") or [])
    for c in e.get("contactos", []):
        checks.append((f"habla con {c}", _n(c) in nombres, nombres))
    if e.get("esperar_ingreso"):
        checks.append(("espera el ingreso", bool(m.get("esperar_ingreso")), ""))
    if e.get("empezar_a"):
        checks.append(("arranca a la hora", bool(m.get("despertar")), ""))
    if e.get("consultar"):
        checks.append(("dice cuándo te consulta", bool(m.get("consultar")), ""))
    pasos = m.get("pasos") or []
    checks.append(("trae el plan en pasos", len(pasos) >= e.get("pasos_min", 1), f"{len(pasos)} pasos"))
    if e.get("acciones"):
        tiene = {p.get("accion") for p in pasos}
        for a in e["acciones"]:
            checks.append((f"plan con {a}", a in tiene, ",".join(sorted(x for x in tiene if x))))
    if e.get("condicion"):
        checks.append(("plan con «solo si»", any(p.get("si") for p in pasos), ""))
    if e.get("fin"):
        checks.append(("dice cuándo termina", bool(m.get("cumplida_cuando")), m.get("cumplida_cuando") or ""))
        checks.append(("dice cuándo la da por perdida", bool(m.get("fracasa_si")), m.get("fracasa_si") or ""))
    # cada paso que le escribe a alguien trae el texto exacto (o es un comprobante/archivo: va sin texto)
    sin_texto = [p.get("hacer", "") for p in pasos if p.get("accion") == "mensaje" and not p.get("texto") and "comprobante" not in _n(p.get("hacer", ""))]
    checks.append(("muestra el texto de los mensajes", not sin_texto, "; ".join(sin_texto)[:120]))
    return checks


def ensayar() -> dict:
    req("POST", f"/api/t/{TENANT}/misiones/ensayo", {"deNuevo": True}).read()
    for _ in range(200):
        d = json.loads(req("GET", f"/api/t/{TENANT}/misiones/ensayo").read())
        if d["estado"] != "corriendo":
            return d
        time.sleep(3)
    return {"estado": "timeout", "ramas": []}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--ensayo", action="store_true")
    ap.add_argument("--solo", default="")
    ap.add_argument("--salida", default=str(AQUI / "tests" / "resultados"))
    a = ap.parse_args()
    casos = json.loads((AQUI / "tests" / "misiones_banco.json").read_text())
    if a.solo:
        casos = [c for c in casos if c["id"] in a.solo.split(",")]
    login()
    resultados, total, ok = [], 0, 0
    for c in casos:
        sesion = json.loads(req("POST", f"/api/t/{TENANT}/charla/nueva", {}).read())["sessionId"]
        t0 = time.time()
        out = decir(sesion, c["pedido"])
        checks = evaluar(c, out)
        ens = None
        if a.ensayo and any(n == "prepara la misión" and v for n, v, _ in checks):
            ens = ensayar()
            reales = [ac for r in ens.get("ramas", []) for t in r["turnos"] for ac in t["acciones"]
                      if ac["tool"] in ("mensaje", "transferencia") and not ac.get("simulado")]
            checks.append(("ensayo: nada salió de verdad", not reales, json.dumps(reales, ensure_ascii=False)[:160]))
            cerradas = sum(1 for r in ens.get("ramas", []) if r.get("final"))
            checks.append(("ensayo: cada rama termina en algo", cerradas == len(ens.get("ramas", [])), f"{cerradas}/{len(ens.get('ramas', []))}"))
        bien = sum(1 for _, v, _ in checks if v)
        total += len(checks)
        ok += bien
        resultados.append({"id": c["id"], "pedido": c["pedido"], "segundos": round(time.time() - t0), "checks": checks,
                           "respuesta": out["respuesta"], "tools": [t["name"] for t in out["tools"]], "ensayo": ens})
        print(f"\n{c['id']}  {bien}/{len(checks)}  ({round(time.time() - t0)} s){'  [necesita celu]' if c.get('necesita_celu') else ''}")
        for n, v, det in checks:
            print(f"   {'✓' if v else '✗'} {n}{f' — {det}' if det and not v else ''}")
    print(f"\nTOTAL {ok}/{total} ({round(100 * ok / max(total, 1))} %)")
    Path(a.salida).mkdir(parents=True, exist_ok=True)
    f = Path(a.salida) / f"banco-{time.strftime('%Y%m%d-%H%M%S')}.json"
    f.write_text(json.dumps({"ok": ok, "total": total, "casos": resultados}, ensure_ascii=False, indent=1))
    print(f"→ {f}")


if __name__ == "__main__":
    main()
