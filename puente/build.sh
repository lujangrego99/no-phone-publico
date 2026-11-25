#!/usr/bin/env bash
# Binarios del puente para Linux y Windows (sin dependencias: Go estático). Salen en puente/dist/.
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p dist
for t in linux/amd64 windows/amd64; do
  os=${t%/*}; arch=${t#*/}; ext=""; [ "$os" = windows ] && ext=.exe
  CGO_ENABLED=0 GOOS=$os GOARCH=$arch mise exec -- go build -trimpath -ldflags "-s -w" -o "dist/no-phone-puente-$os-$arch$ext" .
done
( cd dist && sha256sum no-phone-puente-* > SHA256SUMS )
ls -la dist
