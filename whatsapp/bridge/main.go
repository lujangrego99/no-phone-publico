// whatsapp-bridge — dispositivo vinculado de WhatsApp (whatsmeow) para no-phone.
//
// Mantiene la sesión, guarda chats/mensajes en SQLite (wa.db) y expone una
// API local mínima para lo que necesita la red: estado, QR/código de vinculación,
// enviar y descargar media. Las lecturas las hace el MCP directo contra la DB.
//
//	go run . [-data ~/.local/share/no-phone/whatsapp] [-addr 127.0.0.1:8801]
package main

import (
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"mime"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"time"

	_ "github.com/mattn/go-sqlite3"
	"github.com/mdp/qrterminal/v3"
	qrcode "github.com/skip2/go-qrcode"
	"go.mau.fi/whatsmeow"
	"go.mau.fi/whatsmeow/proto/waE2E"
	"go.mau.fi/whatsmeow/store"
	"go.mau.fi/whatsmeow/store/sqlstore"
	"go.mau.fi/whatsmeow/types"
	"go.mau.fi/whatsmeow/types/events"
	waLog "go.mau.fi/whatsmeow/util/log"
	"google.golang.org/protobuf/proto"
	"regexp"
	"strconv"
)

const schema = `
CREATE TABLE IF NOT EXISTS chats (
	jid               TEXT PRIMARY KEY,
	name              TEXT,
	is_group          INTEGER NOT NULL DEFAULT 0,
	last_message_time INTEGER
);
CREATE TABLE IF NOT EXISTS messages (
	id          TEXT NOT NULL,
	chat_jid    TEXT NOT NULL,
	sender      TEXT,
	sender_name TEXT,
	content     TEXT,
	timestamp   INTEGER NOT NULL,
	is_from_me  INTEGER NOT NULL DEFAULT 0,
	media_type  TEXT,
	filename    TEXT,
	mimetype    TEXT,
	raw         BLOB,
	deleted     INTEGER NOT NULL DEFAULT 0,
	edited      INTEGER NOT NULL DEFAULT 0,
	PRIMARY KEY (id, chat_jid)
);
CREATE INDEX IF NOT EXISTS messages_chat_ts ON messages (chat_jid, timestamp);
CREATE INDEX IF NOT EXISTS messages_ts ON messages (timestamp);
`

type bridge struct {
	cli     *whatsmeow.Client
	db      *sql.DB
	dataDir string
	log     waLog.Logger

	mu          sync.Mutex
	state       string // conectando | esperando_qr | conectado | desconectado | deslogueado
	qrCode      string
	groupNames  map[types.JID]string
	pairingDone chan struct{}
}

