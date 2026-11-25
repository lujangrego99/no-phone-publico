#!/usr/bin/env python3
"""Resumen de la calidad del audio de las llamadas con voz natural (¿voz trabada por la red o por la PC?).

Lee voz-stats.jsonl del admin (lo escribe POST /voz/stats cada 3 s durante la llamada).
Uso:  docker exec no-phone-admin-1 cat /admin-data/voz-stats.jsonl | python3 scripts/voz_stats.py
"""
import json
import sys
from collections import defaultdict

llamadas = defaultdict(list)
for linea in sys.stdin:
    try:
        m = json.loads(linea)
    except ValueError:
        continue
    llamadas[m.get("llamada", "?")].append(m)

for lid, ms in llamadas.items():
    con_voz = [m for m in ms if m.get("recibidos")]
    print(f"\nllamada {lid}: {len(ms)} muestras ({len(ms) * 3} s aprox), {len(con_voz)} con audio de Qwen")
    if not con_voz:
        continue
    rx = sum(m.get("recibidos", 0) for m in con_voz)
    perd = sum(m.get("perdidos", 0) for m in con_voz)
    rtts = [m["rttMs"] for m in ms if m.get("rttMs")]
    lags = [m.get("lagMaxMs", 0) for m in ms if not m.get("oculta")]
    print(f"  red:  pérdida {100 * perd / max(1, rx + perd):.1f}%  ·  RTT {min(rtts, default=0)}–{max(rtts, default=0)} ms  ·  jitter máx {max(m.get('jitterMs', 0) for m in con_voz)} ms")
    print(f"  audio: relleno máx {max(m.get('rellenoPct', 0) for m in con_voz)}%  ·  cortes {sum(m.get('cortes', 0) for m in con_voz)}  ·  buffer máx {max(m.get('bufferMs', 0) for m in con_voz)} ms")
    print(f"  PC:   peor demora del reloj {max(lags, default=0)} ms (pestaña visible){'  · estuvo oculta' if any(m.get('oculta') for m in ms) else ''}")
    print("  peores tramos (t s: relleno%, perdidos, demora reloj):")
    for m in sorted(con_voz, key=lambda m: -m.get("rellenoPct", 0))[:5]:
        print(f"    {m['t'] / 1000:7.1f}: {m.get('rellenoPct', 0):5.1f}%  perdidos {m.get('perdidos', 0):3}  reloj {m.get('lagMaxMs', 0)} ms")
print("\nCómo leerlo: pérdida o jitter altos cuando se traba → red. Demora del reloj alta (>100 ms) con pestaña visible → PC.")
print("Relleno alto sin pérdida ni demora → Alibaba manda la voz a ráfagas (más lento que tiempo real).")
