// Consola no-phone: API + estáticos. Escucha solo en loopback (en el VPS se llega por Tailscale).
import Fastify, { type FastifyRequest } from "fastify";
import cookie from "@fastify/cookie";
import fastifyStatic from "@fastify/static";
import { existsSync } from "node:fs";
import { readFile, writeFile, mkdir, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { db, getTenant, listTenants, logEvent, type Tenant } from "./db.ts";
import {
  HttpError,
  SESSION_COOKIE,
  createSession,
  destroySession,
  hashPassword,
  requireSuperadmin,
  setSessionCookie,
  tenantFor,
  userCount,
  userFromToken,
  verifyPassword,
} from "./auth.ts";
import { hindsight } from "./hindsight.ts";
import * as hermes from "./hermes.ts";
import { getStatus } from "./status.ts";
import { getPulse } from "./pulse.ts";
import * as devices from "./devices.ts";
import * as wa from "./whatsapp.ts";
import { invalidateStatus } from "./status.ts";
import * as llamada from "./llamada.ts";
import * as voz from "./voz.ts";
import * as reglas from "./reglas.ts";
import * as revision from "./revision.ts";
import * as misiones from "./misiones.ts";
import * as alias from "./alias.ts";
import * as tipos from "./tipos.ts";
import * as waAudio from "./wa-audio.ts";
import * as movilidad from "./movilidad.ts";

const here = dirname(fileURLToPath(import.meta.url));
const HOST = process.env.ADMIN_HOST ?? "127.0.0.1";
const PORT = Number(process.env.ADMIN_PORT ?? 8890);
const HINDSIGHT_URL = process.env.HINDSIGHT_URL ?? "http://127.0.0.1:8888";
const DEFAULT_HERMES_HOME = process.env.HERMES_HOME ?? join(homedir(), ".hermes");

const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? "info", redact: ["req.headers.cookie", "req.body.password"] } });
await app.register(cookie);

app.decorateRequest("user", null);
app.addHook("onRequest", async (req) => {
  req.user = userFromToken(req.cookies[SESSION_COOKIE]);
  // CSRF: toda mutación exige un header propio (fuerza preflight) además de la cookie SameSite=Strict.
  if (req.url.startsWith("/api/") && !["GET", "HEAD", "OPTIONS"].includes(req.method) && req.headers["x-np"] !== "1") {
    throw new HttpError(403, "csrf", "Pedido rechazado.");
  }
});

app.setErrorHandler((err, _req, reply) => {
  if (err instanceof HttpError) return reply.status(err.status).send({ error: err.code, message: err.message });
  const status = (err as { statusCode?: number }).statusCode;
  if (status && status < 500) return reply.status(status).send({ error: "pedido_invalido", message: (err as Error).message });
  app.log.error(err);
  return reply.status(500).send({ error: "interno", message: "Algo falló en la consola." });
});

type Body = Record<string, unknown>;
const str = (b: Body, k: string, max = 20000): string => {
  const v = b?.[k];
  if (typeof v !== "string") throw new HttpError(400, "falta_dato", `Falta «${k}».`);
  if (v.length > max) throw new HttpError(400, "muy_largo", `«${k}» es demasiado largo.`);
  return v;
};
const optStr = (b: Body, k: string, max = 20000): string | undefined => (b?.[k] === undefined || b?.[k] === null ? undefined : str(b, k, max));
const SLUG = /^[a-z0-9][a-z0-9-]{1,30}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function checkPassword(p: string) {
  if (p.length < 10 || !/[a-z]/.test(p) || !/[A-Z]/.test(p) || !/\d/.test(p) || !/[^A-Za-z0-9]/.test(p))
    throw new HttpError(400, "clave_debil", "La contraseña necesita al menos 10 caracteres, con mayúscula, minúscula, número y un carácter especial.");
}

// En Docker el puerto se publica solo en el loopback del host, pero el pedido llega desde el gateway
// de la red de Docker: ADMIN_SETUP_ANY_IP=1 (lo pone compose.yaml) habilita el setup igual.
const isLoopback = (req: FastifyRequest) =>
  process.env.ADMIN_SETUP_ANY_IP === "1" || ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(req.ip);

// ---------- sesión ----------

function sessionPayload(req: FastifyRequest) {
  const u = req.user;
  if (!u) return { user: null, needsSetup: userCount() === 0, tenants: [] };
  const tenants = (u.role === "superadmin" ? listTenants() : listTenants().filter((t) => t.id === u.tenant_id)).map((t) => ({ id: t.id, name: t.name }));
  return { user: { id: u.id, name: u.name, email: u.email, role: u.role, tenantId: u.tenant_id }, needsSetup: false, tenants };
}

app.get("/api/session", async (req) => sessionPayload(req));

const attempts = new Map<string, { n: number; until: number }>();
app.post("/api/login", async (req, reply) => {
  const b = req.body as Body;
  const a = attempts.get(req.ip);
  if (a && a.until > Date.now()) throw new HttpError(429, "esperar", "Demasiados intentos. Probá en un minuto.");
  const email = str(b, "email", 200).trim();
  const row = db.prepare("SELECT id, pass_hash FROM users WHERE email = ?").get(email) as { id: number; pass_hash: string } | undefined;
  if (!row || !verifyPassword(str(b, "password", 200), row.pass_hash)) {
    const n = (a?.n ?? 0) + 1;
    attempts.set(req.ip, { n, until: n >= 5 ? Date.now() + 60_000 : 0 });
    throw new HttpError(401, "credenciales", "Email o contraseña incorrectos.");
  }
  attempts.delete(req.ip);
  const { token, maxAge } = createSession(row.id);
  setSessionCookie(reply, token, maxAge);
  req.user = userFromToken(token);
  return sessionPayload(req);
});

app.post("/api/logout", async (req, reply) => {
  destroySession(req.cookies[SESSION_COOKIE]);
  reply.clearCookie(SESSION_COOKIE, { path: "/" });
  return { ok: true };
});

// ---------- alta de tenants ----------

