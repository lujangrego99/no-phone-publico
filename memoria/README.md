# Memoria del secretario (Hindsight)

[Hindsight](https://github.com/vectorize-io/hindsight) (MIT) en Docker: entidades, grafo, tiempo y
observaciones consolidadas sobre Postgres + pgvector. Recall sin LLM; el LLM solo se usa al guardar.

```bash
# secreto (600): HINDSIGHT_API_LLM_API_KEY=…   (proveedor/modelo: HINDSIGHT_LLM_* en compose)
docker compose -f compose.hindsight.yaml up -d
curl -s localhost:8888/health          # API
xdg-open http://127.0.0.1:9999         # UI de administración

# banco «goyo»: misión de extracción, tipos de entidad, recall ≤ 1200 tokens
curl -s -X PUT localhost:8888/v1/default/banks/goyo -H 'content-type: application/json' -d '{}'
curl -s -X PATCH localhost:8888/v1/default/banks/goyo/config -H 'content-type: application/json' \
  -d "{\"updates\": $(cat memoria/banco-goyo.json)}"
```

Hermes: `memory.provider: hindsight` + `~/.hermes/hindsight/config.json` (`mode: local_external`,
`bank_id: goyo`). Personalidad de secretario en `~/.hermes/SOUL.md`.
