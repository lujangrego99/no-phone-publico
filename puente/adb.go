package main

import (
	"archive/zip"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"
)

func nombreAdb() string {
	if runtime.GOOS == "windows" {
		return "adb.exe"
	}
	return "adb"
}

// buscarAdb: el del PATH, el que está al lado del programa o el que bajamos antes; si no hay y bajar=true, baja
// platform-tools oficial de Google a la carpeta de configuración.
func buscarAdb(bajar bool) (string, error) {
	if p, err := exec.LookPath("adb"); err == nil {
		return p, nil
	}
	if exe, err := os.Executable(); err == nil {
		for _, p := range []string{filepath.Join(filepath.Dir(exe), nombreAdb()), filepath.Join(filepath.Dir(exe), "platform-tools", nombreAdb())} {
			if _, err := os.Stat(p); err == nil {
				return p, nil
			}
		}
	}
	propio := filepath.Join(dirConfig(), "platform-tools", nombreAdb())
	if _, err := os.Stat(propio); err == nil {
		return propio, nil
	}
	if !bajar {
		return "", errors.New("adb no encontrado")
	}
	return propio, bajarPlatformTools()
}

func bajarPlatformTools() error {
	so := map[string]string{"linux": "linux", "windows": "windows", "darwin": "darwin"}[runtime.GOOS]
	if so == "" {
		return fmt.Errorf("no sé bajar adb para %s", runtime.GOOS)
	}
	url := "https://dl.google.com/android/repository/platform-tools-latest-" + so + ".zip"
	log.Printf("bajando adb de %s", url)
	cli := &http.Client{Timeout: 5 * time.Minute}
	r, err := cli.Get(url)
	if err != nil {
		return err
	}
	defer r.Body.Close()
	if r.StatusCode != 200 {
		return fmt.Errorf("bajar adb: HTTP %d", r.StatusCode)
	}
	if err := os.MkdirAll(dirConfig(), 0o700); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(dirConfig(), "pt-*.zip")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name())
	if _, err := io.Copy(tmp, r.Body); err != nil {
		tmp.Close()
		return err
	}
	tmp.Close()
	z, err := zip.OpenReader(tmp.Name())
	if err != nil {
		return err
	}
	defer z.Close()
	base := filepath.Clean(dirConfig())
	for _, f := range z.File {
		dst := filepath.Join(base, f.Name)
		if !strings.HasPrefix(dst, base+string(os.PathSeparator)) {
			continue // zip-slip
		}
		if f.FileInfo().IsDir() {
			_ = os.MkdirAll(dst, 0o755)
			continue
		}
		if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
			return err
		}
		in, err := f.Open()
		if err != nil {
			return err
		}
		out, err := os.OpenFile(dst, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, f.Mode()|0o600)
		if err != nil {
			in.Close()
			return err
		}
		_, err = io.Copy(out, in)
		in.Close()
		out.Close()
		if err != nil {
			return err
		}
	}
	log.Printf("adb listo en %s", filepath.Join(base, "platform-tools"))
	return nil
}

var adbMu sync.Mutex

// asegurarAdb arranca el adb server local (127.0.0.1:5037) si no está.
func asegurarAdb() {
	adbMu.Lock()
	defer adbMu.Unlock()
	adb, err := buscarAdb(true)
	if err != nil {
		log.Printf("sin adb: %v", err)
		return
	}
	cmd := exec.Command(adb, "start-server")
	ocultarVentana(cmd)
	if out, err := cmd.CombinedOutput(); err != nil {
		log.Printf("adb start-server: %v %s", err, strings.TrimSpace(string(out)))
	}
}

// celulares: lo que ve el adb de esta PC (serial, estado, modelo).
func celulares() []map[string]string {
	adb, err := buscarAdb(false)
	if err != nil {
		return nil
	}
	cmd := exec.Command(adb, "devices", "-l")
	ocultarVentana(cmd)
	out, err := cmd.Output()
	if err != nil {
		return nil
	}
	var r []map[string]string
	for _, l := range strings.Split(string(out), "\n")[1:] {
		c := strings.Fields(l)
		if len(c) < 2 {
			continue
		}
		d := map[string]string{"serial": c[0], "estado": c[1], "modelo": ""}
		for _, x := range c[2:] {
			if strings.HasPrefix(x, "model:") {
				d["modelo"] = strings.TrimPrefix(x, "model:")
			}
			if strings.HasPrefix(x, "transport_id:") {
				d["transport_id"] = strings.TrimPrefix(x, "transport_id:")
			}
		}
		r = append(r, d)
	}
	return r
}

// versionAdb: la versión del adb server local en el formato del protocolo (4 dígitos hex, p. ej. «0029»), para que el
// hub conteste `host:version` sin cruzar el océano. "" si no responde.
func versionAdb() string {
	c, err := net.DialTimeout("tcp", adbLocal, 3*time.Second)
	if err != nil {
		return ""
	}
	defer c.Close()
	_ = c.SetDeadline(time.Now().Add(5 * time.Second))
	if _, err := c.Write([]byte("000chost:version")); err != nil {
		return ""
	}
	b := make([]byte, 12)
	if _, err := io.ReadFull(c, b); err != nil || string(b[:8]) != "OKAY0004" {
		return ""
	}
	return string(b[8:])
}
