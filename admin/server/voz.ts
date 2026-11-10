// Llamada por voz en tiempo real con Qwen-Omni Realtime (Alibaba Cloud Model Studio) como PUENTE: solo escucha y
// habla. Todo lo que dice el dueño va textual al secretario de siempre (Hermes + DeepSeek, con sus herramientas,
// reglas y memoria) y Qwen dice la respuesta tal cual. Así hay un solo cerebro y la llamada queda en la misma charla.
//
// Seguridad:
// - La API key de Alibaba vive solo acá (archivo 0600 en el volumen de la consola). Nunca vuelve al navegador: la
//   consola devuelve si está cargada y sus últimos 4 caracteres.
// - El navegador habla con Qwen por WebRTC (audio directo, con cancelación de eco), pero el intercambio SDP — el único
//   paso que necesita la key — lo hace este servidor. El host de Alibaba se arma con región de una lista fija y un
//   workspace validado: no se puede usar para pegarle a otra dirección.
// - Las herramientas reales las ejecuta Hermes del lado del servidor, con la sesión del usuario logueado.
import { existsSync } from "node:fs";
import { readFile, writeFile, rm, mkdir, appendFile, stat, rename } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import WebSocket from "ws";
import { HttpError } from "./auth.ts";
import { DATA_DIR, type Tenant } from "./db.ts";

// Modelos realtime que sirven de puente (los de la lista de Model Studio). Flash: el más barato; alcanza porque solo
// escucha y habla (el que piensa es el secretario). Plus: entiende algo mejor con ruido.
export const MODELOS = [
  { id: "qwen3.5-omni-flash-realtime", nombre: "Qwen3.5-Omni-Flash-Realtime — barato (recomendado)" },
  { id: "qwen3.5-omni-plus-realtime", nombre: "Qwen3.5-Omni-Plus-Realtime — mejor con ruido, ~4× más caro" },
  { id: "qwen3.8-omni-flash-realtime", nombre: "Qwen3.8-Omni-Flash-Realtime — si tu cuenta lo tiene" },
] as const;
const MODELO_IDS = new Set<string>(MODELOS.map((m) => m.id));
const MODELO_DEF = process.env.VOZ_MODELO ?? "qwen3.5-omni-flash-realtime";

// Región → sufijo del host de Model Studio (workspace-specific endpoint).
const REGIONES = { intl: "ap-southeast-1", cn: "cn-beijing" } as const;
type Region = keyof typeof REGIONES;

