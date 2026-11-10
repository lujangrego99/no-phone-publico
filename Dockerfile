# no-phone — imagen de la app Python: API HTTP, conectores MCP (naranjax, whatsapp, movilidad)
# y el adb server (servicio `adb`). El celu llega por ADB_MODE (ver docker/entrypoint.sh y DOCKER.md).
# Un mismo uid (10000) en todas las imágenes del compose: comparten volúmenes sin pelear permisos.
FROM python:3.14-slim

ARG PLATFORM_TOOLS_URL=https://dl.google.com/android/repository/platform-tools-latest-linux.zip

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl unzip tini \
 && curl -fsSL "$PLATFORM_TOOLS_URL" -o /tmp/pt.zip \
 && unzip -q /tmp/pt.zip platform-tools/adb -d /tmp \
 && install -m 755 /tmp/platform-tools/adb /usr/local/bin/adb \
 && rm -rf /tmp/pt.zip /tmp/platform-tools \
 && apt-get purge -y unzip && apt-get autoremove -y && rm -rf /var/lib/apt/lists/*

RUN useradd -m -u 10000 nophone
WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY --chown=nophone:nophone . .
# Servidor de uiautomator2 solo en 127.0.0.1 en el celu (si no, queda abierto en su WiFi): vendor/u2/README.md
RUN python scripts/u2_local.py

# Estado persistente: comprobantes/agenda (XDG_DATA_HOME), lock compartido API↔MCP, shots.
# Claves adb en ~/.android: persistirlas o el celu vuelve a pedir "¿Permitir depuración?".
ENV XDG_DATA_HOME=/data \
    XDG_CONFIG_HOME=/data/config \
    XDG_CACHE_HOME=/data/cache \
    NX_LOCK_DIR=/data/locks \
    NX_SHOTS_DIR=/data/shots \
    PYTHONUNBUFFERED=1
# /hermes y /wa: puntos de montaje de volúmenes compartidos; un volumen nuevo hereda este dueño.
RUN mkdir -p /data/config/no-phone /data/locks /home/nophone/.android /hermes /wa \
 && chown -R nophone:nophone /data /home/nophone/.android /hermes /wa
VOLUME ["/data", "/home/nophone/.android"]

USER nophone
EXPOSE 8800 8810 8811 8812 5037
ENTRYPOINT ["/usr/bin/tini", "--", "/app/docker/entrypoint.sh"]
CMD ["uvicorn", "server:app", "--host", "0.0.0.0", "--port", "8800"]
