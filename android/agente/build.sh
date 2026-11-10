#!/usr/bin/env bash
# Compila la APK sin Gradle: aapt2 + javac + d8 + apksigner.
set -euo pipefail
cd "$(dirname "$0")"
SDK=$HOME/android-sdk; BT=$SDK/build-tools/35.0.0; JAR=$SDK/platforms/android-30/android.jar
rm -rf build && mkdir -p build/{res,gen,cls,dex}
$BT/aapt2 compile --dir res -o build/res/res.zip
$BT/aapt2 link -I "$JAR" --manifest AndroidManifest.xml -o build/base.apk \
  --java build/gen build/res/res.zip --min-sdk-version 24 --target-sdk-version 30
javac -nowarn -Xlint:-options -source 8 -target 8 -encoding UTF-8 -cp "$JAR" -d build/cls \
  $(find src build/gen -name '*.java')
$BT/d8 --min-api 24 --lib "$JAR" --output build/dex $(find build/cls -name '*.class')
cp build/base.apk build/sin-firmar.apk
(cd build/dex && zip -q ../sin-firmar.apk classes.dex)
$BT/zipalign -f 4 build/sin-firmar.apk build/alineada.apk
KS=$HOME/android-sdk/spike-debug.keystore
[ -f "$KS" ] || keytool -genkeypair -keystore "$KS" -storepass android -keypass android \
  -alias spike -keyalg RSA -keysize 2048 -validity 3650 -dname "CN=no-phone spike" >/dev/null 2>&1
$BT/apksigner sign --ks "$KS" --ks-pass pass:android --out build/no-phone-agente.apk build/alineada.apk
ls -la build/no-phone-agente.apk