// Voces de la serie Qwen3.5-Omni que hablan castellano (lista oficial «omni-voice-list», sin dialectos chinos).
// grupo: castellano (suenan latinas/españolas) · neutra · acento (de otro país). Cómo suena cada una: botón «escuchar».
export const VOCES = [
  { id: "Sonrisa", genero: "f", grupo: "castellano", desc: "Mujer latinoamericana, cálida y extrovertida" },
  { id: "Bodega", genero: "m", grupo: "castellano", desc: "Hombre español, cálido y entusiasta" },
  { id: "Radio Gol", genero: "m", grupo: "castellano", desc: "Relator de fútbol apasionado, con vuelo poético" },
  { id: "Marina", genero: "f", grupo: "castellano", desc: "Chica criada en una ciudad multicultural" },
  { id: "Andre", genero: "m", grupo: "neutra", desc: "Hombre, voz magnética, natural y firme" },
  { id: "Tina", genero: "f", grupo: "neutra", desc: "Dulce y acogedora, pero filosa para resolver (la de Qwen por defecto)" },
  { id: "Serena", genero: "f", grupo: "neutra", desc: "Mujer joven y suave" },
  { id: "Maia", genero: "f", grupo: "neutra", desc: "Mezcla de inteligencia y dulzura" },
  { id: "Mia", genero: "f", grupo: "neutra", desc: "Tranquila, de vida lenta, voz que calma" },
  { id: "Liora Mira", genero: "f", grupo: "neutra", desc: "Suave, le pone calidez a lo cotidiano" },
  { id: "Katerina", genero: "f", grupo: "neutra", desc: "Madura, con autoridad, ritmo y resonancia" },
  { id: "Arda", genero: "f", grupo: "neutra", desc: "Ni aguda ni grave: limpia, nítida y cálida" },
  { id: "Siiri", genero: "f", grupo: "neutra", desc: "Reservada y suave, habla pausado" },
  { id: "Sunnybobi", genero: "f", grupo: "neutra", desc: "Relajada, un poco tímida, la de al lado" },
  { id: "Harvey", genero: "m", grupo: "neutra", desc: "Grave y suave, cálida como café y libros viejos" },
  { id: "Theo Calm", genero: "m", grupo: "neutra", desc: "Comprensiva y serena, sana con palabras" },
  { id: "Ryan", genero: "m", grupo: "neutra", desc: "Mucha energía, muy expresiva y dramática" },
  { id: "Evan", genero: "m", grupo: "neutra", desc: "Estudiante universitario, joven y simpático" },
  { id: "Raymond", genero: "m", grupo: "neutra", desc: "Voz clara, hogareño y relajado" },
  { id: "Li Cassian", genero: "m", grupo: "neutra", desc: "Medida: tres partes silencio, siete de leer el ambiente" },
  { id: "Joyner", genero: "m", grupo: "neutra", desc: "Gracioso, exagerado y campechano" },
  { id: "Momo", genero: "f", grupo: "neutra", desc: "Juguetona y pícara, para levantar el ánimo" },
  { id: "Jennifer", genero: "f", grupo: "acento", desc: "Mujer estadounidense, calidad de cine" },
  { id: "Aiden", genero: "m", grupo: "acento", desc: "Joven estadounidense que cocina bien" },
  { id: "Gold", genero: "m", grupo: "acento", desc: "Rapero de la costa oeste de EE. UU." },
  { id: "Mione", genero: "f", grupo: "acento", desc: "Vecina británica, madura e inteligente" },
  { id: "Emilien", genero: "m", grupo: "acento", desc: "Hermano mayor francés, romántico" },
  { id: "Dolce", genero: "m", grupo: "acento", desc: "Italiano relajado" },
  { id: "Lenn", genero: "m", grupo: "acento", desc: "Joven alemán, racional y rebelde en los detalles" },
  { id: "Eliška", genero: "f", grupo: "acento", desc: "Centroeuropea, cuidadosa y cálida" },
  { id: "Alek", genero: "m", grupo: "acento", desc: "Ruso: frío por fuera, cálido como la lana" },
  { id: "Jakub", genero: "m", grupo: "acento", desc: "Joven polaco, carismático y artístico" },
  { id: "Griet", genero: "f", grupo: "acento", desc: "Mujer neerlandesa, madura y artística" },
  { id: "Ingrid", genero: "f", grupo: "acento", desc: "Mujer del campo noruego" },
  { id: "Sigga", genero: "f", grupo: "acento", desc: "Joven intelectual de un pueblo de Islandia" },
  { id: "Ono Anna", genero: "f", grupo: "acento", desc: "Amiga de la infancia, viva y juguetona (Japón)" },
  { id: "Sohee", genero: "f", grupo: "acento", desc: "Coreana alegre y muy expresiva" },
  { id: "Rizky", genero: "m", grupo: "acento", desc: "Joven indonesio de voz particular" },
  { id: "Roya", genero: "f", grupo: "acento", desc: "Deportista de espíritu libre" },
  { id: "Hana", genero: "f", grupo: "acento", desc: "Mujer vietnamita madura que ama los perros" },
  { id: "Bea", genero: "f", grupo: "acento", desc: "Filipina dulce que ama el café" },
  { id: "Chloe", genero: "f", grupo: "acento", desc: "Oficinista de Malasia" },
  { id: "Cindy", genero: "f", grupo: "acento", desc: "Joven de Taiwán, de hablar dulce" },
  { id: "Qiao", genero: "f", grupo: "acento", desc: "Dulce por fuera, con mucha personalidad (Taiwán)" },
  { id: "Angel", genero: "f", grupo: "acento", desc: "Muy dulce, con un toque taiwanés" },
  { id: "Wil", genero: "m", grupo: "acento", desc: "Joven de Shenzhen con acento de Hong Kong y Taiwán" },
  { id: "Joseph Chen", genero: "m", grupo: "acento", desc: "Chino de ultramar del sudeste asiático, voz nostálgica" },
] as const;
const VOZ_IDS = new Set<string>(VOCES.map((v) => v.id));

type Config = { apiKey: string; workspaceId: string; region: Region; voz: string; modelo: string; favoritas: string[] };

