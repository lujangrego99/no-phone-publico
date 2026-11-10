#!/bin/sh
set -e
cd /opt/no-phone
docker compose -f compose.yaml -f compose.vps.yaml build $*
echo BUILD_OK
