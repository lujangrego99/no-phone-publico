#!/usr/bin/env bash
# Instala/actualiza no-phone en esta PC con Docker. Idempotente: no pisa un .env existente.
#   ./docker/instalar.sh                 → celu por USB a esta PC
#   ADB_MODE=connect ADB_CONNECT=192.168.1.50:5555 ./docker/instalar.sh   → celu por WiFi
set -euo pipefail
cd "$(dirname "$0")/.."

command -v docker >/dev/null || { echo "Falta Docker: https://docs.docker.com/engine/install/" >&2; exit 1; }
docker compose version >/dev/null || { echo "Falta el plugin docker compose." >&2; exit 1; }

tok() { head -c 32 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 40; }

if [ ! -f .env ]; then
  umask 077
  cat > .env <<ENV
# no-phone — configuración local. NO se sube a git. (chmod 600)
# Tokens internos (generados): conectores MCP y puente de WhatsApp.
MCP_HTTP_TOKEN=$(tok)
WA_BRIDGE_TOKEN=$(tok)
# API interna del celu (la usa la consola)
WALLET_BOT_TOKEN=$(tok)
# API del secretario (la usa la llamada de la consola)
API_SERVER_KEY=$(tok)

# Celular: usb (enchufado a esta PC) | connect (WiFi, ADB_CONNECT=ip:5555)
ADB_MODE=${ADB_MODE:-usb}
ADB_CONNECT=${ADB_CONNECT:-}

# Memoria (Hindsight): LLM para guardar recuerdos. Sin esta key no aprende.
HINDSIGHT_API_LLM_API_KEY=
# HINDSIGHT_LLM_PROVIDER=deepseek
# HINDSIGHT_LLM_MODEL=deepseek-v4-flash
# HINDSIGHT_LLM_BASE_URL=https://api.deepseek.com

# Modelo del secretario: también se carga desde la consola (Secretario → modelo).
# DEEPSEEK_API_KEY=
# OPENAI_API_KEY=

# Movilidad (opcional): GOOGLE_MAPS_API_KEY=
SECRETARIO_DUENO=${SECRETARIO_DUENO:-tu dueño}
# Banco de memoria del secretario (el id que elegís en el setup de la consola). Lo usa el conector de reglas.
HINDSIGHT_BANK=
TZ=${TZ:-America/Argentina/Mendoza}
ENV
  echo "→ .env creado con tokens nuevos. Completá HINDSIGHT_API_LLM_API_KEY cuando la tengas."
fi

if grep -q '^ADB_MODE=usb' .env && command -v adb >/dev/null && adb devices >/dev/null 2>&1; then
  echo "⚠  Hay un adb server corriendo en esta PC y el contenedor necesita el USB del celu."
  echo "   Cerralo con: adb kill-server   (y no lo vuelvas a abrir mientras corre no-phone)"
fi

echo "→ Compilando y levantando (la primera vez tarda: Hermes se compila desde su repo)…"
docker compose --profile base build hermes-base   # Hermes de upstream, fijado
docker compose build hermes   # + docker/hermes_parches.py; admin parte de esta imagen
docker compose up -d --build
echo
echo "Listo. Consola: http://127.0.0.1:${ADMIN_PORT:-8890}  (la primera vez te pide crear tu usuario)"
echo "Estado: docker compose ps · Logs: docker compose logs -f hermes"
