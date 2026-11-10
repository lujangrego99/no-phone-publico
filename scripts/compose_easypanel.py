"""Genera el compose «inline» para Easypanel a partir de compose.yaml + compose.vps.yaml.

Easypanel administra los contenedores (start/stop/logs/env); las imágenes se compilan en el VPS
(scripts/build-hermes-base.sh + docker compose build), así el repo privado no necesita acceso desde Easypanel.
Los volúmenes llevan nombre fijo (no-phone_*) para no depender del nombre de proyecto que use Easypanel.

  python scripts/compose_easypanel.py > /tmp/nophone-easypanel.yml
"""
import json
import subprocess
import sys
from pathlib import Path

RAIZ = Path(__file__).resolve().parent.parent

crudo = subprocess.run(
    ["docker", "compose", "-f", "compose.yaml", "-f", "compose.vps.yaml", "config",
     "--no-interpolate", "--no-path-resolution", "--format", "json"],
    cwd=RAIZ, check=True, capture_output=True, text=True,
    env={"PATH": "/usr/bin:/bin:/usr/local/bin", "AGENTE_CTL_TOKEN": "x", "AGENTE_HOST": "x"},
).stdout
c = json.loads(crudo)
c.pop("name", None)
for nombre in ("adb", "hermes-base"):
    c["services"].pop(nombre, None)
for nombre, s in c["services"].items():
    if "build" in s:
        s.pop("build")
        s["pull_policy"] = "never"
    if not s.get("image"):
        sys.exit(f"{nombre}: sin image")
    s.pop("container_name", None)
    s.pop("profiles", None)
    # env_file relativo al directorio del compose (Easypanel escribe ahí el .env de su pestaña Environment)
    if "env_file" in s:
        s["env_file"] = [".env"]
for nombre, v in (c.get("volumes") or {}).items():
    v["name"] = f"no-phone_{nombre}"
json.dump(c, sys.stdout, indent=1, ensure_ascii=False)
print()
