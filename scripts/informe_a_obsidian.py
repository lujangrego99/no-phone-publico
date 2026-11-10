#!/usr/bin/env python3
"""Pasa los informes de calidad nuevos de la consola a Obsidian (no-phone/informes/) y hace commit + push del vault.

Corre por cron cada 30 min (toma el informe de la noche y los que se generen a pedido). Sin informes nuevos no hace
nada. El admin vive en Docker y no ve el vault: este script lee admin.db por `docker exec` (solo lectura).

  python3 scripts/informe_a_obsidian.py            # exporta los nuevos
  python3 scripts/informe_a_obsidian.py --todos    # re-exporta todos (sobrescribe las notas)
"""
import json
import os
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

VAULT = Path(os.environ.get("NOPHONE_VAULT", "/mnt/c/Users/samsung/Documents/GitHub/obsidian-personal"))
CARPETA = VAULT / "no-phone" / "informes"
NOTA = VAULT / "no-phone" / "MEJORA-CONTINUA.md"
ESTADO = Path.home() / ".local/state/no-phone/informe_obsidian_ultimo"
CONTENEDOR = os.environ.get("ADMIN_CONTAINER", "no-phone-admin-1")
TZ = ZoneInfo("America/Argentina/Mendoza")
DONDE = {"codigo": "código", "desconocida": "¿?"}

LEER = r"""
const {DatabaseSync}=require('node:sqlite');
const db=new DatabaseSync('/admin-data/admin.db',{readOnly:true});
const inf=db.prepare('SELECT id, tenant_id, at, n_charlas, modelo, contenido FROM informes WHERE id > ? ORDER BY id').all(Number(process.argv[1]));
const tit=Object.fromEntries(db.prepare('SELECT session_id, titulo FROM charlas_lista').all().map(r=>[r.session_id, r.titulo]));
console.log(JSON.stringify({inf, tit}));
"""


def leer(desde: int):
    r = subprocess.run(["docker", "exec", "-w", "/opt/no-phone-admin", CONTENEDOR, "node", "-e", LEER, str(desde)],
                       capture_output=True, text=True, timeout=60)
    if r.returncode != 0:
        sys.exit(f"no pude leer los informes: {r.stderr.strip()[:300]}")
    return json.loads(r.stdout)


def local(at: str) -> datetime:
    return datetime.strptime(at, "%Y-%m-%d %H:%M:%S").replace(tzinfo=timezone.utc).astimezone(TZ)


def nombre(i: dict) -> str:
    return f"{local(i['at']):%Y-%m-%d %H%M} informe {i['id']}"


def nota(i: dict, titulos: dict) -> str:
    c = json.loads(i["contenido"])
    n = c.get("numeros", {})
    cuando = local(i["at"])
    resena = f" · {n['con_resena']} con reseña" if n.get("con_resena") else ""
    out = [
        f"# Informe {i['id']} · {cuando:%d/%m/%Y %H:%M}",
        "",
        f"> {i['n_charlas']} charlas · bien {n.get('bien', 0)} · regular {n.get('regular', 0)} · mal {n.get('mal', 0)}"
        f"{resena}"
        f" · `{i['modelo']}` · tenant `{i['tenant_id']}`. Generado por la consola; se ve también en la pestaña «informes». "
        "Volcá lo que vayas a arreglar en [[MEJORA-CONTINUA#Arreglos pendientes]].",
        "",
        c.get("resumen", ""),
        "",
        "## Temas (de más a menos importante)",
        "",
    ]
    for k, t in enumerate(c.get("temas", []), 1):
        donde = DONDE.get(t.get("donde", ""), t.get("donde", ""))
        out.append(f"### {k}. {t.get('titulo', '')}")
        out.append(f"Gravedad {t.get('gravedad', '?')} · {t.get('veces', 1)} {'vez' if t.get('veces', 1) == 1 else 'veces'} · dónde: **{donde}**")
        out.append("")
        if t.get("que_pasa"):
            out.append(f"- **Qué pasa:** {t['que_pasa']}")
        if t.get("que_cambiar"):
            out.append(f"- **Qué cambiar:** {t['que_cambiar']}")
        if t.get("evidencia"):
            out.append(f"- **Evidencia:** «{t['evidencia']}»")
        charlas = [f"{titulos.get(s) or s} (`{s}`)" for s in t.get("charlas", [])]
        if charlas:
            out.append(f"- **En:** {' · '.join(charlas)}")
        out.append("")
    if c.get("anda_bien"):
        out += ["## Anda bien (no romper)", ""] + [f"- {b}" for b in c["anda_bien"]] + [""]
    return "\n".join(out)