const archivo = (t: Tenant) => join(DATA_DIR, `voz-${t.id.replace(/[^a-z0-9_-]/gi, "_")}.json`);

async function leer(t: Tenant): Promise<Config | null> {
  const p = archivo(t);
  if (!existsSync(p)) return null;
  try {
    const c = JSON.parse(await readFile(p, "utf8")) as Partial<Config>;
    if (!c.apiKey || !c.workspaceId) return null;
    return {
      apiKey: c.apiKey,
      workspaceId: c.workspaceId,
      region: c.region === "cn" ? "cn" : "intl",
      voz: VOZ_IDS.has(c.voz ?? "") ? c.voz! : "Sonrisa",
      modelo: MODELO_IDS.has(c.modelo ?? "") ? c.modelo! : MODELO_DEF,
      favoritas: (Array.isArray(c.favoritas) ? c.favoritas : []).filter((v) => VOZ_IDS.has(v)),
    };
  } catch {
    return null;
  }
}

/** Lo que ve el navegador: nunca la key. */
export async function verConfig(t: Tenant) {
  const c = await leer(t);
  return {
    configurada: !!c,
    keyFin: c ? c.apiKey.slice(-4) : null,
    workspaceId: c?.workspaceId ?? null,
    region: c?.region ?? "intl",
    voz: c?.voz ?? "Sonrisa",
    voces: VOCES,
    modelo: c?.modelo ?? MODELO_DEF,
    modelos: MODELOS,
    favoritas: c?.favoritas ?? [],
  };
}

// La key real la valida Alibaba en «probar»: acá solo lo mínimo. Al pegar suelen venir comillas, «Bearer »,
// espacios, saltos de línea o caracteres invisibles (U+200B, U+FEFF): se limpian antes de mirar el formato.
const KEY_RE = /^sk-[\x21-\x7e]{16,300}$/;

