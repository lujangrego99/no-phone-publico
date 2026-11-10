// Cliente fino de la API de Hindsight (memoria). Un banco por tenant.
import { HttpError } from "./auth.ts";

const BASE = (process.env.HINDSIGHT_URL ?? "http://127.0.0.1:8888").replace(/\/$/, "");

type Query = Record<string, string | number | boolean | undefined | null>;

async function call<T>(method: string, path: string, query?: Query, body?: unknown, timeoutMs = 20000): Promise<T> {
  const url = new URL(BASE + path);
  for (const [k, v] of Object.entries(query ?? {})) if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers: body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    throw new HttpError(502, "memoria_caida", "La memoria (Hindsight) no responde.");
  }
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const detail = typeof data?.detail === "string" ? data.detail : `HTTP ${res.status}`;
    throw new HttpError(res.status >= 500 ? 502 : res.status, "memoria_error", detail);
  }
  return data as T;
}

const bank = (id: string) => `/v1/default/banks/${encodeURIComponent(id)}`;

export const hindsight = {
  health: () => call<{ status: string; database: string }>("GET", "/health", undefined, undefined, 4000),
  ensureBank: (id: string) => call("PUT", bank(id), undefined, {}),
  stats: (id: string) => call<Record<string, unknown>>("GET", `${bank(id)}/stats`),
  llmHealth: (id: string) =>
    call<{ operations: { operation: string; ok: boolean; status: string; latency_ms: number }[] }>(
      "POST",
      `${bank(id)}/health/llm`,
      undefined,
      undefined,
      30000,
    ),
  config: (id: string) => call<{ config: Record<string, unknown> }>("GET", `${bank(id)}/config`),
  patchConfig: (id: string, updates: Record<string, unknown>) => call("PATCH", `${bank(id)}/config`, undefined, { updates }),
  entities: (id: string, q: Query) => call<{ items: unknown[]; total: number }>("GET", `${bank(id)}/entities`, q),
  entity: (id: string, entityId: string) => call<unknown>("GET", `${bank(id)}/entities/${encodeURIComponent(entityId)}`),
  entityGraph: (id: string, q: Query) => call<unknown>("GET", `${bank(id)}/entities/graph`, q),
  memories: (id: string, q: Query) => call<{ items: unknown[]; total: number }>("GET", `${bank(id)}/memories/list`, q),
  memory: (id: string, memoryId: string) =>
    call<{
      id: string;
      text?: string;
      fact_type?: string;
      type?: string;
      state?: string;
      source_memory_ids?: string[] | null;
    }>("GET", `${bank(id)}/memories/${encodeURIComponent(memoryId)}`),
  patchMemory: (id: string, memoryId: string, body: Record<string, unknown>) =>
    call("PATCH", `${bank(id)}/memories/${encodeURIComponent(memoryId)}`, undefined, body),
  /** Borra las fichas derivadas de un recuerdo suelto y dispara consolidación. */
  clearMemoryObservations: (id: string, memoryId: string) =>
    call<{ deleted_count?: number }>("DELETE", `${bank(id)}/memories/${encodeURIComponent(memoryId)}/observations`),
  consolidate: (id: string) => call<unknown>("POST", `${bank(id)}/consolidate`, undefined, {}, 60000),
  recall: (id: string, query: string, maxTokens?: number) =>
    call<unknown>("POST", `${bank(id)}/memories/recall`, undefined, {
      query,
      max_tokens: maxTokens,
      types: ["observation", "world", "experience"],
    }),
  // Guardar un documento propio (mismo document_id = reemplaza lo anterior). async: no espera al LLM de extracción.
  retain: (id: string, items: Record<string, unknown>[]) => call("POST", `${bank(id)}/memories`, undefined, { items, async: true }, 30000),
  deleteDocument: (id: string, documentId: string) => call("DELETE", `${bank(id)}/documents/${encodeURIComponent(documentId)}`),
  directives: (id: string) => call<{ items: unknown[] }>("GET", `${bank(id)}/directives`, { limit: 100 }),
  createDirective: (id: string, body: Record<string, unknown>) => call("POST", `${bank(id)}/directives`, undefined, body),
  patchDirective: (id: string, directiveId: string, body: Record<string, unknown>) =>
    call("PATCH", `${bank(id)}/directives/${encodeURIComponent(directiveId)}`, undefined, body),
  deleteDirective: (id: string, directiveId: string) =>
    call("DELETE", `${bank(id)}/directives/${encodeURIComponent(directiveId)}`),
};
