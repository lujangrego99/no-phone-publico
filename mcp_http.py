"""Transporte de los MCP de no-phone: stdio (local) o HTTP con token Bearer (Docker / VPS).

    MCP_TRANSPORT=http MCP_HTTP_TOKEN=… MCP_HOST=0.0.0.0 MCP_PORT=8810 python mcp_server.py
    → http://HOST:8810/mcp   (header Authorization: Bearer <token>)

Los tres conectores (naranjax, whatsapp, movilidad) usan lo mismo: en HTTP nunca corren sin token.
"""
from __future__ import annotations

import os
from typing import Any

TRANSPORT = os.environ.get("MCP_TRANSPORT", "stdio")


def mcp_auth(client_id: str, required_reason: str = "datos personales") -> Any:
    """Verificador de token para FastMCP(auth=…); None en stdio."""
    if TRANSPORT == "stdio":
        return None
    token = os.environ.get("MCP_HTTP_TOKEN")
    if not token:
        raise SystemExit(f"MCP_TRANSPORT={TRANSPORT} exige MCP_HTTP_TOKEN ({required_reason})")
    from fastmcp.server.auth.providers.jwt import StaticTokenVerifier

    return StaticTokenVerifier(tokens={token: {"client_id": client_id, "scopes": []}})


def run(mcp: Any, default_port: int) -> None:
    if TRANSPORT == "stdio":
        mcp.run(transport="stdio")
        return
    mcp.run(
        transport="http",
        host=os.environ.get("MCP_HOST", "127.0.0.1"),
        port=int(os.environ.get("MCP_PORT", str(default_port))),
        path="/mcp",
    )
