#!/bin/sh
# Compila la imagen base de Hermes (no-phone-hermes-base) desde GitHub, en el commit fijado (HERMES_REF).
# Se usa `docker build` directo con «repo.git?ref=<commit>»: el BuildKit nuevo (Docker 29) no resuelve
# «repo.git#<commit>», y compose no reconoce «?ref=» como repo remoto.
#   scripts/build-hermes-base.sh && docker compose build hermes admin
set -eu
REF="${HERMES_REF:-$(sed -n 's/^HERMES_REF=//p' "$(dirname "$0")/../.env" 2>/dev/null | tail -1)}"
REF="${REF:-25c7827ec95c5f41cc90b1eeb147b92f0032ad3d}"
echo "hermes-base ← NousResearch/hermes-agent@$REF"
docker build -t no-phone-hermes-base:latest "https://github.com/NousResearch/hermes-agent.git?ref=$REF"
