#!/usr/bin/env bash
# Local en Windows + WSL: el celu enchufado por USB a Windows, el compose corriendo en WSL.
# El adb de Windows queda en 127.0.0.1 (como siempre) y un reenvío (scripts/adb-relay.ps1) lo expone SOLO en la
# IP de Windows dentro de la red virtual de WSL — no en la WiFi de casa: el protocolo adb no tiene auth y quien
# llegue al puerto controla el celu y la billetera (por eso nunca `adb -a`; y adb no deja elegir la IP).
# Por USB un dump de pantalla tarda ~0,4 s (por WiFi ~1–3 s).
#   scripts/adb-windows-usb.sh     → arranca/verifica y escribe ANDROID_ADB_SERVER_HOST en .env
# Después: docker compose up -d (recrea los servicios del celu con el server nuevo).
set -euo pipefail
cd "$(dirname "$0")/.."
ADB_EXE="${ADB_EXE:-$(ls /mnt/c/Users/*/platform-tools/adb.exe 2>/dev/null | head -1)}"
[ -x "$ADB_EXE" ] || { echo "no encuentro adb.exe (pasalo en ADB_EXE)" >&2; exit 69; }
WIN_IP="$(ip route | awk '/^default/ && !f {print $3; f=1}')"
case "$WIN_IP" in 172.*|10.*|192.168.*) ;; *) echo "IP de Windows rara: $WIN_IP" >&2; exit 65 ;; esac

"$ADB_EXE" start-server >/dev/null 2>&1 || true
"$ADB_EXE" devices -l

if ! timeout 3 bash -c "echo > /dev/tcp/$WIN_IP/5037" 2>/dev/null; then
  PS1_WIN="$(wslpath -w "$PWD/scripts/adb-relay.ps1")"
  nohup powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$PS1_WIN" -ListenIp "$WIN_IP" >/dev/null 2>&1 &
  for _ in $(seq 1 30); do timeout 1 bash -c "echo > /dev/tcp/$WIN_IP/5037" 2>/dev/null && break; sleep 0.5; done
fi
timeout 3 bash -c "echo > /dev/tcp/$WIN_IP/5037" 2>/dev/null || { echo "el reenvío no responde en $WIN_IP:5037" >&2; exit 1; }

if grep -q '^ANDROID_ADB_SERVER_HOST=' .env; then
  sed -i "s#^ANDROID_ADB_SERVER_HOST=.*#ANDROID_ADB_SERVER_HOST=$WIN_IP#" .env
else
  printf '\n# adb de Windows por USB (scripts/adb-windows-usb.sh)\nANDROID_ADB_SERVER_HOST=%s\n' "$WIN_IP" >> .env
fi
echo "listo: $WIN_IP:5037 → adb de Windows. ANDROID_ADB_SERVER_HOST=$WIN_IP en .env — ahora: docker compose up -d"
