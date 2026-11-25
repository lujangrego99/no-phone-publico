# Consola web. Base = la imagen de Hermes del compose (trae Node y el CLI `hermes`, que la consola
# usa para perfiles, tareas y probar MCPs). Se le suma adb para detectar los celulares.
# HERMES_IMAGE = la imagen del servicio hermes, compilada antes (ver compose.yaml).
ARG HERMES_IMAGE=no-phone-hermes:latest
FROM ${HERMES_IMAGE}
USER root
ARG PLATFORM_TOOLS_URL=https://dl.google.com/android/repository/platform-tools-latest-linux.zip
RUN apt-get update && apt-get install -y --no-install-recommends curl unzip tini \
 && curl -fsSL "$PLATFORM_TOOLS_URL" -o /tmp/pt.zip && unzip -q /tmp/pt.zip platform-tools/adb -d /tmp \
 && install -m 755 /tmp/platform-tools/adb /usr/local/bin/adb && rm -rf /tmp/pt.zip /tmp/platform-tools \
 && apt-get purge -y unzip && apt-get autoremove -y && rm -rf /var/lib/apt/lists/*
WORKDIR /opt/no-phone-admin
COPY admin/package.json admin/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY admin/ ./
COPY DESIGN.md PRODUCT.md /opt/no-phone-admin/docs/
# /admin-data existe en la imagen con dueño 10000: si no, el volumen nace de root y SQLite no abre.
RUN npm run build && mkdir -p /admin-data && chown -R 10000:10000 /opt/no-phone-admin /admin-data
USER 10000:10000
ENV NODE_ENV=production ADMIN_HOST=0.0.0.0 ADMIN_PORT=8890 ADMIN_DATA_DIR=/admin-data HERMES_HOME=/opt/data
EXPOSE 8890
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["npx", "tsx", "server/main.ts"]
