# Hermes de upstream (servicio hermes-base, compilado desde su repo) + nuestros parches.
FROM no-phone-hermes-base:latest
COPY docker/hermes_parches.py /tmp/hermes_parches.py
RUN python3 /tmp/hermes_parches.py && rm /tmp/hermes_parches.py
# Búsqueda web sin key (backend «ddgs» de Hermes): sin esto el secretario no puede averiguar nada de afuera.
RUN uv pip install --python /opt/hermes/.venv/bin/python --no-cache ddgs