func main() {
	dataDir := flag.String("data", envOr("WA_DATA_DIR", defaultDataDir()), "directorio de datos (wa.db, media, qr.png)")
	addr := flag.String("addr", envOr("WA_BRIDGE_ADDR", "127.0.0.1:8801"), "dirección de la API local")
	logLevel := flag.String("log", envOr("WA_LOG_LEVEL", "INFO"), "DEBUG | INFO | WARN | ERROR")
	logout := flag.Bool("logout", false, "desvincular este dispositivo de WhatsApp y salir")
	flag.Parse()

	log := waLog.Stdout("bridge", *logLevel, true)
	// wa.db es la sesión de WhatsApp: db, -wal, -shm y media solo para el usuario.
	syscall.Umask(0o077)
	if err := os.MkdirAll(filepath.Join(*dataDir, "media"), 0o700); err != nil {
		log.Errorf("no pude crear %s: %v", *dataDir, err)
		os.Exit(1)
	}

	dbPath := filepath.Join(*dataDir, "wa.db")
	db, err := sql.Open("sqlite3", "file:"+dbPath+"?_foreign_keys=on&_journal_mode=WAL&_busy_timeout=5000")
	if err != nil {
		log.Errorf("abrir db: %v", err)
		os.Exit(1)
	}
	ctx := context.Background()
	container := sqlstore.NewWithDB(db, "sqlite3", waLog.Stdout("store", "WARN", true))
	if err := container.Upgrade(ctx); err != nil {
		log.Errorf("migrar store whatsmeow: %v", err)
		os.Exit(1)
	}
	if _, err := db.Exec(schema); err != nil {
		log.Errorf("migrar schema propio: %v", err)
		os.Exit(1)
	}
	device, err := container.GetFirstDevice(ctx)
	if err != nil {
		log.Errorf("leer dispositivo: %v", err)
		os.Exit(1)
	}
	store.DeviceProps.Os = proto.String("no-phone")

	b := &bridge{
		cli:        whatsmeow.NewClient(device, waLog.Stdout("wa", *logLevel, true)),
		db:         db,
		dataDir:    *dataDir,
		log:        log,
		state:      "conectando",
		groupNames: map[types.JID]string{},
	}
	b.cli.AddEventHandler(b.onEvent)

	if *logout {
		if b.cli.Store.ID == nil {
			log.Infof("no hay sesión vinculada")
			return
		}
		if err := b.cli.Connect(); err != nil {
			log.Errorf("conectar: %v", err)
			os.Exit(1)
		}
		lctx, cancel := context.WithTimeout(ctx, 20*time.Second)
		defer cancel()
		if err := b.cli.Logout(lctx); err != nil {
			log.Errorf("logout: %v", err)
			os.Exit(1)
		}
		log.Infof("sesión cerrada: dispositivo desvinculado de WhatsApp")
		return
	}

	srv := &http.Server{Addr: *addr, Handler: b.routes(os.Getenv("WA_BRIDGE_TOKEN"))}
	go func() {
		log.Infof("API local en http://%s", *addr)
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Errorf("http: %v", err)
			os.Exit(1)
		}
	}()

	if b.cli.Store.ID == nil {
		b.pairLoop(ctx)
	} else if err := b.cli.Connect(); err != nil {
		log.Errorf("conectar: %v", err)
		os.Exit(1)
	}

	sig := make(chan os.Signal, 1)
	signal.Notify(sig, os.Interrupt, syscall.SIGTERM)
	<-sig
	log.Infof("cerrando")
	shutdown, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	_ = srv.Shutdown(shutdown)
	b.cli.Disconnect()
	_ = db.Close()
}

func envOr(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}

func (b *bridge) setState(s string) {
	b.mu.Lock()
	b.state = s
	if s != "esperando_qr" {
		b.qrCode = ""
	}
	b.mu.Unlock()
}

// pairLoop muestra QRs (terminal + qr.png + GET /qr) hasta vincular.
// También se puede vincular por código con POST /pair-phone mientras corre.
func (b *bridge) pairLoop(ctx context.Context) {
	for {
		qrChan, err := b.cli.GetQRChannel(ctx)
		if err != nil {
			b.log.Errorf("canal QR: %v", err)
			os.Exit(1)
		}
		if err := b.cli.Connect(); err != nil {
			b.log.Errorf("conectar para vincular: %v", err)
			time.Sleep(5 * time.Second)
			continue
		}
		for item := range qrChan {
			switch item.Event {
			case whatsmeow.QRChannelEventCode:
				b.mu.Lock()
				b.state, b.qrCode = "esperando_qr", item.Code
				b.mu.Unlock()
				qrPath := filepath.Join(b.dataDir, "qr.png")
				_ = qrcode.WriteFile(item.Code, qrcode.Medium, 512, qrPath)
				fmt.Println("\nWhatsApp → Dispositivos vinculados → Vincular dispositivo. Escaneá:")
				qrterminal.GenerateHalfBlock(item.Code, qrterminal.L, os.Stdout)
				fmt.Printf("(también en %s y en GET /qr; vence en %s)\n", qrPath, item.Timeout)
			case "success":
				_ = os.Remove(filepath.Join(b.dataDir, "qr.png"))
				b.log.Infof("vinculado ✔")
				return
			case whatsmeow.QRChannelEventError:
				b.log.Errorf("error de vinculación: %v", item.Error)
			default:
				b.log.Warnf("evento de vinculación: %s", item.Event)
			}
		}
		if b.cli.Store.ID != nil {
			return
		}
		b.log.Infof("QRs vencidos, genero nuevos")
		time.Sleep(2 * time.Second)
	}
}

