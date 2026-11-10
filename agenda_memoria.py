"""La agenda dentro de la memoria (Hindsight). Ver vault no-phone/AGENDA.md § Encaje con Hindsight.

Hindsight decide quién es quién al guardar, por parecido del nombre: un apodo («Grego») nunca cae en el nombre
completo. Probado (22/10): lo único que lo evita es que la misión de guardado diga «Grego» = Juan Gregorio Pérez.
Así que la agenda:

1. **enlaza** cada entidad de la memoria con su ficha (mismo nombre o apodo, sin LLM);
2. mantiene el **bloque de nombres** de la misión de guardado con los apodos de la agenda (lo nuevo ya sale bien);
3. **sana** lo viejo: en los documentos que guardaron a alguien con un apodo, cambia el apodo por el nombre de la
   ficha en las entidades de cada hecho (export → cambiar → import reemplazando; sin LLM, sin perder hechos). La
   entidad del apodo se vacía. Nunca toca documentos con recuerdos corregidos o descartados a mano;
4. **siembra** la agenda una vez con lo que la memoria ya sabe (un LLM lee los hechos y saca quién tiene qué apodos).
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import sqlite3
import time
import urllib.error
import urllib.request
from typing import Any

import agenda as A

HINDSIGHT = os.environ.get("HINDSIGHT_URL", "http://hindsight:8888").rstrip("/")
BANK = os.environ.get("HINDSIGHT_BANK", "")
OPENROUTER_KEY = os.environ.get("OPENROUTER_API_KEY", "")
MODELO = os.environ.get("AGENDA_MODELO", "deepseek/deepseek-v4.1-flash")

INICIO = "[nombres que unió el dueño · lo mantiene la consola, no editar]"
FIN = "[/nombres]"
BLOQUE = re.compile(r"\n*\[nombres que unió el dueño[^\]]*\][\s\S]*?\[/nombres\]\n*")
TOPE_LINEAS = 200          # ~3 k tokens por guardado como mucho
REPROCESAR_POR_PASADA = 20  # documentos re-etiquetados por pasada (sin LLM: export → cambiar nombres → import)
DOC_VIEJO = "consola-nombres"  # el documento de apodos que guardaba la consola antes de la agenda

RUIDO = re.compile(r"^(tipo:.*|user|usuario|assistant|asistente|the user|hermes agent|secretario|secretaria)$", re.I)


def _call(method: str, path: str, body: Any = None, timeout: float = 60) -> Any:
    req = urllib.request.Request(
        f"{HINDSIGHT}/v1/default/banks/{BANK}{path}",
        data=None if body is None else json.dumps(body).encode(),
        method=method,
        headers={"content-type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=timeout) as r:
        raw = r.read()
    return json.loads(raw) if raw else None


def _entidades() -> list[dict]:
    out: list[dict] = []
    off = 0
    while True:
        j = _call("GET", f"/entities?limit=500&offset={off}")
        out += j.get("items", [])
        off += 500
        if off >= j.get("total", 0) or not j.get("items"):
            return [e for e in out if not RUIDO.match((e.get("canonical_name") or "").strip())]


# ---------- 1. enlazar ----------

def enlazar(con: sqlite3.Connection) -> dict:
    """Cada entidad sin ficha: si su nombre es el nombre o un apodo de UNA sola ficha, queda enlazada."""
    hechos = 0
    actuales = _entidades()
    vivas = {e["id"] for e in actuales}
    # La memoria borra una entidad cuando ya no la nombra ningún dato (p. ej. «Grego» después de sanar): fuera.
    for r in con.execute("SELECT entidad_id FROM entidades").fetchall():
        if r["entidad_id"] not in vivas:
            con.execute("DELETE FROM entidades WHERE entidad_id=?", (r["entidad_id"],))
    ya = {r["entidad_id"] for r in con.execute("SELECT entidad_id FROM entidades")}
    vetos = {(r["entidad_id"], r["ficha_id"]) for r in con.execute("SELECT entidad_id, ficha_id FROM no_enlazar")}
    for e in actuales:
        if e["id"] in ya:
            continue
        cands = [f for f in A._exactos(con, [e["canonical_name"]]) if (e["id"], f["id"]) not in vetos]
        if len(cands) != 1:
            continue
        con.execute("INSERT OR IGNORE INTO entidades (entidad_id, ficha_id, nombre, origen, at) VALUES (?, ?, ?, 'auto', ?)",
                    (e["id"], cands[0]["id"], e["canonical_name"], time.time()))
        hechos += 1
    if hechos:
        A._version_mas(con)
    return {"enlazadas": hechos}


# ---------- 2. bloque de nombres ----------

def lineas_bloque(con: sqlite3.Connection) -> list[str]:
    """«Grego», «Goyo» = Juan Gregorio Pérez — por ficha: apodos + nombres con que la memoria la tiene guardada,
    los de más uso reciente primero, hasta TOPE_LINEAS."""
    # Solo fichas confirmadas (por el dueño o la memoria): el nombre de un contacto tal como está agendado
    # («Manu😁») no sirve como nombre canónico para la memoria.
    filas = con.execute(
        """SELECT f.id, f.nombre, MAX(n.at) AS ult FROM fichas f
           JOIN nombres n ON n.ficha_id = f.id AND n.clase = 'apodo'
           WHERE f.estado = 'confirmado' GROUP BY f.id
           UNION
           SELECT f.id, f.nombre, MAX(e.at) FROM fichas f JOIN entidades e ON e.ficha_id = f.id
           WHERE f.estado = 'confirmado' GROUP BY f.id
           ORDER BY 3 DESC"""
    ).fetchall()
    vistos: set[str] = set()
    out: list[str] = []
    dobles = ambiguos(con)
    for f in filas:
        if f["id"] in vistos:
            continue
        vistos.add(f["id"])
        otros: dict[str, str] = {}
        for r in con.execute("SELECT texto, norm FROM nombres WHERE ficha_id=? AND clase='apodo'", (f["id"],)):
            otros.setdefault(r["norm"], r["texto"])
        for r in con.execute("SELECT nombre FROM entidades WHERE ficha_id=?", (f["id"],)):
            otros.setdefault(A.norm(r["nombre"]), r["nombre"])
        otros.pop(A.norm(f["nombre"]), None)
        for n in dobles:
            otros.pop(n, None)
        if not otros:
            continue
        out.append(f"- {', '.join(f'«{t}»' for t in otros.values())} = {f['nombre']}")
        if len(out) >= TOPE_LINEAS:
            break
    return out


def con_bloque(mision: str, lineas: list[str]) -> str:
    base = BLOQUE.sub("\n", mision or "").rstrip()
    if not lineas:
        return base
    return (f"{base}\n\n{INICIO}\nEstos nombres son la misma entidad: al guardar, usá siempre el nombre de la derecha "
            f"(nunca crees una entidad aparte para los de la izquierda).\n" + "\n".join(lineas) + f"\n{FIN}")


def firma_bloque(lineas: list[str]) -> str:
    return hashlib.sha1("\n".join(lineas).encode()).hexdigest()[:12]


def actualizar_mision(con: sqlite3.Connection) -> dict:
    lineas = lineas_bloque(con)
    cfg = _call("GET", "/config")["config"]
    actual = cfg.get("retain_mission") or ""
    nueva = con_bloque(actual, lineas)
    if nueva != actual.rstrip():
        _call("PATCH", "/config", {"updates": {"retain_mission": nueva}})
        return {"mision": "actualizada", "lineas": len(lineas)}
    return {"mision": "igual", "lineas": len(lineas)}


# ---------- 3. sanar lo viejo ----------
# Los documentos que la memoria guardó con un apodo se re-etiquetan SIN LLM: se exportan (hechos + nombres de
# entidades), se cambia cada apodo por el nombre de la ficha en la lista de entidades de cada hecho y se vuelven a
# importar reemplazando (`document-transfer`, on_conflict=replace: re-resuelve entidades, no extrae nada). El texto de
# los hechos queda igual. NO se usa `/reprocess`: vuelve a extraer con la misión de HOY, que es más estricta que la de
# cuando se guardó, y se pierden hechos (probado 22/10: 30 → 18 hechos en 12 documentos; se restauraron del backup).

def mapa_apodos(con: sqlite3.Connection) -> dict[str, str]:
    """norm(apodo o nombre con que la memoria tiene a alguien) → nombre de su ficha (solo fichas confirmadas)."""
    out: dict[str, str] = {}
    for f in con.execute("SELECT id, nombre FROM fichas WHERE estado='confirmado'").fetchall():
        for r in con.execute("SELECT texto FROM nombres WHERE ficha_id=? AND clase='apodo'", (f["id"],)):
            out[A.norm(r["texto"])] = f["nombre"]
        for r in con.execute("SELECT nombre FROM entidades WHERE ficha_id=?", (f["id"],)):
            out[A.norm(r["nombre"])] = f["nombre"]
        out.pop(A.norm(f["nombre"]), None)
    dobles = ambiguos(con)
    return {k: v for k, v in out.items() if k not in dobles}


def ambiguos(con: sqlite3.Connection) -> set[str]:
    """Nombres que en la agenda son de más de una ficha («Manu» = Jose Manuel Mora y también el contacto «Manu😁»):
    ni van al bloque de la misión ni se re-etiquetan. El secretario los pregunta cuando hace falta."""
    return {r["norm"] for r in con.execute("SELECT norm FROM nombres GROUP BY norm HAVING COUNT(DISTINCT ficha_id) > 1")}


def _multipart(campo: str, nombre: str, data: bytes) -> tuple[bytes, str]:
    import uuid as _u
    bd = _u.uuid4().hex
    cuerpo = (f'--{bd}\r\nContent-Disposition: form-data; name="{campo}"; filename="{nombre}"\r\n'
              "Content-Type: application/zip\r\n\r\n").encode() + data + f"\r\n--{bd}--\r\n".encode()
    return cuerpo, f"multipart/form-data; boundary={bd}"


def _esperar(op: str, tope: float = 120) -> dict:
    t = time.time()
    while time.time() - t < tope:
        s = _call("GET", f"/operations/{op}")
        if s.get("status") in ("completed", "failed"):
            return s
        time.sleep(2)
    return {"status": "timeout"}


def reetiquetar(docs: list[str], mapa: dict[str, str]) -> dict:
    import io
    import urllib.parse
    import zipfile

    q = "&".join(f"document_id={urllib.parse.quote(d)}" for d in docs)
    op = _call("POST", f"/document-transfer/export?{q}", {})
    s = _esperar(op["operation_id"])
    if s.get("status") != "completed":
        return {"error": f"export {s.get('status')}: {s.get('error_message')}"}
    with urllib.request.urlopen(f"{HINDSIGHT}{s['result_metadata']['download_url']}", timeout=60) as r:
        zin = zipfile.ZipFile(io.BytesIO(r.read()))
    cambios = 0
    out = io.BytesIO()
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as zout:
        for n in zin.namelist():
            raw = zin.read(n)
            if n.startswith("documents/"):
                d = json.loads(raw)
                for fct in d.get("facts") or []:
                    nuevas: list[str] = []
                    for e in fct.get("entities") or []:
                        c = mapa.get(A.norm(e), e)
                        cambios += c != e
                        if c not in nuevas:
                            nuevas.append(c)
                    fct["entities"] = nuevas
                raw = json.dumps(d, ensure_ascii=False).encode()
            zout.writestr(n, raw)
    cuerpo, ctype = _multipart("file", "agenda.zip", out.getvalue())
    req = urllib.request.Request(f"{HINDSIGHT}/v1/default/banks/{BANK}/document-transfer?on_conflict=replace",
                                 data=cuerpo, method="POST", headers={"content-type": ctype})
    with urllib.request.urlopen(req, timeout=60) as r:
        op = json.loads(r.read())
    s = _esperar(op["operation_id"])
    if s.get("status") != "completed":
        return {"error": f"import {s.get('status')}: {s.get('error_message')}"}
    return {"documentos": len(docs), "entidades_cambiadas": cambios}


def sanar(con: sqlite3.Connection, tope: int = REPROCESAR_POR_PASADA) -> dict:
    """Documentos donde la memoria guardó a alguien con un apodo → re-etiquetar con el nombre de su ficha."""
    mapa = mapa_apodos(con)
    firma = hashlib.sha1(json.dumps(sorted(mapa.items()), ensure_ascii=False).encode()).hexdigest()[:12]
    try:
        _call("DELETE", f"/documents/{DOC_VIEJO}")  # sus apodos ahora viven en la agenda y en la misión
    except urllib.error.HTTPError:
        pass
    if not mapa:
        return {"reetiquetados": 0}
    docs: list[str] = []
    for e in _entidades():
        if A.norm(e["canonical_name"]) not in mapa:
            continue
        try:
            units = _call("GET", f"/memories/list?entity_id={e['id']}&limit=200").get("items", [])
        except urllib.error.HTTPError:
            continue
        for u in units:
            d = u.get("document_id")
            if d and d != DOC_VIEJO and d not in docs:
                docs.append(d)
    listos: list[str] = []
    saltados = 0
    for d in docs:
        if len(listos) >= tope:
            break
        k = f"reetiquetado:{d}"
        r = con.execute("SELECT v FROM meta WHERE k=?", (k,)).fetchone()
        if r and r["v"] == firma:
            continue
        todas = _call("GET", f"/memories/list?document_id={d}&limit=200").get("items", [])
        invalidadas = _call("GET", f"/memories/list?document_id={d}&state=invalidated&limit=50").get("items", [])
        if invalidadas or any(u.get("edited_at") for u in todas):
            saltados += 1  # tiene correcciones del dueño: no se toca (queda unido en la consola igual)
            con.execute("INSERT OR REPLACE INTO meta (k, v) VALUES (?, ?)", (k, firma))
            continue
        listos.append(d)
    res: dict[str, Any] = {"reetiquetados": 0, "saltados_por_correcciones": saltados}
    if listos:
        r = reetiquetar(listos, mapa)
        if "error" in r:
            return {**res, **r}
        for d in listos:
            con.execute("INSERT OR REPLACE INTO meta (k, v) VALUES (?, ?)", (f"reetiquetado:{d}", firma))
        res.update(reetiquetados=len(listos), entidades_cambiadas=r["entidades_cambiadas"])
    res["pendientes"] = max(0, len(docs) - len(listos) - saltados)
    return res


# ---------- 4. sembrar desde lo que ya sabe la memoria ----------

SISTEMA_SEMILLA = """Te paso todos los datos que guardó la memoria de un secretario personal (uno por línea).
Sacá quién tiene MÁS DE UN NOMBRE (apodos, nombre completo, cómo figura agendado) y también a quien tenga un número de
celular conocido aunque tenga un solo nombre. Solo lo que digan los datos; no inventes.
Devolvé SOLO un JSON: {"identidades": [{"nombre": "el nombre completo o más formal", "otros": ["apodos y otras formas"],
"numero": "celular si figura, si no vacío", "relacion": "qué es para el dueño, corto, si figura", "tipo": "persona|grupo|lugar|cuenta"}]}
Incluí al dueño. No incluyas alias de cuentas bancarias (palta.camote.mp) como nombres. No pongas como «otros» frases genéricas
(«el usuario», «mi amigo»), salvo las que el dueño usa como nombre («mi vieja» para la madre)."""


def _pedir_json(sistema: str, usuario: str) -> dict:
    body = json.dumps({
        "model": MODELO, "temperature": 0.1, "response_format": {"type": "json_object"},
        "messages": [{"role": "system", "content": sistema}, {"role": "user", "content": usuario}],
    }).encode()
    req = urllib.request.Request("https://openrouter.ai/api/v1/chat/completions", data=body, method="POST",
                                 headers={"content-type": "application/json", "authorization": f"Bearer {OPENROUTER_KEY}"})
    for intento in range(3):  # a veces el modelo devuelve el mensaje vacío
        with urllib.request.urlopen(req, timeout=180) as r:
            crudo = (json.loads(r.read())["choices"][0]["message"].get("content") or "").strip()
        if crudo:
            return json.loads(re.sub(r"^```(json)?\s*|\s*```$", "", crudo))
        time.sleep(3 * (intento + 1))
    raise RuntimeError("el modelo devolvió vacío 3 veces")


def sembrar(con: sqlite3.Connection, forzar: bool = False) -> dict:
    if not OPENROUTER_KEY:
        return {"semilla": "sin_key"}
    if not forzar and con.execute("SELECT 1 FROM meta WHERE k='semilla'").fetchone():
        return {"semilla": "ya_hecha"}
    textos: list[str] = []
    off = 0
    while True:
        j = _call("GET", f"/memories/list?limit=200&offset={off}")
        textos += [u["text"].split(" | ")[0].strip() for u in j.get("items", []) if u.get("fact_type") in ("world", "observation")]
        off += 200
        if off >= j.get("total", 0) or not j.get("items"):
            break
    textos = list(dict.fromkeys(t for t in textos if t))
    res = _pedir_json(SISTEMA_SEMILLA, "\n".join(textos)[:120_000])
    aplicadas = creadas = 0
    con.execute("BEGIN")
    try:
        for i in res.get("identidades", []):
            nombre = (i.get("nombre") or "").strip()
            otros = [o.strip() for o in i.get("otros") or []
                     if o and o.strip() and A.norm(o) != A.norm(nombre) and "(" not in o and "." not in o]
            num = re.sub(r"\D", "", i.get("numero") or "")
            if not nombre or (not otros and len(num) < 10):
                continue
            tipo = i.get("tipo") if i.get("tipo") in ("persona", "grupo", "lugar", "cuenta") else "persona"
            f = None
            if len(num) >= 10:
                f = con.execute("SELECT * FROM fichas WHERE wa_jid LIKE ?", (f"%{num[-10:]}@s.whatsapp.net",)).fetchone()
            if f is None and tipo == "persona":
                f = A.misma_persona(con, [nombre] + otros)
            if f is None:
                cands = A._exactos(con, [nombre])
                f = cands[0] if len(cands) == 1 else None
            if f is None:
                fid = A.crear(con, nombre, tipo=tipo, estado="confirmado", origen="memoria", relacion=i.get("relacion") or None)
                creadas += 1
            else:
                fid = f["id"]
                if i.get("relacion"):
                    con.execute("UPDATE fichas SET relacion=COALESCE(relacion, ?) WHERE id=?", (i["relacion"], fid))
                # El nombre completo que conoce la memoria es mejor que cómo está agendado («Benjamin ortiz»).
                if f["estado"] in ("contacto", "sin_identificar") and len(A.palabras(nombre)) >= len(A.palabras(f["nombre"])):
                    con.execute("UPDATE fichas SET nombre=?, estado='confirmado' WHERE id=?", (nombre, fid))
            A._poner_nombre(con, fid, nombre, "nombre", "memoria")
            for o in otros:
                A._poner_nombre(con, fid, o, "apodo", "memoria")
            aplicadas += 1
        con.execute("INSERT OR REPLACE INTO meta (k, v) VALUES ('semilla', ?)", (str(time.time()),))
        A._version_mas(con)
        con.execute("COMMIT")
    except Exception:
        con.execute("ROLLBACK")
        raise
    return {"semilla": "hecha", "identidades": aplicadas, "fichas_nuevas": creadas}


# ---------- unir / separar desde la consola (compatible con «es la misma que…») ----------

def _ficha_de_entidad(con: sqlite3.Connection, entidad_id: str, nombre: str) -> str:
    r = con.execute("SELECT ficha_id FROM entidades WHERE entidad_id=?", (entidad_id,)).fetchone()
    if r:
        return r["ficha_id"]
    cands = A._exactos(con, [nombre])
    fid = cands[0]["id"] if len(cands) == 1 else A.crear(con, nombre, estado="confirmado", origen="consola")
    con.execute("INSERT OR REPLACE INTO entidades (entidad_id, ficha_id, nombre, origen, at) VALUES (?, ?, ?, 'consola', ?)",
                (entidad_id, fid, nombre, time.time()))
    return fid


def unir(con: sqlite3.Connection, alias_id: str, alias_nombre: str, canon_id: str, canon_nombre: str) -> dict:
    con.execute("BEGIN")
    try:
        destino = _ficha_de_entidad(con, canon_id, canon_nombre)
        origen = _ficha_de_entidad(con, alias_id, alias_nombre)
        if origen != destino:
            A.fusionar(con, origen, destino)
        con.execute("UPDATE entidades SET ficha_id=?, origen='consola' WHERE entidad_id=?", (destino, alias_id))
        con.execute("DELETE FROM no_enlazar WHERE entidad_id=? AND ficha_id=?", (alias_id, destino))
        A._poner_nombre(con, destino, alias_nombre, "apodo", "consola")
        # El nombre que el dueño eligió que quede manda (si no, una ficha de WhatsApp queda con cómo está agendado,
        # «Bernabe Sssa», y la memoria reescribiría el nombre bueno con el typo).
        A._poner_nombre(con, destino, canon_nombre, "nombre", "consola")
        con.execute("UPDATE fichas SET nombre=?, estado='confirmado', actualizado=? WHERE id=?", (canon_nombre, time.time(), destino))
        A._version_mas(con)
        con.execute("COMMIT")
    except Exception:
        con.execute("ROLLBACK")
        raise
    return {"ok": True, "ficha": destino}


def separar(con: sqlite3.Connection, alias_id: str) -> dict:
    """alias_id = entidad de la memoria, o «apodo:<ficha>:<norm>» (un apodo de la agenda sin entidad propia)."""
    con.execute("BEGIN")
    try:
        if alias_id.startswith("apodo:"):
            _, fid, n = alias_id.split(":", 2)
            con.execute("DELETE FROM nombres WHERE ficha_id=? AND norm=? AND clase='apodo'", (fid, n))
            for e in con.execute("SELECT entidad_id FROM entidades WHERE ficha_id=?", (fid,)).fetchall():
                r = con.execute("SELECT nombre FROM entidades WHERE entidad_id=?", (e["entidad_id"],)).fetchone()
                if r and A.norm(r["nombre"]) == n:
                    con.execute("DELETE FROM entidades WHERE entidad_id=?", (e["entidad_id"],))
                    con.execute("INSERT OR IGNORE INTO no_enlazar (entidad_id, ficha_id) VALUES (?, ?)", (e["entidad_id"], fid))
        else:
            r = con.execute("SELECT ficha_id, nombre FROM entidades WHERE entidad_id=?", (alias_id,)).fetchone()
            if not r:
                con.execute("ROLLBACK")
                return {"ok": False, "error": "no_estaba"}
            con.execute("DELETE FROM entidades WHERE entidad_id=?", (alias_id,))
            con.execute("INSERT OR IGNORE INTO no_enlazar (entidad_id, ficha_id) VALUES (?, ?)", (alias_id, r["ficha_id"]))
            con.execute("DELETE FROM nombres WHERE ficha_id=? AND norm=? AND clase='apodo'", (r["ficha_id"], A.norm(r["nombre"])))
        A._version_mas(con)
        con.execute("COMMIT")
    except Exception:
        con.execute("ROLLBACK")
        raise
    return {"ok": True}


def grupos(con: sqlite3.Connection) -> list[dict]:
    """Formato de /memory/aliases (la pantalla de memoria): por ficha confirmada con una entidad «canónica» en la
    memoria, sus otros nombres — otras entidades enlazadas y apodos de la agenda (aunque la memoria ya no los tenga
    como entidad aparte, p. ej. después de sanar)."""
    out: list[dict] = []
    for f in con.execute("SELECT id, nombre FROM fichas WHERE estado='confirmado'").fetchall():
        ents = con.execute("SELECT entidad_id, nombre FROM entidades WHERE ficha_id=? ORDER BY at", (f["id"],)).fetchall()
        if not ents:
            continue
        canon = next((e for e in ents if A.norm(e["nombre"]) == A.norm(f["nombre"])), ents[0])
        vistos = {A.norm(canon["nombre"])}
        for e in ents:
            if e["entidad_id"] != canon["entidad_id"]:
                vistos.add(A.norm(e["nombre"]))
                out.append({"alias_id": e["entidad_id"], "alias_nombre": e["nombre"],
                            "canonico_id": canon["entidad_id"], "canonico_nombre": f["nombre"], "ficha": f["id"]})
        for r in con.execute("SELECT texto, norm FROM nombres WHERE ficha_id=? AND clase='apodo' ORDER BY at", (f["id"],)):
            if r["norm"] in vistos:
                continue
            vistos.add(r["norm"])
            out.append({"alias_id": f"apodo:{f['id']}:{r['norm']}", "alias_nombre": r["texto"],
                        "canonico_id": canon["entidad_id"], "canonico_nombre": f["nombre"], "ficha": f["id"]})
    return out


def pasada(con: sqlite3.Connection) -> dict:
    """Lo que corre solo cada pocos minutos (y al toque cuando cambia la agenda)."""
    if not BANK:
        return {"memoria": "sin_banco"}
    out: dict[str, Any] = {}
    out.update(enlazar(con))
    out.update(actualizar_mision(con))
    out.update(sanar(con))
    return out
