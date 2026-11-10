//go:build windows

package main

import (
	"fmt"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"syscall"
)

const claveRun = `HKCU\Software\Microsoft\Windows\CurrentVersion\Run`

// ocultar: en segundo plano no hay consola; el log va a un archivo en la carpeta de configuración.
func ocultar() {
	syscall.NewLazyDLL("kernel32.dll").NewProc("FreeConsole").Call()
	_ = os.MkdirAll(dirConfig(), 0o700)
	if f, err := os.OpenFile(filepath.Join(dirConfig(), "puente.log"), os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600); err == nil {
		log.SetOutput(f)
	}
}

func ocultarVentana(c *exec.Cmd) {
	c.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: 0x08000000} // CREATE_NO_WINDOW
}

func instalar() error {
	exe, err := os.Executable()
	if err != nil {
		return err
	}
	val := fmt.Sprintf(`"%s" correr --oculto`, exe)
	if out, err := exec.Command("reg", "add", claveRun, "/v", "no-phone-puente", "/t", "REG_SZ", "/d", val, "/f").CombinedOutput(); err != nil {
		return fmt.Errorf("reg add: %v %s", err, out)
	}
	cmd := exec.Command(exe, "correr", "--oculto")
	ocultarVentana(cmd)
	if err := cmd.Start(); err != nil {
		return err
	}
	fmt.Println("Listo: corre en segundo plano y arranca solo al iniciar sesión. Log:", filepath.Join(dirConfig(), "puente.log"))
	return nil
}

func desinstalar() error {
	_ = exec.Command("reg", "delete", claveRun, "/v", "no-phone-puente", "/f").Run()
	_ = exec.Command("taskkill", "/IM", filepath.Base(os.Args[0]), "/FI", fmt.Sprintf("PID ne %d", os.Getpid()), "/F").Run()
	fmt.Println("Listo: ya no arranca solo.")
	return nil
}
