// Revisión de cada charla e informe (base de la mejora continua). Corre una vez por noche (REVISION_HORA, hora de la
// consola) o a pedido (botón en «informes», POST /informes/generar, o `tsx server/informe-cli.ts`).
// Cada charla con actividad nueva desde su última revisión (y quieta hace QUIETA_MIN): un modelo la lee entera (lo que dijo el dueño, lo que
// contestó el secretario, las herramientas con sus resultados y los tiempos) y arma una ficha: qué pidió, si se logró,
// qué salió mal y la causa probable. Si el dueño dejó una reseña (opcional: «¿salió lo que querías?»), esa es la verdad
// y la ficha se rehace con ella. Si después sigue hablando en la misma charla, se vuelve a revisar.
// Sin key de OpenRouter no hace nada. No cambia nada solo: las fichas son el insumo para proponer mejoras.
import { db, getTenant, type Tenant } from "./db.ts";
import { historial } from "./llamada.ts";
import { HttpError } from "./auth.ts";
import { existsSync, readFileSync } from "node:fs";
import { STATS } from "./voz.ts";

db.exec(`
CREATE TABLE IF NOT EXISTS resenas (
  session_id TEXT NOT NULL,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  nota       TEXT NOT NULL CHECK (nota IN ('bien', 'mal')),
  texto      TEXT,
  at         TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (session_id, user_id)
);
CREATE TABLE IF NOT EXISTS informes (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id  TEXT NOT NULL,
  at         TEXT NOT NULL DEFAULT (datetime('now')),
  n_charlas  INTEGER NOT NULL,
  modelo     TEXT NOT NULL,
  contenido  TEXT NOT NULL              -- JSON
);
CREATE TABLE IF NOT EXISTS revisiones (
  session_id TEXT PRIMARY KEY,
  tenant_id  TEXT NOT NULL,
  user_id    INTEGER NOT NULL,
  hasta      INTEGER NOT NULL,           -- ms del último mensaje revisado
  con_resena INTEGER NOT NULL DEFAULT 0, -- 1 si la ficha ya tuvo en cuenta la reseña del dueño
  modelo     TEXT NOT NULL,
  ficha      TEXT NOT NULL,              -- JSON
  at         TEXT NOT NULL DEFAULT (datetime('now'))
);
`);

const QUIETA_MIN = Number(process.env.REVISION_QUIETA_MIN ?? 15);
const MODELO = process.env.REVISION_MODELO ?? "deepseek/deepseek-v4.1-flash";
const MODELO_INFORME = process.env.INFORME_MODELO ?? MODELO;
const HORA = process.env.REVISION_HORA ?? "03:00"; // todas las noches
const KEY = process.env.OPENROUTER_API_KEY ?? "";

export function guardarResena(userId: number, tenant: Tenant, sessionId: string, b: Record<string, unknown>) {
  const ok = db.prepare("SELECT 1 FROM charlas_lista WHERE session_id = ? AND user_id = ? AND tenant_id = ?").get(sessionId, userId, tenant.id);
  if (!ok) throw new HttpError(404, "charla_no_existe", "Esa charla no existe.");
  const nota = b.nota === "bien" || b.nota === "mal" ? b.nota : null;
  if (!nota) throw new HttpError(400, "nota_invalida", "La reseña es «bien» o «mal».");
  const texto = typeof b.texto === "string" ? b.texto.trim().slice(0, 1000) || null : null;
  db.prepare(
    "INSERT INTO resenas (session_id, user_id, nota, texto) VALUES (?, ?, ?, ?) ON CONFLICT (session_id, user_id) DO UPDATE SET nota = excluded.nota, texto = COALESCE(excluded.texto, resenas.texto), at = datetime('now')",
  ).run(sessionId, userId, nota, texto);
  return { ok: true };
}

export function listar(tenant: Tenant, limite = 50) {
  const rows = db
    .prepare(
      `SELECT r.session_id, r.ficha, r.at, r.con_resena, c.titulo, s.nota, s.texto AS resena
         FROM revisiones r LEFT JOIN charlas_lista c ON c.session_id = r.session_id
         LEFT JOIN resenas s ON s.session_id = r.session_id AND s.user_id = r.user_id
        WHERE r.tenant_id = ? AND r.user_id NOT IN (SELECT id FROM users WHERE email LIKE '%@local') ORDER BY r.at DESC LIMIT ?`,
    )
    .all(tenant.id, limite) as { session_id: string; ficha: string; at: string; con_resena: number; titulo: string | null; nota: string | null; resena: string | null }[];
  return {
    revisiones: rows.map((r) => ({ sessionId: r.session_id, titulo: r.titulo, at: r.at.replace(" ", "T") + "Z", resena: r.nota ? { nota: r.nota, texto: r.resena } : null, ficha: JSON.parse(r.ficha) })),
  };
}

