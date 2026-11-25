"""Helpers compartidos: distancias, horas en Mendoza, parseo de puntos/horarios."""
from __future__ import annotations

import math
import re
import time
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

TZ = ZoneInfo("America/Argentina/Mendoza")
# Centro del Gran Mendoza (lat, lng) — sesgo para búsquedas.
CENTRO = (-32.8895, -68.8458)

_LATLNG = re.compile(r"^\s*(-?\d{1,2}\.\d+)\s*,\s*(-?\d{1,3}\.\d+)\s*$")
_PARADA = re.compile(r"^\s*([MLml]?\d{3,6})\s*$")


def ahora_ms() -> int:
    return int(time.time() * 1000)


def hhmm(ms: float | int | None) -> str | None:
    if not ms:
        return None
    return datetime.fromtimestamp(ms / 1000, TZ).strftime("%H:%M")


def minutos(desde_ms: float, hasta_ms: float) -> int:
    return round((hasta_ms - desde_ms) / 60000)


def distancia_m(a: tuple[float, float], b: tuple[float, float]) -> float:
    """Haversine entre (lat, lng)."""
    lat1, lng1 = map(math.radians, a)
    lat2, lng2 = map(math.radians, b)
    h = math.sin((lat2 - lat1) / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin((lng2 - lng1) / 2) ** 2
    return 2 * 6371000 * math.asin(math.sqrt(h))


def parse_latlng(texto: str) -> tuple[float, float] | None:
    m = _LATLNG.match(texto or "")
    return (float(m.group(1)), float(m.group(2))) if m else None


def parse_codigo_parada(texto: str) -> str | None:
    m = _PARADA.match(texto or "")
    return m.group(1).upper() if m else None


def parse_hora(texto: str | None) -> int | None:
    """'18:30' (hoy; si ya pasó, mañana) · ISO 'YYYY-MM-DDTHH:MM' · 'en 20' / '+20' minutos · None → None."""
    if not texto:
        return None
    t = texto.strip().lower()
    m = re.match(r"^(?:en\s+|\+)(\d{1,3})\s*(?:m|min|minutos)?$", t)
    if m:
        return ahora_ms() + int(m.group(1)) * 60000
    m = re.match(r"^(\d{1,2})[:.](\d{2})\s*(?:hs?)?$", t)
    if m:
        now = datetime.now(TZ)
        dt = now.replace(hour=int(m.group(1)), minute=int(m.group(2)), second=0, microsecond=0)
        if dt < now - timedelta(minutes=5):
            dt += timedelta(days=1)
        return int(dt.timestamp() * 1000)
    try:
        dt = datetime.fromisoformat(texto.strip())
    except ValueError as e:
        raise ValueError(f"Hora no entendida: {texto!r}. Usá 'HH:MM', 'en 20' o ISO.") from e
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=TZ)
    return int(dt.timestamp() * 1000)
