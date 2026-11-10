"""Agenda — quién es quién para el secretario (diseño: vault no-phone/AGENDA.md).

Una ficha por persona, grupo, lugar o cuenta con su nombre, apodos y cómo encontrarla en cada herramienta
(WhatsApp, Naranja X). Es la fuente de verdad de la identidad: la memoria (Hindsight) guarda hechos, pero decide
quién es quién por parecido del nombre y no sabe de apodos. La agenda se llena sola desde los contactos de WhatsApp
y la agenda de Naranja X (nombre → CVU), y aprende apodos en la charla.

Un solo archivo SQLite por secretario: lo escriben el conector «agenda» (este módulo) y la consola (memoria, enlace
con Hindsight). Mismo esquema en `admin/server/agenda.ts`: si cambia acá, cambia allá.
"""
from __future__ import annotations

import difflib
import json
import os
import re
import sqlite3
import time
import unicodedata
import uuid
from pathlib import Path
from typing import Any, Iterable

DDL = """
CREATE TABLE IF NOT EXISTS fichas (
  id          TEXT PRIMARY KEY,
  nombre      TEXT NOT NULL,
  tipo        TEXT NOT NULL DEFAULT 'persona',   -- persona | grupo | lugar | cuenta
  relacion    TEXT,                              -- «amigo de la facu», «primo»
  estado      TEXT NOT NULL DEFAULT 'contacto',  -- contacto (vino de una herramienta) | confirmado | sin_identificar
  origen      TEXT NOT NULL,                     -- whatsapp | naranjax | charla | consola
  wa_jid      TEXT UNIQUE,
  wa_nombre   TEXT,                              -- cómo está agendado en WhatsApp
  nx_alias    TEXT,
  nx_cvu      TEXT,
  nx_titular  TEXT,
  direccion   TEXT,
  creado      REAL NOT NULL,
  actualizado REAL NOT NULL
);
-- Todo lo que sirve para encontrar una ficha. clase: nombre | apodo | whatsapp | naranjax.
-- Un mismo texto puede estar en dos fichas (dos «Juan»): eso es ambiguo y siempre se pregunta.
CREATE TABLE IF NOT EXISTS nombres (
  ficha_id TEXT NOT NULL REFERENCES fichas(id) ON DELETE CASCADE,
  texto    TEXT NOT NULL,
  norm     TEXT NOT NULL,
  clase    TEXT NOT NULL,
  origen   TEXT NOT NULL,
  at       REAL NOT NULL,
  PRIMARY KEY (ficha_id, norm)
);
CREATE INDEX IF NOT EXISTS nombres_norm ON nombres (norm);
-- Entidades de Hindsight que son esta ficha (la memoria puede tener a la misma persona con varios nombres).
CREATE TABLE IF NOT EXISTS entidades (
  entidad_id TEXT PRIMARY KEY,
  ficha_id   TEXT NOT NULL REFERENCES fichas(id) ON DELETE CASCADE,
  nombre     TEXT NOT NULL,
  origen     TEXT NOT NULL,                       -- auto (mismo nombre) | consola
  at         REAL NOT NULL
);
-- «separar» en la consola: esa entidad no se vuelve a enlazar sola con esa ficha.
CREATE TABLE IF NOT EXISTS no_enlazar (
  entidad_id TEXT NOT NULL,
  ficha_id   TEXT NOT NULL,
  PRIMARY KEY (entidad_id, ficha_id)
);
CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
"""

# Solo UN artículo adelante («al Berna», «la Champagnat»). Nunca «lo»/«de»: «lo de Goyo» es un lugar, no «Goyo».
ARTICULOS = {"el", "la", "los", "las", "al", "a"}
NORM_VERSION = "2"


def ruta() -> Path:
    base = Path(os.environ.get("XDG_DATA_HOME") or str(Path.home() / ".local" / "share")) / "no-phone"
    return Path(os.environ.get("AGENDA_DB") or base / "agenda.db")


