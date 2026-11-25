#!/usr/bin/env bash
# Muda los volúmenes de no-phone de esta PC al VPS (mismos nombres: proyecto compose «no-phone»).
# Requiere el stack local DETENIDO (WhatsApp, Hermes y la memoria no pueden correr en dos lados).
#   SSHPASS=… scripts/mudar-a-vps.sh root@IP
set -euo pipefail
DEST=${1:?root@ip}
SSH="sshpass -e ssh -o ConnectTimeout=10 $DEST"
# stt-models y tts-voces no viajan: el VPS se baja los modelos solo (y más rápido).
VOLS="app-data wa-data hermes-data hindsight-data admin-data"

if docker ps --format '{{.Names}}' | grep -q '^no-phone-'; then
  echo "El stack local sigue corriendo: docker compose stop primero." >&2
  exit 1
fi
for v in $VOLS; do
  echo "== $v"
  $SSH "docker volume create no-phone_$v >/dev/null"
  # hermes-data: la caché de uv (~4 GB) se regenera sola; no viaja.
  excl=""
  [ "$v" = hermes-data ] && excl="--exclude=./home/.cache/uv"
  docker run --rm -v "no-phone_$v:/v:ro" alpine sh -c "cd /v && tar -cf - $excl ." \
    | gzip -1 \
    | $SSH "docker run --rm -i -v no-phone_$v:/v alpine sh -c 'cd /v && gunzip | tar -xpf -'"
  echo "   $(docker run --rm -v no-phone_$v:/v:ro alpine du -sh /v | cut -f1) local → $($SSH "docker run --rm -v no-phone_$v:/v:ro alpine du -sh /v" | cut -f1) VPS"
done
echo MUDANZA_OK
