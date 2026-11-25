#!/usr/bin/env bash
# Guarda la Google Maps API key para el MCP movilidad sin que quede en el historial ni en pantalla.
# Uso: ./scripts/set-google-key.sh   (te la pide oculta)
set -euo pipefail

dir="${XDG_CONFIG_HOME:-$HOME/.config}/no-phone"
file="$dir/movilidad.env"
mkdir -p "$dir"
chmod 700 "$dir"

read -rsp "Pegá la Google Maps API key (no se muestra): " key
echo
if [[ ! "$key" =~ ^AIza[0-9A-Za-z_-]{35}$ ]]; then
  echo "Eso no parece una API key de Google (empiezan con AIza y tienen 39 caracteres). No guardé nada." >&2
  exit 1
fi

umask 077
tmp="$(mktemp "$dir/.movilidad.env.XXXXXX")"
if [[ -f "$file" ]]; then
  grep -v '^GOOGLE_MAPS_API_KEY=' "$file" > "$tmp" || true
fi
printf 'GOOGLE_MAPS_API_KEY=%s\n' "$key" >> "$tmp"
mv "$tmp" "$file"
chmod 600 "$file"
unset key

echo "Guardada en $file (chmod 600)."
echo "Probando la key contra Google (sin mostrarla)…"
set -a; . "$file"; set +a
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST 'https://places.googleapis.com/v1/places:searchText' \
  -H "X-Goog-Api-Key: $GOOGLE_MAPS_API_KEY" -H 'X-Goog-FieldMask: places.displayName' \
  -H 'Content-Type: application/json' -d '{"textQuery":"Plaza Independencia Mendoza"}')
case "$code" in
  200) echo "Places API: OK" ;;
  403) echo "Places API: 403 — habilitá 'Places API (New)' en el proyecto y revisá restricciones de la key." ;;
  *)   echo "Places API: HTTP $code" ;;
esac
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST 'https://routes.googleapis.com/directions/v2:computeRoutes' \
  -H "X-Goog-Api-Key: $GOOGLE_MAPS_API_KEY" -H 'X-Goog-FieldMask: routes.duration' \
  -H 'Content-Type: application/json' \
  -d '{"origin":{"location":{"latLng":{"latitude":-32.8897,"longitude":-68.8445}}},"destination":{"location":{"latLng":{"latitude":-32.8798,"longitude":-68.8795}}},"travelMode":"WALK"}')
case "$code" in
  200) echo "Routes API: OK" ;;
  403) echo "Routes API: 403 — habilitá 'Routes API' en el proyecto y revisá restricciones de la key." ;;
  *)   echo "Routes API: HTTP $code" ;;
esac
echo "Reiniciá el MCP movilidad (o la sesión de Claude) para que tome la key."