def conectar(path: Path | None = None) -> sqlite3.Connection:
    p = path or ruta()
    p.parent.mkdir(parents=True, exist_ok=True)
    con = sqlite3.connect(p, timeout=10, isolation_level=None)
    con.row_factory = sqlite3.Row
    con.execute("PRAGMA journal_mode=WAL")
    con.execute("PRAGMA busy_timeout=10000")
    con.execute("PRAGMA foreign_keys=ON")
    con.executescript(DDL)
    _renormalizar(con)
    try:
        os.chmod(p, 0o600)
    except OSError:
        pass
    return con


def _renormalizar(con: sqlite3.Connection) -> None:
    """Si cambió cómo se normaliza, se recalculan todos los nombres (una vez)."""
    r = con.execute("SELECT v FROM meta WHERE k='norm'").fetchone()
    if r and r["v"] == NORM_VERSION:
        return
    con.execute("BEGIN IMMEDIATE")
    try:
        filas = con.execute("SELECT ficha_id, texto, norm, clase, origen, at FROM nombres").fetchall()
        con.execute("DELETE FROM nombres")
        for f in filas:
            n = norm(f["texto"])
            if n:
                con.execute("INSERT OR IGNORE INTO nombres (ficha_id, texto, norm, clase, origen, at) VALUES (?, ?, ?, ?, ?, ?)",
                            (f["ficha_id"], f["texto"], n, f["clase"], f["origen"], f["at"]))
        con.execute("INSERT OR REPLACE INTO meta (k, v) VALUES ('norm', ?)", (NORM_VERSION,))
        con.execute("COMMIT")
    except Exception:
        con.execute("ROLLBACK")
        raise


def norm(s: str | None) -> str:
    """«el Berna», «Bernabé» → «berna», «bernabe»: sin tildes, minúsculas, sin signos ni artículo adelante."""
    t = "".join(c for c in unicodedata.normalize("NFKD", s or "") if not unicodedata.combining(c)).casefold()
    t = re.sub(r"[^a-z0-9ñ@.]+", " ", t).strip()
    ws = t.split()
    if len(ws) > 1 and ws[0] in ARTICULOS:
        ws = ws[1:]
    return " ".join(ws)


def palabras(s: str | None) -> list[str]:
    return [w for w in norm(s).split() if len(w) >= 3]


def _version_mas(con: sqlite3.Connection) -> None:
    con.execute("INSERT INTO meta (k, v) VALUES ('version', '1') ON CONFLICT (k) DO UPDATE SET v = CAST(v AS INTEGER) + 1")


def _ahora() -> float:
    return time.time()


def _poner_nombre(con: sqlite3.Connection, ficha_id: str, texto: str | None, clase: str, origen: str) -> bool:
    """Agrega un nombre buscable. Un nombre o apodo nunca se degrada a «whatsapp»: gana la clase más fuerte."""
    n = norm(texto)
    if not n or len(n) < 2:
        return False
    fuerza = {"whatsapp": 0, "naranjax": 1, "nombre": 2, "apodo": 2}
    cur = con.execute("SELECT clase FROM nombres WHERE ficha_id=? AND norm=?", (ficha_id, n)).fetchone()
    if cur and fuerza.get(cur["clase"], 0) >= fuerza.get(clase, 0):
        return False
    con.execute(
        "INSERT INTO nombres (ficha_id, texto, norm, clase, origen, at) VALUES (?, ?, ?, ?, ?, ?) "
        "ON CONFLICT (ficha_id, norm) DO UPDATE SET clase=excluded.clase, origen=excluded.origen, texto=excluded.texto, at=excluded.at",
        (ficha_id, (texto or "").strip(), n, clase, origen, _ahora()),
    )
    return True


