//go:build !windows

package main

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
)

func ocultar()                   {}
func ocultarVentana(_ *exec.Cmd) {}

func unidad() string {
	d, _ := os.UserConfigDir()
	return filepath.Join(d, "systemd", "user", "no-phone-puente.service")
}

func instalar() error {
	exe, err := os.Executable()
	if err != nil {
		return err
	}
	exe, _ = filepath.EvalSymlinks(exe)
	if err := os.MkdirAll(filepath.Dir(unidad()), 0o755); err != nil {
		return err
	}
	u := fmt.Sprintf(`[Unit]
Description=no-phone puente (celu por USB → no-phone en el VPS)
After=network-online.target

[Service]
ExecStart=%q correr
Restart=always
RestartSec=10

[Install]
WantedBy=default.target
`, exe)
	if err := os.WriteFile(unidad(), []byte(u), 0o644); err != nil {
		return err
	}
	for _, a := range [][]string{{"daemon-reload"}, {"enable", "--now", "no-phone-puente.service"}} {
		if out, err := exec.Command("systemctl", append([]string{"--user"}, a...)...).CombinedOutput(); err != nil {
			return fmt.Errorf("systemctl %v: %v %s", a, err, out)
		}
	}
	fmt.Println("Listo: arranca solo al iniciar sesión. Ver: systemctl --user status no-phone-puente · journalctl --user -u no-phone-puente -f")
	return nil
}

func desinstalar() error {
	_ = exec.Command("systemctl", "--user", "disable", "--now", "no-phone-puente.service").Run()
	if err := os.Remove(unidad()); err != nil && !os.IsNotExist(err) {
		return err
	}
	_ = exec.Command("systemctl", "--user", "daemon-reload").Run()
	fmt.Println("Listo: ya no arranca solo.")
	return nil
}
