#!/usr/bin/env bash
# Corre en la máquina que tiene el celu por USB (casa). Expone el adb server local (127.0.0.1:5037)
# en UNA IP concreta para que el contenedor no-phone (ADB_MODE=remote) lo use:
#   - VPS:   la IP de Tailscale/WireGuard de esta máquina   → scripts/adb-gateway.sh 100.x.y.z
#   - local: el gateway de Docker                            → scripts/adb-gateway.sh 172.17.0.1
# El protocolo adb NO tiene auth: quien llegue a ese puerto controla el celu (y la billetera).
# Nunca 0.0.0.0 ni una IP pública.
set -euo pipefail
BIND="${1:?uso: adb-gateway.sh <ip-a-escuchar> [puerto]}"
PORT="${2:-5037}"
case "$BIND" in 0.0.0.0|::|"*") echo "no: $BIND expone el celu a toda la red" >&2; exit 64 ;; esac
command -v socat >/dev/null || { echo "falta socat" >&2; exit 69; }
adb start-server >/dev/null
adb devices -l
echo "adb gateway: $BIND:$PORT → 127.0.0.1:5037"
exec socat "TCP-LISTEN:$PORT,bind=$BIND,reuseaddr,fork" TCP:127.0.0.1:5037
