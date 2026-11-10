"""Parches sobre el Hermes fijado (HERMES_REF), hasta subir a una versión que ya los traiga.

1. API /v1/responses con `conversation`: para saber dónde empieza el turno, Hermes comparaba el historial
   guardado con el que devuelve el agente con igualdad de dicts entera; el agente estampa `_db_persisted`,
   `reasoning`, etc., así que nunca coincidía y cada mensaje re-pegaba todo el historial (se duplicaba:
   5 → 12 → 27 → 69 → 139 ítems, y comprimía a los pocos mensajes). Upstream lo arregló comparando solo
   rol/contenido/herramientas (#95137, gateway/platforms/api_server_turn_boundary.py); esto es lo mismo.
2. Memoria (Hindsight): un turno cuyo mensaje empieza con «⟦ensayo⟧» no se guarda. Son los ensayos de misión de la
   consola: eventos de mentira («Pepe te transfirió 100») que no pueden terminar como hechos del dueño.
"""
import sys
from pathlib import Path

f = Path("/opt/hermes/gateway/platforms/api_server.py")
src = f.read_text()

viejo = """        prior = list(conversation_history)
        current_user = {"role": "user", "content": user_message}
        expected_prefix = prior + [current_user]
        if agent_messages[:len(expected_prefix)] == expected_prefix:
            return len(expected_prefix)
        if prior and agent_messages[:len(prior)] == prior:
            return len(prior)
        return 0
"""
nuevo = """        prior = list(conversation_history)
        current_user = {"role": "user", "content": user_message}
        expected_prefix = prior + [current_user]
        claves = ("role", "content", "tool_calls", "tool_call_id")  # parche no-phone (upstream #95137)

        def _mismo_prefijo(got_all, want_all):
            if len(got_all) < len(want_all):
                return False
            for got, want in zip(got_all, want_all):
                if isinstance(got, dict) and isinstance(want, dict):
                    if any(got.get(k) != want.get(k) for k in claves):
                        return False
                elif got != want:
                    return False
            return True

        if _mismo_prefijo(agent_messages, expected_prefix):
            return len(expected_prefix)
        if prior and _mismo_prefijo(agent_messages, prior):
            return len(prior)
        return 0
"""
if nuevo in src:
    print("[parches] turn boundary: ya aplicado")
elif src.count(viejo) == 1:
    f.write_text(src.replace(viejo, nuevo))
    print("[parches] turn boundary: aplicado")
else:
    sys.exit("[parches] turn boundary: no encontré el código a parchear (¿cambió HERMES_REF?)")


# ---------- 2. ensayos de misión fuera de la memoria ----------
m = Path("/opt/hermes/plugins/memory/hindsight/__init__.py")
msrc = m.read_text()
ancla = """        if self._shutting_down.is_set():
            logger.debug("sync_turn: skipped (shutting down)")
            return
"""
extra = """        if str(user_content or "").lstrip().startswith("\u27e6ensayo\u27e7"):  # parche no-phone: ensayos de misión
            logger.debug("sync_turn: skipped (ensayo de misión)")
            return
"""
if extra in msrc:
    print("[parches] ensayo fuera de la memoria: ya aplicado")
elif msrc.count(ancla) == 1:
    m.write_text(msrc.replace(ancla, ancla + extra))
    print("[parches] ensayo fuera de la memoria: aplicado")
else:
    sys.exit("[parches] ensayo fuera de la memoria: no encontré sync_turn (¿cambió HERMES_REF?)")
