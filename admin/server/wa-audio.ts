// Audios de WhatsApp para escucharlos en la consola (tarjetas del chat y la llamada): el puente baja la nota de voz
// a su carpeta de media (volumen wa-data, acá montado de solo lectura en /wa-data) y se sirve pasada a MP3 (Safari no
// reproduce OGG/Opus). Solo audios: el resto del volumen tiene la sesión de WhatsApp.
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, realpath, stat, unlink, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { promisify } from "node:util";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { HttpError } from "./auth.ts";
import { DATA_DIR, tenantTools, type Tenant } from "./db.ts";

const run = promisify(execFile);
const MEDIA = (process.env.WA_MEDIA_DIR ?? "/wa-data/whatsapp/media").replace(/\/$/, "");
const CACHE = join(DATA_DIR, "audio-cache");
const AUDIO = /\.(ogg|opus|oga|mp3|m4a|aac|amr|wav)$/i;
const JID = /^[0-9a-zA-Z.\-_@:]{5,80}$/;
const ID = /^[0-9A-Za-z]{6,64}$/;

async function bajar(t: Tenant, chat: string, id: string): Promise<string> {
  const tools = tenantTools(t);
  if (!tools.wa_bridge_url) throw new HttpError(409, "sin_puente", "Este secretario no tiene WhatsApp configurado.");
  let r: Response;
  try {
    r = await fetch(`${tools.wa_bridge_url.replace(/\/$/, "")}/download`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(tools.wa_bridge_token ? { authorization: `Bearer ${tools.wa_bridge_token}` } : {}) },
      body: JSON.stringify({ chat_jid: chat, id }),
      signal: AbortSignal.timeout(60_000),
    });
  } catch {
    throw new HttpError(502, "puente_caido", "WhatsApp no responde ahora.");
  }
  const d = (await r.json().catch(() => ({}))) as { path?: string; error?: string };
  if (!r.ok || !d.path) throw new HttpError(404, "sin_audio", d.error ?? "No pude bajar ese audio (puede haber vencido en WhatsApp).");
  const i = d.path.indexOf("/media/");
  if (i < 0) throw new HttpError(502, "ruta_rara", "El puente devolvió una ruta inesperada.");
  const local = join(MEDIA, d.path.slice(i + "/media/".length));
  let real: string;
  try {
    real = await realpath(local);
  } catch {
    throw new HttpError(404, "sin_audio", "El audio no quedó en la carpeta compartida.");
  }
  if (!real.startsWith(MEDIA + "/") || !AUDIO.test(real)) throw new HttpError(403, "no_es_audio", "Ese mensaje no es un audio.");
  return real;
}

/** MP3 del audio (cacheado por mensaje). Lo usan la tarjeta y la llamada. */
export async function mp3(t: Tenant, chat: string, id: string): Promise<Buffer> {
  if (!JID.test(chat) || !ID.test(id)) throw new HttpError(400, "pedido_invalido", "Audio inválido.");
  await mkdir(CACHE, { recursive: true });
  const out = join(CACHE, createHash("sha256").update(`${t.id}|${chat}|${id}`).digest("hex").slice(0, 32) + ".mp3");
  if (!existsSync(out) || (await stat(out)).size === 0) {
    const src = await bajar(t, chat, id);
    try {
      await run("ffmpeg", ["-v", "error", "-y", "-i", src, "-vn", "-ac", "1", "-b:a", "64k", out], { timeout: 60_000 });
    } catch {
      throw new HttpError(500, "audio_roto", "No pude convertir ese audio.");
    }
  }
  return readFile(out);
}

// Notas de voz que graba el dueño (llamada o chat): se pasan a ogg/opus (el formato de WhatsApp) en app-data, que el
// conector de WhatsApp ve como /data. El nombre lleva «nota-de-voz-<seg>s»: así el puente la manda como nota de voz.
const NOTAS = (process.env.NOTAS_DIR ?? "/app-data/no-phone/notas").replace(/\/$/, "");
const NOTAS_MCP = (process.env.NOTAS_DIR_MCP ?? "/data/no-phone/notas").replace(/\/$/, "");
const NOTA_MAX_BYTES = 15 * 1024 * 1024;

