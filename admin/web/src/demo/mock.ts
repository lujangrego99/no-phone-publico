// Modo demo (build con VITE_DEMO=1): la consola corre sola en el navegador, sin servidor, con datos ficticios.
// Intercepta fetch("/api/...") y contesta como el servidor real. Nada sale del navegador.
// Todo lo que aparece acá es inventado: personas, números, alias, montos y conversaciones.
/* eslint-disable @typescript-eslint/no-explicit-any */
type Json = Record<string, any>;

const T = "demo";
const iso = (minDesde = 0) => new Date(Date.now() + minDesde * 60_000).toISOString();
const hhmm = (minDesde = 0) => {
  const d = new Date(Date.now() + minDesde * 60_000);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};
const fecha = (minDesde = 0) => {
  const d = new Date(Date.now() + minDesde * 60_000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} ${hhmm(minDesde)}`;
};

// ---------------- herramientas (resultados con la forma real de cada MCP) ----------------

let nId = 0;
const tool = (name: string, args: Json, result: Json) => ({ id: `t${++nId}`, name, args, result, done: true });

const MAMA = { nombre: "Mamá", numero: "+54 9 261 555-0101", jid: "5492615550101@s.whatsapp.net" };
const JUAN = { titular: "Juan Pérez", entidad: "Mercado Pago", alias: "juan.perez.demo", cvu_cbu: "0000000000000000000000" };

const R = {
  waMama: () =>
    tool("mcp__whatsapp__wa_mensajes", { chat: "Mamá" }, {
      chat: MAMA,
      mensajes: [
        { id: "m1", de: "Mamá", texto: "Hola hijo, ¿venís a cenar el domingo?", fecha: fecha(-95) },
        { id: "m2", de: "Mamá", texto: "Hago empanadas 🥟", fecha: fecha(-94) },
        { id: "m3", de: "Mamá", texto: "Avisame a qué hora llegás así pongo el horno", fecha: fecha(-40) },
      ],
    }),
  waPreview: (texto: string) =>
    tool("mcp__whatsapp__wa_enviar_preview", { destino: "Mamá", texto }, {
      estado: "listo_para_enviar",
      destinatario: { nombre: "Mamá", numero: MAMA.numero },
      contenido: `«${texto}»`,
      pregunta: `¿Le mando a Mamá: «${texto}»?`,
    }),
  waEnviado: (texto: string) => tool("mcp__whatsapp__wa_enviar", { confirmado: true }, { estado: "enviado", a: "Mamá", texto, fecha: fecha(0) }),
  waRecientes: () =>
    tool("mcp__whatsapp__wa_recientes", {}, {
      chats: [
        { chat: "Mamá", chat_jid: "a", mensajes: [{ de: "Mamá", texto: "Avisame a qué hora llegás así pongo el horno", fecha: fecha(-40) }] },
        { chat: "Lucía", chat_jid: "b", mensajes: [{ de: "Lucía", texto: "¿Me pasás el apunte de Análisis?", fecha: fecha(-25) }] },
        { chat: "Fútbol de los jueves", chat_jid: "c", mensajes: [{ de: "Nico", texto: "Falta uno para el jueves ⚽", fecha: fecha(-12) }] },
        { chat: "Juan Pérez", chat_jid: "d", mensajes: [{ de: "Juan Pérez", media: "nota_de_voz", fecha: fecha(-5) }] },
      ],
    }),
  nxSaldo: () =>
    tool("mcp__naranjax__nx_saldo", {}, {
      pesos: 184_350.42,
      dolares: 120,
      rendimientos_mes: 3_912.1,
      movimientos_preview: [
        { tipo: "Transferencia recibida", contraparte: "Lucía Gómez", monto_raw: "+ $ 12.000,00" },
        { tipo: "Pago", contraparte: "Supermercado", monto_raw: "- $ 23.480,00" },
        { tipo: "Transferencia enviada", contraparte: "Juan Pérez", monto_raw: "- $ 5.000,00" },
      ],
    }),
  nxArmar: (monto: number) =>
    tool("mcp__naranjax__nx_transfer_armar", { destino: "Juan", monto }, {
      estado: "listo_para_enviar",
      monto,
      destinatario: JUAN,
      disponible_monto: 184_350.42,
      puede_transferir: true,
      historial: { conocida: true },
    }),
  nxEnviada: (monto: number) =>
    tool("mcp__naranjax__nx_transfer", { confirmado: true }, { estado: "ok", mensaje: `Le mandaste ${pesos(monto)} a Juan Pérez.`, monto }),
  micro: () =>
    tool("mcp__movilidad__micro_cuando_viene", { parada: "M1031" }, {
      parada: { codigo: "M1031", ubicacion: "San Martín y Garibaldi" },
      arribos: [
        { linea: "160", cartel: "Las Heras por San Martín", en_min: 4, tiempo_real: true },
        { linea: "940", cartel: "Godoy Cruz – Centro", en_min: 9, tiempo_real: true },
        { linea: "160", cartel: "Las Heras por San Martín", en_min: 21, tiempo_real: false, hora: hhmm(21) },
      ],
      consultado: hhmm(0),
      consultado_epoch: Math.floor(Date.now() / 1000),
    }),
  vigilar: () =>
    tool("mcp__whatsapp__wa_vigilar", { contacto: "Lucía", horas: 6 }, {
      estado: "vigilando",
      hasta: hhmm(360),
      vigilancia: { nombre: "Lucía", contiene: null, una_vez: true },
    }),
};

const pesos = (n: number) => n.toLocaleString("es-AR", { style: "currency", currency: "ARS", maximumFractionDigits: 2 });

// ---------------- charlas guardadas ----------------

const vos = (texto: string, min: number) => ({ quien: "vos", texto, at: Date.now() + min * 60_000 });
const sec = (texto: string, min: number) => ({ quien: "secretario", texto, at: Date.now() + min * 60_000 });
const herr = (t: Json) => ({ quien: "herramienta", tool: t });

const CHARLAS: Record<string, { titulo: string; ultima: string; lineas: Json[] }> = {
  "demo-1": {
    titulo: "¿Qué me escribió mamá?",
    ultima: iso(-3),
    lineas: [
      vos("¿Qué me escribió mamá?", -32),
      herr(R.waMama()),
      sec("Te preguntó si vas a cenar el domingo (hace empanadas) y quiere saber a qué hora llegás para prender el horno.", -32),
      vos("Decile que sí, que llego a las 8", -31),
      herr(R.waPreview("¡Sí, ma! Llego a las 8 🙌")),
      herr(R.waEnviado("¡Sí, ma! Llego a las 8 🙌")),
      sec("Listo, se lo mandé.", -30),
      vos("¿Cuánta plata tengo en Naranja X?", -12),
      herr(R.nxSaldo()),
      sec("Tenés $184.350,42 y US$ 120. Este mes te rindió $3.912,10.", -12),
      vos("Pasale 5000 a Juan por la pizza", -4),
      herr(R.nxArmar(5000)),
      sec("Te armé la transferencia a Juan Pérez por $5.000. ¿La mando?", -4),
      vos("sí, transferí", -3),
      herr(R.nxEnviada(5000)),
      sec("Hecho: le mandaste $5.000 a Juan Pérez. Si querés le paso el comprobante por WhatsApp.", -3),
    ],
  },
  "demo-2": {
    titulo: "¿Cuándo viene el micro a la facu?",
    ultima: iso(-180),
    lineas: [
      vos("¿Cuándo viene el micro en la parada de San Martín y Garibaldi?", -182),
      herr(R.micro()),
      sec("El 160 pasa en 4 minutos (en vivo por GPS) y después el 940 en 9. Si salís ya, llegás al 160.", -182),
    ],
  },
  "demo-3": {
    titulo: "Avisame si Lucía me escribe",
    ultima: iso(-60 * 26),
    lineas: [
      vos("Avisame si Lucía me escribe hoy", -60 * 26),
      herr(R.vigilar()),
      sec("Dale, la vigilo hasta la noche. Si te escribe, te aviso acá al toque.", -60 * 26),
    ],
  },
};
let actual = "demo-1";

// ---------------- respuestas en vivo (lo que escribís en la demo) ----------------

type Paso = { tool?: Json; texto?: string };
let pendiente: null | "wa" | "nx" = null;
let montoPend = 0;
let textoPend = "";

function guion(pregunta: string): Paso[] {
  const p = pregunta.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
  const si = /^(si|dale|ok|mandalo|transferi|de una|listo)\b/.test(p) || /\b(mandalo|transferi)\b/.test(p);
  const no = /^no\b/.test(p);
  if (pendiente && (si || no)) {
    const era = pendiente;
    pendiente = null;
    if (no) return [{ texto: "Ok, no lo mando." }];
    if (era === "wa") return [{ tool: R.waEnviado(textoPend) }, { texto: "Listo, se lo mandé." }];
    return [{ tool: R.nxEnviada(montoPend) }, { texto: `Hecho: le mandaste ${pesos(montoPend)} a Juan Pérez.` }];
  }
  if (/saldo|plata|cuanto tengo|naranja/.test(p)) return [{ tool: R.nxSaldo() }, { texto: "Tenés $184.350,42 y US$ 120. Este mes te rindió $3.912,10." }];
  const monto = /(\d[\d.]*)/.exec(p)?.[1];
  if (/pasa|transfer|manda.*\d|deposit/.test(p) && monto) {
    montoPend = Number(monto.replace(/\./g, "")) || 1000;
    pendiente = "nx";
    return [{ tool: R.nxArmar(montoPend) }, { texto: `Te armé la transferencia a Juan Pérez por ${pesos(montoPend)}. ¿La mando?` }];
  }
  if (/micro|colectivo|bondi|parada|160|940/.test(p))
    return [{ tool: R.micro() }, { texto: "El 160 pasa en 4 minutos (en vivo por GPS) y el 940 en 9." }];
  if (/decile|mandale|respondele|contestale/.test(p)) {
    textoPend = pregunta.replace(/^.*?(decile|mandale|respondele|contestale)( a mam[aá])?( que)?\s*/i, "").trim() || "¡Ahí voy!";
    textoPend = textoPend.charAt(0).toUpperCase() + textoPend.slice(1);
    pendiente = "wa";
    return [{ tool: R.waPreview(textoPend) }, { texto: "Te dejo el borrador. ¿Se lo mando?" }];
  }
  if (/mama|vieja/.test(p)) return [{ tool: R.waMama() }, { texto: "Te pregunta si vas a cenar el domingo y a qué hora llegás." }];
  if (/escribi|mensaje|whatsapp|wsp|novedades/.test(p))
    return [{ tool: R.waRecientes() }, { texto: "Te escribieron Mamá (cena del domingo), Lucía (un apunte), el grupo del fútbol y Juan te mandó un audio." }];
  if (/avisa|vigila/.test(p)) return [{ tool: R.vigilar() }, { texto: "Dale, la vigilo. Si te escribe, te aviso acá." }];
  return [
    {
      texto:
        "Esta es una demo con datos ficticios 🙂 Probá con: «¿qué me escribieron?», «¿cuánta plata tengo?», «pasale 3000 a Juan», «decile a mamá que llego tarde» o «¿cuándo viene el micro?».",
    },
  ];
}

const espera = (ms: number) => new Promise((r) => setTimeout(r, ms));

function sse(pregunta: string): Response {
  const enc = new TextEncoder();
  const pasos = guion(pregunta);
  const charla = CHARLAS[actual];
  charla.lineas.push(vos(pregunta, 0));
  charla.ultima = iso(0);
  const body = new ReadableStream({
    async start(ctrl) {
      const ev = (event: string, data: Json) => ctrl.enqueue(enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      for (const p of pasos) {
        if (p.tool) {
          const t: Json = { ...p.tool, id: `v${++nId}` };
          await espera(350);
          ev("tool", { id: t.id, name: t.name, args: t.args });
          await espera(900 + Math.random() * 600);
          ev("tool_done", { id: t.id, result: t.result });
          charla.lineas.push(herr(t));
        }
        if (p.texto) {
          await espera(300);
          for (const pedazo of p.texto.match(/\S+\s*/g) ?? []) {
            ev("delta", { text: pedazo });
            await espera(35);
          }
          charla.lineas.push(sec(p.texto, 0));
        }
      }
      ctrl.close();
    },
  });
  return new Response(body, { headers: { "content-type": "text/event-stream" } });
}

// ---------------- memoria ----------------

const ENT = [
  { id: "e1", canonical_name: "Mamá", mention_count: 42, tipo: "gente", obs: ["Es la mamá del dueño; en WhatsApp figura como «Mamá».", "Los domingos suele invitar a cenar."] },
  { id: "e2", canonical_name: "Juan Pérez", mention_count: 17, tipo: "gente", obs: ["Amigo de la facu.", "En Naranja X: alias juan.perez.demo (Mercado Pago)."] },
  { id: "e3", canonical_name: "Lucía Gómez", mention_count: 11, tipo: "gente", obs: ["Compañera de Análisis Matemático.", "En WhatsApp figura como «Lucía»."] },
  { id: "e4", canonical_name: "Fútbol de los jueves", mention_count: 8, tipo: "grupo", obs: ["Grupo de WhatsApp del fútbol, juegan los jueves a las 21."] },
  { id: "e5", canonical_name: "la facu", mention_count: 14, tipo: "lugar", obs: ["Universidad, en el centro de Mendoza.", "Toma el 160 en San Martín y Garibaldi."] },
  { id: "e6", canonical_name: "casa", mention_count: 9, tipo: "lugar", obs: ["Calle Falsa 123, Godoy Cruz (dirección de ejemplo)."] },
  { id: "e7", canonical_name: "Naranja X", mention_count: 23, tipo: "cuenta", obs: ["Billetera principal del dueño."] },
  { id: "e8", canonical_name: "Nico", mention_count: 5, tipo: "gente", obs: ["Organiza el fútbol de los jueves."] },
];
const entidad = (e: (typeof ENT)[number]) => ({
  id: e.id,
  canonical_name: e.canonical_name,
  mention_count: e.mention_count,
  first_seen: iso(-60 * 24 * 30),
  last_seen: iso(-60 * Number(e.id.slice(1))),
  metadata: null,
});
const unidades = (e: (typeof ENT)[number]) =>
  e.obs.map((text, i) => ({
    id: `${e.id}-u${i}`,
    text,
    context: "charla con el secretario",
    date: iso(-60 * 24 * (i + 1)),
    fact_type: i === 0 ? "observation" : "world",
    mentioned_at: iso(-60 * 24 * (i + 1)),
    entities: [e.canonical_name],
    proof_count: 2 + i,
    state: null,
    invalidation_reason: null,
    edited_at: null,
  }));

// ---------------- resto de la consola ----------------

const piece = (id: string, label: string, detail: string, health = "ok") => ({ id, label, health, detail, checkedAt: iso(0) });
const STATUS = () => ({
  memory: piece("memory", "memoria", "Hindsight · 142 recuerdos"),
  llm: piece("llm", "modelo", "OpenRouter · deepseek"),
  scheduler: piece("scheduler", "tareas", "corriendo"),
  devices: [
    {
      id: "celu",
      kind: "fisico",
      label: "Moto G (demo)",
      serial: "DEMO0001",
      adbServer: null,
      active: true,
      profile: { fabricante: "motorola", modelo: "moto g", android: "13", resolucion: "720x1600", ui_mode: "fast" },
      secrets: { NX_PIN: true },
      health: "ok",
      detail: "conectado por adb",
    },
  ],
  whatsapp: piece("whatsapp", "WhatsApp", "vinculado · 214 chats"),
  mcp: [
    { ...piece("naranjax", "Naranja X", "13 herramientas"), tools: 13, ms: 41 },
    { ...piece("whatsapp", "WhatsApp", "22 herramientas"), tools: 22, ms: 18 },
    { ...piece("movilidad", "Movilidad", "6 herramientas"), tools: 6, ms: 25 },
    { ...piece("reglas", "Reglas", "4 herramientas"), tools: 4, ms: 9 },
  ],
  checkedAt: iso(0),
});

const RULES = [
  { id: "r1", name: "Plata siempre con confirmación", content: "Nunca transfieras sin mostrarme antes el monto y el destinatario.", is_active: true, priority: 1 },
  { id: "r2", name: "Comprobante por WhatsApp", content: "Después de transferirle a alguien, ofrecé mandarle el comprobante por WhatsApp.", is_active: true, priority: 2 },
  { id: "r3", name: "Respuestas cortas", content: "Contestame corto, en una o dos oraciones.", is_active: true, priority: 3 },
];

const SECRETARY = {
  soul: "Sos el secretario personal de tu dueño. Hablás en español rioplatense, corto y claro.\nUsás su celular por él (WhatsApp, Naranja X, micros) y nunca mandás plata ni mensajes sin su sí.",
  model: { provider: "openrouter", default: "deepseek/deepseek-v4.1-flash", base_url: null },
  memoryProvider: "hindsight",
  recall: { recall_budget: "mid", recall_max_tokens: 1200, auto_recall: true, auto_retain: true },
  bank: { retain_mission: "Quién es quién, cómo figura cada uno en cada app, lugares habituales y preferencias.", observations_mission: null, recall_max_tokens: 1200, disposition_skepticism: 3, disposition_literalism: 3, disposition_empathy: 4 },
  bankId: "demo",
  providerKeys: { openrouter: true },
};

const MISIONES = [
  {
    id: "mis1",
    sessionId: "demo-3",
    objetivo: "Conseguir 1 jugador para el fútbol del jueves",
    alcance: "Puede escribirle a Nico y a Juan; confirmar el primero que diga que sí.",
    consultar: "Si nadie puede antes del miércoles a la noche.",
    estado: "activa",
    nota: "Juan dijo que capaz; espero a Nico.",
    resultado: null,
    contactos: ["Nico", "Juan Pérez"],
    transferencias: [],
    esperaIngreso: false,
    mensajes: 2,
    mensajesMax: 6,
    turnos: 3,
    vence: iso(60 * 30),
    despertar: null,
    log: [
      { at: iso(-120), tipo: "creada", texto: "Arrancó con tu sí." },
      { at: iso(-118), tipo: "secretario", texto: "Le escribí a Nico y a Juan." },
      { at: iso(-40), tipo: "evento", texto: "Juan contestó: «capaz, te confirmo a la noche»." },
    ],
  },
  {
    id: "mis2",
    sessionId: "demo-1",
    objetivo: "Cobrarle a Lucía los $12.000 del regalo y avisar cuando llegue",
    alcance: "Mandarle un recordatorio amable; esperar el ingreso en Naranja X.",
    consultar: "Nada.",
    estado: "cumplida",
    nota: "",
    resultado: "Lucía transfirió $12.000 ayer a las 18:20.",
    contactos: ["Lucía Gómez"],
    transferencias: [],
    esperaIngreso: true,
    mensajes: 1,
    mensajesMax: 3,
    turnos: 2,
    vence: iso(-60),
    despertar: null,
    log: [{ at: iso(-60 * 20), tipo: "evento", texto: "Ingreso de $12.000 de Lucía Gómez." }],
  },
];
const VIGS = [{ id: "v1", nombre: "Lucía", contiene: null, estado: "activa", hasta: iso(300), avisos: 0 }];
const JOBS = [
  { id: "j1", name: "Recordar pagar el alquiler", prompt: "Recordame pagar el alquiler", schedule: "0 9 5 * *", state: "scheduled", enabled: true, next_run_at: iso(60 * 24 * 6), last_run_at: null, last_status: null, last_error: null, repeat: null },
  { id: "j2", name: "Resumen de WhatsApp a la mañana", prompt: "Decime qué me escribieron a la noche", schedule: "30 8 * * 1-5", state: "scheduled", enabled: true, next_run_at: iso(60 * 14), last_run_at: iso(-60 * 10), last_status: "ok", last_error: null, repeat: null },
];

// ---------------- router ----------------

const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });

async function responder(path: string, method: string, body: Json): Promise<Response> {
  const p = path.replace(/^\/api/, "");
  const [ruta, qs] = p.split("?");
  const q = new URLSearchParams(qs ?? "");
  const t = `/t/${T}`;

  if (ruta === "/session")
    return json({ user: { id: 1, name: "Demo", email: "demo@ejemplo.com", role: "owner", tenantId: T }, needsSetup: false, tenants: [{ id: T, name: "Demo" }] });
  if (ruta === "/logout") return json({ ok: true });
  if (!ruta.startsWith(t)) return json({ ok: true });
  const r = ruta.slice(t.length);

  // chat
  if (r === "/charla" && method === "GET") return json({ sessionId: actual, lineas: CHARLAS[actual].lineas });
  if (r === "/charlas")
    return json({
      charlas: Object.entries(CHARLAS)
        .map(([sessionId, c]) => ({ sessionId, titulo: c.titulo, ultima: c.ultima, actual: sessionId === actual }))
        .sort((a, b) => b.ultima.localeCompare(a.ultima)),
    });
  if (r === "/charla/abrir") {
    if (CHARLAS[body.sessionId]) actual = body.sessionId;
    return json({ sessionId: actual, lineas: CHARLAS[actual].lineas });
  }
  if (r === "/charla/nueva") {
    actual = `demo-${Object.keys(CHARLAS).length + 1}-${Date.now()}`;
    CHARLAS[actual] = { titulo: "charla nueva", ultima: iso(0), lineas: [] };
    pendiente = null;
    return json({ sessionId: actual, lineas: [] });
  }
  if (r === "/llamada") {
    const c = CHARLAS[actual];
    if (!c.lineas.length) c.titulo = String(body.text ?? "").slice(0, 60);
    return sse(String(body.text ?? ""));
  }
  if (r === "/voz/config") return json({ configurada: false });
  if (r === "/avisos") return json({ avisos: [], sinVer: 0, misionTurnos: {} });
  if (r === "/pulse")
    return json({ lines: [], signal: [], counts: { memories: 142, observations: 38, jobs: 2, devices: 1, tools: 4, toolsUp: 4 }, checkedAt: iso(0) });
  if (r === "/movilidad/arribos") return json(R.micro().result);

  // memoria
  if (r === "/memory/entities") return json({ items: ENT.map(entidad), total: ENT.length });
  if (r.startsWith("/memory/entities/")) {
    const e = ENT.find((x) => x.id === decodeURIComponent(r.split("/").pop()!) || x.canonical_name === decodeURIComponent(r.split("/").pop()!));
    if (!e) return json({ error: "no_existe", message: "No está." }, 404);
    return json({ ...entidad(e), observations: e.obs.map((text) => ({ text, mentioned_at: iso(-60 * 24) })) });
  }
  if (r === "/memory/units") {
    const e = ENT.find((x) => x.id === q.get("entity") || x.canonical_name === q.get("entity"));
    return json({ items: e ? unidades(e) : ENT.flatMap(unidades).slice(0, 12) });
  }
  if (r === "/memory/aliases") return json({ items: [] });
  if (r === "/memory/tipos") return json({ tipos: Object.fromEntries(ENT.map((e) => [e.id, e.tipo])) });
  if (r === "/memory/stats") return json({ nodes_by_fact_type: { world: 61, experience: 43, observation: 38 }, total_observations: 38, last_memory_write_at: iso(-3), pending_operations: 0 });
  if (r === "/memory/graph") {
    const nodes = ENT.map((e) => ({ data: { id: e.id, label: e.canonical_name, mentionCount: e.mention_count } }));
    const pares = [["e1", "e6"], ["e2", "e5"], ["e3", "e5"], ["e4", "e8"], ["e2", "e4"], ["e2", "e7"], ["e3", "e7"], ["e1", "e7"]];
    const edges = pares.map(([source, target], i) => ({ data: { source, target, weight: 3 + i, lastCooccurred: iso(-60 * i) } }));
    return json({ nodes, edges, total_entities: nodes.length, total_edges: edges.length });
  }
  if (r === "/memory/recall")
    return json({ results: ENT.slice(0, 3).flatMap(unidades).slice(0, 4), memories: ENT.slice(0, 3).flatMap(unidades).slice(0, 4) });

  // tareas
  if (r === "/misiones") return json({ misiones: MISIONES });
  if (r === "/vigilancias") return json({ vigilancias: VIGS });
  if (r === "/jobs") return json({ jobs: JOBS, schedulerRunning: true });

  // ajustes
  if (r.startsWith("/status")) return json(STATUS());
  if (r === "/devices") return json({ devices: STATUS().devices, secretKeys: { NX_PIN: { label: "PIN de Naranja X", min: 4, max: 6 } } });
  if (r === "/secretary") return json(SECRETARY);
  if (r === "/rules") return json({ items: RULES });
  if (r === "/whatsapp")
    return json({ configured: true, url: "http://puente:8801", reachable: true, estado: "conectado", linked: true, nombre: "Demo", numero: "+54 9 261 555-0100", chats: 214, mensajes: 18_432, qr: null, error: null });
  if (r === "/tools/movilidad/maps") return json({ tieneKey: false });
  if (r === "/informes") return json({ informes: [], corriendo: false });
  if (r.startsWith("/revisiones")) return json({ revisiones: [] });

  if (method !== "GET") return json({ error: "demo", message: "En la demo esto no se guarda." }, 400);
  return json({});
}

// Cartel fijo: que nadie confunda la demo con una consola de verdad.
function cartel() {
  const a = document.createElement("a");
  a.href = "https://github.com/lujangrego99/no-phone-publico";
  a.target = "_blank";
  a.rel = "noopener";
  a.innerHTML = "demo<span> · datos ficticios</span>";
  a.className = "np-demo-cartel";
  const css = document.createElement("style");
  // Abajo a la izquierda en compu (sobre el hueco de la columna de charlas); arriba al medio en el celu.
  css.textContent = `.np-demo-cartel{position:fixed;left:24px;bottom:20px;z-index:9999;padding:4px 12px;border-radius:999px;
border:1px solid #ffb00066;background:#0a0a09e6;color:#ffb000;font:600 13px/1.4 'Atkinson Hyperlegible Next',system-ui,sans-serif;
text-decoration:none;white-space:nowrap}
@media (max-width:760px){.np-demo-cartel{left:50%;bottom:auto;top:14px;transform:translateX(-50%)}.np-demo-cartel span{display:none}}`;
  document.head.appendChild(css);
  document.body.appendChild(a);
}

export function instalarDemo() {
  if (document.body) cartel();
  else addEventListener("DOMContentLoaded", cartel);
  const original = window.fetch.bind(window);
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const u = new URL(url, location.href);
    if (!u.pathname.includes("/api/")) return original(input, init);
    const path = u.pathname.slice(u.pathname.indexOf("/api/")) + u.search;
    let body: Json = {};
    try {
      body = init?.body ? JSON.parse(String(init.body)) : {};
    } catch {
      /* sin cuerpo */
    }
    await espera(120);
    return responder(path, (init?.method ?? "GET").toUpperCase(), body);
  };
}
