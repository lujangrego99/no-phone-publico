// Estado de las piezas de un secretario. Los chequeos lentos (MCP, LLM) se cachean por tenant.
import { hindsight } from "./hindsight.ts";
import { readAgentSettings, schedulerRunning, testMcp } from "./hermes.ts";
import { tenantTools, type Tenant } from "./db.ts";
import { viewDevices, type DeviceView } from "./devices.ts";
import * as wa from "./whatsapp.ts";

export type Health = "ok" | "caido" | "desconocido";

export interface Piece {
  id: string;
  label: string;
  health: Health;
  detail: string;
  checkedAt: string;
}

export interface McpPiece extends Piece {
  tools: number | null;
  ms: number | null;
}

export interface Status {
  memory: Piece;
  llm: Piece;
  scheduler: Piece;
  devices: DeviceView[];
  whatsapp: Piece | null;
  mcp: McpPiece[];
  checkedAt: string;
}

const now = () => new Date().toISOString();
const cache = new Map<string, { at: number; value: Status }>();
const TTL = 60_000;

async function memoryPiece(): Promise<Piece> {
  try {
    const h = await hindsight.health();
    return { id: "memoria", label: "memoria", health: h.status === "healthy" ? "ok" : "caido", detail: `hindsight ${h.status}`, checkedAt: now() };
  } catch {
    return { id: "memoria", label: "memoria", health: "caido", detail: "hindsight no responde", checkedAt: now() };
  }
}

async function llmPiece(t: Tenant): Promise<Piece> {
  try {
    const r = await hindsight.llmHealth(t.bank_id);
    const bad = r.operations.filter((o) => !o.ok);
    if (!bad.length) return { id: "llm", label: "llm de memoria", health: "ok", detail: "guardar, consolidar y reflexionar responden", checkedAt: now() };
    const status = [...new Set(bad.map((o) => o.status))].join(", ");
    const why = status.includes("auth") ? "la API key fue rechazada" : status;
    return { id: "llm", label: "llm de memoria", health: "caido", detail: `${why} · no puede guardar recuerdos`, checkedAt: now() };
  } catch (e) {
    return { id: "llm", label: "llm de memoria", health: "desconocido", detail: (e as Error).message, checkedAt: now() };
  }
}

async function schedulerPiece(t: Tenant): Promise<Piece> {
  const r = await schedulerRunning(t);
  if (r === null) return { id: "programador", label: "programador", health: "desconocido", detail: "no pude consultar hermes", checkedAt: now() };
  return {
    id: "programador",
    label: "programador",
    health: r ? "ok" : "caido",
    detail: r ? "las tareas se disparan a horario" : "el gateway de hermes está apagado · las tareas no se disparan",
    checkedAt: now(),
  };
}

async function whatsappPiece(t: Tenant): Promise<Piece | null> {
  const s = await wa.status(t);
  if (!s.configured) return null;
  const base = { id: "whatsapp-puente", label: "whatsapp", checkedAt: now() };
  if (!s.reachable) return { ...base, health: "caido", detail: s.error && !/no responde/.test(s.error) ? s.error : "el puente no responde" };
  if (s.linked && s.estado === "conectado") return { ...base, health: "ok", detail: `vinculado como ${s.nombre ?? s.numero ?? "?"} · ${s.chats} chats` };
  if (s.estado === "esperando_qr") return { ...base, health: "caido", detail: "sin vincular · escaneá el QR desde tu WhatsApp" };
  if (s.linked) return { ...base, health: "caido", detail: `vinculado pero ${s.estado ?? "sin conexión"} · reconectando` };
  return { ...base, health: "caido", detail: `${s.estado ?? "sin sesión"} · hay que vincular` };
}

async function mcpPieces(t: Tenant): Promise<McpPiece[]> {
  const settings = await readAgentSettings(t);
  // Secuencial: cada test levanta el server MCP; en paralelo dos tocarían el celu a la vez.
  const out: McpPiece[] = [];
  for (const s of settings.mcpServers) {
    const r = await testMcp(t, s.name);
    out.push({
      id: `mcp-${s.name}`,
      label: s.name,
      health: r.ok ? "ok" : "caido",
      detail: r.ok ? `${r.tools ?? "?"} herramientas` : (r.error ?? "no conecta"),
      tools: r.tools,
      ms: r.ms,
      checkedAt: now(),
    });
  }
  return out;
}

/** Algo cambió afuera (vincular, desvincular): la próxima lectura mide de nuevo. */
export function invalidateStatus(t: Tenant) {
  cache.delete(t.id);
}

export async function getStatus(t: Tenant, refresh = false): Promise<Status> {
  const hit = cache.get(t.id);
  if (!refresh && hit && Date.now() - hit.at < TTL) return hit.value;
  const [memory, llm, scheduler, devices, whatsapp, mcp] = await Promise.all([
    memoryPiece(),
    llmPiece(t),
    schedulerPiece(t),
    viewDevices(t),
    whatsappPiece(t),
    mcpPieces(t),
  ]);
  const value: Status = { memory, llm, scheduler, devices, whatsapp, mcp, checkedAt: now() };
  cache.set(t.id, { at: Date.now(), value });
  return value;
}
