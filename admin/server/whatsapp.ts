// Puente de WhatsApp de un tenant (whatsapp/bridge): estado, QR, vinculación por código y desvincular.
// Cada tenant tiene su propio puente (una cuenta de WhatsApp por puente) en tools.wa_bridge_url.
import { db, tenantTools, type Tenant } from "./db.ts";
import { HttpError } from "./auth.ts";

export interface WaStatus {
  configured: boolean;
  url: string | null;
  reachable: boolean;
  /** conectando | esperando_qr | conectado | desconectado | deslogueado */
  estado: string | null;
  linked: boolean;
  nombre: string | null;
  numero: string | null;
  chats: number;
  mensajes: number;
  /** Huella del QR vigente; cambia cuando vence y hay uno nuevo. */
  qr: string | null;
  error: string | null;
}

function bridge(t: Tenant) {
  const tools = tenantTools(t);
  if (!tools.wa_bridge_url) throw new HttpError(409, "sin_puente", "Este secretario no tiene puente de WhatsApp configurado.");
  return { url: tools.wa_bridge_url.replace(/\/$/, ""), token: tools.wa_bridge_token };
}

async function call(t: Tenant, method: string, path: string, body?: unknown, timeout = 8000): Promise<Response> {
  const b = bridge(t);
  try {
    return await fetch(`${b.url}${path}`, {
      method,
      headers: {
        ...(b.token ? { authorization: `Bearer ${b.token}` } : {}),
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeout),
    });
  } catch {
    throw new HttpError(502, "puente_caido", "El puente de WhatsApp no responde.");
  }
}

async function bridgeError(r: Response, fallback: string): Promise<never> {
  const msg = ((await r.json().catch(() => null)) as { error?: string } | null)?.error;
  throw new HttpError(r.status >= 500 ? 502 : r.status, "puente_error", msg ?? fallback);
}

export async function status(t: Tenant): Promise<WaStatus> {
  const url = tenantTools(t).wa_bridge_url ?? null;
  const base: WaStatus = { configured: !!url, url, reachable: false, estado: null, linked: false, nombre: null, numero: null, chats: 0, mensajes: 0, qr: null, error: null };
  if (!url) return base;
  try {
    const r = await call(t, "GET", "/status", undefined, 4000);
    if (r.status === 401) return { ...base, error: "el puente pide un token y el guardado no sirve" };
    const s = (await r.json()) as { estado?: string; conectado?: boolean; logueado?: boolean; nombre?: string; jid?: string; chats?: number; mensajes?: number; qr?: string };
    return {
      ...base,
      reachable: true,
      estado: s.estado ?? null,
      linked: !!s.logueado || !!s.jid,
      nombre: s.nombre ?? null,
      numero: s.jid ? s.jid.split("@")[0] : null,
      chats: s.chats ?? 0,
      mensajes: s.mensajes ?? 0,
      qr: s.qr ?? null,
    };
  } catch (e) {
    return { ...base, error: (e as Error).message };
  }
}

export async function qrPng(t: Tenant): Promise<Buffer> {
  const r = await call(t, "GET", "/qr");
  if (!r.ok) await bridgeError(r, "No hay QR pendiente.");
  return Buffer.from(await r.arrayBuffer());
}

export async function pairPhone(t: Tenant, phone: string): Promise<{ code: string }> {
  const digits = phone.replace(/\D/g, "");
  if (digits.length < 10 || digits.length > 15) throw new HttpError(400, "telefono_invalido", "Poné el número completo con código de país, por ejemplo 5492611234567.");
  const r = await call(t, "POST", "/pair-phone", { phone: digits }, 20000);
  if (!r.ok) await bridgeError(r, "No pude pedir el código.");
  const out = (await r.json()) as { code?: string; codigo?: string };
  const code = out.code ?? out.codigo;
  if (!code) throw new HttpError(502, "puente_error", "El puente no devolvió código.");
  return { code };
}

export async function logout(t: Tenant): Promise<void> {
  const r = await call(t, "POST", "/logout", undefined, 25000);
  if (r.status === 404) throw new HttpError(501, "puente_viejo", "El puente no sabe desvincular: hay que actualizarlo y reiniciarlo.");
  if (!r.ok) await bridgeError(r, "No pude desvincular.");
}

const URL_RE = /^https?:\/\/[A-Za-z0-9.-]{1,253}(:\d{2,5})?\/?$/;

/** Dónde está el puente del tenant (y su token, si el puente lo pide). Solo el superadmin. */
export function setBridge(t: Tenant, url: string | null, token: string | undefined) {
  const tools = tenantTools(t);
  if (url) {
    if (!URL_RE.test(url)) throw new HttpError(400, "url_invalida", "La URL va como http://host:puerto.");
    tools.wa_bridge_url = url.replace(/\/$/, "");
  } else {
    delete tools.wa_bridge_url;
    delete tools.wa_bridge_token;
  }
  if (token !== undefined) {
    if (token) tools.wa_bridge_token = token;
    else delete tools.wa_bridge_token;
  }
  db.prepare("UPDATE tenants SET tools = ? WHERE id = ?").run(JSON.stringify(tools), t.id);
}
