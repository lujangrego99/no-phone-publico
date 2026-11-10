"""Voz del secretario para la llamada: Piper, local y gratis (nada sale de la máquina). Solo red interna.

POST /hablar {"texto": "...", "velocidad": 1.0} → audio/wav
La voz se baja una vez de rhasspy/piper-voices al volumen /voces (PIPER_VOZ, p. ej. es_MX-ald-medium; otras: es_AR-daniela-high, es_MX-claude-high).
"""
import io
import os
import threading
import urllib.request
import wave
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.responses import Response
from pydantic import BaseModel

VOZ = os.environ.get("PIPER_VOZ", "es_MX-ald-medium")
VOCES = Path(os.environ.get("PIPER_VOCES", "/voces"))
HF = "https://huggingface.co/rhasspy/piper-voices/resolve/main"

app = FastAPI(title="no-phone tts")
_voz = None
_lock = threading.Lock()


def _ruta_hf(voz: str) -> str:
    # es_AR-daniela-high → es/es_AR/daniela/high/es_AR-daniela-high
    idioma, nombre, calidad = voz.split("-", 2)
    return f"{idioma.split('_')[0]}/{idioma}/{nombre}/{calidad}/{voz}"


def voz():
    global _voz
    if _voz is None:
        from piper import PiperVoice

        modelo = VOCES / f"{VOZ}.onnx"
        if not modelo.exists():
            VOCES.mkdir(parents=True, exist_ok=True)
            for ext in (".onnx.json", ".onnx"):
                tmp = VOCES / f"{VOZ}{ext}.part"
                urllib.request.urlretrieve(f"{HF}/{_ruta_hf(VOZ)}{ext}", tmp)
                tmp.replace(VOCES / f"{VOZ}{ext}")
        _voz = PiperVoice.load(str(modelo))
    return _voz


class Req(BaseModel):
    texto: str
    velocidad: float = 1.0


@app.get("/health")
def health():
    return {"ok": True, "voz": VOZ, "cargada": _voz is not None}


@app.post("/hablar")
def hablar(req: Req):
    texto = req.texto.strip()[:1200]
    if not texto:
        raise HTTPException(400, "texto_vacio")
    from piper import SynthesisConfig

    buf = io.BytesIO()
    with _lock:
        v = voz()
        with wave.open(buf, "wb") as wf:
            # length_scale < 1 = más rápido
            v.synthesize_wav(texto, wf, syn_config=SynthesisConfig(length_scale=1.0 / max(0.6, min(req.velocidad, 1.6))))
    return Response(buf.getvalue(), media_type="audio/wav")
