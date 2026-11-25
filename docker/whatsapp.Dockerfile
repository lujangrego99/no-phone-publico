# Puente de WhatsApp (whatsmeow). go-sqlite3 necesita cgo → compila en golang y corre en debian slim.
FROM golang:1.27-bookworm AS build
WORKDIR /src
COPY whatsapp/bridge/go.mod whatsapp/bridge/go.sum ./
RUN go mod download
COPY whatsapp/bridge/ ./
RUN CGO_ENABLED=1 go build -trimpath -ldflags="-s -w" -o /out/whatsapp-bridge .

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates tini && rm -rf /var/lib/apt/lists/* \
 && useradd -m -u 10000 nophone && mkdir -p /data/whatsapp && chown -R nophone:nophone /data
COPY --from=build /out/whatsapp-bridge /usr/local/bin/whatsapp-bridge
USER nophone
# Sesión de WhatsApp + chats/mensajes: perderla = volver a vincular.
ENV WA_DATA_DIR=/data/whatsapp WA_BRIDGE_ADDR=0.0.0.0:8801
VOLUME ["/data"]
EXPOSE 8801
# /logout sale con código 3 a propósito: restart del compose lo relanza con QR nuevo.
ENTRYPOINT ["/usr/bin/tini", "--", "whatsapp-bridge"]