// ---------- eventos ----------

func (b *bridge) onEvent(raw any) {
	switch evt := raw.(type) {
	case *events.Connected:
		b.setState("conectado")
		b.log.Infof("conectado como %s", b.cli.Store.ID)
	case *events.Disconnected:
		b.setState("desconectado")
	case *events.LoggedOut:
		b.setState("deslogueado")
		b.log.Errorf("sesión cerrada desde el teléfono (%s). Reiniciá el bridge para volver a vincular.", evt.Reason)
		go func() { time.Sleep(time.Second); os.Exit(2) }()
	case *events.Message:
		b.storeMessage(evt, "")
	case *events.HistorySync:
		b.storeHistory(evt)
	case *events.GroupInfo:
		if evt.Name != nil {
			b.mu.Lock()
			b.groupNames[evt.JID] = evt.Name.Name
			b.mu.Unlock()
			_, _ = b.db.Exec(`UPDATE chats SET name=? WHERE jid=?`, evt.Name.Name, evt.JID.String())
		}
	case *events.JoinedGroup:
		b.mu.Lock()
		b.groupNames[evt.JID] = evt.Name
		b.mu.Unlock()
		b.upsertChat(evt.JID, evt.Name, 0)
	}
}

func (b *bridge) storeHistory(evt *events.HistorySync) {
	n := 0
	for _, conv := range evt.Data.GetConversations() {
		chatJID, err := types.ParseJID(conv.GetID())
		if err != nil {
			continue
		}
		name := conv.GetDisplayName()
		if name == "" {
			name = conv.GetName()
		}
		if chatJID.Server == types.HiddenUserServer {
			if pn, err := types.ParseJID(conv.GetPnJID()); err == nil && !pn.IsEmpty() {
				chatJID = pn
			}
		}
		for _, hm := range conv.GetMessages() {
			msg, err := b.cli.ParseWebMessage(chatJID, hm.GetMessage())
			if err != nil {
				continue
			}
			if b.storeMessage(msg, name) {
				n++
			}
		}
	}
	b.log.Infof("historial: %d mensajes guardados (%s)", n, evt.Data.GetSyncType())
}

// normalize pasa un JID LID (@lid) a número de teléfono cuando se conoce el mapeo.
func (b *bridge) normalize(jid, alt types.JID) types.JID {
	jid = jid.ToNonAD()
	if jid.Server != types.HiddenUserServer {
		return jid
	}
	if !alt.IsEmpty() && alt.Server == types.DefaultUserServer {
		return alt.ToNonAD()
	}
	if pn, err := b.cli.Store.LIDs.GetPNForLID(context.Background(), jid); err == nil && !pn.IsEmpty() {
		return pn.ToNonAD()
	}
	return jid
}

func (b *bridge) contactName(jid types.JID) string {
	c, err := b.cli.Store.Contacts.GetContact(context.Background(), jid)
	if err != nil || !c.Found {
		return ""
	}
	for _, s := range []string{c.FullName, c.FirstName, c.BusinessName, c.PushName} {
		if s != "" {
			return s
		}
	}
	return ""
}

func (b *bridge) groupName(jid types.JID) string {
	b.mu.Lock()
	name, ok := b.groupNames[jid]
	b.mu.Unlock()
	if ok {
		return name
	}
	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	defer cancel()
	info, err := b.cli.GetGroupInfo(ctx, jid)
	if err != nil {
		return ""
	}
	b.mu.Lock()
	b.groupNames[jid] = info.Name
	b.mu.Unlock()
	return info.Name
}

