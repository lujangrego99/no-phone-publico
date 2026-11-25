"""Prepara el HERMES_HOME del contenedor `hermes` antes de que arranque (servicio `init`).

- config.yaml: si no existe, uno mínimo (modelo, memoria Hindsight). Siempre: los tres conectores
  apuntando a los MCP HTTP del compose con el token de .env (si cambia el token, se re-sincroniza).
- SOUL.md: la plantilla del secretario si no hay una.
- hindsight/config.json: memoria en http://hindsight:8888 (la consola fija el banco en el setup).

Idempotente: lo que el usuario cambió (modelo, personalidad, recall) no se pisa.
"""
from __future__ import annotations

import json
import os
import sys
from pathlib import Path

HOME = Path(os.environ.get("HERMES_HOME_DIR", "/hermes"))
TEMPLATES = Path(__file__).resolve().parent.parent / "admin" / "server" / "templates"
TOKEN = os.environ.get("MCP_HTTP_TOKEN", "")

MCPS = {
    "naranjax": os.environ.get("MCP_NARANJAX_URL", "http://nophone-mcp:8810/mcp"),
    "whatsapp": os.environ.get("MCP_WHATSAPP_URL", "http://nophone-mcp-whatsapp:8811/mcp"),
    "movilidad": os.environ.get("MCP_MOVILIDAD_URL", "http://nophone-mcp-movilidad:8812/mcp"),
    "reglas": os.environ.get("MCP_REGLAS_URL", "http://nophone-mcp-reglas:8813/mcp"),
    "agenda": os.environ.get("MCP_AGENDA_URL", "http://nophone-mcp-agenda:8814/mcp"),
}

# Herramientas propias de Hermes que el secretario puede usar cuando atiende (chat de la consola) y en tareas
# programadas. Sin terminal, archivos, código, navegador, delegación ni skills: lee mensajes de terceros y no
# corre aislado, así que nada que ejecute cosas o se reescriba a sí mismo. Tampoco `memory` (la memoria en archivo
# de Hermes, USER.md): la memoria es Hindsight y las reglas van por el conector secretario, un solo lugar para cada
# cosa. Si ya hay una lista, no se pisa. Web: solo «search» (buscar); para leer una página está web_leer del
# conector de reglas (sin key), porque el web_extract de Hermes con ddgs no lee nada y el modelo lo intenta igual.
TOOLSETS_SEGUROS = ["cronjob", "session_search", "todo", "vision", "search"]


def contexto_memoria(dueno: str) -> str:
    return (f"Charla por chat entre {dueno} (el dueño) y su secretario personal. Las líneas «{dueno}: …» son lo que dice "
            "el dueño; las «Secretario: …» son lo que contesta el secretario (lo que él hace no es un dato del dueño).")


def load_yaml(p: Path) -> dict:
    try:
        import yaml  # viene con uvicorn[standard]? no siempre: fallback JSON

        return yaml.safe_load(p.read_text()) or {}
    except ModuleNotFoundError:
        return json.loads(p.read_text())


def dump(p: Path, data: dict) -> None:
    # JSON es YAML válido: Hermes lo lee igual y no dependemos de PyYAML acá.
    tmp = p.with_suffix(".tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n")
    tmp.chmod(0o600)
    tmp.replace(p)


