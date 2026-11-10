# Celu por túnel SSH (Termux) — cualquier red, sin APK

Naranja X bloquea el login si hay un servicio de accesibilidad sideloadeado (Play Integrity), así que el
celu se maneja por adb + uiautomator2, y el VPS llega a su adbd por un túnel que abre el propio celu.

```
celu: adbd 127.0.0.1:5555 (adb tcpip 5555, auth RSA de adb)
  └─ Termux: ssh -N -R 172.19.0.1:15555:127.0.0.1:5555 celu12t@VPS   (tunel-np, se reconecta solo)
VPS: sshd → 172.19.0.1:15555 (gateway de la red docker no-phone_default, no sale a internet)
  └─ servicio adb-tunel (compose.vps.yaml): adb connect 172.19.0.1:15555
       └─ perfil en phones.json: serial "172.19.0.1:15555", adb_server "adb-tunel:5037"
```

## Interruptor (un botón de Termux:Widget)

Un solo botón, `~/.shortcuts/no-phone` (`nophone boton`): muestra el estado en grande; si está APAGADO lo prende,
si está PRENDIDO ofrece apagarlo (Enter). Por consola sigue `nophone on|off|estado`.
Acceso rápido «Depuración inalámbrica» agregado a la cortina (`cmd statusbar add-tile
com.android.settings/.development.qstile.DevelopmentTiles$WirelessDebugging`, por adb): un toque la prende, mantenerlo
apretado abre su pantalla (vincular con código).

- **APAGAR**: borra `~/.nophone-on`, corta el túnel y cierra el adb por red (`adb usb` desde el adb de Termux,
  que está autorizado contra el propio celu). Apaga también la depuración inalámbrica. Con eso no queda
  **ningún** camino por red: ni el VPS ni otra PC en el WiFi. Abrir Termux no lo reactiva (`tunel-np` no
  arranca sin `~/.nophone-on`).
- **PRENDER**: solo desde el celu. Si el 5555 está cerrado, explica los pasos, muestra cuenta regresiva y espera
  (3 min) a que actives **«Depuración inalámbrica»** desde la cortina; si conecta pero no autoriza, avisa que falta
  emparejar. Ojo: con la opción tildada a veces no arranca el servicio (sin `service.adb.tls.port`): apagar y prender.
  Si hay PC con cable, `adb tcpip 5555` desde la PC hace lo mismo. con el puerto TLS (`service.adb.tls.port`) hace `adb tcpip 5555`,
  vuelve a apagar la depuración inalámbrica y levanta el túnel. Necesita WiFi solo para ese paso. Sirve también
  después de reiniciar el celu (sin PC).
- Prendido se nota por la notificación de Termux («wake lock held»).

## Seguridad

- Usuario `celu12t` del VPS: sin password, sin shell (`ForceCommand nologin`, `PermitTTY no`), solo puede
  abrir `172.19.0.1:15555` (`PermitListen` + `permitlisten=` en authorized_keys), `PermitOpen none`.
  Bloque `Match User celu12t` al final de `/etc/ssh/sshd_config`.
- Host key del VPS fijada (`~/.ssh/known_hosts_np`, `StrictHostKeyChecking=yes`; no está en el repo: `ssh-keyscan` + verificar huella).
- IP del VPS en `~/.nophone.env` (`NP_VPS_HOST=…`).
- adbd pide la clave RSA de quien conecta. Autorizadas: el adb del VPS (volumen `no-phone_adb-keys`), el de
  Termux y el de la PC de Goyo. Revocar todo: Opciones de desarrollador → Revocar autorizaciones de depuración.
- El servidor de uiautomator2 escucha solo en 127.0.0.1 del celu (vendor/u2).
- La limpieza de memoria de `naranjax.py` nunca cierra `com.termux` (si no, corta el túnel a mitad del flujo).

## Instalación

Con el celu por USB y Termux abierto: servir esta carpeta (`python -m http.server 8999 --bind 127.0.0.1`),
`adb reverse tcp:8999 tcp:8999` y en Termux `curl -sf http://127.0.0.1:8999/instalar.sh | bash`.
Antes: `ssh-keygen -t ed25519 -f ~/.ssh/tunel` (la pública va a `authorized_keys` de `celu12t`), `pkg upgrade`
(si no, `adb` de android-tools no linkea), y autorizar en pantalla el adb de Termux
(`adb connect 127.0.0.1:5555`). Termux y Termux:Widget tienen que ser de la misma fuente (GitHub) por la firma;
Termux con «mostrar sobre otras apps» (si no, el widget no abre la ventana).