// ---------- la revisión ----------

const corto = (n: string) => n.replace(/^mcp__[a-z0-9_-]+?__/, "");
const recorte = (v: unknown, n: number) => {
  const s = typeof v === "string" ? v : JSON.stringify(v ?? "");
  return s.length > n ? s.slice(0, n) + "…" : s;
};
const hora = (ms?: number) => (ms ? new Date(ms).toISOString().slice(11, 19) : "--:--:--");

function transcripcion(tenant: Tenant, sessionId: string) {
  const lineas = historial(tenant, sessionId);
  let ultimo = 0;
  let previo: number | undefined;
  const out: string[] = [];
  for (const l of lineas) {
    const at = "at" in l ? l.at : undefined;
    if (at) ultimo = Math.max(ultimo, at);
    const pausa = at && previo ? Math.round((at - previo) / 1000) : 0;
    if (at) previo = at;
    const t = `[${hora(at)}${pausa >= 5 ? ` +${pausa}s` : ""}]`;
    if (l.quien === "vos") out.push(`${t} DUEÑO: ${l.texto}`);
    else if (l.quien === "secretario") out.push(`${t} SECRETARIO: ${l.texto}`);
    else if (l.quien === "mision") out.push(`${t} (evento automático, no lo dijo el dueño): ${recorte(l.texto, 300)}`);
    else if ("tool" in l) out.push(`${t} herramienta ${corto(l.tool.name)}(${recorte(l.tool.args, 300)}) → ${recorte(l.tool.result, 2000)}`);
  }
  return { texto: out.join("\n"), hayDueno: lineas.some((l) => l.quien === "vos"), ultimo };
}

// Lo que pasó en la capa de voz (si fue llamada con voz natural): conteos del rastro de eventos de Alibaba, sin
// contenido. Lo que se pierde ahí (frases oídas que nunca llegaron al secretario, reconexiones) no queda en Hermes.
function resumenVoz(sessionId: string): string {
  const cuenta = new Map<string, number>();
  let muestras = 0, maxRelleno = 0, perdidos = 0, recibidos = 0;
  const errores: string[] = [];
  for (const f of [STATS + ".1", STATS]) {
    if (!existsSync(f)) continue;
    for (const linea of readFileSync(f, "utf8").split("\n")) {
      if (!linea.includes(sessionId)) continue;
      let m: Record<string, unknown>;
      try {
        m = JSON.parse(linea);
      } catch {
        continue;
      }
      if (m.llamada !== sessionId) continue;
      if (typeof m.ev === "string") cuenta.set(m.ev, (cuenta.get(m.ev) ?? 0) + 1);
      else if (typeof m.error === "string") errores.push(m.error);
      else {
        muestras++;
        maxRelleno = Math.max(maxRelleno, Number(m.rellenoPct ?? 0));
        perdidos += Number(m.perdidos ?? 0);
        recibidos += Number(m.recibidos ?? 0);
      }
    }
  }
  if (!cuenta.size && !muestras) return "";
  const n = (k: string) => cuenta.get(k) ?? 0;
  return [
    `VOZ (llamada con voz natural, ~${muestras * 3} s; conteos de eventos, sin contenido):`,
    `- frases que detectó que el dueño terminó de decir: ${n("input_audio_buffer.speech_stopped")}`,
    `- transcripciones que llegaron: ${n("conversation.item.input_audio_transcription.completed")}, fallidas: ${n("conversation.item.input_audio_transcription.failed")}`,
    `- respuestas habladas: ${n("response.done")}; sesiones de voz abiertas: ${n("session.created")} (más de 1 = se reconectó)`,
    `- audio recibido: ${recibidos} paquetes, ${perdidos} perdidos, máximo relleno ${maxRelleno}%`,
    errores.length ? `- errores de la voz: ${[...new Set(errores)].slice(0, 5).join(" | ")}` : "",
    "Si hubo más transcripciones que mensajes DUEÑO en la charla, hay frases que se oyeron y nunca llegaron al secretario.",
  ]
    .filter(Boolean)
    .join("\n");
}

