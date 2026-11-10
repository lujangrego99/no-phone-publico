# Voz del secretario (Piper TTS). Local, CPU.
FROM python:3.12-slim
RUN pip install --no-cache-dir "piper-tts==1.8.0" "fastapi>=0.115" "uvicorn>=0.32" \
 && useradd -u 10000 -m tts && mkdir -p /voces && chown 10000:10000 /voces
WORKDIR /app
COPY tts/server.py .
USER 10000:10000
EXPOSE 8830
CMD ["uvicorn", "server:app", "--host", "0.0.0.0", "--port", "8830"]