func (b *bridge) upsertChat(jid types.JID, name string, ts int64) {
	isGroup := 0
	if jid.Server == types.GroupServer {
		isGroup = 1
	}
	_, err := b.db.Exec(`
		INSERT INTO chats (jid, name, is_group, last_message_time) VALUES (?, NULLIF(?, ''), ?, NULLIF(?, 0))
		ON CONFLICT(jid) DO UPDATE SET
			name = COALESCE(NULLIF(excluded.name, ''), chats.name),
			last_message_time = MAX(COALESCE(chats.last_message_time, 0), COALESCE(excluded.last_message_time, 0))`,
		jid.String(), name, isGroup, ts)
	if err != nil {
		b.log.Warnf("upsert chat %s: %v", jid, err)
	}
}

// storeMessage persiste un mensaje. nameHint viene del history sync.
func (b *bridge) storeMessage(evt *events.Message, nameHint string) bool {
	info := evt.Info
	if info.Chat.Server == types.BroadcastServer || info.Chat.Server == types.NewsletterServer {
		return false
	}
	alt := info.SenderAlt
	if info.IsFromMe {
		alt = info.RecipientAlt
	}
	chat := info.Chat.ToNonAD()
	if !info.IsGroup {
		chat = b.normalize(info.Chat, alt)
	}
	sender := b.normalize(info.Sender, info.SenderAlt)
	msg := evt.Message

	if pm := msg.GetProtocolMessage(); pm != nil {
		id := pm.GetKey().GetID()
		switch pm.GetType() {
		case waE2E.ProtocolMessage_REVOKE:
			_, _ = b.db.Exec(`UPDATE messages SET deleted=1 WHERE id=? AND chat_jid=?`, id, chat.String())
		case waE2E.ProtocolMessage_MESSAGE_EDIT:
			if text, _, _, _ := extract(pm.GetEditedMessage()); text != "" {
				_, _ = b.db.Exec(`UPDATE messages SET content=?, edited=1 WHERE id=? AND chat_jid=?`, text, id, chat.String())
			}
		}
		return false
	}

	text, mediaType, filename, mimetype := extract(msg)
	if text == "" && mediaType == "" {
		return false
	}
	var raw []byte
	if mediaType != "" {
		raw, _ = proto.Marshal(msg)
	}

	chatName := nameHint
	if info.IsGroup {
		if chatName == "" {
			chatName = b.groupName(chat)
		}
	} else if n := b.contactName(chat); n != "" {
		chatName = n
	} else if !info.IsFromMe && chatName == "" {
		chatName = info.PushName
	}
	senderName := ""
	if info.IsFromMe {
		senderName = "yo"
	} else if senderName = b.contactName(sender); senderName == "" {
		senderName = info.PushName
	}

	ts := info.Timestamp.Unix()
	b.upsertChat(chat, chatName, ts)
	_, err := b.db.Exec(`
		INSERT INTO messages (id, chat_jid, sender, sender_name, content, timestamp, is_from_me, media_type, filename, mimetype, raw)
		VALUES (?, ?, ?, NULLIF(?, ''), ?, ?, ?, NULLIF(?, ''), NULLIF(?, ''), NULLIF(?, ''), ?)
		ON CONFLICT(id, chat_jid) DO NOTHING`,
		info.ID, chat.String(), sender.String(), senderName, text, ts, info.IsFromMe, mediaType, filename, mimetype, raw)
	if err != nil {
		b.log.Warnf("guardar mensaje %s: %v", info.ID, err)
		return false
	}
	return true
}