def crear(con: sqlite3.Connection, nombre: str, *, tipo: str = "persona", estado: str, origen: str, **campos: Any) -> str:
    fid = uuid.uuid4().hex[:12]
    t = _ahora()
    cols = {k: v for k, v in campos.items() if k in {"relacion", "wa_jid", "wa_nombre", "nx_alias", "nx_cvu", "nx_titular", "direccion"} and v}
    con.execute(
        f"INSERT INTO fichas (id, nombre, tipo, estado, origen, creado, actualizado{''.join(', ' + k for k in cols)}) "
        f"VALUES (?, ?, ?, ?, ?, ?, ?{', ?' * len(cols)})",
        (fid, nombre.strip(), tipo, estado, origen, t, t, *cols.values()),
    )
    _poner_nombre(con, fid, nombre, "nombre", origen)
    _version_mas(con)
    return fid


# ---------- WhatsApp ----------

def numero_de_jid(jid: str | None) -> str | None:
    if not jid or not jid.endswith("@s.whatsapp.net"):
        return None
    return "+" + jid.split("@")[0].split(":")[0]


def _wa_con(wa_db: Path) -> sqlite3.Connection | None:
    if not wa_db.exists():
        return None
    c = sqlite3.connect(f"file:{wa_db}?mode=ro", uri=True, timeout=5)
    c.row_factory = sqlite3.Row
    return c


def sincronizar_whatsapp(con: sqlite3.Connection, wa_db: Path) -> dict:
    """Contactos y chats de WhatsApp → fichas «contacto». No pisa el nombre de una ficha que confirmó el dueño."""
    wa = _wa_con(wa_db)
    if wa is None:
        return {"whatsapp": "sin_base"}
    nuevos = actualizados = 0
    try:
        filas: dict[str, tuple[str, str]] = {}  # jid → (nombre, tipo)
        try:
            for r in wa.execute(
                "SELECT their_jid AS jid, COALESCE(NULLIF(full_name,''), NULLIF(first_name,''), NULLIF(business_name,''), "
                "NULLIF(push_name,'')) AS nombre FROM whatsmeow_contacts"
            ):
                if r["jid"] and r["jid"].endswith("@s.whatsapp.net") and r["nombre"]:
                    filas[r["jid"]] = (r["nombre"], "persona")
        except sqlite3.OperationalError:
            pass  # bridge sin vincular todavía
        for r in wa.execute("SELECT jid, name, is_group FROM chats WHERE name IS NOT NULL AND name != ''"):
            if r["is_group"]:
                filas[r["jid"]] = (r["name"], "grupo")
            elif r["jid"].endswith("@s.whatsapp.net") and r["jid"] not in filas:
                filas[r["jid"]] = (r["name"], "persona")
    finally:
        wa.close()
    con.execute("BEGIN")
    try:
        for jid, (nombre, tipo) in filas.items():
            cur = con.execute("SELECT id, wa_nombre FROM fichas WHERE wa_jid=?", (jid,)).fetchone()
            if cur is None:
                crear(con, nombre, tipo=tipo, estado="contacto", origen="whatsapp", wa_jid=jid, wa_nombre=nombre)
                nuevos += 1
            elif cur["wa_nombre"] != nombre:
                con.execute("UPDATE fichas SET wa_nombre=?, actualizado=? WHERE id=?", (nombre, _ahora(), cur["id"]))
                _poner_nombre(con, cur["id"], nombre, "whatsapp", "whatsapp")
                actualizados += 1
        if nuevos or actualizados:
            _version_mas(con)
        con.execute("COMMIT")
    except Exception:
        con.execute("ROLLBACK")
        raise
    return {"whatsapp": len(filas), "nuevos": nuevos, "actualizados": actualizados}


# ---------- Naranja X (agenda.json de naranjax.py: nombres → CVU aprendidos al transferir) ----------