def main() -> int:
    if not TOKEN:
        print("[init] falta MCP_HTTP_TOKEN en .env (corré docker/instalar.sh)", file=sys.stderr)
        return 1
    HOME.mkdir(parents=True, exist_ok=True)

    cfg_path = HOME / "config.yaml"
    cfg = load_yaml(cfg_path) if cfg_path.exists() else {}
    cfg.setdefault(
        "model",
        {
            "provider": os.environ.get("HERMES_MODEL_PROVIDER", "deepseek"),
            "default": os.environ.get("HERMES_MODEL", "deepseek-v4-flash"),
            "base_url": os.environ.get("HERMES_MODEL_BASE_URL", "https://api.deepseek.com/v1"),
        },
    )
    # El modelo aguanta 1M: con 64k comprimía a los pocos mensajes (el resumen tarda ~1 min).
    comp = cfg.setdefault("compression", {})
    comp.setdefault("enabled", True)
    comp.setdefault("threshold_tokens", 200_000)
    # Herramientas de los MCP a la vista desde el principio: con tool_search el modelo gastaba una vuelta
    # (tool_describe) por cada herramienta antes de usarla, ~3 s cada una.
    cfg.setdefault("tools", {}).setdefault("tool_search", {}).setdefault("enabled", "off")
    # Sin «pensar» antes de cada respuesta: con deepseek-v4-flash baja ~1–2 s por llamada al modelo y para usar
    # herramientas de secretario no cambia la calidad (medido en rondas r2/r3, 2026-10-21).
    cfg.setdefault("agent", {}).setdefault("reasoning_effort", "none")
    # Tope de vueltas por mensaje (Hermes trae 90): un pedido normal usa 1–8; a veces el modelo repite una
    # herramienta que falla siempre igual (22 cronjob sin hora) y con 90 se queda minutos. 20 corta antes.
    cfg["agent"].setdefault("max_turns", 20)
    mem = cfg.setdefault("memory", {})
    mem.setdefault("memory_enabled", True)
    mem.setdefault("provider", "hindsight")
    pts = cfg.setdefault("platform_toolsets", {})
    for plataforma in ("api_server", "cron"):
        lst = pts.setdefault(plataforma, list(TOOLSETS_SEGUROS))
        if "web" in lst:  # instalaciones anteriores: buscar sí, web_extract (no anda con ddgs) no
            lst[lst.index("web")] = "search"
    servers = cfg.setdefault("mcp_servers", {})
    servers.pop("secretario", None)  # el conector de reglas se llamaba así hasta 2026-10-21
    for name, url in MCPS.items():
        cur = servers.get(name) or {}
        # Si venía de una instalación local (command/args), pasa a HTTP.
        for k in ("command", "args", "env"):
            cur.pop(k, None)
        cur["url"] = url
        cur["headers"] = {"Authorization": f"Bearer {TOKEN}"}
        # Nuestros MCP no publican resources ni prompts: sin esto Hermes suma 4 herramientas vacías por conector
        # (16 schemas que el modelo lee en cada mensaje).
        tf = cur.setdefault("tools", {})
        tf.setdefault("resources", False)
        tf.setdefault("prompts", False)
        servers[name] = cur
    dump(cfg_path, cfg)

    soul = HOME / "SOUL.md"
    if not soul.exists():
        dueno = os.environ.get("SECRETARIO_DUENO", "tu dueño")
        soul.write_text((TEMPLATES / "soul.md").read_text().replace("{{dueno}}", dueno))
        soul.chmod(0o600)

    hcfg_path = HOME / "hindsight" / "config.json"
    hcfg_path.parent.mkdir(exist_ok=True)
    hcfg = json.loads(hcfg_path.read_text()) if hcfg_path.exists() else {
        "mode": "local_external",
        "memory_mode": "hybrid",
        "auto_recall": True,
        "recall_budget": "mid",
        "recall_max_tokens": 1200,
        "recall_types": "observation,world",
        "auto_retain": True,
        "retain_async": True,
        "retain_every_n_turns": 1,
        "retain_assistant_prefix": "Secretario",
    }
    # Sin esto Hermes etiqueta cada charla «conversation between Hermes Agent and the User» y la memoria guarda
    # «Hermes Agent», «the User» y «el usuario es…». setdefault: no pisa lo que se ajustó a mano o desde la consola.
    dueno = os.environ.get("SECRETARIO_DUENO", "el dueño")
    hcfg.setdefault("retain_context", contexto_memoria(dueno))
    hcfg["api_url"] = os.environ.get("HINDSIGHT_URL", "http://hindsight:8888")
    hcfg.setdefault("bank_id", os.environ.get("BANK_ID", "secretario"))
    hcfg_path.write_text(json.dumps(hcfg, ensure_ascii=False, indent=2) + "\n")
    hcfg_path.chmod(0o600)

    print(f"[init] {HOME} listo: conectores {', '.join(MCPS)} por HTTP · memoria {hcfg['api_url']} (banco {hcfg['bank_id']})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