// extract devuelve texto legible + datos de media de un mensaje.
func extract(m *waE2E.Message) (text, mediaType, filename, mimetype string) {
	if m == nil {
		return
	}
	switch {
	case m.GetConversation() != "":
		text = m.GetConversation()
	case m.GetExtendedTextMessage() != nil:
		text = m.GetExtendedTextMessage().GetText()
	case m.GetImageMessage() != nil:
		x := m.GetImageMessage()
		text, mediaType, mimetype = x.GetCaption(), "imagen", x.GetMimetype()
	case m.GetVideoMessage() != nil:
		x := m.GetVideoMessage()
		text, mediaType, mimetype = x.GetCaption(), "video", x.GetMimetype()
	case m.GetAudioMessage() != nil:
		x := m.GetAudioMessage()
		mediaType, mimetype = "audio", x.GetMimetype()
		if x.GetPTT() {
			mediaType = "nota_de_voz"
		}
	case m.GetDocumentMessage() != nil:
		x := m.GetDocumentMessage()
		text, mediaType, filename, mimetype = x.GetCaption(), "documento", x.GetFileName(), x.GetMimetype()
	case m.GetStickerMessage() != nil:
		mediaType, mimetype = "sticker", m.GetStickerMessage().GetMimetype()
	case m.GetLocationMessage() != nil:
		x := m.GetLocationMessage()
		text = fmt.Sprintf("[ubicación] %s %f,%f", x.GetName(), x.GetDegreesLatitude(), x.GetDegreesLongitude())
	case m.GetLiveLocationMessage() != nil:
		x := m.GetLiveLocationMessage()
		text = fmt.Sprintf("[ubicación en vivo] %f,%f", x.GetDegreesLatitude(), x.GetDegreesLongitude())
	case m.GetContactMessage() != nil:
		text = "[contacto] " + m.GetContactMessage().GetDisplayName()
	case m.GetPollCreationMessage() != nil:
		text = "[encuesta] " + m.GetPollCreationMessage().GetName()
	case m.GetPollCreationMessageV3() != nil:
		text = "[encuesta] " + m.GetPollCreationMessageV3().GetName()
	case m.GetReactionMessage() != nil:
		if r := m.GetReactionMessage().GetText(); r != "" {
			text = "[reacción " + r + "]"
		}
	}
	return
}

// ---------- API local ----------

func (b *bridge) routes(token string) http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /status", b.handleStatus)
	mux.HandleFunc("GET /qr", b.handleQR)
	mux.HandleFunc("POST /pair-phone", b.handlePairPhone)
	mux.HandleFunc("POST /logout", b.handleLogout)
	mux.HandleFunc("POST /check", b.handleCheck)
	mux.HandleFunc("POST /send", b.handleSend)
	mux.HandleFunc("POST /download", b.handleDownload)
	if token == "" {
		return mux
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
		if subtle.ConstantTimeCompare([]byte(got), []byte(token)) != 1 {
			writeErr(w, http.StatusUnauthorized, "token inválido")
			return
		}
		mux.ServeHTTP(w, r)
	})
}

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}

func writeErr(w http.ResponseWriter, code int, msg string) {
	writeJSON(w, code, map[string]string{"error": msg})
}

func readJSON(r *http.Request, v any) error {
	return json.NewDecoder(http.MaxBytesReader(nil, r.Body, 1<<20)).Decode(v)
}

func (b *bridge) handleStatus(w http.ResponseWriter, _ *http.Request) {
	b.mu.Lock()
	out := map[string]any{"estado": b.state, "conectado": b.cli.IsConnected(), "logueado": b.cli.IsLoggedIn()}
	if b.qrCode != "" {
		// Huella corta del QR vigente: la consola web sabe cuándo pedir la imagen nueva.
		sum := sha256.Sum256([]byte(b.qrCode))
		out["qr"] = hex.EncodeToString(sum[:6])
	}
	b.mu.Unlock()
	if id := b.cli.Store.ID; id != nil {
		out["jid"] = id.ToNonAD().String()
		out["nombre"] = b.cli.Store.PushName
	}
	var chats, msgs int
	_ = b.db.QueryRow(`SELECT COUNT(*) FROM chats`).Scan(&chats)
	_ = b.db.QueryRow(`SELECT COUNT(*) FROM messages`).Scan(&msgs)
	out["chats"], out["mensajes"] = chats, msgs
	writeJSON(w, http.StatusOK, out)
}

func (b *bridge) handleQR(w http.ResponseWriter, _ *http.Request) {
	b.mu.Lock()
	code := b.qrCode
	b.mu.Unlock()
	if code == "" {
		writeErr(w, http.StatusNotFound, "no hay QR pendiente (ya vinculado o todavía conectando)")
		return
	}
	png, err := qrcode.Encode(code, qrcode.Medium, 512)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	w.Header().Set("Content-Type", "image/png")
	_, _ = w.Write(png)
}