const PAUTA = `Sos el revisor de calidad de un secretario personal (agente de IA) que usa Goyo, su dueño, por chat o por llamada de voz. El secretario maneja Naranja X (saldo, transferencias), WhatsApp, cómo llegar en Mendoza, recordatorios y su memoria. En la llamada el dueño puede no estar mirando la pantalla: todo tiene que funcionar de oído.

Leé la charla entera y juzgá como lo haría el dueño: ¿consiguió lo que quería, rápido y sin vueltas?

Fijate especialmente en:
- pedidos que no se tomaron, se olvidaron o se entendieron mal (también los que dijo en el medio de otro);
- cosas que el dueño tuvo que repetir o corregir («no, eso no», «te dije…», reírse de un error, preguntar «¿de dónde sacaste eso?»);
- confirmaciones de más, preguntas innecesarias o, al revés, suposiciones sin preguntar (p. ej. desde dónde sale);
- respuestas largas, lentas (mirá las pausas +Ns), que no contestan lo preguntado o con un tono que no va;
- errores de herramientas, datos incorrectos, cosas que dijo que hizo y no hizo;
- lo que el dueño habría querido que hiciera solo.
No marques como problema las barreras de seguridad que funcionaron bien (pedir un sí antes de mandar plata o un WhatsApp es correcto; pedirlo dos veces no).

Los resultados de herramientas vienen recortados (terminan en «…»): que algo no aparezca en el recorte NO significa que el secretario lo inventó; marcalo como dato_incorrecto solo si contradice lo que sí se ve.
Si hay datos de VOZ, compará las transcripciones con los mensajes DUEÑO: frases oídas que no llegaron al secretario son un problema grave (causa "voz"), aunque la charla escrita parezca bien.

Si hay RESEÑA DEL DUEÑO, es la verdad: si dice que algo no salió, buscá qué fue aunque la charla parezca bien.

Devolvé SOLO un JSON con esta forma (en castellano rioplatense, conciso):
{
  "resumen": "una frase: qué quería el dueño y cómo terminó",
  "pedidos": [{"pedido": "...", "logrado": "si|parcial|no|no_se", "evidencia": "cita corta de la charla"}],
  "problemas": [{
    "tipo": "no_tomo_pedido|entendio_mal|confirmacion_de_mas|pregunta_de_mas|supuso_mal|lento|respuesta_larga|no_contesto|tono|error_herramienta|dato_incorrecto|dijo_y_no_hizo|otro",
    "gravedad": 1,
    "que_paso": "...",
    "evidencia": "cita corta",
    "causa_probable": "instrucciones|memoria|herramienta|codigo|voz|externo|desconocida",
    "sugerencia": "qué cambiar para que no vuelva a pasar"
  }],
  "satisfaccion": "bien|regular|mal",
  "inferido": true
}
gravedad: 1 = molestia, 2 = le costó o tardó mucho, 3 = no logró lo que quería o hubo un error peligroso. "inferido" es false solo si hay reseña del dueño. Si no hubo problemas, "problemas": [].`;