async function guardarNota(buf: Buffer): Promise<{ archivo: string; duracion_s: number }> {
  if (buf.length < 800) throw new HttpError(400, "nota_vacia", "La grabación quedó vacía.");
  await mkdir(NOTAS, { recursive: true });
  // limpieza: las de más de 7 días ya se mandaron (o no se van a mandar)
  for (const f of await readdir(NOTAS).catch(() => [] as string[])) {
    const ruta = join(NOTAS, f);
    if (Date.now() - (await stat(ruta).catch(() => ({ mtimeMs: Date.now() }))).mtimeMs > 7 * 86400_000) await unlink(ruta).catch(() => null);
  }
  const id = randomBytes(6).toString("hex");
  const crudo = join(NOTAS, `.crudo-${id}`);
  await writeFile(crudo, buf);
  try {
    const { stdout } = await run("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", crudo], { timeout: 20_000 }).catch(() => ({ stdout: "" }));
    let seg = Math.max(1, Math.round(Number.parseFloat(String(stdout).trim()) || 0));
    const tmp = join(NOTAS, `.conv-${id}.ogg`);
    await run("ffmpeg", ["-v", "error", "-y", "-i", crudo, "-vn", "-ac", "1", "-ar", "48000", "-c:a", "libopus", "-b:a", "24k", "-application", "voip", tmp], { timeout: 60_000 });
    if (!Number.parseFloat(String(stdout).trim())) {
      // webm de MediaRecorder sin duración en el encabezado: se mide el ogg ya convertido
      const r2 = await run("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", tmp], { timeout: 20_000 }).catch(() => ({ stdout: "" }));
      seg = Math.max(1, Math.round(Number.parseFloat(String(r2.stdout).trim()) || 1));
    }
    const nombre = `nota-de-voz-${seg}s-${id}.ogg`;
    await run("mv", [tmp, join(NOTAS, nombre)]);
    return { archivo: `${NOTAS_MCP}/${nombre}`, duracion_s: seg };
  } catch (e) {
    if (e instanceof HttpError) throw e;
    throw new HttpError(500, "nota_rota", "No pude convertir la grabación.");
  } finally {
    await unlink(crudo).catch(() => null);
  }
}

/** Escuchar una nota grabada antes de mandarla (solo las de la carpeta de notas). */
async function leerNota(archivo: string): Promise<Buffer> {
  const nombre = archivo.split("/").pop() ?? "";
  if (!/^nota-de-voz-\d+s-[a-f0-9]{12}\.ogg$/.test(nombre)) throw new HttpError(400, "nota_invalida", "Nota inválida.");
  return readFile(join(NOTAS, nombre)).catch(() => {
    throw new HttpError(404, "sin_nota", "Esa nota ya no está.");
  });
}

export function rutas(app: FastifyInstance, T: string, tenantOf: (req: FastifyRequest) => Tenant) {
  app.addContentTypeParser(["audio/webm", "audio/ogg", "audio/mp4", "audio/mpeg", "audio/wav", "audio/x-m4a", "application/octet-stream"], { parseAs: "buffer", bodyLimit: NOTA_MAX_BYTES }, (_req, body, done) => done(null, body));
  app.post(`${T}/wa/nota`, async (req) => {
    tenantOf(req);
    if (!Buffer.isBuffer(req.body)) throw new HttpError(400, "nota_vacia", "Mandá el audio grabado.");
    return guardarNota(req.body);
  });
  app.get(`${T}/wa/nota`, async (req, reply) => {
    tenantOf(req);
    const buf = await leerNota(String((req.query as { archivo?: string }).archivo ?? ""));
    return reply.header("content-type", "audio/ogg").header("cache-control", "private, max-age=600").send(buf);
  });
  app.get(`${T}/wa/audio`, async (req, reply) => {
    const t = tenantOf(req);
    const q = req.query as { chat?: string; id?: string };
    const buf = await mp3(t, String(q.chat ?? ""), String(q.id ?? ""));
    return reply.header("content-type", "audio/mpeg").header("cache-control", "private, max-age=86400").send(buf);
  });
}