// Con qué etiqueta guarda la memoria cada charla. Sin esto Hermes pone «conversation between Hermes Agent and the
// User» y la memoria termina guardando «Hermes Agent», «the User» y «el usuario es…» como si fueran datos.
const contextoMemoria = (dueno: string) =>
  `Charla por chat entre ${dueno} (el dueño) y su secretario personal. Las líneas «${dueno}: …» son lo que dice el dueño; ` +
  "las «Secretario: …» son lo que contesta el secretario (lo que él hace no es un dato del dueño).";

async function provisionTenant(opts: { id: string; name: string; hermesHome?: string; bankId?: string; waBridgeUrl?: string }): Promise<Tenant> {
  const { id, name } = opts;
  if (!SLUG.test(id)) throw new HttpError(400, "id_invalido", "El id va en minúsculas, números y guiones.");
  if (getTenant(id)) throw new HttpError(409, "id_repetido", "Ya existe un secretario con ese id.");
  let home = opts.hermesHome;
  const bankId = opts.bankId ?? id;
  const fresh = !home;
  if (!home) {
    await hermes.createProfile(id);
    home = join(DEFAULT_HERMES_HOME, "profiles", id);
  }
  if (fresh) {
    const soul = (await readFile(join(here, "templates/soul.md"), "utf8")).replaceAll("{{dueno}}", name);
    await writeFile(join(home, "SOUL.md"), soul, { mode: 0o600 });
    const base = join(DEFAULT_HERMES_HOME, "hindsight/config.json");
    const hcfg = existsSync(base) ? JSON.parse(await readFile(base, "utf8")) : { mode: "local_external", api_url: HINDSIGHT_URL };
    hcfg.bank_id = bankId;
    hcfg.retain_user_prefix = name;
    hcfg.retain_assistant_prefix = "Secretario";
    hcfg.retain_context = contextoMemoria(name);
    await mkdir(join(home, "hindsight"), { recursive: true });
    await writeFile(join(home, "hindsight/config.json"), JSON.stringify(hcfg, null, 2) + "\n", { mode: 0o600 });
  }
  if (!fresh) {
    // Secretario existente (setup): su memoria pasa a ser el banco elegido.
    const p = join(home, "hindsight/config.json");
    const hcfg = existsSync(p) ? JSON.parse(await readFile(p, "utf8")) : { mode: "local_external", api_url: HINDSIGHT_URL };
    if (hcfg.bank_id !== bankId) {
      hcfg.bank_id = bankId;
      hcfg.retain_user_prefix ??= name;
      hcfg.retain_context ??= contextoMemoria(name);
      await mkdir(join(home, "hindsight"), { recursive: true });
      await writeFile(p, JSON.stringify(hcfg, null, 2) + "\n", { mode: 0o600 });
    }
  }
  await hindsight.ensureBank(bankId);
  // Banco nuevo o sin misión (setup sobre un secretario que ya existía): se le aplica la plantilla.
  const sinMision = !fresh && !(await hindsight.config(bankId).catch(() => ({ config: {} as Record<string, unknown> }))).config.retain_mission;
  if (fresh || sinMision) {
    const tpl = JSON.parse((await readFile(join(here, "templates/bank.json"), "utf8")).replaceAll("{{dueno}}", name));
    await hindsight.patchConfig(bankId, tpl);
  }
  const tools: Record<string, string> = opts.waBridgeUrl ? { wa_bridge_url: opts.waBridgeUrl } : {};
  if (opts.waBridgeUrl && process.env.WA_BRIDGE_TOKEN) tools.wa_bridge_token = process.env.WA_BRIDGE_TOKEN;
  if (fresh) {
    // Cada secretario nuevo con sus propios celulares; su MCP naranjax los lee de ahí.
    tools.phones_file = join(home, "no-phone/phones.json");
    tools.phone_secrets_dir = join(home, "no-phone/devices");
    await hermes.setMcpEnv({ id, name, hermes_home: home, bank_id: bankId, tools: "{}", created_at: "" }, "naranjax", {
      NX_PHONES_FILE: tools.phones_file,
      NX_PHONE_SECRETS_DIR: tools.phone_secrets_dir,
    });
  }
  db.prepare("INSERT INTO tenants (id, name, hermes_home, bank_id, tools) VALUES (?, ?, ?, ?, ?)").run(id, name, home, bankId, JSON.stringify(tools));
  return getTenant(id)!;
}

// Primer arranque: crea el superadmin y registra el secretario que ya existe en esta máquina.
app.post("/api/setup", async (req, reply) => {
  if (userCount() > 0) throw new HttpError(409, "ya_configurado", "La consola ya está configurada.");
  if (!isLoopback(req)) throw new HttpError(403, "solo_local", "La configuración inicial solo se hace desde esta máquina.");
  const b = req.body as Body;
  const name = str(b, "name", 80).trim();
  const email = str(b, "email", 200).trim();
  const password = str(b, "password", 200);
  const tenantId = str(b, "tenantId", 31).trim();
  if (!name) throw new HttpError(400, "falta_nombre", "Poné tu nombre.");
  if (!EMAIL.test(email)) throw new HttpError(400, "email_invalido", "Ese email no parece válido.");
  checkPassword(password);
  const tenant = await provisionTenant({
    id: tenantId,
    name,
    hermesHome: DEFAULT_HERMES_HOME,
    bankId: optStr(b, "bankId", 60)?.trim() || tenantId,
    waBridgeUrl: process.env.WA_BRIDGE_URL ?? "http://127.0.0.1:8801",
  });
  const info = db.prepare("INSERT INTO users (email, name, pass_hash, role, tenant_id) VALUES (?, ?, ?, 'superadmin', ?)").run(email, name, hashPassword(password), tenant.id);
  const userId = Number(info.lastInsertRowid);
  logEvent(tenant.id, userId, "setup", "consola configurada");
  const { token, maxAge } = createSession(userId);
  setSessionCookie(reply, token, maxAge);
  req.user = userFromToken(token);
  return sessionPayload(req);
});

app.get("/api/admin/tenants", async (req) => {
  requireSuperadmin(req);
  const counts = await Promise.all(listTenants().map((t) => devices.countDevices(t).catch(() => 0)));
  return listTenants().map((t, i) => ({
    id: t.id,
    name: t.name,
    bankId: t.bank_id,
    hermesHome: t.hermes_home,
    createdAt: t.created_at,
    devices: counts[i],
    users: db.prepare("SELECT id, name, email, role FROM users WHERE tenant_id = ? ORDER BY id").all(t.id),
  }));
});

