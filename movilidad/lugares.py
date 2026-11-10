"""Lugares del dueño para movilidad: «casa», «el laburo», «la facu», «lo de mi vieja».

Salen de la agenda (fichas tipo lugar con dirección, o la dirección de una persona), la misma que se edita desde la
consola. Una palabra personal NUNCA se busca en Google: «casa» daba «Casa Segal». Si no está en la agenda, se
devuelve que no se sabe (y el secretario pregunta y la guarda con agenda_lugar).

También lleva el historial de viajes (dónde estuvo / adónde fue) para suponer el punto de partida cuando el dueño no
lo dice: el destino del último viaje si fue hace poco; si no, su casa.
"""
from __future__ import annotations

import json
import re
import time
from pathlib import Path

import agenda as A

# Palabras que solo tienen sentido para el dueño (sin artículo; `agenda.norm` ya saca «el/la»).
PERSONALES = {
    "casa", "mi casa", "casita", "mi casita", "depto", "mi depto", "departamento", "mi departamento",
    "laburo", "mi laburo", "trabajo", "mi trabajo", "oficina", "mi oficina", "estudio",
    "facu", "mi facu", "facultad", "mi facultad", "uni", "universidad", "mi universidad",
    "gimnasio", "gym", "mi gimnasio",
}
_LO_DE = re.compile(r"^(?:a |en |hasta |desde )?(?:lo de|lo del|lo de la|la casa de|casa de|el depto de|el departamento de)\s+(.+)$")
_LO_DE_ESTRICTO = re.compile(r"^(?:a |en |hasta |desde )?(?:lo de|lo del|lo de la)\s+")  # «casa de Gobierno» es un lugar
_ACA = {"aca", "aqui", "donde estoy", "estoy aca", "mi ubicacion", "ubicacion actual", "aca donde estoy"}

HISTORIAL_HORAS = 6
_MAX_HISTORIAL = 300


class LugarDesconocido(ValueError):
    """Lugar personal que la agenda no tiene: hay que preguntarle al dueño, no adivinar."""


# «estoy en mi casa», «salgo del laburo», «desde la facu» → lo que importa es el lugar.
_FRASE = re.compile(r"^(?:ahora )?(?:estoy (?:en )?|estamos (?:en )?|salgo (?:de |desde )?|sal[ií] (?:de )?|voy (?:desde )?|parto (?:de |desde )?|desde |en )")
_CONTRAE = {"del ": "el ", "de la ": "la "}


def _n(texto: str | None) -> str:
    n = A.norm(texto)
    m = _FRASE.match(n)
    if m and len(n) > m.end():
        n = n[m.end():]
        for a, b in _CONTRAE.items():
            if n.startswith(a):
                n = b + n[len(a):]
        n = A.norm(n)
    return n


def es_aca(texto: str | None) -> bool:
    return not (texto or "").strip() or _n(texto) in _ACA


def es_personal(texto: str) -> bool:
    n = _n(texto)
    return n in PERSONALES or n.split(" ", 1)[0] in {"mi", "mis"} or bool(_LO_DE_ESTRICTO.match(n))


def _ficha_con_direccion(con, texto: str) -> dict | None:
    r = A.resolver(con, texto, "lugar")
    if r.get("estado") == "ok" and r.get("direccion"):
        return r
    return None


