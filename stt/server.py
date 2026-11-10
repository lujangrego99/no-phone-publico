"""Transcripción local de audios (notas de voz de WhatsApp) con faster-whisper. Gratis y sin sacar el audio
de la máquina. Solo en la red interna del compose; lee únicamente dentro de STT_ROOT (el volumen de WhatsApp).

POST /transcribe {"path": "/wa/whatsapp/media/…/x.opus"} → {"texto", "idioma", "duracion_s", "segundos_proceso"}
"""
import os
import threading
import time
from pathlib import Path

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

ROOT = Path(os.environ.get("STT_ROOT", "/wa")).resolve()
MODEL = os.environ.get("STT_MODEL", "small")
COMPUTE = os.environ.get("STT_COMPUTE", "int8")
THREADS = int(os.environ.get("STT_THREADS", "4"))
LANG = os.environ.get("STT_LANG", "es") or None

app = FastAPI(title="no-phone stt")
_model = None
_lock = threading.Lock()  # un audio a la vez: CPU acotada (WSL / VPS chico)


def model():
    global _model
    if _model is None:
        from faster_whisper import WhisperModel

        _model = WhisperModel(MODEL, device="cpu", compute_type=COMPUTE, cpu_threads=THREADS,
                              download_root=os.environ.get("STT_MODELS", "/models"))
    return _model


class Req(BaseModel):
    path: str


@app.get("/health")
def health():
    return {"ok": True, "modelo": MODEL, "cargado": _model is not None}


@app.post("/transcribe")
def transcribe(req: Req):
    p = Path(req.path).resolve()
    if ROOT not in p.parents:
        raise HTTPException(400, "fuera_de_raiz")
    if not p.is_file():
        raise HTTPException(404, "no_existe")
    t0 = time.monotonic()
    with _lock:
        segs, info = model().transcribe(str(p), language=LANG, vad_filter=True, beam_size=5)
        texto = " ".join(s.text.strip() for s in segs).strip()
    return {
        "texto": texto,
        "idioma": info.language,
        "duracion_s": round(info.duration, 1),
        "segundos_proceso": round(time.monotonic() - t0, 1),
    }