app.post("/api/admin/tenants", async (req) => {
  const me = requireSuperadmin(req);
  const b = req.body as Body;
  const id = str(b, "id", 31).trim();
  const ownerName = str(b, "ownerName", 80).trim();
  const ownerEmail = str(b, "ownerEmail", 200).trim();
  const ownerPassword = str(b, "ownerPassword", 200);
  if (!ownerName) throw new HttpError(400, "falta_nombre", "Poné el nombre del dueño.");
  if (!EMAIL.test(ownerEmail)) throw new HttpError(400, "email_invalido", "Ese email no parece válido.");
  checkPassword(ownerPassword);
  if (db.prepare("SELECT 1 FROM users WHERE email = ?").get(ownerEmail)) throw new HttpError(409, "email_repetido", "Ya hay un usuario con ese email.");
  const t = await provisionTenant({ id, name: ownerName });
  db.prepare("INSERT INTO users (email, name, pass_hash, role, tenant_id) VALUES (?, ?, ?, 'owner', ?)").run(ownerEmail, ownerName, hashPassword(ownerPassword), t.id);
  logEvent(t.id, me.id, "tenant", `secretario creado para ${ownerName}`);
  return { ok: true, id: t.id };
});

app.post("/api/admin/tenants/:tenant/users", async (req) => {
  const me = requireSuperadmin(req);
  const t = tenantFor(req, (req.params as { tenant: string }).tenant);
  const b = req.body as Body;
  const name = str(b, "name", 80).trim();
  const email = str(b, "email", 200).trim();
  const password = str(b, "password", 200);
  if (!name || !EMAIL.test(email)) throw new HttpError(400, "datos_invalidos", "Nombre o email inválidos.");
  checkPassword(password);
  try {
    db.prepare("INSERT INTO users (email, name, pass_hash, role, tenant_id) VALUES (?, ?, ?, 'owner', ?)").run(email, name, hashPassword(password), t.id);
  } catch {
    throw new HttpError(409, "email_repetido", "Ya hay un usuario con ese email.");
  }
  logEvent(t.id, me.id, "usuario", `acceso dado a ${name}`);
  return { ok: true };
});

app.delete("/api/admin/users/:id", async (req) => {
  const me = requireSuperadmin(req);
  const id = Number((req.params as { id: string }).id);
  if (id === me.id) throw new HttpError(400, "uno_mismo", "No podés borrarte a vos.");
  const u = db.prepare("SELECT name, tenant_id FROM users WHERE id = ?").get(id) as { name: string; tenant_id: string | null } | undefined;
  if (!u) throw new HttpError(404, "no_existe", "Ese usuario no existe.");
  db.prepare("DELETE FROM users WHERE id = ?").run(id);
  logEvent(u.tenant_id, me.id, "usuario", `acceso quitado a ${u.name}`);
  return { ok: true };
});

// ---------- por tenant ----------

const T = "/api/t/:tenant";
const tenantOf = (req: FastifyRequest) => tenantFor(req, (req.params as { tenant: string }).tenant);
const q = (req: FastifyRequest) => req.query as Record<string, string | undefined>;
const clampInt = (v: string | undefined, def: number, min: number, max: number) => Math.max(min, Math.min(max, Number.parseInt(v ?? "", 10) || def));

// Miniatura de un adjunto que el secretario va a mandar (hoy: comprobantes de Naranja X). Solo esa carpeta:
// el resto del volumen tiene config y PINs. Las herramientas ven el volumen en /data; la consola, en /app-data.
const ADJUNTOS = (process.env.ADJUNTOS_DIR ?? "/app-data/no-phone/comprobantes").replace(/\/$/, "");
app.get(`${T}/adjunto`, async (req, reply) => {
  tenantOf(req);
  const ruta = String(q(req).ruta ?? "");
  const local = ruta.replace(/^\/data\//, "/app-data/");
  let real: string;
  try {
    real = await realpath(local);
  } catch {
    throw new HttpError(404, "sin_adjunto", "No encontré el archivo.");
  }
  if (!real.startsWith(ADJUNTOS + "/") || !/\.(png|jpe?g|webp|gif)$/i.test(real)) throw new HttpError(403, "adjunto_prohibido", "Ese archivo no se puede mostrar.");
  const ext = real.split(".").pop()!.toLowerCase();
  reply.header("content-type", ext === "jpg" ? "image/jpeg" : `image/${ext}`).header("cache-control", "private, max-age=3600");
  return reply.send(await readFile(real));
});

// Voz del secretario en la llamada (Piper, servicio tts). El navegador la reproduce; si falla, usa la del sistema.
const TTS = (process.env.TTS_URL ?? "http://127.0.0.1:8830").replace(/\/$/, "");
app.post(`${T}/voz`, async (req, reply) => {
  tenantOf(req);
  const b = req.body as Body;
  const texto = str(b, "texto", 1200).trim();
  if (!texto) throw new HttpError(400, "falta_texto", "No hay nada que decir.");
  let res: Response;
  try {
    res = await fetch(`${TTS}/hablar`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ texto, velocidad: typeof b.velocidad === "number" ? b.velocidad : 1.05 }),
      signal: AbortSignal.timeout(30_000),
    });
  } catch {
    throw new HttpError(502, "voz_caida", "La voz no responde.");
  }
  if (!res.ok) throw new HttpError(502, "voz_error", `La voz respondió ${res.status}.`);
  reply.header("content-type", "audio/wav").header("cache-control", "no-store");
  return reply.send(Buffer.from(await res.arrayBuffer()));
});