def sincronizar_naranjax(con: sqlite3.Connection, agenda_json: Path) -> dict:
    try:
        entries = json.loads(agenda_json.read_text(encoding="utf-8")).get("entries", [])
    except (OSError, ValueError):
        return {"naranjax": "sin_agenda"}
    hechos = 0
    con.execute("BEGIN")
    try:
        for e in entries:
            titular = (e.get("titular") or "").strip()
            cvu = (e.get("cvu") or "").strip()
            if not titular and not cvu:
                continue
            fid = None
            if cvu:
                r = con.execute("SELECT id FROM fichas WHERE nx_cvu=?", (cvu,)).fetchone()
                fid = r["id"] if r else None
            if fid is None:
                f = misma_persona(con, [titular] + list(e.get("nombres") or []))
                fid = f["id"] if f else None
            if fid is None:
                fid = crear(con, titular or e.get("alias") or cvu, estado="contacto", origen="naranjax")
            con.execute(
                "UPDATE fichas SET nx_cvu=COALESCE(nx_cvu, ?), nx_alias=COALESCE(nx_alias, ?), nx_titular=COALESCE(nx_titular, ?), "
                "actualizado=? WHERE id=?",
                (cvu or None, e.get("alias") or None, titular or None, _ahora(), fid),
            )
            if titular:
                _poner_nombre(con, fid, titular, "naranjax", "naranjax")
            for n in e.get("nombres") or []:
                # Lo que el dueño usó para pedir la transferencia («Berna») es un apodo suyo; el alias de NX no.
                clase = "naranjax" if norm(n) in {norm(titular), norm(e.get("alias"))} or "." in n else "apodo"
                _poner_nombre(con, fid, n, clase, "naranjax")
            hechos += 1
        _version_mas(con)
        con.execute("COMMIT")
    except Exception:
        con.execute("ROLLBACK")
        raise
    return {"naranjax": hechos}


# ---------- buscar ----------

def _encaja(w: str, x: str) -> bool:
    return x == w or (len(w) >= 4 and x.startswith(w)) or (len(x) >= 4 and w.startswith(x)) or difflib.SequenceMatcher(None, w, x).ratio() >= 0.84


def misma_persona(con: sqlite3.Connection, nombres: list[str]) -> sqlite3.Row | None:
    """¿Ya hay UNA ficha de persona que sea esta? Por nombre exacto, o porque todas las palabras del nombre más corto
    encajan con el otro y son al menos dos («Bernabe Gabriel Sosa» = «Bernabe Sssa», agendado con typo).
    Si hay dudas (dos candidatos), None: mejor una sugerencia que unir a dos personas distintas."""
    personas = [c for c in _exactos(con, nombres) if c["tipo"] == "persona"]
    if len(personas) == 1:
        return personas[0]
    if personas:
        return None
    hallados: dict[str, sqlite3.Row] = {}
    for n in nombres:
        a = palabras(n)
        if len(a) < 2:
            continue
        for _, f in _parecidos(con, n, limite=10):
            if f["tipo"] != "persona":
                continue
            for r in con.execute("SELECT norm FROM nombres WHERE ficha_id=?", (f["id"],)):
                b = [w for w in r["norm"].split() if len(w) >= 3]
                corto, largo = (a, b) if len(a) <= len(b) else (b, a)
                if len(corto) >= 2 and all(any(_encaja(w, x) for x in largo) for w in corto):
                    hallados[f["id"]] = f
    return next(iter(hallados.values())) if len(hallados) == 1 else None

def _exactos(con: sqlite3.Connection, textos: Iterable[str]) -> list[sqlite3.Row]:
    ns = list({norm(t) for t in textos if norm(t)})
    if not ns:
        return []
    q = ",".join("?" * len(ns))
    return con.execute(
        f"SELECT DISTINCT f.* FROM nombres n JOIN fichas f ON f.id = n.ficha_id WHERE n.norm IN ({q})", ns
    ).fetchall()


def _actividad(wa_db: Path | None, jids: list[str]) -> dict[str, int]:
    """Mensajes de los últimos 30 días por chat: para saber cuál es «el de siempre»."""
    if not wa_db or not jids:
        return {}
    wa = _wa_con(wa_db)
    if wa is None:
        return {}
    try:
        q = ",".join("?" * len(jids))
        return {
            r[0]: r[1]
            for r in wa.execute(
                f"SELECT chat_jid, COUNT(*) FROM messages WHERE chat_jid IN ({q}) AND timestamp >= ? GROUP BY chat_jid",
                (*jids, int(time.time()) - 30 * 86400),
            )
        }
    finally:
        wa.close()