function limpiarKey(s: string): string {
  return s
    .replace(/[\u200b-\u200d\u2060\ufeff\u00a0]/g, "")
    .trim()
    .replace(/^(?:authorization:\s*)?bearer\s+/i, "")
    .replace(/^["'`«]+|["'`»]+$/g, "")
    .replace(/\s+/g, "");
}

function errorKey(k: string): string | null {
  if (KEY_RE.test(k)) return null;
  if (!/^sk-/i.test(k)) return "La API key de Model Studio empieza con «sk-». Revisá que hayas copiado la key y no el nombre o el ID.";
  if (!k.startsWith("sk-")) return "La key empieza con «SK-» en mayúsculas: tiene que ser «sk-» en minúsculas.";
  if (k.length < 19) return `La key quedó muy corta (${k.length} caracteres): parece que se copió cortada.`;
  if (k.length > 303) return "La key quedó demasiado larga: parece que se pegó algo más junto con ella.";
  return "La key tiene caracteres raros (acentos o símbolos que no van). Copiala de nuevo desde Model Studio.";
}
const WS_RE = /^[a-z0-9][a-z0-9-]{2,63}$/i;

export async function guardarConfig(t: Tenant, b: Record<string, unknown>) {
  const actual = await leer(t);
  const nueva = typeof b.apiKey === "string" ? limpiarKey(b.apiKey) : "";
  const apiKey = nueva || actual?.apiKey;
  const workspaceId = typeof b.workspaceId === "string" && b.workspaceId.trim() ? b.workspaceId.trim() : actual?.workspaceId;
  const region: Region = b.region === "cn" ? "cn" : b.region === "intl" ? "intl" : actual?.region ?? "intl";
  const voz = typeof b.voz === "string" && VOZ_IDS.has(b.voz) ? b.voz : actual?.voz ?? "Sonrisa";
  const modelo = typeof b.modelo === "string" && MODELO_IDS.has(b.modelo) ? b.modelo : actual?.modelo ?? MODELO_DEF;
  if (!apiKey) throw new HttpError(400, "key_invalida", "Falta la API key de Model Studio.");
  const malKey = errorKey(apiKey);
  if (malKey) throw new HttpError(400, "key_invalida", malKey);
  if (!workspaceId || !WS_RE.test(workspaceId)) throw new HttpError(400, "workspace_invalido", "El Workspace ID tiene un formato inválido.");
  const favoritas = Array.isArray(b.favoritas)
    ? [...new Set(b.favoritas.filter((v): v is string => typeof v === "string" && VOZ_IDS.has(v)))].slice(0, 20)
    : actual?.favoritas ?? [];
  const c: Config = { apiKey, workspaceId, region, voz, modelo, favoritas };
  await writeFile(archivo(t), JSON.stringify(c), { mode: 0o600 });
}

export async function borrarConfig(t: Tenant) {
  await rm(archivo(t), { force: true });
}

const host = (c: Config) => `${c.workspaceId.toLowerCase()}.${REGIONES[c.region]}.maas.aliyuncs.com`;

// Sin la key ni nada que la contenga en los mensajes de error.
const limpiar = (s: string, c: Config) => s.split(c.apiKey).join("[key]").replace(/sk-[A-Za-z0-9_-]{8,}/g, "[key]").slice(0, 200);

/** Traduce la respuesta de error de Alibaba ({code, message}) a algo que se entienda, sin la key. */
function errorAlibaba(status: number, cuerpo: string, c: Config): string {
  let code = "";
  let message = "";
  try {
    const j = JSON.parse(cuerpo) as { code?: string; message?: string };
    code = j.code ?? "";
    message = j.message ?? "";
  } catch {
    message = cuerpo;
  }
  if (code === "BadRequest.IllegalEndpoint" || /workspace endpoint/i.test(message))
    return (
      `Alibaba no reconoce el Workspace ID «${c.workspaceId}» en ${c.region === "cn" ? "Beijing" : "Singapur"}. ` +
      "No es el número de cuenta: en Model Studio (misma región que la key) tocá el ícono de arriba a la derecha y copiá «Workspace ID»."
    );
  if (status === 401 || status === 403 || /InvalidApiKey|Unauthorized|AccessDenied/i.test(code))
    return `Alibaba rechazó la key${c.region === "cn" ? "" : " (las de Singapur y Beijing son distintas: fijate la región)"}.`;
  if (/model/i.test(code) || /model/i.test(message)) return `Alibaba no habilita el modelo ${c.modelo} en esa cuenta: probá con otro de la lista.`;
  const detalle = limpiar([code, message].filter(Boolean).join(": "), c);
  return `Alibaba respondió ${status}${detalle ? ` (${detalle})` : ""}.`;
}

/** Prueba la key: abre la sesión realtime y espera `session.created`. */
export async function probar(t: Tenant): Promise<{ ok: true } | { ok: false; mensaje: string }> {
  const c = await leer(t);
  if (!c) return { ok: false, mensaje: "Todavía no cargaste la key." };
  return new Promise((resolve) => {
    const ws = new WebSocket(`wss://${host(c)}/api-ws/v1/realtime?model=${encodeURIComponent(c.modelo)}`, {
      headers: { Authorization: `Bearer ${c.apiKey}` },
      handshakeTimeout: 8000,
    });
    const fin = (r: { ok: true } | { ok: false; mensaje: string }) => {
      clearTimeout(tope);
      try {
        ws.terminate();
      } catch {
        /* ya cerrado */
      }
      resolve(r);
    };
    const tope = setTimeout(() => fin({ ok: false, mensaje: "Alibaba no respondió a tiempo." }), 10000);
    ws.on("message", (raw) => {
      try {
        const ev = JSON.parse(String(raw)) as { type?: string; error?: { message?: string } };
        if (ev.type === "session.created") fin({ ok: true });
        else if (ev.type === "error") fin({ ok: false, mensaje: limpiar(ev.error?.message ?? "error", c) });
      } catch {
        /* ignorar */
      }
    });
    ws.on("unexpected-response", (_req, res) => {
      let cuerpo = "";
      res.on("data", (d: Buffer) => (cuerpo += d));
      res.on("end", () => fin({ ok: false, mensaje: errorAlibaba(res.statusCode ?? 0, cuerpo, c) }));
      res.on("error", () => fin({ ok: false, mensaje: errorAlibaba(res.statusCode ?? 0, "", c) }));
    });
    ws.on("error", (e) => fin({ ok: false, mensaje: limpiar(e.message, c) }));
  });
}

// Instrucciones de la voz: puente puro.
// Instrucciones de la voz: puente puro. La consola le pasa al secretario lo que transcribe el reconocedor y después
// le pide a Qwen (response.create con instrucciones) que diga la respuesta textual. Sin herramientas: medido, Qwen las
// llamaba sin argumentos o contestaba por su cuenta (chistes, saludos) sin pasar por el secretario.
const PUENTE =
  "Sos la VOZ de un secretario, no el secretario. No pensás ni respondés por tu cuenta: sos un puente.\n" +
  "- Nunca contestes por tu cuenta lo que dice el dueño. Solo hablás cuando te piden decir un texto.\n" +
  "- Cuando te piden decir un texto, decilo tal cual, con voz natural y en castellano rioplatense: no agregues, no " +
  "quites, no resumas ni comentes.\n" +
  "- Si te interrumpen mientras hablás, callate.";

/** Intercambio SDP del navegador con Alibaba (lo único que necesita la key) + la configuración de la sesión. */
export async function sdp(t: Tenant, offer: string) {
  const c = await leer(t);
  if (!c) throw new HttpError(409, "voz_sin_key", "Falta cargar la key de Alibaba para la llamada (Ajustes → Voz).");
  if (!offer.startsWith("v=0") || offer.length > 20000) throw new HttpError(400, "sdp_invalido", "Oferta de audio inválida.");
  let res: Response;
  try {
    res = await fetch(`https://${host(c)}/api/v1/webrtc/realtime?model=${encodeURIComponent(c.modelo)}`, {
      method: "POST",
      headers: { "content-type": "application/sdp", Authorization: `Bearer ${c.apiKey}` },
      body: offer,
      signal: AbortSignal.timeout(15000),
    });
  } catch {
    throw new HttpError(502, "voz_caida", "No pude conectar con Alibaba para la llamada.");
  }
  const body = await res.text();
  if (!res.ok) throw new HttpError(502, "voz_error", errorAlibaba(res.status, body, c));
  return {
    answer: body,
    session: {
      modalities: ["text", "audio"],
      voice: c.voz,
      input_audio_format: "pcm",
      output_audio_format: "pcm",
      instructions: PUENTE,
      // En castellano: sin idioma, una frase corta salió transcripta en hindi.
      input_audio_transcription: { model: "qwen3-asr-flash-realtime", language: "es" },
      // Fin de turno por sentido (no por silencio): no corta en las pausas para pensar. create_response=false: detecta
      // el turno y transcribe, pero no contesta solo (lo que se dice lo decide el secretario).
      turn_detection: { type: "semantic_vad", silence_duration_ms: 700, create_response: false, interrupt_response: true },
      temperature: 0.3,
    },
  };
}


// ---------- muestras de voz («escuchar» en el gestor) ----------
// Se le pide al mismo modelo realtime que diga la frase con esa voz (sin micrófono: turn_detection null + response.create)
// y se arma un WAV con el PCM que devuelve. Se guarda en disco: escuchar de nuevo la misma voz y frase no cuesta nada.
export const FRASE_MUESTRA = "Hola Goyo, soy tu secretario. ¿Le paso diez lucas al Berna?";
const dirMuestras = join(DATA_DIR, "voz-muestras");

function wav(pcm: Buffer, rate = 24000): Buffer {
  const h = Buffer.alloc(44);
  h.write("RIFF", 0);
  h.writeUInt32LE(36 + pcm.length, 4);
  h.write("WAVEfmt ", 8);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20); // PCM
  h.writeUInt16LE(1, 22); // mono
  h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * 2, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write("data", 36);
  h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

export async function muestra(t: Tenant, voz: string, frase?: string): Promise<Buffer> {
  const c = await leer(t);
  if (!c) throw new HttpError(409, "voz_sin_key", "Primero cargá la key de Alibaba.");
  if (!VOZ_IDS.has(voz)) throw new HttpError(400, "voz_invalida", "Esa voz no está en la lista.");
  const texto = (frase ?? "").trim().slice(0, 200) || FRASE_MUESTRA;
  const clave = createHash("sha1").update(`${c.modelo}|${voz}|${texto}`).digest("hex").slice(0, 20);
  const archivoWav = join(dirMuestras, `${clave}.wav`);
  if (existsSync(archivoWav)) return readFile(archivoWav);

  const pcm = await new Promise<Buffer>((resolve, reject) => {
    const partes: Buffer[] = [];
    const ws = new WebSocket(`wss://${host(c)}/api-ws/v1/realtime?model=${encodeURIComponent(c.modelo)}`, {
      headers: { Authorization: `Bearer ${c.apiKey}` },
      handshakeTimeout: 8000,
    });
    const fin = (e?: Error) => {
      clearTimeout(tope);
      try {
        ws.terminate();
      } catch {
        /* ya cerrado */
      }
      if (e) reject(e);
      else resolve(Buffer.concat(partes));
    };
    const tope = setTimeout(() => fin(partes.length ? undefined : new HttpError(504, "voz_lenta", "Alibaba no devolvió la muestra a tiempo.")), 25000);
    let n = 0; // event_id único aunque salgan dos en el mismo milisegundo
    const mandar = (ev: Record<string, unknown>) => ws.send(JSON.stringify({ event_id: `ev_${Date.now()}_${n++}`, ...ev }));
    ws.on("message", (raw) => {
      let ev: { type?: string; delta?: string; error?: { message?: string } };
      try {
        ev = JSON.parse(String(raw));
      } catch {
        return;
      }
      if (ev.type === "session.created")
        mandar({
          type: "session.update",
          session: {
            modalities: ["text", "audio"],
            voice: voz,
            output_audio_format: "pcm",
            turn_detection: null,
            instructions:
              "Sos una voz de prueba. Cuando te pidan responder, decí EXACTAMENTE esta frase, en castellano rioplatense, " +
              `con naturalidad y sin agregar nada antes ni después: «${texto}»`,
          },
        });
      else if (ev.type === "session.updated") {
        // Alibaba ya no responde si la sesión no tiene ningún mensaje con rol user («The input messages do not contain
        // elements with the role of user»): se pone uno antes de pedir la respuesta.
        mandar({ type: "conversation.item.create", item: { type: "message", role: "user", content: [{ type: "input_text", text: "Decí la frase." }] } });
        mandar({ type: "response.create" });
      }
      else if (ev.type === "response.audio.delta" && ev.delta) partes.push(Buffer.from(ev.delta, "base64"));
      else if (ev.type === "response.done") fin();
      else if (ev.type === "error") fin(new HttpError(502, "voz_error", limpiar(ev.error?.message ?? "error", c)));
    });
    ws.on("unexpected-response", (_req, res) =>
      fin(new HttpError(502, "voz_error", res.statusCode === 401 || res.statusCode === 403 ? "Alibaba rechazó la key." : `Alibaba respondió ${res.statusCode}.`)),
    );
    ws.on("error", (e) => fin(new HttpError(502, "voz_error", limpiar(e.message, c))));
  });
  if (pcm.length < 2000) throw new HttpError(502, "voz_vacia", "La muestra vino vacía.");
  const out = wav(pcm);
  await mkdir(dirMuestras, { recursive: true });
  await writeFile(archivoWav, out);
  return out;
}


// ---------- calidad del audio de la llamada (diagnóstico) ----------
// El navegador manda cada pocos segundos las estadísticas de WebRTC (paquetes perdidos, jitter, audio rellenado por el
// navegador, demora del reloj de la página). Sirve para saber si la voz trabada es la red o la PC. Sin contenido.
export const STATS = join(DATA_DIR, "voz-stats.jsonl");
export async function guardarStats(t: Tenant, userId: number | undefined, b: Record<string, unknown>) {
  const muestras = Array.isArray(b.muestras) ? b.muestras.slice(0, 500) : []; // muestras + rastro de eventos
  const llamada = typeof b.llamada === "string" ? b.llamada.slice(0, 80) : "";
  const lineas = muestras
    .filter((m): m is Record<string, unknown> => !!m && typeof m === "object")
    .map((m) => {
      const limpio: Record<string, number | string | boolean> = {};
      for (const [k, v] of Object.entries(m).slice(0, 30))
        if (/^[a-zA-Z]{1,30}$/.test(k) && (typeof v === "number" || typeof v === "boolean" || (typeof v === "string" && v.length < 40))) limpio[k] = v;
      return JSON.stringify({ tenant: t.id, user: userId ?? null, llamada, ...limpio });
    });
  if (!lineas.length) return { ok: true };
  try {
    if ((await stat(STATS)).size > 5_000_000) await rename(STATS, STATS + ".1");
  } catch {
    /* todavía no existe */
  }
  await appendFile(STATS, lineas.join("\n") + "\n", { mode: 0o600 });
  return { ok: true };
}
