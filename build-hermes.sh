#!/bin/sh
set -e
cd /opt/no-phone
scripts/build-hermes-base.sh
docker compose -f compose.yaml -f compose.vps.yaml build hermes admin
echo BUILD_OK
