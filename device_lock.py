"""Lock de proceso entre procesos (HTTP uvicorn ↔ MCP stdio).

Sin esto, Claude/HTTP y el MCP pelean el mismo adb/uiautomator2 → timeouts de 90–180s.
"""
from __future__ import annotations

import fcntl
import os
import time
from contextlib import contextmanager
from pathlib import Path

# Un lock por aparato. En Docker, NX_LOCK_DIR (o el dir de NX_LOCK_PATH) en un volumen
# compartido → API y MCP comparten los locks.
if os.environ.get("NX_LOCK_DIR"):
    LOCK_DIR = Path(os.environ["NX_LOCK_DIR"])
elif os.environ.get("NX_LOCK_PATH"):
    LOCK_DIR = Path(os.environ["NX_LOCK_PATH"]).parent
else:
    LOCK_DIR = Path(__file__).parent


def _lock_path(serial: str | None = None) -> Path:
    """Un lock por aparato: se puede usar Redmi y Moto en paralelo desde procesos distintos."""
    try:
        from phones import lock_suffix

        suffix = lock_suffix(serial)
    except Exception:
        suffix = (serial or os.environ.get("ANDROID_SERIAL") or "default").replace("/", "_")
    return LOCK_DIR / f".device-{suffix}.lock"


class DeviceBusy(Exception):
    code = "device_busy"


@contextmanager
def device_lock(timeout: float = 20.0, who: str = "?", serial: str | None = None):
    """flock exclusivo por serial. Si ese celu está ocupado, falla con DeviceBusy."""
    path = _lock_path(serial)
    path.touch(exist_ok=True)
    fh = open(path, "a+", encoding="utf-8")
    start = time.time()
    while True:
        try:
            fcntl.flock(fh.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            break
        except BlockingIOError:
            if time.time() - start >= timeout:
                holder = ""
                try:
                    holder = path.read_text(encoding="utf-8").strip()
                except OSError:
                    pass
                fh.close()
                raise DeviceBusy(
                    f"device_busy: el celular está ocupado por otra operación "
                    f"(esperé {timeout:.0f}s). No uses MCP y HTTP a la vez sobre el mismo serial. "
                    f"lock={path.name} holder={holder or '?'} intento={who} pid={os.getpid()}"
                )
            time.sleep(0.25)
    try:
        fh.seek(0)
        fh.truncate()
        fh.write(f"{who} pid={os.getpid()} t={time.time():.0f}\n")
        fh.flush()
        yield
    finally:
        try:
            fcntl.flock(fh.fileno(), fcntl.LOCK_UN)
        finally:
            fh.close()