def _parecidos(con: sqlite3.Connection, texto: str, limite: int = 6) -> list[tuple[int, sqlite3.Row]]:
    """Fichas cuyas palabras encajan con las pedidas: una empieza con la otra («Berna» ~ «Bernabe») o casi iguales
    (typos: «Sssa»). Puntaje = cuántas palabras pedidas encajan."""
    pedidas = palabras(texto)
    if not pedidas:
        return []
    likes = [f"%{w[:3]}%" for w in pedidas]
    filas = con.execute(
        "SELECT n.ficha_id, n.norm FROM nombres n WHERE " + " OR ".join("n.norm LIKE ?" for _ in likes), likes
    ).fetchall()
    puntos: dict[str, int] = {}
    for r in filas:
        suyas = r["norm"].split()
        p = sum(any(_encaja(w, x) for x in suyas) for w in pedidas)
        if p:
            puntos[r["ficha_id"]] = max(puntos.get(r["ficha_id"], 0), p)
    if not puntos:
        return []
    mejor = max(puntos.values())
    ids = [i for i, p in puntos.items() if p == mejor]
    q = ",".join("?" * len(ids))
    return [(mejor, f) for f in con.execute(f"SELECT * FROM fichas WHERE id IN ({q})", ids).fetchall()][:limite * 3]


def ficha_corta(con: sqlite3.Connection, f: sqlite3.Row) -> dict:
    apodos = [r["texto"] for r in con.execute(
        "SELECT texto FROM nombres WHERE ficha_id=? AND clase='apodo' ORDER BY at", (f["id"],))]
    out: dict[str, Any] = {"ficha": f["id"], "nombre": f["nombre"], "tipo": f["tipo"]}
    if f["relacion"]:
        out["relacion"] = f["relacion"]
    if apodos:
        out["apodos"] = apodos
    if f["wa_jid"]:
        out["whatsapp"] = numero_de_jid(f["wa_jid"]) or f["wa_jid"]
        if f["wa_nombre"] and norm(f["wa_nombre"]) != norm(f["nombre"]):
            out["agendado_en_whatsapp"] = f["wa_nombre"]
    if f["nx_alias"] or f["nx_cvu"]:
        out["naranjax"] = f["nx_alias"] or f["nx_cvu"]
    if f["direccion"]:
        out["direccion"] = f["direccion"]
    if f["estado"] == "sin_identificar":
        out["sin_identificar"] = True
    return out


def _ordenar(con: sqlite3.Connection, fichas: list[sqlite3.Row], wa_db: Path | None) -> list[sqlite3.Row]:
    act = _actividad(wa_db, [f["wa_jid"] for f in fichas if f["wa_jid"]])
    peso = {"confirmado": 2, "contacto": 1, "sin_identificar": 0}
    # Lo que el dueño o la memoria ya confirmaron va antes que un contacto cualquiera; después, el más hablado.
    return sorted(fichas, key=lambda f: (-peso.get(f["estado"], 0), -act.get(f["wa_jid"] or "", 0), f["nombre"]))


def _el_de_siempre(con: sqlite3.Connection, fichas: list[sqlite3.Row], wa_db: Path | None) -> sqlite3.Row | None:
    """Entre homónimos, el que claramente es «el de siempre» (≥3 mensajes en 30 días y ≥3× el segundo)."""
    act = _actividad(wa_db, [f["wa_jid"] for f in fichas if f["wa_jid"]])
    cuentas = sorted(((act.get(f["wa_jid"] or "", 0), f) for f in fichas), key=lambda x: -x[0])
    if len(cuentas) >= 2 and cuentas[0][0] >= 3 and cuentas[0][0] >= 3 * max(cuentas[1][0], 1):
        return cuentas[0][1]
    return None