// Avisos del vigía de WhatsApp (vigilancias «avisame si X me escribe» y resultados de tareas programadas).
// Los escribe el conector de WhatsApp en su volumen; acá solo se leen. ?desde=ISO → solo los más nuevos.
const AVISOS = process.env.WA_AVISOS ?? "/wa-data/whatsapp/avisos.jsonl";
type Aviso = { id: string; at: string; texto: string; origen: string; vigilancia?: string; tarea?: string; mision?: string; sesion?: string };
// Últimos 7 días, más nuevos primero, con «visto» (de este usuario) y la charla donde se pidió (vigilancias).
app.get(`${T}/avisos`, async (req) => {
  tenantOf(req);
  const desde = Date.now() - 7 * 86400_000;
  // Los de las misiones los escribe la consola (cada uno ya sabe su charla); los del vigía, el conector de WhatsApp.
  const deMisiones = misiones
    .avisosDe(req.user!.id)
    .filter((a) => Date.parse(a.at) > desde)
    .map((a) => ({ id: a.id, at: a.at, texto: a.texto, origen: a.origen, mision: a.mision, sesion: a.sesion }));
  const todos = (existsSync(AVISOS) ? await readFile(AVISOS, "utf8") : "")
    .trim()
    .split("\n")
    .slice(-500)
    .map((l) => {
      try {
        return JSON.parse(l) as Aviso;
      } catch {
        return null;
      }
    })
    .filter((a): a is Aviso => !!a && Date.parse(a.at) > desde)
    .concat(deMisiones)
    .sort((a, b) => b.at.localeCompare(a.at))
    .slice(0, 60);
  const vistos = new Set(
    (db.prepare("SELECT aviso_id FROM avisos_vistos WHERE user_id = ?").all(req.user!.id) as { aviso_id: string }[]).map((r) => r.aviso_id),
  );
  const charla = db.prepare("SELECT session_id FROM vigilancia_charla WHERE vigilancia_id = ? AND user_id = ?");
  const avisos = todos.map((a) => ({
    ...a,
    visto: vistos.has(a.id),
    charla: a.sesion ? a.sesion : (a.vigilancia ?? a.tarea) ? ((charla.get((a.vigilancia ?? a.tarea) as string, req.user!.id) as { session_id: string } | undefined)?.session_id ?? null) : null,
  }));
  return { avisos, sinVer: avisos.filter((a) => !a.visto).length, misionTurnos: misiones.turnosRecientes() };
});

// Misiones: encargos largos que el secretario sigue solo (se crean en el chat, con el sí del dueño).
app.get(`${T}/misiones`, async (req) => ({ misiones: misiones.listar(tenantOf(req).id) }));
app.get(`${T}/misiones/borrador`, async (req) => llamada.borradoresPendientes(llamada.charlaActual(req.user!.id, tenantOf(req).id)));
// Corregir un mensaje de la propuesta de misión (la de la charla abierta) antes de aprobarla.
app.post(`${T}/misiones/borrador`, async (req) => {
  const t = tenantOf(req);
  const b = req.body as Body;
  const i = Number(b.i);
  const texto = str(b, "texto", 1500).trim();
  if (!Number.isInteger(i) || i < 0 || i > 20 || !texto) throw new HttpError(400, "pedido_invalido", "Mensaje inválido.");
  return llamada.editarBorrador(llamada.charlaActual(req.user!.id, t.id), i, texto);
});
app.post(`${T}/misiones/:id/:accion`, async (req) => {
  const t = tenantOf(req);
  const { id, accion } = req.params as { id: string; accion: string };
  if (!/^[a-f0-9]{8}$/.test(id) || !["pausar", "reanudar", "cancelar"].includes(accion)) throw new HttpError(400, "pedido_invalido", "Pedido inválido.");
  const r = await misiones.accion(t.id, id, accion);
  logEvent(t.id, req.user!.id, "mision", `${accion} una misión`);
  return r;
});
app.post(`${T}/avisos/vistos`, async (req) => {
  tenantOf(req);
  const ids = (req.body as { ids?: unknown }).ids;
  if (!Array.isArray(ids) || ids.length > 200 || !ids.every((x) => typeof x === "string" && /^[a-f0-9]{6,32}$/.test(x)))
    throw new HttpError(400, "ids_invalidos", "Avisos inválidos.");
  const ins = db.prepare("INSERT OR IGNORE INTO avisos_vistos (user_id, aviso_id) VALUES (?, ?)");
  for (const id of ids as string[]) ins.run(req.user!.id, id);
  return { ok: true };
});

