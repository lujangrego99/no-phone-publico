#!/bin/sh
# Cómo llega el contenedor al celular (ADB_MODE):
#   remote  → usa un adb server de otro host (ANDROID_ADB_SERVER_HOST/PORT). El celu va por USB a ese host.
#             Es el modo VPS: casa (USB + adb server) ←tailnet→ VPS (este contenedor).
#   connect → levanta su propio adb server y hace `adb connect $ADB_CONNECT` (celu en `adb tcpip 5555`).
#   usb     → su propio adb server con /dev/bus/usb montado (solo local; matar el adb del host antes).
#   apk     → sin adb: los celus se conectan solos al hub de agentes (APK no-phone). Modo VPS sin PC en casa.
set -eu

ADB_MODE="${ADB_MODE:-remote}"

ADB="adb"
adb_state() { timeout 10 $ADB ${ANDROID_SERIAL:+-s "$ANDROID_SERIAL"} get-state 2>/dev/null || echo "sin-device"; }

if [ "$ADB_MODE" = apk ]; then
  echo "[no-phone] celus por la APK (hub de agentes ${AGENTE_HUB_URL:-ws://agente:8766}), sin adb"
  exec "$@"
fi

case "$ADB_MODE" in
  remote)
    : "${ANDROID_ADB_SERVER_HOST:?ADB_MODE=remote exige ANDROID_ADB_SERVER_HOST}"
    # adbutils/uiautomator2 leen ANDROID_ADB_SERVER_HOST/PORT; el CLI adb, ANDROID_ADB_SERVER_ADDRESS/PORT.
    export ANDROID_ADB_SERVER_HOST ANDROID_ADB_SERVER_PORT="${ANDROID_ADB_SERVER_PORT:-5037}"
    export ANDROID_ADB_SERVER_ADDRESS="$ANDROID_ADB_SERVER_HOST"
    ADB="adb -H $ANDROID_ADB_SERVER_HOST -P $ANDROID_ADB_SERVER_PORT"
    echo "[no-phone] adb remoto ${ANDROID_ADB_SERVER_HOST}:${ANDROID_ADB_SERVER_PORT}"
    timeout 10 $ADB devices -l || echo "[no-phone] WARN: adb server remoto no responde"
    ;;
  connect|usb)
    unset ANDROID_ADB_SERVER_HOST
    adb start-server
    if [ "$ADB_MODE" = connect ]; then
      : "${ADB_CONNECT:?ADB_MODE=connect exige ADB_CONNECT=ip:5555}"
      export ANDROID_SERIAL="${ANDROID_SERIAL:-$ADB_CONNECT}"
      adb connect "$ADB_CONNECT" || true
      # Reconecta si el celu se cae (WiFi, reboot de router). Si el celu se reinició, hace falta `adb tcpip 5555` por USB.
      ( while sleep "${ADB_RECONNECT_EVERY:-30}"; do
          [ "$(adb_state)" = device ] || adb connect "$ADB_CONNECT" >/dev/null 2>&1 || true
        done ) &
    fi
    adb devices -l
    ;;
  *) echo "ADB_MODE inválido: $ADB_MODE (remote|connect|usb|apk)" >&2; exit 64 ;;
esac

st="$(adb_state)"
[ "$st" = device ] || echo "[no-phone] WARN: estado del celu = $st (unauthorized → aceptar el popup en el teléfono)"

exec "$@"
