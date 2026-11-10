// no-phone-puente: une el celu enchufado por USB a esta PC con no-phone en el VPS.
//
// Conecta SALIENTE (wss) al hub de agentes y, por cada conexión que no-phone abre contra su «adb server»
// (agente:5037), abre una contra el adb server de ESTA PC (127.0.0.1:5037) y pasa los bytes. No abre puertos
// y el destino es fijo: el VPS no puede hacer que la PC se conecte a otra cosa.
//
//	no-phone-puente vincular <código>   guarda URL, id y token (el código sale de `agente_hub.py alta-puente <id>`)
//	no-phone-puente                     corre (reconecta solo)
//	no-phone-puente instalar            arranca solo al iniciar sesión (systemd de usuario / registro de Windows)
//	no-phone-puente desinstalar         saca el arranque automático
//	no-phone-puente estado              configuración y celulares que ve adb
package main

import (
	"context"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/coder/websocket"
)

const version = "0.2.0"

const (
	abrir          = 1
	datos          = 2
	cerrar         = 3
	abrirAcelerado = 4 // 1 byte (1 = host:tport, la respuesta trae 8 bytes de id) + pedido de transporte + servicio
)

// adbLocal: el adb server de esta PC. NOPHONE_PUENTE_ADB solo sirve para pruebas (otro puerto local).
var adbLocal = func() string {
	if v := os.Getenv("NOPHONE_PUENTE_ADB"); strings.HasPrefix(v, "127.0.0.1:") {
		return v
	}
	return "127.0.0.1:5037"
}()

type Config struct {
	URL   string `json:"url"`
	ID    string `json:"id"`
	Token string `json:"token"`
}

func dirConfig() string {
	d, err := os.UserConfigDir()
	if err != nil {
		d = "."
	}
	return filepath.Join(d, "no-phone-puente")
}

func rutaConfig() string { return filepath.Join(dirConfig(), "config.json") }

func leerConfig() (Config, error) {
	var c Config
	b, err := os.ReadFile(rutaConfig())
	if err != nil {
		return c, err
	}
	err = json.Unmarshal(b, &c)
	if err == nil && (c.URL == "" || c.ID == "" || c.Token == "") {
		err = errors.New("configuración incompleta")
	}
	return c, err
}

func vincular(codigo string) error {
	codigo = strings.TrimSpace(codigo)
	crudo, err := base64.RawURLEncoding.DecodeString(strings.TrimRight(codigo, "="))
	if err != nil {
		return fmt.Errorf("el código no es válido (¿se copió entero?): %w", err)
	}
	var c Config
	if err := json.Unmarshal(crudo, &c); err != nil || c.URL == "" || c.ID == "" || c.Token == "" {
		return errors.New("el código no es válido (¿se copió entero?)")
	}
	if !strings.HasPrefix(c.URL, "wss://") && !strings.HasPrefix(c.URL, "ws://127.0.0.1") {
		return errors.New("el código apunta a una dirección sin cifrar; no lo uso")
	}
	if err := os.MkdirAll(dirConfig(), 0o700); err != nil {
		return err
	}
	b, _ := json.MarshalIndent(c, "", "  ")
	if err := os.WriteFile(rutaConfig(), b, 0o600); err != nil {
		return err
	}
	fmt.Printf("Vinculado como «%s» → %s\nConfiguración: %s\n", c.ID, c.URL, rutaConfig())
	return nil
}

// ---------------------------------------------------------------- túnel

type flujo struct {
	ch   chan []byte
	once sync.Once
}

func (f *flujo) terminar() { f.once.Do(func() { close(f.ch) }) }

type tunel struct {
	ws     *websocket.Conn
	ctx    context.Context
	mu     sync.Mutex
	flujos map[uint32]*flujo
}

func marco(tipo byte, id uint32, p []byte) []byte {
	b := make([]byte, 5+len(p))
	b[0] = tipo
	binary.BigEndian.PutUint32(b[1:5], id)
	copy(b[5:], p)
	return b
}

func (t *tunel) mandar(tipo byte, id uint32, p []byte) error {
	ctx, cancel := context.WithTimeout(t.ctx, 30*time.Second)
	defer cancel()
	return t.ws.Write(ctx, websocket.MessageBinary, marco(tipo, id, p))
}

func (t *tunel) abrir(id uint32, previo []byte) {
	f := &flujo{ch: make(chan []byte, 256)}
	t.mu.Lock()
	t.flujos[id] = f
	t.mu.Unlock()
	go t.atender(id, f, previo)
}

