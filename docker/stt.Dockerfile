# Transcripción local (faster-whisper). Python 3.12: ctranslate2 no publica ruedas para 3.14 todavía.
FROM python:3.12-slim
RUN pip install --no-cache-dir "faster-whisper==1.1.1" "requests>=2.32" "av==13.1.0" "fastapi>=0.115" "uvicorn>=0.32" \
 && useradd -u 10000 -m stt && mkdir -p /models && chown 10000:10000 /models
WORKDIR /app
COPY stt/server.py .
USER 10000:10000
ENV STT_MODELS=/models HF_HOME=/models
EXPOSE 8820
CMD ["uvicorn", "server:app", "--host", "0.0.0.0", "--port", "8820"]