def buscar(texto: str) -> dict | None:
    """Lugar de la agenda que el dueño nombra → {nombre, direccion, ficha, decir}. None si no es de la agenda.

    Lanza LugarDesconocido si es claramente personal («casa», «el laburo», «lo de Pepín») y la agenda no lo sabe."""
    n = _n(texto)
    if not n:
        return None
    con = A.conectar()
    try:
        candidatos = [n]
        if n.startswith("mi ") or n.startswith("mis "):
            candidatos.append(n.split(" ", 1)[1])
        m = _LO_DE.match(n)
        persona = m.group(1) if m else None
        if persona:
            candidatos = [persona] + ([persona.split(" ", 1)[1]] if persona.startswith(("mi ", "mis ")) else [])
        for c in candidatos:
            f = _ficha_con_direccion(con, c)
            if f:
                if f["tipo"] == "lugar":
                    # Como lo nombró él: «casa» → «tu casa» (aunque la ficha se llame «casa de Javier…»).
                    pal = c.split(" ", 1)[1] if c.startswith(("mi ", "mis ")) else c
                    decir = (f"tu {pal}" if pal in PERSONALES else
                             f"tu {f['nombre'].lower()}" if _n(f["nombre"]) in PERSONALES else f["nombre"])
                else:
                    decir = f"lo de {f['nombre']}"
                return {"nombre": decir, "direccion": f["direccion"], "ficha": f["ficha"], "decir": decir}
        if persona and _LO_DE_ESTRICTO.match(n):
            raise LugarDesconocido(f"No sé dónde vive {persona}. Preguntale al dueño la dirección y guardala con "
                                   "agenda_lugar(ficha=la de esa persona). No la busques en Google.")
        if es_personal(n):
            raise LugarDesconocido(f"No sé dónde queda «{texto}» para tu dueño. Preguntale la dirección (una vez) y "
                                   "guardala con agenda_lugar; no la busques en Google ni la adivines.")
        return None
    finally:
        con.close()


def mis_lugares() -> list[dict]:
    con = A.conectar()
    try:
        return A.lugares(con)
    finally:
        con.close()


# ── historial: para suponer dónde está ───────────────────────────
def _historial_path() -> Path:
    return A.ruta().parent / "movilidad_historial.jsonl"


def registrar(origen: dict, destino: dict, llegada_ms: int | None, origen_texto: str, destino_texto: str) -> None:
    """Un viaje consultado: estaba en `origen` y va a `destino`. Sin coordenadas de más: nombre + texto pedido."""
    p = _historial_path()
    try:
        p.parent.mkdir(parents=True, exist_ok=True)
        linea = json.dumps({"ts": time.time(), "origen": origen_texto, "origen_nombre": origen.get("nombre"),
                            "destino": destino_texto, "destino_nombre": destino.get("nombre"),
                            "llegada_ms": llegada_ms}, ensure_ascii=False)
        lineas = p.read_text().splitlines()[-(_MAX_HISTORIAL - 1):] if p.exists() else []
        p.write_text("\n".join([*lineas, linea]) + "\n")
    except OSError:
        pass


def _ultimos() -> list[dict]:
    p = _historial_path()
    if not p.exists():
        return []
    out = []
    for l in p.read_text().splitlines():
        try:
            out.append(json.loads(l))
        except json.JSONDecodeError:
            continue
    return out


def suponer_origen(destino_texto: str, ahora: float | None = None) -> tuple[str, str]:
    """¿Desde dónde sale si no lo dijo? → (texto para resolver, por qué). Lanza LugarDesconocido si no hay base.

    1. Mismo destino que el último viaje (hace < 6 h): vuelve a preguntar lo mismo → el mismo origen de antes.
    2. Último viaje hace < 6 h: está donde iba.
    3. Si no: en su casa (de la agenda)."""
    ahora = ahora or time.time()
    dest = _n(destino_texto)
    recientes = [h for h in _ultimos() if ahora - h.get("ts", 0) < HISTORIAL_HORAS * 3600]
    if recientes:
        u = recientes[-1]
        if _n(u.get("destino") or "") == dest or _n(u.get("destino_nombre") or "") == dest:
            if u.get("origen") and _n(u["origen"]) != dest:
                return u["origen"], f"es el mismo viaje que consultaste a las {time.strftime('%H:%M', time.localtime(u['ts']))}"
        elif u.get("destino"):
            return u["destino"], f"a las {time.strftime('%H:%M', time.localtime(u['ts']))} ibas para {u.get('destino_nombre') or u['destino']}"
    try:
        casa = buscar("casa")
    except LugarDesconocido:
        casa = None
    if casa and _n(destino_texto) not in {"casa", "mi casa"} and not _es_misma(casa, destino_texto):
        return "casa", "no me dijiste desde dónde y no consultaste otro viaje hoy"
    raise LugarDesconocido("No sé desde dónde sale tu dueño: preguntale «¿desde dónde salís?» (una sola vez).")


def _es_misma(lugar: dict, texto: str) -> bool:
    try:
        otro = buscar(texto)
    except LugarDesconocido:
        return False
    return bool(otro) and otro.get("ficha") == lugar.get("ficha")
