// Cliente de la agenda (conector «agenda», mcp_agenda.py): quién es quién. La consola le pide lo que sabe de la
// gente nombrada en cada mensaje y le pasa los «es la misma que…» / «separar» de la pantalla de memoria.
// La agenda es la dueña de la identidad y de cómo se entera la memoria (bloque de nombres, reprocesar lo viejo).
const BASE = (process.env.AGENDA_URL ?? "http://nophone-mcp-agenda:8814").replace(/\/$/, "");
const TOKEN = process.env.MCP_HTTP_TOKEN ?? "";

export class AgendaCaida extends Error {}

async function call<T>(method: string, path: string, body?: unknown, timeoutMs = 8000): Promise<T> {
  let r: Response;
  try {
    r = await fetch(BASE + path, {
      method,
      headers: { authorization: `Bearer ${TOKEN}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    throw new AgendaCaida("La agenda no responde.");
  }
  if (!r.ok) throw new AgendaCaida(`La agenda respondió ${r.status}.`);
  return (await r.json()) as T;
}

export interface Grupo {
  alias_id: string;
  alias_nombre: string;
  canonico_id: string;
  canonico_nombre: string;
  ficha: string;
}

export const agenda = {
  grupos: () => call<{ items: Grupo[] }>("GET", "/agenda/grupos"),
  unir: (b: { alias_id: string; alias_nombre: string; canonico_id: string; canonico_nombre: string }) => call<{ ok: boolean }>("POST", "/agenda/unir", b),
  separar: (alias_id: string) => call<{ ok: boolean }>("POST", "/agenda/separar", { alias_id }),
  estado: () => call<Record<string, unknown>>("GET", "/agenda/estado", undefined, 4000),
  // Rápido (SQLite local del conector): si tarda o falla, el mensaje sigue sin esto.
  identidad: (texto: string, timeoutMs = 1500) => call<{ lineas: string[] }>("POST", "/agenda/identidad", { texto }, timeoutMs),
};

// Bloque para las instrucciones de Hermes: la gente que el dueño nombró en ESTE mensaje, tal como está en la agenda.
export async function agendaPara(texto: string): Promise<string> {
  if (!texto.trim()) return "";
  try {
    const { lineas } = await agenda.identidad(texto);
    return lineas.length
      ? "Agenda (quién es quién para tu dueño; para WhatsApp usá el número como destino, para plata su Naranja X):\n" + lineas.join("\n")
      : "";
  } catch {
    return "";
  }
}