// Key de Google Maps del conector de movilidad. Se escribe en el movilidad.env del volumen de la app (el conector
// la relee sola en cada búsqueda); nunca vuelve al front. Sin key, el conector usa OpenStreetMap.
const MOVILIDAD_ENV = process.env.MOVILIDAD_ENV ?? "/app-data/config/no-phone/movilidad.env";
const leerMapsKey = async () => {
  if (!existsSync(MOVILIDAD_ENV)) return null;
  const l = (await readFile(MOVILIDAD_ENV, "utf8")).split("\n").find((x) => x.startsWith("GOOGLE_MAPS_API_KEY="));
  return l ? l.split("=")[1].trim() || null : null;
};
app.get(`${T}/tools/movilidad/maps`, async (req) => {
  tenantOf(req);
  return { tieneKey: !!(await leerMapsKey()) || !!process.env.GOOGLE_MAPS_API_KEY };
});
app.put(`${T}/tools/movilidad/maps`, async (req) => {
  const t = tenantOf(req);
  const key = str(req.body as Body, "key", 200).trim();
  if (!/^[A-Za-z0-9_-]{20,120}$/.test(key)) throw new HttpError(400, "key_invalida", "Esa key no tiene el formato de una de Google (empieza con «AIza…»).");
  // Prueba real antes de guardar: una búsqueda de texto chiquita en Places API (New).
  let detalle = "";
  try {
    const r = await fetch("https://places.googleapis.com/v1/places:searchText", {
      method: "POST",
      headers: { "content-type": "application/json", "X-Goog-Api-Key": key, "X-Goog-FieldMask": "places.displayName" },
      body: JSON.stringify({ textQuery: "Plaza Independencia, Mendoza", maxResultCount: 1 }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!r.ok) {
      const e = (await r.json().catch(() => null)) as { error?: { message?: string; status?: string } } | null;
      detalle = e?.error?.message ?? `Google respondió ${r.status}`;
      throw new HttpError(400, "key_rechazada", `Google no aceptó la key: ${detalle.slice(0, 220)} Revisá que tenga habilitadas Places API (New) y Routes API.`);
    }
  } catch (e) {
    if (e instanceof HttpError) throw e;
    throw new HttpError(502, "google_no_responde", "No pude probar la key contra Google (¿sin internet?). No la guardé.");
  }
  await mkdir(dirname(MOVILIDAD_ENV), { recursive: true });
  const previo = existsSync(MOVILIDAD_ENV) ? (await readFile(MOVILIDAD_ENV, "utf8")).split("\n").filter((l) => l && !l.startsWith("GOOGLE_MAPS_API_KEY=")) : [];
  await writeFile(MOVILIDAD_ENV, [...previo, `GOOGLE_MAPS_API_KEY=${key}`].join("\n") + "\n", { mode: 0o600 });
  logEvent(t.id, req.user!.id, "conector", "cargó la key de Google Maps");
  invalidateStatus(t);
  return { ok: true };
});
app.delete(`${T}/tools/movilidad/maps`, async (req) => {
  const t = tenantOf(req);
  if (existsSync(MOVILIDAD_ENV)) {
    const resto = (await readFile(MOVILIDAD_ENV, "utf8")).split("\n").filter((l) => l && !l.startsWith("GOOGLE_MAPS_API_KEY="));
    await writeFile(MOVILIDAD_ENV, resto.length ? resto.join("\n") + "\n" : "", { mode: 0o600 });
  }
  logEvent(t.id, req.user!.id, "conector", "quitó la key de Google Maps");
  return { ok: true };
});

// Vigilancias de WhatsApp («avisame si X me escribe»): las maneja el vigía del conector, sin IA. Acá se listan y se
// piden cancelaciones (la consola ve wa-data en solo lectura: el pedido va a app-data y el vigía lo aplica).
const VIGILANCIAS = process.env.WA_VIGILANCIAS ?? "/wa-data/whatsapp/vigilancias.json";
const VIG_CANCELAR = process.env.WA_VIG_CANCELAR ?? "/app-data/no-phone/vigilancias-cancelar.json";
type Vig = { id: string; nombre: string; estado: string; vence: number; creada: string; contiene?: string | null; avisados: string[] };
app.get(`${T}/vigilancias`, async (req) => {
  tenantOf(req);
  const vs: Vig[] = existsSync(VIGILANCIAS) ? JSON.parse(await readFile(VIGILANCIAS, "utf8")) : [];
  const pedidas: string[] = existsSync(VIG_CANCELAR) ? JSON.parse((await readFile(VIG_CANCELAR, "utf8")) || "[]") : [];
  const ahora = Date.now() / 1000;
  return {
    vigilancias: vs
      .filter((v) => v.estado === "activa" || ahora - v.vence < 86400)
      .map((v) => ({
        id: v.id,
        nombre: v.nombre,
        contiene: v.contiene ?? null,
        estado: pedidas.includes(v.id) && v.estado === "activa" ? "cancelando" : v.estado === "activa" && v.vence < ahora ? "vencida" : v.estado,
        hasta: new Date(v.vence * 1000).toISOString(),
        avisos: v.avisados.length,
      }))
      .sort((a, b) => (a.estado === "activa" ? -1 : 1) - (b.estado === "activa" ? -1 : 1) || b.hasta.localeCompare(a.hasta)),
  };
});
app.post(`${T}/vigilancias/:id/cancelar`, async (req) => {
  const t = tenantOf(req);
  const id = (req.params as { id: string }).id;
  if (!/^[a-z0-9]{4,16}$/.test(id)) throw new HttpError(400, "id_invalido", "Vigilancia inválida.");
  const pedidas: string[] = existsSync(VIG_CANCELAR) ? JSON.parse((await readFile(VIG_CANCELAR, "utf8")) || "[]") : [];
  await mkdir(dirname(VIG_CANCELAR), { recursive: true });
  await writeFile(VIG_CANCELAR, JSON.stringify([...new Set([...pedidas, id])]));
  logEvent(t.id, req.user!.id, "vigilancia", "canceló una vigilancia de WhatsApp");
  return { ok: true };
});

// Charla en curso: sigue entre recargas y dispositivos hasta «nueva charla».
app.get(`${T}/charla`, async (req) => {
  const t = tenantOf(req);
  const sessionId = llamada.charlaActual(req.user!.id, t.id);
  return { sessionId, lineas: llamada.historial(t, sessionId) };
});
app.get(`${T}/charlas`, async (req) => ({ charlas: llamada.charlas(req.user!.id, tenantOf(req)) }));
app.post(`${T}/charla/abrir`, async (req) => {
  const t = tenantOf(req);
  const sessionId = str(req.body as Body, "sessionId", 80);
  if (!llamada.SESSION_RE.test(sessionId)) throw new HttpError(400, "sesion_invalida", "Charla inválida.");
  return llamada.abrirCharla(req.user!.id, t, sessionId);
});
app.post(`${T}/charla/nueva`, async (req) => {
  const t = tenantOf(req);
  const modo = (req.body as Body | undefined)?.modo === "conocer" ? "conocer" : undefined;
  const ya = modo === "conocer" ? llamada.conocerDe(req.user!.id, t.id) : undefined;
  const sessionId = llamada.nuevaCharla(req.user!.id, t.id, modo);
  return { sessionId, lineas: ya ? llamada.historial(t, sessionId) : [], retomada: !!ya };
});

// Chat / llamada: texto (escrito o reconocido en el navegador) → secretario → SSE de vuelta.
app.post(`${T}/llamada`, async (req, reply) => {
  const t = tenantOf(req);
  const b = req.body as Body;
  const sessionId = str(b, "sessionId", 80);
  if (!llamada.SESSION_RE.test(sessionId)) throw new HttpError(400, "sesion_invalida", "Sesión de llamada inválida.");
  llamada.tocarCharla(req.user!.id, t.id, sessionId, str(b, "text", 2000));
  const text = str(b, "text", 2000).trim();
  if (!text) throw new HttpError(400, "falta_texto", "No se escuchó nada.");
  await llamada.stream(t, text, sessionId, b.voz === true, reply, req.user!.id);
});
// Llamada en tiempo real (Qwen-Omni como puente de voz). La key de Alibaba queda en el servidor.
app.get(`${T}/voz/config`, async (req) => voz.verConfig(tenantOf(req)));
app.put(`${T}/voz/config`, async (req) => {
  const t = tenantOf(req);
  await voz.guardarConfig(t, req.body as Body);
  logEvent(t.id, req.user!.id, "secretario", "configuró la voz de la llamada");
  return voz.verConfig(t);
});
app.delete(`${T}/voz/config`, async (req) => {
  const t = tenantOf(req);
  await voz.borrarConfig(t);
  logEvent(t.id, req.user!.id, "secretario", "borró la key de voz");
  return { ok: true };
});
app.post(`${T}/voz/probar`, async (req) => voz.probar(tenantOf(req)));
// Muestra de una voz para el gestor («escuchar»). WAV; queda en caché por voz + frase.
app.post(`${T}/voz/muestra`, async (req, reply) => {
  const t = tenantOf(req);
  const b = req.body as Body;
  const audio = await voz.muestra(t, str(b, "voz", 40), typeof b.frase === "string" ? b.frase : undefined);
  reply.header("content-type", "audio/wav").header("cache-control", "private, max-age=86400");
  return reply.send(audio);
});
app.post(`${T}/voz/sdp`, async (req) => {
  const t = tenantOf(req);
  return voz.sdp(t, str(req.body as Body, "offer", 20000));
});
// La voz le pasa lo que dijo el dueño al secretario y recibe qué decir.
app.post(`${T}/voz/turno`, async (req) => {
  const t = tenantOf(req);
  const b = req.body as Body;
  const sessionId = str(b, "sessionId", 80);
  if (!llamada.SESSION_RE.test(sessionId)) throw new HttpError(400, "sesion_invalida", "Sesión de llamada inválida.");
  // Lo que transcribió el reconocedor, literal (en la voz natural): el freno de plata/WhatsApp revisa ESTO, no lo
  // que Qwen dice que dijo. "" = no llegó la transcripción.
  const literal = typeof b.literal === "string" ? b.literal.slice(0, 2000).trim() : undefined;
  // Qwen a veces llama sin `dijo`: entonces vale lo literal (antes se descartaba el turno en silencio).
  const dijo = str(b, "dijo", 2000).trim() || literal || "";
  if (!dijo) return { decir: "No te escuché bien, ¿me lo repetís?", tools: [], sigue: false };
  llamada.tocarCharla(req.user!.id, t.id, sessionId, dijo);
  return llamada.vozTurno(t, dijo, sessionId, req.user!.id, literal);
});
// La parte siguiente de un turno largo (avance o respuesta final).
// Revisión de cada charla (mejora continua): reseña opcional del dueño y fichas del revisor.
app.post(`${T}/charlas/:sid/resena`, async (req) =>
  revision.guardarResena(req.user!.id, tenantOf(req), (req.params as { sid: string }).sid, (req.body ?? {}) as Record<string, unknown>),
);
app.get(`${T}/revisiones`, async (req) => revision.listar(tenantOf(req), clampInt(q(req).limit, 50, 1, 200)));
app.post(`${T}/charlas/:sid/revisar`, async (req) => revision.revisarYa(tenantOf(req), (req.params as { sid: string }).sid));
app.get(`${T}/informes`, async (req) => revision.informes(tenantOf(req)));
// A pedido (botón «generar ahora»): revisa las charlas pendientes y arma el informe. Tarda (un modelo por charla).
app.post(`${T}/informes/generar`, async (req) => revision.correr(tenantOf(req)));
// Estadísticas de audio de la llamada (diagnóstico de voz trabada: red vs. PC).
app.post(`${T}/voz/stats`, async (req) => voz.guardarStats(tenantOf(req), req.user?.id, (req.body ?? {}) as Record<string, unknown>));
app.post(`${T}/voz/seguir`, async (req) => {
  tenantOf(req);
  const turno = str(req.body as Body, "turno", 60);
  if (!/^[0-9a-f-]{36}$/.test(turno)) throw new HttpError(400, "turno_invalido", "Turno inválido.");
  return llamada.vozSeguir(turno, req.user!.id);
});
app.get(`${T}/pulse`, async (req) => getPulse(tenantOf(req), q(req).refresh === "1"));
app.get(`${T}/status`, async (req) => getStatus(tenantOf(req), q(req).refresh === "1"));

// memoria
app.get(`${T}/memory/stats`, async (req) => hindsight.stats(tenantOf(req).bank_id));
app.get(`${T}/memory/entities`, async (req) => {
  const t = tenantOf(req);
  return hindsight.entities(t.bank_id, { limit: clampInt(q(req).limit, 200, 1, 500), offset: clampInt(q(req).offset, 0, 0, 100000) });
});
app.get(`${T}/memory/entities/:id`, async (req) => hindsight.entity(tenantOf(req).bank_id, (req.params as { id: string }).id));
app.get(`${T}/memory/graph`, async (req) => hindsight.entityGraph(tenantOf(req).bank_id, { limit: clampInt(q(req).limit, 300, 1, 1000) }));
app.get(`${T}/memory/units`, async (req) => {
  const t = tenantOf(req);
  const { type, q: text, entity, state } = q(req);
  return hindsight.memories(t.bank_id, {
    type: type && ["world", "experience", "observation"].includes(type) ? type : undefined,
    q: text?.slice(0, 200),
    entity_id: entity,
    state: state === "invalidated" ? "invalidated" : undefined,
    limit: clampInt(q(req).limit, 40, 1, 200),
    offset: clampInt(q(req).offset, 0, 0, 100000),
  });
});
app.patch(`${T}/memory/units/:id`, async (req) => {
  const t = tenantOf(req);
  const b = req.body as Body;
  const id = (req.params as { id: string }).id;
  const unit = await hindsight.memory(t.bank_id, id);
  const kind = unit.fact_type ?? unit.type ?? "";
  const text = optStr(b, "text", 4000);
  const invalidate = b.invalidate === true;
  const reason = optStr(b, "reason", 300) ?? "corregido desde la consola";

  // Las fichas (observations) las arma Hindsight a partir de world/experience: no se editan ni se invalidan.
  // «Descartar» una ficha = invalidar los datos sueltos de origen y limpiar las fichas derivadas.
  if (kind === "observation") {
    if (text !== undefined) {
      throw new HttpError(
        400,
        "ficha_no_editable",
        "Las fichas se arman solas. Corregí o descartá el recuerdo suelto del que salen, o pedile al secretario el dato nuevo en el chat.",
      );
    }
    if (!invalidate) throw new HttpError(400, "nada_que_cambiar", "No hay cambios.");
    const fuentes = (unit.source_memory_ids ?? []).filter((x) => typeof x === "string" && x.length > 0);
    if (!fuentes.length) {
      // Sin origen: borrar observaciones del banco no; al menos forzar consolidate tras intentar limpiar por id.
      await hindsight.clearMemoryObservations(t.bank_id, id).catch(() => null);
      throw new HttpError(400, "ficha_sin_origen", "Esta ficha no tiene recuerdos sueltos de origen para descartar.");
    }
    for (const sid of fuentes) {
      await hindsight.patchMemory(t.bank_id, sid, { state: "invalidated", reason });
      await hindsight.clearMemoryObservations(t.bank_id, sid).catch(() => null);
    }
    logEvent(t.id, req.user!.id, "memoria", `descartó una ficha (${fuentes.length} origen${fuentes.length === 1 ? "" : "es"})`);
    return { ok: true, invalidated_sources: fuentes };
  }

  const body: Body = {};
  if (text !== undefined) body.text = text;
  if (invalidate) {
    body.state = "invalidated";
    body.reason = reason;
  }
  if (!Object.keys(body).length) throw new HttpError(400, "nada_que_cambiar", "No hay cambios.");
  await hindsight.patchMemory(t.bank_id, id, body);
  // Si invalidamos un suelto, sacamos las fichas que lo resumían (Hindsight rearma en el próximo consolidate).
  if (invalidate) await hindsight.clearMemoryObservations(t.bank_id, id).catch(() => null);
  logEvent(t.id, req.user!.id, "memoria", body.state ? "descartó un recuerdo" : "corrigió un recuerdo");
  return { ok: true };
});
alias.rutas(app, T, tenantOf);
tipos.rutas(app, T, tenantOf);
waAudio.rutas(app, T, tenantOf);
movilidad.rutas(app, T, tenantOf);
misiones.rutas(app, T, tenantOf);
app.post(`${T}/memory/recall`, async (req) => {
  const t = tenantOf(req);
  const b = req.body as Body;
  return hindsight.recall(t.bank_id, str(b, "query", 500), typeof b.maxTokens === "number" ? b.maxTokens : undefined);
});

// reglas del banco (directives)
app.get(`${T}/rules`, async (req) => hindsight.directives(tenantOf(req).bank_id));
app.post(`${T}/rules`, async (req) => {
  const t = tenantOf(req);
  const b = req.body as Body;
  await hindsight.createDirective(t.bank_id, { name: str(b, "name", 120), content: str(b, "content", 2000), priority: 0, is_active: true, tags: [] });
  logEvent(t.id, req.user!.id, "regla", `regla nueva «${str(b, "name", 120)}»`);
  await reglas.sincronizarSoul(t).catch(() => null);
  return { ok: true };
});
app.patch(`${T}/rules/:id`, async (req) => {
  const t = tenantOf(req);
  const b = req.body as Body;
  const patch: Body = {};
  if (typeof b.isActive === "boolean") patch.is_active = b.isActive;
  const content = optStr(b, "content", 2000);
  if (content !== undefined) patch.content = content;
  await hindsight.patchDirective(t.bank_id, (req.params as { id: string }).id, patch);
  logEvent(t.id, req.user!.id, "regla", "editó una regla");
  await reglas.sincronizarSoul(t).catch(() => null);
  return { ok: true };
});
app.delete(`${T}/rules/:id`, async (req) => {
  const t = tenantOf(req);
  await hindsight.deleteDirective(t.bank_id, (req.params as { id: string }).id);
  logEvent(t.id, req.user!.id, "regla", "borró una regla");
  await reglas.sincronizarSoul(t).catch(() => null);
  return { ok: true };
});

// secretario
const BANK_KEYS = ["retain_mission", "observations_mission", "recall_max_tokens", "disposition_skepticism", "disposition_literalism", "disposition_empathy", "enable_observations"] as const;
app.get(`${T}/secretary`, async (req) => {
  const t = tenantOf(req);
  const [soul, agent, recall, bankCfg] = await Promise.all([
    hermes.readSoul(t),
    hermes.readAgentSettings(t),
    hermes.readRecallSettings(t),
    hindsight.config(t.bank_id).catch(() => ({ config: {} as Record<string, unknown> })),
  ]);
  const bank = Object.fromEntries(BANK_KEYS.map((k) => [k, bankCfg.config[k] ?? null]));
  const keys = await hermes.providerKeysPresent(t);
  return { soul: reglas.sinBloque(soul), model: agent.model, memoryProvider: agent.memoryProvider, recall, bank, bankId: t.bank_id, providerKeys: keys };
});
app.put(`${T}/secretary/soul`, async (req) => {
  const t = tenantOf(req);
  const text = str(req.body as Body, "soul", 20000);
  if (text.trim().length < 20) throw new HttpError(400, "muy_corto", "La personalidad quedó casi vacía.");
  await reglas.guardarPersonalidad(t, reglas.sinBloque(text));
  logEvent(t.id, req.user!.id, "secretario", "cambió la personalidad");
  return { ok: true };
});
app.patch(`${T}/secretary/model`, async (req) => {
  const t = tenantOf(req);
  const b = req.body as Body;
  await hermes.writeModel(t, { provider: optStr(b, "provider", 60), default: optStr(b, "default", 120), base_url: b.base_url === null ? null : optStr(b, "base_url", 300) });
  logEvent(t.id, req.user!.id, "secretario", "cambió el modelo");
  return { ok: true };
});
app.put(`${T}/secretary/model-key`, async (req) => {
  const t = tenantOf(req);
  const b = req.body as Body;
  const provider = str(b, "provider", 40);
  await hermes.setProviderKey(t, provider, str(b, "value", 300).trim());
  logEvent(t.id, req.user!.id, "secretario", `cargó la API key de ${provider}`);
  return { ok: true };
});
app.patch(`${T}/secretary/recall`, async (req) => {
  const t = tenantOf(req);
  await hermes.writeRecallSettings(t, req.body as Body);
  logEvent(t.id, req.user!.id, "secretario", "ajustó la memoria del agente");
  return { ok: true };
});
app.patch(`${T}/secretary/bank`, async (req) => {
  const t = tenantOf(req);
  const b = req.body as Body;
  const updates = Object.fromEntries(Object.entries(b).filter(([k]) => (BANK_KEYS as readonly string[]).includes(k)));
  if (!Object.keys(updates).length) throw new HttpError(400, "nada_que_cambiar", "No hay cambios.");
  await hindsight.patchConfig(t.bank_id, updates);
  logEvent(t.id, req.user!.id, "secretario", "ajustó qué recuerda");
  return { ok: true };
});

// celulares (registro único: phones.json del tenant, el mismo que usa el MCP naranjax)
const uiMode = (v: unknown) => (devices.UI_MODES as unknown[]).includes(v) ? (v as devices.UiMode) : undefined;
app.get(`${T}/devices`, async (req) => ({ devices: await devices.viewDevices(tenantOf(req)), secretKeys: devices.SECRET_KEYS }));
app.post(`${T}/devices`, async (req) => {
  const t = tenantOf(req);
  const b = req.body as Body;
  const d = await devices.createDevice(t, {
    id: str(b, "id", 41).trim(),
    kind: b.kind === "virtual" ? "virtual" : "fisico",
    label: str(b, "label", 80),
    serial: optStr(b, "serial", 64)?.trim(),
    adbServer: optStr(b, "adbServer", 270)?.trim() || null,
    uiMode: uiMode(b.uiMode) ?? "fast",
  });
  logEvent(t.id, req.user!.id, "celular", `agregó ${d.label}`);
  return devices.viewDevice(t, d.id);
});
app.patch(`${T}/devices/:id`, async (req) => {
  const t = tenantOf(req);
  const d = await devices.getDevice(t, (req.params as { id: string }).id);
  const b = req.body as Body;
  await devices.updateDevice(t, d.id, {
    label: optStr(b, "label", 80),
    serial: optStr(b, "serial", 64)?.trim(),
    uiMode: uiMode(b.uiMode),
    redetect: b.redetect === true,
    activate: b.activate === true,
  });
  logEvent(t.id, req.user!.id, "celular", b.activate === true ? `pasó a usar ${d.label}` : `actualizó ${d.label}`);
  return devices.viewDevice(t, d.id);
});
app.put(`${T}/devices/:id/secrets/:key`, async (req) => {
  const t = tenantOf(req);
  const { id, key } = req.params as { id: string; key: string };
  const d = await devices.getDevice(t, id);
  if (!(key in devices.SECRET_KEYS)) throw new HttpError(400, "secreto_desconocido", "Ese dato no se puede guardar acá.");
  await devices.setSecret(t, d, key as devices.SecretKey, str(req.body as Body, "value", 100));
  logEvent(t.id, req.user!.id, "celular", `cargó ${devices.SECRET_KEYS[key as devices.SecretKey].label} de ${d.label}`);
  return { ok: true };
});
app.delete(`${T}/devices/:id`, async (req) => {
  const t = tenantOf(req);
  const d = await devices.getDevice(t, (req.params as { id: string }).id);
  await devices.deleteDevice(t, d.id);
  logEvent(t.id, req.user!.id, "celular", `quitó ${d.label}`);
  return { ok: true };
});

// whatsapp (puente del tenant)
app.get(`${T}/whatsapp`, async (req) => wa.status(tenantOf(req)));
app.get(`${T}/whatsapp/qr`, async (req, reply) => {
  const png = await wa.qrPng(tenantOf(req));
  return reply.header("cache-control", "no-store").type("image/png").send(png);
});
app.post(`${T}/whatsapp/pair-phone`, async (req) => {
  const t = tenantOf(req);
  const out = await wa.pairPhone(t, str(req.body as Body, "phone", 30));
  logEvent(t.id, req.user!.id, "whatsapp", "pidió código de vinculación");
  return out;
});
app.post(`${T}/whatsapp/logout`, async (req) => {
  const t = tenantOf(req);
  await wa.logout(t);
  invalidateStatus(t);
  logEvent(t.id, req.user!.id, "whatsapp", "desvinculó WhatsApp");
  return { ok: true };
});
app.put(`${T}/whatsapp/bridge`, async (req) => {
  requireSuperadmin(req);
  const t = tenantOf(req);
  const b = req.body as Body;
  wa.setBridge(t, optStr(b, "url", 300)?.trim() || null, optStr(b, "token", 300));
  invalidateStatus(t);
  logEvent(t.id, req.user!.id, "whatsapp", "cambió el puente");
  return wa.status(getTenant(t.id)!);
});

// herramientas
app.post(`${T}/tools/:name/test`, async (req) => hermes.testMcp(tenantOf(req), (req.params as { name: string }).name));

// tareas
app.get(`${T}/jobs`, async (req) => {
  const t = tenantOf(req);
  const [jobs, running] = await Promise.all([hermes.listJobs(t), hermes.schedulerRunning(t)]);
  return { jobs, schedulerRunning: running };
});
app.post(`${T}/jobs/:id/:action`, async (req) => {
  const t = tenantOf(req);
  const { id, action } = req.params as { id: string; action: string };
  if (!["pause", "resume", "remove"].includes(action)) throw new HttpError(400, "accion_invalida", "Acción inválida.");
  await hermes.jobAction(t, id, action as "pause" | "resume" | "remove");
  const verb = { pause: "pausó", resume: "reanudó", remove: "canceló" }[action as "pause"];
  logEvent(t.id, req.user!.id, "tarea", `${verb} una tarea`);
  return { ok: true };
});

// ---------- estáticos (build de Vite) ----------

const dist = join(here, "../web/dist");
if (existsSync(dist)) {
  await app.register(fastifyStatic, { root: dist, wildcard: true });
  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith("/api/")) return reply.status(404).send({ error: "no_existe", message: "Ruta inexistente." });
    return reply.sendFile("index.html");
  });
}

await app.listen({ host: HOST, port: PORT });
revision.arrancar();
misiones.arrancarMotor();