func (t *tunel) soltar(id uint32) {
	t.mu.Lock()
	f := t.flujos[id]
	delete(t.flujos, id)
	t.mu.Unlock()
	if f != nil {
		f.terminar()
	}
}

// atender: un flujo contra el adb local. `previo` (apertura acelerada): el hub ya le dijo OKAY al cliente por la
// elección del celu; acá se manda esa elección + el servicio juntos y se saca la respuesta de la elección (4 bytes,
// +8 de id con host:tport). Si la elección falla, su FAIL va al cliente como respuesta del servicio.
func (t *tunel) atender(id uint32, f *flujo, previo []byte) {
	c, err := net.DialTimeout("tcp", adbLocal, 5*time.Second)
	if err != nil {
		asegurarAdb()
		c, err = net.DialTimeout("tcp", adbLocal, 5*time.Second)
	}
	if err != nil {
		log.Printf("no hay adb server en %s: %v", adbLocal, err)
		t.soltar(id)
		_ = t.mandar(cerrar, id, nil)
		return
	}
	defer c.Close()
	if len(previo) > 1 {
		// El adb server descarta lo que llega antes de contestar la elección: primero la elección, esperar su
		// respuesta (local, milisegundos) y recién ahí el servicio.
		transporte, servicio, ok := partirPedido(previo[1:])
		var st []byte
		var err error
		if !ok {
			err = errors.New("apertura acelerada mal formada")
		} else if _, err = c.Write(transporte); err == nil {
			_ = c.SetReadDeadline(time.Now().Add(15 * time.Second))
			st = make([]byte, 4)
			_, err = io.ReadFull(c, st)
			if err == nil && string(st) == "OKAY" && previo[0] == 1 {
				_, err = io.ReadFull(c, make([]byte, 8))
			}
			_ = c.SetReadDeadline(time.Time{})
		}
		if err == nil && string(st) == "OKAY" {
			_, err = c.Write(servicio)
		} else if err == nil { // FAIL + largo + motivo: lo ve el cliente como respuesta del servicio
			_ = t.mandar(datos, id, st)
		}
		if err != nil {
			t.soltar(id)
			_ = t.mandar(cerrar, id, nil)
			return
		}
	}
	// VPS → adb local
	go func() {
		for p := range f.ch {
			if _, err := c.Write(p); err != nil {
				break
			}
		}
		if tc, ok := c.(*net.TCPConn); ok {
			_ = tc.CloseWrite()
		}
	}()
	// adb local → VPS
	buf := make([]byte, 64*1024)
	for {
		n, err := c.Read(buf)
		if n > 0 {
			if e := t.mandar(datos, id, buf[:n]); e != nil {
				break
			}
		}
		if err != nil {
			break
		}
	}
	t.mu.Lock()
	_, sigue := t.flujos[id]
	t.mu.Unlock()
	t.soltar(id)
	if sigue {
		_ = t.mandar(cerrar, id, nil)
	}
}

// partirPedido separa el primer pedido adb (4 dígitos hex de largo + texto) del resto.
func partirPedido(b []byte) (primero, resto []byte, ok bool) {
	if len(b) < 4 {
		return nil, nil, false
	}
	var n int
	if _, err := fmt.Sscanf(string(b[:4]), "%04x", &n); err != nil || 4+n > len(b) {
		return nil, nil, false
	}
	return b[:4+n], b[4+n:], true
}

func (t *tunel) cerrarTodo() {
	t.mu.Lock()
	fs := t.flujos
	t.flujos = map[uint32]*flujo{}
	t.mu.Unlock()
	for _, f := range fs {
		f.terminar()
	}
}

