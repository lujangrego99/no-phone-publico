# no-phone-puente

Une el celu enchufado por USB a una PC (Linux o Windows) con no-phone en el VPS, por adb. Con el puente, no-phone
maneja el celu con uiautomator2 completo (lo que la APK no puede: force-stop, teclas, capturas en Android 10). La PC
tiene que estar prendida y el celu enchufado.

```
celu ─USB─ PC: adb server 127.0.0.1:5037 ⇄ no-phone-puente ══wss══▶ hub de agentes (VPS) :5037 ◀─ no-phone (u2)
```

- La PC conecta **saliente** (wss, el mismo dominio TLS del hub): no abre puertos.
- El destino en la PC es fijo (`127.0.0.1:5037`): el VPS no puede hacer que la PC se conecte a otra cosa.
- En el VPS, el «adb server» del hub escucha solo en la red privada de no-phone (`AGENTE_ADB_VECINO`), no en la red
  de Easypanel que comparten las otras apps: adb no tiene contraseña.
- Una PC puente a la vez (si se conecta otra, reemplaza a la anterior). Token por PC; el VPS guarda solo el sha256.

## Usar

1. En el VPS, código de vinculación (una vez por PC; repetirlo invalida el anterior):
   `docker exec apps_nophone-agente-1 python agente_hub.py alta-puente casa`
2. En la PC, con el celu enchufado y la **depuración USB** activada:
   ```
   no-phone-puente vincular <código>
   no-phone-puente estado        # el celu tiene que figurar «device» (aceptá «¿Permitir depuración?» en el celu)
   no-phone-puente instalar      # que arranque solo al iniciar sesión
   ```
   Si no hay `adb`, el programa baja platform-tools oficial de Google a su carpeta de configuración.
3. En la consola, el perfil del celu con su **serial adb real** (el de `estado`), no `apk:…`.

Linux: `systemctl --user status no-phone-puente`, `journalctl --user -u no-phone-puente -f`. Si `adb devices` dice
`no permissions`, faltan las reglas udev (Arch: `android-udev`). Windows: corre oculto; log en
`%AppData%\no-phone-puente\puente.log`. Si Windows no ve el celu, falta el driver USB de Google o el del fabricante.

## Compilar

`./build.sh` → `dist/no-phone-puente-linux-amd64` y `dist/no-phone-puente-windows-amd64.exe` (+ `SHA256SUMS`).

## Protocolo

WebSocket a `wss://<AGENTE_HOST>/puente` con `X-Puente: <id>` y `Authorization: Bearer <token>`. Marcos binarios:
1 byte tipo (1 abrir · 2 datos · 3 cerrar · 4 abrir acelerado) + 4 bytes id de flujo (big endian) + datos. Cada 25 s
la PC manda un texto `{"ev":"hola","version":…,"capacidades":["acelerar"],"adb_version":"0029",
"adb":[{serial,estado,modelo,transport_id}]}` que el hub muestra en `/estado`.

**Acelerado** (0.2.0): uiautomator2 abre por cada pedido dos conexiones adb y espera cada respuesta; con ~250 ms de
ida y vuelta a la PC eran >1 s por operación. El hub contesta solo `host:version` (con `adb_version`) y la elección
del celu (`host:tport:serial:X` / `host:transport:X`, solo si la PC lo informó `device`) y manda en el marco 4:
1 byte (1 = tport, cuya respuesta trae 8 bytes de id) + pedido de elección + pedido de servicio. La PC manda la
elección, **espera el OKAY** (el adb server descarta lo que llega antes de contestarla) y recién ahí el servicio; el
estado real del servicio vuelve al cliente. Si la elección falla, su FAIL llega como respuesta del servicio.
Medido desde el VPS: exists 1,1 → 0,6 s · dump 1,6 → 1,1 s · app_current 2,8 → 1,1 s · shell 0,84 → 0,32 s.