def resolver(con: sqlite3.Connection, texto: str, para: str = "mencionar", wa_db: Path | None = None) -> dict:
    """¿Quién es «texto»? para = mencionar (solo lo nombró) | mensaje | plata | lugar (hay que actuar).

    estado: ok (sin preguntar) · preguntar (con `pregunta` y `candidatos`) · desconocido (nadie: anotarlo si solo
    lo mencionó; preguntar quién es si hay que actuar)."""
    actuar = para != "mencionar"
    pedido = texto.strip()
    exactos = _exactos(con, [pedido])
    if exactos:
        n = norm(pedido)
        # ¿Es un apodo que el dueño usa para más de uno? Entonces siempre se pregunta.
        apodo_de = {r["ficha_id"] for r in con.execute("SELECT ficha_id FROM nombres WHERE norm=? AND clase='apodo'", (n,))}
        if len(exactos) == 1:
            f = exactos[0]
            if actuar and f["estado"] == "sin_identificar" and not (f["wa_jid"] or f["nx_cvu"] or f["direccion"]):
                # Lo anotó cuando solo lo mencionó: para actuar falta saber quién es (una sola pregunta).
                return {"estado": "desconocido", "ficha": f["id"],
                        "pregunta": f"¿Quién es {pedido}? Decime cómo está en WhatsApp o su número.",
                        "hint": f"Con la respuesta: agenda_apodo(ficha_del_contacto, \"{pedido}\")."}
            return {"estado": "ok", **ficha_corta(con, f)}
        if len(apodo_de) == 1 and not actuar:
            f = next(f for f in exactos if f["id"] in apodo_de)
            return {"estado": "ok", **ficha_corta(con, f)}
        if len(apodo_de) == 1:
            f = next(f for f in exactos if f["id"] in apodo_de)
            return {"estado": "ok", **ficha_corta(con, f), "otros_posibles": [ficha_corta(con, x)["nombre"] for x in exactos if x["id"] != f["id"]][:3]}
        top = _el_de_siempre(con, exactos, wa_db) if len(apodo_de) < 2 else None
        if top is not None:
            return {"estado": "ok", **ficha_corta(con, top),
                    "otros_posibles": [x["nombre"] for x in exactos if x["id"] != top["id"]][:3]}
        cands = _ordenar(con, exactos, wa_db)[:3]
        return _preguntar(con, pedido, cands, actuar)
    parecidos = [f for _, f in _parecidos(con, pedido)]
    if not parecidos:
        if actuar:
            return {"estado": "desconocido",
                    "pregunta": f"No tengo a {pedido} en la agenda, ¿quién es? (un contacto de WhatsApp o un número)"}
        return {"estado": "desconocido",
                "hint": f"Solo lo mencionó: no preguntes. Anotalo con agenda_anotar(\"{pedido}\") y seguí."}
    cands = _ordenar(con, parecidos, wa_db)[:3]
    if not actuar:
        return {"estado": "probable", "candidatos": [ficha_corta(con, f) for f in cands],
                "hint": "Solo lo mencionó: no preguntes. Si más adelante hay que actuar, ahí confirmás quién es."}
    return _preguntar(con, pedido, cands, actuar)


def _desc(con: sqlite3.Connection, f: sqlite3.Row) -> str:
    extra = f["relacion"] or (f"agendado {f['wa_nombre']}" if f["wa_nombre"] and norm(f["wa_nombre"]) != norm(f["nombre"]) else "")
    return f["nombre"] + (f", {extra}" if extra else "")


def _preguntar(con: sqlite3.Connection, pedido: str, cands: list[sqlite3.Row], actuar: bool) -> dict:
    if len(cands) == 1:
        p = f"¿{pedido} es {_desc(con, cands[0])}?"
    else:
        nombres = [_desc(con, f) for f in cands]
        p = f"¿{pedido} es " + ", ".join(nombres[:-1]) + f" o {nombres[-1]}?"
    return {
        "estado": "preguntar",
        "pregunta": p,
        "candidatos": [ficha_corta(con, f) for f in cands],
        "hint": ("Si vas a mandar un mensaje o plata, poné esta duda DENTRO de la confirmación de la herramienta "
                 "(una sola pregunta). Con la respuesta: agenda_apodo(ficha, \"" + pedido + "\")." if actuar else ""),
    }


