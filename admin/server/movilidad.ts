// Movilidad para las tarjetas del chat (conector «movilidad», mcp_movilidad.py): cambiar desde dónde salís, actualizar
// arribos, tus lugares. Va directo al conector (sin el modelo): tocar «salgo del laburo» o «actualizar» no gasta turnos.
import type { FastifyInstance, FastifyRequest } from "fastify";
import { HttpError } from "./auth.ts";
import type { Tenant } from "./db.ts";

const BASE = (process.env.MOVILIDAD_URL ?? "http://nophone-mcp-movilidad:8812").replace(/\/$/, "");
const TOKEN = process.env.MCP_HTTP_TOKEN ?? "";

async function call(method: string, path: string, body?: unknown, timeoutMs = 45_000): Promise<unknown> {
  let r: Response;
  try {
    r = await fetch(BASE + path, {
      method,
      headers: { authorization: `Bearer ${TOKEN}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    throw new HttpError(502, "movilidad_caida", "Movilidad no responde ahora.");
  }
  if (!r.ok) throw new HttpError(502, "movilidad_error", `Movilidad respondió ${r.status}.`);
  return r.json();
}

const texto = (v: unknown, max = 200) => (typeof v === "string" ? v.trim().slice(0, max) : "");

export function rutas(app: FastifyInstance, T: string, tenantOf: (req: FastifyRequest) => Tenant) {
  app.post(`${T}/movilidad/viaje`, async (req) => {
    tenantOf(req);
    const b = (req.body ?? {}) as Record<string, unknown>;
    const destino = texto(b.destino);
    if (!destino) throw new HttpError(400, "sin_destino", "Falta adónde vas.");
    return call("POST", "/movilidad/viaje", { destino, origen: texto(b.origen) || null, salida: texto(b.salida, 40) || null });
  });
  app.get(`${T}/movilidad/arribos`, async (req) => {
    tenantOf(req);
    const q = req.query as { parada?: string; linea?: string };
    const parada = texto(q.parada, 12);
    if (!/^[MLml]?\d{3,6}$/.test(parada)) throw new HttpError(400, "parada_invalida", "Parada inválida.");
    const linea = texto(q.linea, 8);
    return call("GET", `/movilidad/arribos?parada=${encodeURIComponent(parada)}${linea ? `&linea=${encodeURIComponent(linea)}` : ""}`, undefined, 20_000);
  });
  app.get(`${T}/movilidad/lugares`, async (req) => {
    tenantOf(req);
    return call("GET", "/movilidad/lugares", undefined, 5_000);
  });
}