def anotar_en_indice(nuevos: list[dict]):
    """Lista «Informes» en MEJORA-CONTINUA.md: un link por informe, el más nuevo arriba."""
    texto = NOTA.read_text(encoding="utf-8") if NOTA.exists() else "# Mejora continua\n"
    titulo = "## Informes (se agregan solos)"
    if titulo not in texto:
        texto = texto.rstrip() + f"\n\n{titulo}\n\n"
    cab, _, resto = texto.partition(titulo)
    lineas = resto.split("\n")
    # lista = líneas «- [[...]]» justo después del título; lo demás (otras secciones) se conserva
    lista, i = [], 0
    while i < len(lineas) and (not lineas[i].strip() or lineas[i].startswith("- [[")):
        if lineas[i].startswith("- [["):
            lista.append(lineas[i])
        i += 1
    for inf in nuevos:
        c = json.loads(inf["contenido"])
        n = c.get("numeros", {})
        temas = c.get("temas", [])
        top = f" — {temas[0]['titulo']}" if temas else ""
        linea = (f"- [[informes/{nombre(inf)}|{local(inf['at']):%d/%m %H:%M}]] · {inf['n_charlas']} charlas "
                 f"(bien {n.get('bien', 0)} · regular {n.get('regular', 0)} · mal {n.get('mal', 0)}) · {len(temas)} temas{top}")
        lista = [l for l in lista if f"informe {inf['id']}|" not in l and f"informe {inf['id']}]]" not in l]
        lista.insert(0, linea)
    NOTA.write_text(cab + titulo + "\n\n" + "\n".join(lista) + "\n" + ("\n" + "\n".join(lineas[i:]) if lineas[i:] and "".join(lineas[i:]).strip() else ""), encoding="utf-8")


def git(*args):
    return subprocess.run(["git", "-C", str(VAULT), *args], capture_output=True, text=True, timeout=120)


def main():
    todos = "--todos" in sys.argv
    desde = 0 if todos or not ESTADO.exists() else int(ESTADO.read_text().strip() or 0)
    datos = leer(desde)
    nuevos = datos["inf"]
    if not nuevos:
        return
    CARPETA.mkdir(parents=True, exist_ok=True)
    archivos = []
    for inf in nuevos:
        f = CARPETA / f"{nombre(inf)}.md"
        f.write_text(nota(inf, datos["tit"]), encoding="utf-8")
        archivos.append(f)
    anotar_en_indice(nuevos)
    rel = [str(f.relative_to(VAULT)) for f in archivos] + [str(NOTA.relative_to(VAULT))]
    git("add", *rel)
    r = git("commit", "-q", "-m", f"no-phone: informe{'s' if len(nuevos) > 1 else ''} de calidad {', '.join(str(i['id']) for i in nuevos)}")
    if r.returncode == 0:
        p = git("push", "-q")
        if p.returncode != 0:  # el commit queda; se sube en el próximo push (de esto o de Obsidian Git)
            print(f"push falló: {p.stderr.strip()[:200]}", file=sys.stderr)
    ESTADO.parent.mkdir(parents=True, exist_ok=True)
    ESTADO.write_text(str(max(i["id"] for i in nuevos)))
    print(f"exportados: {', '.join(str(i['id']) for i in nuevos)}")


if __name__ == "__main__":
    main()