// handleLogout desvincula este dispositivo de WhatsApp (como «cerrar sesión» desde el teléfono),
// borra el historial guardado (chats, mensajes, media: podrían ser de otra cuenta al revincular)
// y sale con código 3; systemd lo reinicia y arranca el ciclo de QR de nuevo.
func (b *bridge) handleLogout(w http.ResponseWriter, r *http.Request) {
	if b.cli.Store.ID == nil {
		writeErr(w, http.StatusConflict, "no hay sesión vinculada")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 20*time.Second)
	defer cancel()
	if err := b.cli.Logout(ctx); err != nil {
		writeErr(w, http.StatusBadGateway, err.Error())
		return
	}
	_, _ = b.db.Exec(`DELETE FROM messages; DELETE FROM chats;`)
	_ = os.RemoveAll(filepath.Join(b.dataDir, "media"))
	_ = os.MkdirAll(filepath.Join(b.dataDir, "media"), 0o700)
	b.setState("deslogueado")
	b.log.Infof("desvinculado desde la API; reinicio para mostrar QR nuevo")
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "reinicia": true})
	go func() { time.Sleep(500 * time.Millisecond); os.Exit(3) }()
}

// handlePairPhone vincula por código de 8 caracteres (sin escanear QR).
func (b *bridge) handlePairPhone(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Phone string `json:"phone"`
	}
	if err := readJSON(r, &req); err != nil || onlyDigits(req.Phone) == "" {
		writeErr(w, http.StatusBadRequest, "phone requerido (formato internacional, ej 5492611234567)")
		return
	}
	if b.cli.Store.ID != nil {
		writeErr(w, http.StatusConflict, "ya vinculado")
		return
	}
	code, err := b.cli.PairPhone(r.Context(), onlyDigits(req.Phone), true, whatsmeow.PairClientChrome, "Chrome (Linux)")
	if err != nil {
		writeErr(w, http.StatusBadGateway, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"codigo": code, "instrucciones": "WhatsApp → Dispositivos vinculados → Vincular con número de teléfono"})
}

func onlyDigits(s string) string {
	var sb strings.Builder
	for _, c := range s {
		if c >= '0' && c <= '9' {
			sb.WriteRune(c)
		}
	}
	return sb.String()
}

// resolve convierte "5492611234567" o un JID en un JID válido de WhatsApp.
func (b *bridge) resolve(ctx context.Context, to string) (types.JID, error) {
	if strings.Contains(to, "@") {
		jid, err := types.ParseJID(to)
		if err != nil {
			return jid, err
		}
		return b.normalize(jid, types.JID{}), nil
	}
	digits := onlyDigits(to)
	if len(digits) < 8 {
		return types.JID{}, fmt.Errorf("número inválido: %q", to)
	}
	resp, err := b.cli.IsOnWhatsApp(ctx, []string{"+" + digits})
	if err != nil {
		return types.JID{}, fmt.Errorf("no pude verificar el número: %w", err)
	}
	if len(resp) == 0 || !resp[0].IsIn {
		return types.JID{}, fmt.Errorf("%s no tiene WhatsApp", digits)
	}
	// El ID canónico puede venir como LID (@lid): para mostrar y guardar usamos el número.
	return b.normalize(resp[0].JID, resp[0].PhoneNumber), nil
}

func (b *bridge) handleCheck(w http.ResponseWriter, r *http.Request) {
	var req struct {
		To string `json:"to"`
	}
	if err := readJSON(r, &req); err != nil || req.To == "" {
		writeErr(w, http.StatusBadRequest, "to requerido")
		return
	}
	if !b.cli.IsLoggedIn() {
		writeErr(w, http.StatusServiceUnavailable, "WhatsApp no conectado")
		return
	}
	jid, err := b.resolve(r.Context(), req.To)
	if err != nil {
		writeErr(w, http.StatusNotFound, err.Error())
		return
	}
	name := b.contactName(jid)
	if jid.Server == types.GroupServer {
		name = b.groupName(jid)
	}
	writeJSON(w, http.StatusOK, map[string]string{"jid": jid.String(), "nombre": name})
}