# ---------- aprender ----------

def ficha_por_id(con: sqlite3.Connection, fid: str) -> sqlite3.Row | None:
    return con.execute("SELECT * FROM fichas WHERE id=?", (fid,)).fetchone()


def agregar_apodo(con: sqlite3.Connection, fid: str, apodo: str, origen: str = "charla") -> dict:
    f = ficha_por_id(con, fid)
    if f is None:
        return {"error": "ficha_no_existe", "mensaje": "Esa ficha no está en la agenda."}
    if not norm(apodo):
        return {"error": "apodo_vacio", "mensaje": "Falta el apodo."}
    con.execute("BEGIN")
    try:
        _poner_nombre(con, fid, apodo, "apodo", origen)
        # Si era una ficha «sin identificar» con ese mismo nombre, se funde en esta.
        for s in con.execute("SELECT f.id FROM fichas f JOIN nombres n ON n.ficha_id=f.id WHERE f.estado='sin_identificar' "
                             "AND n.norm=? AND f.id != ?", (norm(apodo), fid)).fetchall():
            fusionar(con, s["id"], fid)
        con.execute("UPDATE fichas SET estado=CASE WHEN estado='sin_identificar' THEN 'confirmado' ELSE estado END, "
                    "actualizado=? WHERE id=?", (_ahora(), fid))
        _version_mas(con)
        con.execute("COMMIT")
    except Exception:
        con.execute("ROLLBACK")
        raise
    return {"estado": "ok", **ficha_corta(con, ficha_por_id(con, fid))}


def anotar(con: sqlite3.Connection, nombre: str, relacion: str | None = None) -> dict:
    """Alguien nombrado que no está: ficha «sin identificar» (se completa sola o desde la consola)."""
    ya = _exactos(con, [nombre])
    if ya:
        return {"estado": "ya_estaba", **ficha_corta(con, ya[0])}
    con.execute("BEGIN")
    try:
        fid = crear(con, nombre, estado="sin_identificar", origen="charla", relacion=relacion)
        con.execute("COMMIT")
    except Exception:
        con.execute("ROLLBACK")
        raise
    return {"estado": "anotado", **ficha_corta(con, ficha_por_id(con, fid))}


def guardar_lugar(con: sqlite3.Connection, nombre: str, direccion: str, apodos: Iterable[str] = (),
                  ficha_id: str | None = None, relacion: str | None = None, origen: str = "charla") -> dict:
    """Dónde queda algo que el dueño nombra: su casa, el laburo, la facu (ficha tipo lugar), o la dirección de una
    persona («lo de mi vieja») si viene `ficha_id`. Es lo que usa movilidad para «casa»/«lo de X»: nunca se adivina."""
    direccion = (direccion or "").strip()
    if not direccion:
        return {"error": "direccion_vacia", "mensaje": "Falta la dirección."}
    con.execute("BEGIN")
    try:
        if ficha_id:
            f = ficha_por_id(con, ficha_id)
            if f is None:
                con.execute("ROLLBACK")
                return {"error": "ficha_no_existe", "mensaje": "Esa ficha no está en la agenda."}
            fid = f["id"]
            con.execute("UPDATE fichas SET direccion=?, actualizado=? WHERE id=?", (direccion, _ahora(), fid))
        else:
            ya = [f for f in _exactos(con, [nombre, *apodos]) if f["tipo"] == "lugar"]
            if ya:
                fid = ya[0]["id"]
                con.execute("UPDATE fichas SET direccion=?, relacion=COALESCE(?, relacion), estado='confirmado', actualizado=? "
                            "WHERE id=?", (direccion, relacion, _ahora(), fid))
            else:
                fid = crear(con, nombre, tipo="lugar", estado="confirmado", origen=origen, direccion=direccion, relacion=relacion)
        for a in apodos:
            _poner_nombre(con, fid, a, "apodo", origen)
        _version_mas(con)
        con.execute("COMMIT")
    except Exception:
        con.execute("ROLLBACK")
        raise
    return {"estado": "ok", **ficha_corta(con, ficha_por_id(con, fid))}


