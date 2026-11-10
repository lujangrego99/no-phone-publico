// Cliente de la API de la consola. Toda mutación lleva el header anti-CSRF.
import { useEffect, useState } from "react";
export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/api${path}`, {
      method,
      credentials: "same-origin",
      headers: {
        ...(method === "GET" ? {} : { "x-np": "1" }),
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0, "sin_conexion", "No hay conexión con la consola.");
  }
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) throw new ApiError(res.status, data?.error ?? "error", data?.message ?? `Error ${res.status}`);
  return data as T;
}

export const api = {
  get: <T>(path: string) => request<T>("GET", path),
  post: <T>(path: string, body?: unknown) => request<T>("POST", path, body ?? {}),
  put: <T>(path: string, body?: unknown) => request<T>("PUT", path, body ?? {}),
  patch: <T>(path: string, body?: unknown) => request<T>("PATCH", path, body ?? {}),
  del: <T>(path: string) => request<T>("DELETE", path),
};

// ---------- tipos compartidos con el servidor ----------

export interface SessionUser {
  id: number;
  name: string;
  email: string;
  role: "superadmin" | "owner";
  tenantId: string | null;
}
export interface Session {
  user: SessionUser | null;
  needsSetup: boolean;
  tenants: { id: string; name: string }[];
}

export type Depth = 0 | 1 | 2 | 3;

export interface PulseLine {
  id: string;
  depth: Depth;
  failed: boolean;
  title: string;
  detail: string;
  to: string;
  action: string;
}
export interface Pulse {
  lines: PulseLine[];
  signal: { at: string; who: string; text: string }[];
  counts: { memories: number; observations: number; jobs: number; devices: number; tools: number; toolsUp: number };
  checkedAt: string;
}

export type Health = "ok" | "caido" | "desconocido";
export interface Piece {
  id: string;
  label: string;
  health: Health;
  detail: string;
  checkedAt: string;
}
export interface DeviceView {
  id: string;
  kind: "fisico" | "virtual";
  label: string;
  serial: string | null;
  adbServer: string | null;
  active: boolean;
  profile: { fabricante?: string; modelo?: string; android?: string; resolucion?: string; ui_mode?: "fast" | "normal" | "safe" };
  secrets: Record<string, boolean>;
  health: Health;
  detail: string;
}
export interface Status {
  memory: Piece;
  llm: Piece;
  scheduler: Piece;
  devices: DeviceView[];
  whatsapp: Piece | null;
  mcp: (Piece & { tools: number | null; ms: number | null })[];
  checkedAt: string;
}

export interface WaStatus {
  configured: boolean;
  url: string | null;
  reachable: boolean;
  estado: string | null;
  linked: boolean;
  nombre: string | null;
  numero: string | null;
  chats: number;
  mensajes: number;
  qr: string | null;
  error: string | null;
}

// «tipo:persona» y similares son etiquetas que la memoria a veces guarda como si fueran entidades; «user», «assistant»
// son los roles genéricos con que a veces se nombra al dueño o al secretario. Nunca se muestran como gente.
export const esRuido = (name: string) => /^tipo:/i.test(name) || /^(user|usuario|assistant|asistente|the user|hermes agent|secretario|secretaria)$/i.test(name.trim());

// Grafo de co-ocurrencia de Hindsight (formato cytoscape): dos entidades unidas = aparecieron juntas en lo guardado.
export interface EntityGraph {
  nodes: { data: { id: string; label: string; mentionCount: number } }[];
  edges: { data: { source: string; target: string; weight: number; lastCooccurred: string | null } }[];
  total_entities: number;
  total_edges: number;
}

// Nombres que el dueño unió («Goyo», «Grego» → «Juan Gregorio Pérez»). canonico nunca es a su vez un alias.
export interface Alias {
  alias_id: string;
  alias_nombre: string;
  canonico_id: string;
  canonico_nombre: string;
}

// Para sugerir duplicados: sin tildes ni mayúsculas, por palabra.
const palabras = (s: string) =>
  s
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 4);
// «Berna» ~ «Bernabe Gabriel Sosa» (una palabra empieza con la otra), «Sosá» ~ «Sosa».
export function parecidos(a: string, b: string): boolean {
  const pa = palabras(a);
  const pb = palabras(b);
  return pa.some((x) => pb.some((y) => x === y || (x.length >= 4 && y.startsWith(x)) || (y.length >= 4 && x.startsWith(y))));
}

export interface Entity {
  id: string;
  canonical_name: string;
  mention_count: number;
  first_seen: string | null;
  last_seen: string | null;
  metadata: Record<string, unknown> | null;
}
export interface EntityDetail extends Entity {
  observations: { text: string; mentioned_at: string | null }[];
}
export interface MemoryUnit {
  id: string;
  text: string;
  context: string | null;
  date: string | null;
  fact_type: "world" | "experience" | "observation" | string;
  source_memory_ids?: string[] | null; // en una ficha: los datos sueltos que resume
  mentioned_at: string | null;
  entities: Entities;
  proof_count: number | null;
  state: string | null;
  invalidation_reason: string | null;
  edited_at: string | null;
}
export interface Rule {
  id: string;
  name: string;
  content: string;
  is_active: boolean;
  priority: number;
}
export interface Job {
  id: string;
  name: string;
  prompt: string;
  schedule: string;
  state: string;
  enabled: boolean;
  next_run_at: string | null;
  last_run_at: string | null;
  last_status: string | null;
  last_error: string | null;
  repeat: { times: number | null; completed: number } | null;
}
export interface Secretary {
  soul: string;
  model: { provider: string | null; default: string | null; base_url: string | null };
  memoryProvider: string | null;
  recall: { recall_budget?: string; recall_max_tokens?: number; recall_types?: string; auto_recall?: boolean; auto_retain?: boolean };
  bank: {
    retain_mission: string | null;
    observations_mission: string | null;
    recall_max_tokens: number | null;
    disposition_skepticism: number | null;
    disposition_literalism: number | null;
    disposition_empathy: number | null;
  };
  bankId: string;
  providerKeys: Record<string, boolean>;
}

// ---------- formato ----------

export function when(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  // «hoy 14:30», «mañana 09:00», «ayer 22:10», «jue 23/10 14:30»: se lee de un vistazo, sin hacer cuentas.
  const hm = d.toLocaleTimeString("es-AR", { hour: "2-digit", minute: "2-digit", hour12: false });
  const dia = (x: Date) => new Date(x.toDateString()).getTime();
  const dif = Math.round((dia(d) - dia(new Date())) / 86_400_000);
  if (dif === 0) return `hoy ${hm}`;
  if (dif === 1) return `mañana ${hm}`;
  if (dif === -1) return `ayer ${hm}`;
  const fecha = d.toLocaleDateString("es-AR", { weekday: "short", day: "2-digit", month: "2-digit" }).replace(",", "");
  return `${fecha} ${hm}`;
}

// Hindsight devuelve las entidades como lista o como texto «a, b» (según versión): siempre texto legible.
export type Entities = string[] | string | null;
// Sin las etiquetas («tipo:persona») ni los roles genéricos que la memoria cuelga de cada recuerdo.
export const entitiesText = (e: Entities | undefined): string =>
  (Array.isArray(e) ? e : (e ?? "").split(","))
    .map((x) => x.trim())
    .filter((x) => x && !esRuido(x))
    .join(", ");

// La memoria agrega metadatos al texto de los datos sueltos («… | When: … | Involving: …»): se muestra la oración.
export const textoRecuerdo = (t: string) => t.split(" | ")[0].trim();

// Para buscar sin que importen tildes ni mayúsculas («jose» encuentra «José»).
export const sinTildes = (t: string) => t.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();

// Qué es cada nombre de la memoria (lo calcula el servidor: agenda + etiquetas «tipo:» del grafo; ver server/tipos.ts).
export type TipoNombre = "gente" | "grupo" | "lugar" | "cuenta" | "otro";
export const TIPOS: { id: TipoNombre; plural: string }[] = [
  { id: "gente", plural: "gente" },
  { id: "grupo", plural: "grupos" },
  { id: "lugar", plural: "lugares" },
  { id: "cuenta", plural: "cuentas y empresas" },
  { id: "otro", plural: "otras cosas" },
];
// Si el servidor no lo sabe (nombre sin vínculos): un nombre propio es alguien; una palabra común, otra cosa.
export const tipoPorDefecto = (nombre: string): TipoNombre => (/^\p{Lu}|^\+?\d{7,}/u.test(nombre.trim()) ? "gente" : "otro");

// Valor que espera a que dejes de tipear (búsquedas en vivo que van al servidor).
export function useDemorado<T>(v: T, ms = 300): T {
  const [d, setD] = useState(v);
  useEffect(() => {
    const t = setTimeout(() => setD(v), ms);
    return () => clearTimeout(t);
  }, [v, ms]);
  return d;
}