async function pedirJson(modelo: string, sistema: string, usuario: string): Promise<Record<string, unknown>> {
  const r = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", Authorization: `Bearer ${KEY}` },
    body: JSON.stringify({
      model: modelo,
      temperature: 0.2,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: sistema },
        { role: "user", content: usuario },
      ],
    }),
    signal: AbortSignal.timeout(180_000),
  });
  if (!r.ok) throw new Error(`OpenRouter ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const j = (await r.json()) as { choices?: { message?: { content?: string } }[] };
  const crudo = j.choices?.[0]?.message?.content ?? "";
  try {
    return JSON.parse(crudo.replace(/^```(json)?\s*|\s*```$/g, ""));
  } catch {
    throw new Error("el modelo no devolvió JSON");
  }
}

async function revisar(sessionId: string, tenant: Tenant, userId: number) {
  const { texto, hayDueno, ultimo } = transcripcion(tenant, sessionId);
  const resena = db.prepare("SELECT nota, texto FROM resenas WHERE session_id = ? AND user_id = ?").get(sessionId, userId) as
    | { nota: string; texto: string | null }
    | undefined;
  if (!hayDueno) {
    // nada que revisar (charla vacía o solo eventos automáticos): se marca para no volver a mirarla
    db.prepare(
      "INSERT OR REPLACE INTO revisiones (session_id, tenant_id, user_id, hasta, con_resena, modelo, ficha) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run(sessionId, tenant.id, userId, ultimo, resena ? 1 : 0, "-", JSON.stringify({ resumen: "sin mensajes del dueño", pedidos: [], problemas: [], satisfaccion: "bien", inferido: true, vacia: true }));
    return;
  }
  const usuario =
    `CHARLA ${sessionId}:\n${texto.slice(-60_000)}\n\n` +
    (resumenVoz(sessionId) ? resumenVoz(sessionId) + "\n\n" : "Sin datos de voz natural (chat, o llamada sin registro de voz).\n\n") +
    (resena ? `RESEÑA DEL DUEÑO: ${resena.nota === "bien" ? "salió bien" : "NO salió lo que quería"}${resena.texto ? ` — «${resena.texto}»` : ""}` : "Sin reseña del dueño.");
  const ficha = await pedirJson(MODELO, PAUTA, usuario);
  ficha.inferido = !resena;
  db.prepare(
    "INSERT OR REPLACE INTO revisiones (session_id, tenant_id, user_id, hasta, con_resena, modelo, ficha, at) VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))",
  ).run(sessionId, tenant.id, userId, ultimo, resena ? 1 : 0, MODELO, JSON.stringify(ficha));
}

// Pendientes: quietas hace QUIETA_MIN, de los últimos 7 días, sin ficha, con mensajes nuevos o con reseña nueva.
function pendientes(limite: number) {
  return db
    .prepare(
      `SELECT c.session_id, c.tenant_id, c.user_id, c.ultima, r.hasta, r.con_resena, s.at AS resena_at, r.at AS rev_at
         FROM charlas_lista c
         JOIN users u ON u.id = c.user_id
         LEFT JOIN revisiones r ON r.session_id = c.session_id
         LEFT JOIN resenas s ON s.session_id = c.session_id AND s.user_id = c.user_id
        WHERE c.ultima <= datetime('now', ?) AND c.ultima >= datetime('now', '-7 days')
          AND u.email NOT LIKE '%@local' -- usuarios de prueba (qa@local): sus charlas no son uso real
          AND (r.session_id IS NULL OR c.ultima > r.at OR (s.at IS NOT NULL AND s.at > r.at))
        ORDER BY c.ultima DESC LIMIT ?`,
    )
    .all(`-${QUIETA_MIN} minutes`, limite) as { session_id: string; tenant_id: string; user_id: number }[];
}

// ---------- informe ----------

const PAUTA_INFORME = `Sos el revisor de calidad de un secretario personal (agente de IA) que usa Goyo por chat y por llamada de voz. Te paso las fichas de revisión de sus charlas recientes (cada una: qué pidió, si se logró, problemas con causa probable y, a veces, la reseña del propio Goyo, que es la verdad).

Armá el informe para que el desarrollador sepa QUÉ MEJORAR, en orden de importancia:
- agrupá los problemas que son el mismo en el fondo (aunque se vean distintos) y contá en cuántas charlas pasó;
- separá patrón (pasó varias veces o es grave) de casual;
- para cada tema decí dónde está la falla y qué cambiar, concreto (qué instrucción, qué herramienta, qué parte de la voz);
- anotá también lo que anda bien (para no romperlo).
Castellano rioplatense, conciso, sin relleno.

Devolvé SOLO un JSON:
{
  "resumen": "2-3 frases: cómo viene el uso y lo más importante a arreglar",
  "numeros": {"charlas": 0, "bien": 0, "regular": 0, "mal": 0, "con_resena": 0},
  "temas": [{
    "titulo": "...",
    "gravedad": 1,
    "veces": 1,
    "charlas": ["sessionId", "..."],
    "que_pasa": "...",
    "donde": "instrucciones|memoria|herramienta|codigo|voz|externo|desconocida",
    "que_cambiar": "...",
    "evidencia": "cita corta de una ficha"
  }],
  "anda_bien": ["..."]
}
temas ordenados del más importante al menos (gravedad 3 = no logró lo que quería o error peligroso).`;

export function informes(tenant: Tenant) {
  const rows = db.prepare("SELECT id, at, n_charlas, modelo, contenido FROM informes WHERE tenant_id = ? ORDER BY id DESC LIMIT 60").all(tenant.id) as {
    id: number;
    at: string;
    n_charlas: number;
    modelo: string;
    contenido: string;
  }[];
  return { informes: rows.map((r) => ({ id: r.id, at: r.at.replace(" ", "T") + "Z", charlas: r.n_charlas, modelo: r.modelo, ...JSON.parse(r.contenido) })), corriendo };
}

async function armarInforme(tenant: Tenant): Promise<number | null> {
  const ultimo = db.prepare("SELECT at FROM informes WHERE tenant_id = ? ORDER BY id DESC LIMIT 1").get(tenant.id) as { at: string } | undefined;
  const fichas = db
    .prepare(
      `SELECT r.session_id, r.ficha, c.titulo, s.nota, s.texto
         FROM revisiones r LEFT JOIN charlas_lista c ON c.session_id = r.session_id
         LEFT JOIN resenas s ON s.session_id = r.session_id AND s.user_id = r.user_id
        WHERE r.tenant_id = ? AND r.at > ? AND r.modelo != '-'
          AND r.user_id NOT IN (SELECT id FROM users WHERE email LIKE '%@local')
        ORDER BY r.at`,
    )
    .all(tenant.id, ultimo?.at ?? "1970-01-01") as { session_id: string; ficha: string; titulo: string | null; nota: string | null; texto: string | null }[];
  if (!fichas.length) return null;
  const usuario = fichas
    .map((f) => JSON.stringify({ sessionId: f.session_id, titulo: f.titulo, resena: f.nota ? { nota: f.nota, texto: f.texto } : null, ficha: JSON.parse(f.ficha) }))
    .join("\n")
    .slice(0, 150_000);
  const contenido = await pedirJson(MODELO_INFORME, PAUTA_INFORME, `FICHAS (${fichas.length}):\n${usuario}`);
  const r = db
    .prepare("INSERT INTO informes (tenant_id, n_charlas, modelo, contenido) VALUES (?, ?, ?, ?)")
    .run(tenant.id, fichas.length, MODELO_INFORME, JSON.stringify(contenido));
  return Number(r.lastInsertRowid);
}

let corriendo = false;
/** Revisa todas las charlas pendientes y arma el informe. Una corrida por vez. */
export async function correr(tenant?: Tenant): Promise<{ revisadas: number; informe: number | null; errores: string[] }> {
  if (corriendo) throw new HttpError(409, "ya_corriendo", "Ya se está armando un informe.");
  if (!KEY) throw new HttpError(409, "sin_key", "Falta OPENROUTER_API_KEY.");
  corriendo = true;
  const errores: string[] = [];
  let revisadas = 0;
  let informe: number | null = null;
  try {
    for (const p of pendientes(500)) {
      if (tenant && p.tenant_id !== tenant.id) continue;
      const t = getTenant(p.tenant_id);
      if (!t) continue;
      try {
        await revisar(p.session_id, t, p.user_id);
        revisadas++;
      } catch (e) {
        errores.push(`${p.session_id}: ${(e as Error).message}`);
      }
    }
    const tenants = tenant ? [tenant] : (db.prepare("SELECT DISTINCT tenant_id FROM revisiones").all() as { tenant_id: string }[]).map((r) => getTenant(r.tenant_id)).filter((t): t is Tenant => !!t);
    for (const t of tenants) {
      try {
        informe = (await armarInforme(t)) ?? informe;
      } catch (e) {
        errores.push(`informe ${t.id}: ${(e as Error).message}`);
      }
    }
  } finally {
    corriendo = false;
  }
  if (errores.length) console.error("[revision]", errores.join(" | "));
  return { revisadas, informe, errores };
}

/** Para probar a mano: revisa ya esa charla (aunque no esté quieta). */
export async function revisarYa(tenant: Tenant, sessionId: string) {
  const row = db.prepare("SELECT user_id FROM charlas_lista WHERE session_id = ? AND tenant_id = ?").get(sessionId, tenant.id) as { user_id: number } | undefined;
  if (!row) throw new HttpError(404, "charla_no_existe", "Esa charla no existe.");
  if (!KEY) throw new HttpError(409, "sin_key", "Falta OPENROUTER_API_KEY.");
  await revisar(sessionId, tenant, row.user_id);
  return listar(tenant, 200).revisiones.find((r) => r.sessionId === sessionId) ?? null;
}

// Todas las noches a la HORA (hora local de la consola, TZ del contenedor).
export function arrancar() {
  if (!KEY) return console.warn("[revision] sin OPENROUTER_API_KEY: no se revisan las charlas");
  const [h, m] = HORA.split(":").map(Number);
  const programar = () => {
    const ahora = new Date();
    const prox = new Date(ahora);
    prox.setHours(h || 0, m || 0, 0, 0);
    if (prox <= ahora) prox.setDate(prox.getDate() + 1);
    setTimeout(async () => {
      try {
        const r = await correr();
        console.log(`[revision] noche: ${r.revisadas} charlas revisadas, informe ${r.informe ?? "sin novedades"}`);
      } catch (e) {
        console.error("[revision] noche:", (e as Error).message);
      }
      programar();
    }, prox.getTime() - ahora.getTime()).unref?.();
  };
  programar();
}