def lugares(con: sqlite3.Connection) -> list[dict]:
    """Los lugares del dueño con dirección (casa, laburo, facu…)."""
    return [ficha_corta(con, f) for f in con.execute(
        "SELECT * FROM fichas WHERE tipo='lugar' AND direccion IS NOT NULL AND estado != 'sin_identificar' ORDER BY nombre")]


def fusionar(con: sqlite3.Connection, desde: str, hacia: str) -> None:
    """Mueve todo de la ficha `desde` a `hacia` y borra `desde` (sin transacción propia)."""
    if desde == hacia:
        return
    a = ficha_por_id(con, desde)
    if a is None:
        return
    con.execute("UPDATE OR IGNORE nombres SET ficha_id=? WHERE ficha_id=?", (hacia, desde))
    con.execute("UPDATE OR IGNORE entidades SET ficha_id=? WHERE ficha_id=?", (hacia, desde))
    for col in ("relacion", "nx_alias", "nx_cvu", "nx_titular", "direccion", "wa_nombre"):
        con.execute(f"UPDATE fichas SET {col}=COALESCE({col}, ?) WHERE id=?", (a[col], hacia))
    wa = a["wa_jid"]
    con.execute("DELETE FROM fichas WHERE id=?", (desde,))
    if wa:
        con.execute("UPDATE fichas SET wa_jid=COALESCE(wa_jid, ?) WHERE id=?", (wa, hacia))
    _version_mas(con)


# ---------- ficha completa ----------

def ficha(con: sqlite3.Connection, fid: str, wa_db: Path | None = None) -> dict:
    f = ficha_por_id(con, fid)
    if f is None:
        return {"error": "ficha_no_existe", "mensaje": "Esa ficha no está en la agenda."}
    out = ficha_corta(con, f)
    out["estado"] = f["estado"]
    otros = [r["texto"] for r in con.execute(
        "SELECT texto FROM nombres WHERE ficha_id=? AND clase IN ('whatsapp','naranjax') AND norm != ?", (fid, norm(f["nombre"])))]
    if otros:
        out["tambien_figura_como"] = otros
    if f["tipo"] == "grupo" and f["wa_jid"] and wa_db:
        out["miembros"] = miembros_grupo(con, f["wa_jid"], wa_db)
    return out


def miembros_grupo(con: sqlite3.Connection, grupo_jid: str, wa_db: Path) -> list[str]:
    """Quiénes escribieron en el grupo (últimos 90 días), cruzados por número con la agenda. No se copian a la
    ficha: se sacan en el momento, así nunca quedan viejos."""
    wa = _wa_con(wa_db)
    if wa is None:
        return []
    try:
        senders = [r[0] for r in wa.execute(
            "SELECT sender, MAX(timestamp) t FROM messages WHERE chat_jid=? AND is_from_me=0 AND timestamp >= ? "
            "GROUP BY sender ORDER BY t DESC LIMIT 40", (grupo_jid, int(time.time()) - 90 * 86400))]
        lid: dict[str, str] = {}
        try:
            for r in wa.execute("SELECT lid, pn FROM whatsmeow_lid_map"):
                lid[str(r[0]).split("@")[0]] = str(r[1]).split("@")[0]
        except sqlite3.OperationalError:
            pass
    finally:
        wa.close()
    out = []
    for s in senders:
        user = str(s or "").split("@")[0].split(":")[0]
        user = lid.get(user, user)
        jid = f"{user}@s.whatsapp.net"
        r = con.execute("SELECT nombre FROM fichas WHERE wa_jid=?", (jid,)).fetchone()
        out.append(r["nombre"] if r else f"+{user}")
    return out


def sincronizar(con: sqlite3.Connection, wa_db: Path | None, nx_json: Path | None) -> dict:
    out: dict[str, Any] = {}
    if wa_db:
        out.update(sincronizar_whatsapp(con, wa_db))
    if nx_json:
        out.update(sincronizar_naranjax(con, nx_json))
    return out