func (b *bridge) handleSend(w http.ResponseWriter, r *http.Request) {
	var req struct {
		To   string `json:"to"`
		Text string `json:"text"`
		File string `json:"file"`
	}
	if err := readJSON(r, &req); err != nil || req.To == "" || (req.Text == "" && req.File == "") {
		writeErr(w, http.StatusBadRequest, "to + (text o file) requeridos")
		return
	}
	if !b.cli.IsLoggedIn() {
		writeErr(w, http.StatusServiceUnavailable, "WhatsApp no conectado")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 60*time.Second)
	defer cancel()
	jid, err := b.resolve(ctx, req.To)
	if err != nil {
		writeErr(w, http.StatusNotFound, err.Error())
		return
	}
	msg := &waE2E.Message{Conversation: proto.String(req.Text)}
	if req.File != "" {
		if msg, err = b.mediaMessage(ctx, req.File, req.Text); err != nil {
			writeErr(w, http.StatusBadRequest, err.Error())
			return
		}
	}
	resp, err := b.cli.SendMessage(ctx, jid, msg)
	if err != nil {
		writeErr(w, http.StatusBadGateway, err.Error())
		return
	}
	// El eco propio no siempre vuelve como evento: lo guardamos ya.
	own := b.cli.Store.ID.ToNonAD()
	b.storeMessage(&events.Message{
		Info: types.MessageInfo{
			MessageSource: types.MessageSource{Chat: jid, Sender: own, IsFromMe: true, IsGroup: jid.Server == types.GroupServer},
			ID:            resp.ID,
			Timestamp:     resp.Timestamp,
		},
		Message: msg,
	}, "")
	writeJSON(w, http.StatusOK, map[string]any{"id": resp.ID, "jid": jid.String(), "timestamp": resp.Timestamp.Unix()})
}

var notaSeg = regexp.MustCompile(`nota-de-voz-(\d+)s`)

func (b *bridge) mediaMessage(ctx context.Context, path, caption string) (*waE2E.Message, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("leer archivo: %w", err)
	}
	mt := mime.TypeByExtension(strings.ToLower(filepath.Ext(path)))
	if mt == "" {
		mt = http.DetectContentType(data)
	}
	kind := whatsmeow.MediaDocument
	switch {
	case strings.HasPrefix(mt, "image/"):
		kind = whatsmeow.MediaImage
	case strings.HasPrefix(mt, "video/"):
		kind = whatsmeow.MediaVideo
	case strings.HasPrefix(mt, "audio/"):
		kind = whatsmeow.MediaAudio
	}
	up, err := b.cli.Upload(ctx, data, kind)
	if err != nil {
		return nil, fmt.Errorf("subir media: %w", err)
	}
	size := uint64(len(data))
	switch kind {
	case whatsmeow.MediaImage:
		return &waE2E.Message{ImageMessage: &waE2E.ImageMessage{
			Caption: proto.String(caption), Mimetype: proto.String(mt), URL: &up.URL, DirectPath: &up.DirectPath,
			MediaKey: up.MediaKey, FileEncSHA256: up.FileEncSHA256, FileSHA256: up.FileSHA256, FileLength: &size,
		}}, nil
	case whatsmeow.MediaVideo:
		return &waE2E.Message{VideoMessage: &waE2E.VideoMessage{
			Caption: proto.String(caption), Mimetype: proto.String(mt), URL: &up.URL, DirectPath: &up.DirectPath,
			MediaKey: up.MediaKey, FileEncSHA256: up.FileEncSHA256, FileSHA256: up.FileSHA256, FileLength: &size,
		}}, nil
	case whatsmeow.MediaAudio:
		am := &waE2E.AudioMessage{
			Mimetype: proto.String(mt), URL: &up.URL, DirectPath: &up.DirectPath,
			MediaKey: up.MediaKey, FileEncSHA256: up.FileEncSHA256, FileSHA256: up.FileSHA256, FileLength: &size,
		}
		// Nota de voz grabada por el dueño en la consola (ogg/opus «…nota-de-voz-12s-…»): va como nota de voz (PTT),
		// no como archivo de audio, con su duración.
		if base := filepath.Base(path); strings.Contains(base, "nota-de-voz") {
			am.PTT = proto.Bool(true)
			am.Mimetype = proto.String("audio/ogg; codecs=opus")
			if m := notaSeg.FindStringSubmatch(base); m != nil {
				if n, err := strconv.Atoi(m[1]); err == nil {
					am.Seconds = proto.Uint32(uint32(n))
				}
			}
		}
		return &waE2E.Message{AudioMessage: am}, nil
	}
	return &waE2E.Message{DocumentMessage: &waE2E.DocumentMessage{
		Caption: proto.String(caption), Mimetype: proto.String(mt), FileName: proto.String(filepath.Base(path)),
		URL: &up.URL, DirectPath: &up.DirectPath,
		MediaKey: up.MediaKey, FileEncSHA256: up.FileEncSHA256, FileSHA256: up.FileSHA256, FileLength: &size,
	}}, nil
}