func sesion(cfg Config) error {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	h := http.Header{}
	h.Set("X-Puente", cfg.ID)
	h.Set("Authorization", "Bearer "+cfg.Token)
	dctx, dcancel := context.WithTimeout(ctx, 20*time.Second)
	ws, resp, err := websocket.Dial(dctx, cfg.URL, &websocket.DialOptions{HTTPHeader: h})
	dcancel()
	if err != nil {
		if resp != nil && resp.StatusCode == http.StatusNotFound {
			return fmt.Errorf("el VPS no tiene puente (¿hub viejo?): %w", err)
		}
		return err
	}
	ws.SetReadLimit(64 << 20)
	t := &tunel{ws: ws, ctx: ctx, flujos: map[uint32]*flujo{}}
	defer t.cerrarTodo()
	defer ws.CloseNow()
	log.Printf("conectado a %s como «%s»", cfg.URL, cfg.ID)

	// Estado para la consola + ping propio (si el VPS deja de contestar, se reconecta).
	go func() {
		tic := time.NewTicker(25 * time.Second)
		defer tic.Stop()
		for {
			hola, _ := json.Marshal(map[string]any{"ev": "hola", "version": version, "capacidades": []string{"acelerar"},
				"adb_version": versionAdb(), "adb": celulares()})
			wctx, wc := context.WithTimeout(ctx, 20*time.Second)
			err := ws.Write(wctx, websocket.MessageText, hola)
			if err == nil {
				err = ws.Ping(wctx)
			}
			wc()
			if err != nil {
				cancel()
				return
			}
			select {
			case <-ctx.Done():
				return
			case <-tic.C:
			}
		}
	}()

	for {
		tipo, m, err := ws.Read(ctx)
		if err != nil {
			var ce websocket.CloseError
			if errors.As(err, &ce) && ce.Code == 4401 {
				return errors.New("el VPS rechazó el token: volvé a vincular con un código nuevo")
			}
			return err
		}
		if tipo != websocket.MessageBinary || len(m) < 5 {
			continue
		}
		id := binary.BigEndian.Uint32(m[1:5])
		switch m[0] {
		case abrir:
			t.abrir(id, nil)
		case abrirAcelerado:
			p := make([]byte, len(m)-5)
			copy(p, m[5:])
			t.abrir(id, p)
		case datos:
			t.mu.Lock()
			f := t.flujos[id]
			t.mu.Unlock()
			if f != nil {
				p := make([]byte, len(m)-5)
				copy(p, m[5:])
				select {
				case f.ch <- p:
				case <-ctx.Done():
				}
			}
		case cerrar:
			t.soltar(id)
		}
	}
}

func correr() error {
	cfg, err := leerConfig()
	if err != nil {
		return fmt.Errorf("falta vincular esta PC (no-phone-puente vincular <código>): %w", err)
	}
	asegurarAdb()
	espera := time.Second
	for {
		inicio := time.Now()
		err := sesion(cfg)
		if err != nil && strings.Contains(err.Error(), "rechazó el token") {
			return err
		}
		if time.Since(inicio) > time.Minute {
			espera = time.Second
		}
		log.Printf("desconectado (%v); reintento en %s", err, espera)
		time.Sleep(espera)
		if espera < 30*time.Second {
			espera *= 2
		}
	}
}

func estado() {
	if cfg, err := leerConfig(); err != nil {
		fmt.Println("Sin vincular:", err)
	} else {
		fmt.Printf("Vinculado como «%s» → %s\n", cfg.ID, cfg.URL)
	}
	fmt.Println("Configuración:", rutaConfig())
	if adb, err := buscarAdb(false); err == nil {
		fmt.Println("adb:", adb)
	} else {
		fmt.Println("adb: no está (se baja solo al correr)")
	}
	cs := celulares()
	if len(cs) == 0 {
		fmt.Println("Celulares: ninguno (¿enchufado? ¿depuración USB activada y aceptada?)")
	}
	for _, c := range cs {
		fmt.Printf("Celular: %s  %s  %s\n", c["serial"], c["estado"], c["modelo"])
	}
}

func uso() {
	fmt.Fprintf(os.Stderr, `no-phone-puente %s — une el celu enchufado a esta PC con no-phone

  no-phone-puente vincular <código>   vincula esta PC (el código te lo da no-phone)
  no-phone-puente                     corre el puente
  no-phone-puente instalar            que arranque solo al iniciar sesión
  no-phone-puente desinstalar         que no arranque solo
  no-phone-puente estado              ver configuración y celulares
`, version)
}

func main() {
	log.SetFlags(log.Ldate | log.Ltime)
	args := os.Args[1:]
	oculto := false
	if len(args) > 0 && args[len(args)-1] == "--oculto" {
		oculto, args = true, args[:len(args)-1]
	}
	cmd := "correr"
	if len(args) > 0 {
		cmd = args[0]
	}
	var err error
	switch cmd {
	case "correr":
		if oculto {
			ocultar()
		}
		err = correr()
	case "vincular":
		if len(args) < 2 {
			uso()
			os.Exit(64)
		}
		err = vincular(args[1])
	case "instalar":
		err = instalar()
	case "desinstalar":
		err = desinstalar()
	case "estado":
		estado()
	case "version", "--version":
		fmt.Println(version)
	default:
		uso()
		os.Exit(64)
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, "error:", err)
		if oculto {
			log.Print(err)
		}
		os.Exit(1)
	}
}
