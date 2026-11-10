"""Instala/actualiza la APK en el Redmi (MIUI bloquea `adb install` y Play Protect bloquea apps con accesibilidad).
Camino: copiar a Descargas -> abrir desde el Administrador de archivos (u2) con el verificador apagado SOLO durante
la instalación; al final restaura verificador y el permiso de instalar del explorador."""
import os, subprocess, time, sys
import xml.etree.ElementTree as ET
os.environ.setdefault("ANDROID_ADB_SERVER_HOST", "172.24.240.1")
import uiautomator2 as u2

A = "/mnt/c/Users/samsung/platform-tools/adb.exe"
S = "TU_SERIAL"
FE = "com.mi.android.globalFileexplorer"
AQUI = os.path.dirname(os.path.abspath(__file__))


def sh(c):
    return subprocess.run([A, "-s", S, "shell", c], capture_output=True, text=True).stdout.strip()


win = r"C:\Users\samsung\Documents\nophone-agente.apk"
subprocess.run(["cp", os.path.join(AQUI, "build", "no-phone-agente.apk"), "/mnt/c/Users/samsung/Documents/nophone-agente.apk"], check=True)
subprocess.run([A, "-s", S, "push", win, "/sdcard/Download/nophone-agente.apk"], capture_output=True, check=True)
sh("am broadcast -a android.intent.action.MEDIA_SCANNER_SCAN_FILE -d file:///sdcard/Download/nophone-agente.apk")
d = u2.connect(S)
d.screen_on()


def textos():
    return [e.attrib.get("text") for e in ET.fromstring(d.dump_hierarchy()).iter() if e.attrib.get("text")]


prev = sh("settings get global package_verifier_enable") or "1"
sh("settings put global package_verifier_enable 0")
sh(f"appops set {FE} REQUEST_INSTALL_PACKAGES allow")
ok = False
try:
    d.app_start(FE, stop=True)
    time.sleep(2.5)
    for t in ("Cancelar", "CANCELAR"):
        if d(text=t).exists(timeout=0):
            d(text=t).click(); time.sleep(1)
    d(text="nophone-agente.apk").click(timeout=8)
    for i in range(30):
        time.sleep(1.0)
        ts = textos()
        if any(t in ts for t in ("Se instaló la app.", "LISTO", "ABRIR")):
            ok = True
            if d(text="LISTO").exists(timeout=0): d(text="LISTO").click()
            break
        for t in ("INSTALAR", "ACTUALIZAR", "Instalar", "Actualizar", "INSTALAR DE TODAS FORMAS", "CONTINUAR", "ACEPTAR"):
            if t in ts:
                d(text=t).click(); break
finally:
    sh(f"settings put global package_verifier_enable {prev if prev != 'null' else '1'}")
    sh(f"appops set {FE} REQUEST_INSTALL_PACKAGES default")
    d.press("home")
print("instalada" if ok else "NO se pudo instalar", "| verifier=", sh("settings get global package_verifier_enable"),
      "|", sh("dumpsys package ar.nophone.agente | grep -m1 lastUpdateTime"))
sys.exit(0 if ok else 1)