func (b *bridge) handleDownload(w http.ResponseWriter, r *http.Request) {
	var req struct {
		ChatJID string `json:"chat_jid"`
		ID      string `json:"id"`
	}
	if err := readJSON(r, &req); err != nil || req.ChatJID == "" || req.ID == "" {
		writeErr(w, http.StatusBadRequest, "chat_jid + id requeridos")
		return
	}
	var raw []byte
	var filename sql.NullString
	var mediaType string
	err := b.db.QueryRow(`SELECT raw, filename, COALESCE(media_type, '') FROM messages WHERE id=? AND chat_jid=?`,
		req.ID, req.ChatJID).Scan(&raw, &filename, &mediaType)
	if errors.Is(err, sql.ErrNoRows) || len(raw) == 0 {
		writeErr(w, http.StatusNotFound, "mensaje sin media o inexistente")
		return
	} else if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	var m waE2E.Message
	if err := proto.Unmarshal(raw, &m); err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	var dl whatsmeow.DownloadableMessage
	var mt string
	switch {
	case m.GetImageMessage() != nil:
		dl, mt = m.GetImageMessage(), m.GetImageMessage().GetMimetype()
	case m.GetVideoMessage() != nil:
		dl, mt = m.GetVideoMessage(), m.GetVideoMessage().GetMimetype()
	case m.GetAudioMessage() != nil:
		dl, mt = m.GetAudioMessage(), m.GetAudioMessage().GetMimetype()
	case m.GetDocumentMessage() != nil:
		dl, mt = m.GetDocumentMessage(), m.GetDocumentMessage().GetMimetype()
	case m.GetStickerMessage() != nil:
		dl, mt = m.GetStickerMessage(), m.GetStickerMessage().GetMimetype()
	default:
		writeErr(w, http.StatusNotFound, "tipo de media no descargable")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 120*time.Second)
	defer cancel()
	data, err := b.cli.Download(ctx, dl)
	if err != nil {
		writeErr(w, http.StatusBadGateway, "descarga: "+err.Error())
		return
	}
	name := req.ID
	if filename.Valid && filename.String != "" {
		name = req.ID + "_" + filepath.Base(filename.String)
	} else if exts, _ := mime.ExtensionsByType(strings.Split(mt, ";")[0]); len(exts) > 0 {
		name += exts[len(exts)-1]
	}
	dir := filepath.Join(b.dataDir, "media", strings.ReplaceAll(req.ChatJID, "@", "_"))
	if err := os.MkdirAll(dir, 0o700); err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	path := filepath.Join(dir, name)
	if err := os.WriteFile(path, data, 0o600); err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	abs, _ := filepath.Abs(path)
	writeJSON(w, http.StatusOK, map[string]any{"path": abs, "mimetype": mt, "bytes": len(data), "tipo": mediaType})
}

// defaultDataDir: fuera del repo, para que la sesión sobreviva a worktrees/clones.
func defaultDataDir() string {
	if x := os.Getenv("XDG_DATA_HOME"); x != "" {
		return filepath.Join(x, "no-phone", "whatsapp")
	}
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".local", "share", "no-phone", "whatsapp")
}
