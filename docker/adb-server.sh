#!/bin/sh
# Servicio `adb`: el ÚNICO adb server del compose. Los demás contenedores le hablan por la red
# interna (ANDROID_ADB_SERVER_HOST=adb). Escucha en todas las interfaces DEL CONTENEDOR (-a) pero
# el puerto no se publica en el host: adb no tiene auth.
#   ADB_MODE=usb      → toma el USB del celu (/dev/bus/usb). En el host no tiene que haber otro adb server.
#   ADB_MODE=connect  → adb connect $ADB_CONNECT (celu en `adb tcpip 5555`, misma red).
set -eu
ADB_MODE="${ADB_MODE:-usb}"
adb kill-server >/dev/null 2>&1 || true
adb -a -P 5037 nodaemon server &
SERVER=$!
sleep 2
if [ "$ADB_MODE" = connect ]; then
  : "${ADB_CONNECT:?ADB_MODE=connect exige ADB_CONNECT=ip:5555}"
  adb connect "$ADB_CONNECT" || true
  ( while sleep "${ADB_RECONNECT_EVERY:-30}"; do
      [ "$(timeout 10 adb -s "$ADB_CONNECT" get-state 2>/dev/null)" = device ] || adb connect "$ADB_CONNECT" >/dev/null 2>&1 || true
    done ) &
elif [ "$ADB_MODE" != usb ]; then
  echo "ADB_MODE inválido para el servicio adb: $ADB_MODE (usb|connect)" >&2; exit 64
fi
adb devices -l || true
echo "[adb] listo ($ADB_MODE). Si el celu dice unauthorized: aceptá «¿Permitir depuración?» en la pantalla."
wait "$SERVER"
