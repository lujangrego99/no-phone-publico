// Chat con el secretario, con llamada ahí mismo: escribís y contesta en texto; en llamada, el navegador
// escucha (SpeechRecognition) y habla con Piper (servicio tts local; si falla, speechSynthesis). Gratis y local:
// solo el texto viaja al secretario.
// Una sola conversación (sesión de Hermes) para el chat y la llamada. En llamada el micrófono queda abierto:
// el turno se cierra por silencio REAL (nivel del micrófono, no lo que tarda el reconocedor) y se ve venir en
// un anillo; se lo puede interrumpir hablando y lo que agregás mientras piensa se suma. Pantalla de llamada
// con un círculo que se mueve con tu voz, subtítulo en vivo y aviso hablado cuando usa una herramienta.
import { useEffect, useRef, useState, type FormEvent, type MouseEvent as RMouseEvent, type PointerEvent as RPointerEvent } from "react";
import { Link, useSearchParams } from "react-router";
import { useConsole } from "../App";
import { marcarVistos, useAvisos } from "../avisos";
import { useCaidos } from "../caidos";
import { Icon } from "../components/Icon";
import { Failure } from "../components/kit";
import { Dialog, confirmar } from "../components/ui";
import "../styles/chat.css";
import "../styles/pendientes.css";
import { ToolView, etiqueta, familia, tieneTarjeta, type ToolItem } from "../components/ToolCards";
import { VozRealtime, type VozConfig } from "./vozRealtime";
import { VozAjustes } from "./VozAjustes";

const APP_DE: Record<string, string> = { whatsapp: "WhatsApp", naranjax: "Naranja X", movilidad: "Movilidad", reglas: "reglas", secretario: "reglas" };

type Estado = "colgado" | "escuchando" | "pensando" | "hablando";
// «mision»: el evento que despertó un turno de una misión (un mensaje de Pepín, la hora, plata que entró).
type Linea = { quien: "vos" | "secretario" | "mision"; texto: string; at?: number } | { quien: "herramienta"; tool: ToolItem };
const corteDeTurno = (l: Linea) => l.quien === "vos" || l.quien === "mision";

// Tipos mínimos de Web Speech (no vienen en lib.dom de TS).
type Rec = {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  start(): void;
  abort(): void;
  onresult: ((e: { resultIndex: number; results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }> }) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
};
const RecCtor = (window as unknown as { SpeechRecognition?: new () => Rec; webkitSpeechRecognition?: new () => Rec }).SpeechRecognition ??
  (window as unknown as { webkitSpeechRecognition?: new () => Rec }).webkitSpeechRecognition;

// Lo que dice mientras usa una herramienta, para que no haya silencio muerto (una vez por turno).
const AVISO: Record<string, string> = {
  reglas: "Dale, lo anoto.",
  whatsapp: "Me fijo en WhatsApp.",
  naranjax: "Dejame ver en Naranja X.",
  movilidad: "Ya te lo busco.",
  otra: "Dame un segundo.",
};

// Un «tic» corto: te escuché y lo mando / arrancó la llamada.
let audioCtx: AudioContext | null = null;
function tic(alto = true) {
  try {
    audioCtx ??= new AudioContext();
    const o = audioCtx.createOscillator();
    const g = audioCtx.createGain();
    const t = audioCtx.currentTime;
    o.frequency.setValueAtTime(alto ? 880 : 520, t);
    o.frequency.exponentialRampToValueAtTime(alto ? 620 : 440, t + 0.09);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.12, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.12);
    o.connect(g).connect(audioCtx.destination);
    o.start(t);
    o.stop(t + 0.13);
  } catch {
    /* sin audio: no importa */
  }
}

// En localhost HTTP el navegador trata el origen como seguro y trae randomUUID; en la LAN
// (http://192.168.x.x) no: sin fallback el chat tira al montar y la página queda negra.
function nuevaSesion() {
  if (typeof crypto.randomUUID === "function") return `llamada-${crypto.randomUUID()}`;
  const a = new Uint8Array(16);
  crypto.getRandomValues(a);
  const h = [...a].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `llamada-${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

// Una nota de voz que grabaste va al secretario como «⟦nota de voz grabada para X (N s) — archivo: …⟧»: se ve corta.
const notaDeVoz = (t: string) => t.replace(/^⟦nota de voz grabada para (.+?) \((\d+) s\)[^⟧]*⟧$/, "🎤 nota de voz para $1 ($2 s)");

// **negrita** del modelo → negrita (sin mostrar los asteriscos). Nada más de markdown.
function conNegritas(t: string) {
  return t.split(/(\*\*[^*\n]+\*\*)/g).map((p, i) => (/^\*\*[^*\n]+\*\*$/.test(p) ? <strong key={i}>{p.slice(2, -2)}</strong> : p));
}

// hora de un mensaje: «00:45»; de otro día, «20/10 23:31»
function horaCorta(ms: number) {
  const d = new Date(ms);
  const hm = d.toLocaleTimeString("es-AR", { hour: "2-digit", minute: "2-digit", hour12: false });
  return d.toDateString() === new Date().toDateString() ? hm : `${d.toLocaleDateString("es-AR", { day: "2-digit", month: "2-digit" })} ${hm}`;
}

// «hoy 22:15», «ayer», «lun 20/10»
function cuando(iso: string) {
  const d = new Date(iso);
  const hoy = new Date();
  const dias = Math.round((new Date(hoy.toDateString()).getTime() - new Date(d.toDateString()).getTime()) / 86_400_000);
  const hm = d.toLocaleTimeString("es-AR", { hour: "2-digit", minute: "2-digit", hour12: false });
  if (dias === 0) return `hoy ${hm}`;
  if (dias === 1) return `ayer ${hm}`;
  return d.toLocaleDateString("es-AR", { weekday: "short", day: "2-digit", month: "2-digit" });
}

function vozEs(): SpeechSynthesisVoice | null {
  const vs = speechSynthesis.getVoices().filter((v) => v.lang.toLowerCase().startsWith("es"));
  for (const p of ["es-ar", "es-419", "es-us", "es-mx", "es-es"]) {
    const v = vs.find((x) => x.lang.toLowerCase() === p && /google|natural|online/i.test(x.name)) ?? vs.find((x) => x.lang.toLowerCase() === p);
    if (v) return v;
  }
  return vs[0] ?? null;
}

const corto = (n: string) => n.replace(/^mcp__[a-z0-9_-]+?__/, "");

// Qué se muestra: una OPERACIÓN (mandar un WhatsApp, transferir) es UNA tarjeta que se actualiza: de todos sus
// pasos (buscar destinatario → armar → preview corregido…) se dibuja solo el último, con el final adentro
// (enviado / transferida / cancelado). Los reintentos fallidos se esconden si después salió bien, y las líneas de
// lectura ya terminadas sin tarjeta propia se esconden cuando en ese turno vino algo después. Solo la última
// tarjeta que pide respuesta, posterior a tu último mensaje, tiene botones.
const PASOS: Record<string, string[]> = {
  wa: ["wa_enviar_preview"],
  nx: ["nx_destino_resolver", "nx_transfer_preview", "nx_transfer_armar"],
  rg: ["regla_preparar"],
  ms: ["mision_preparar"],
};
const FINALES: Record<string, string[]> = {
  wa: ["wa_enviar", "wa_enviar_cancelar"],
  nx: ["nx_transfer", "nx_transfer_y_comprobante", "nx_transfer_cancelar"],
  rg: ["regla_guardar"],
};
const flujo = (n: string, tabla: Record<string, string[]>) => Object.keys(tabla).find((k) => tabla[k].includes(corto(n)));

function visibles(lineas: Linea[]) {
  type Herr = Extract<Linea, { quien: "herramienta" }>;
  const ocultas = new Set<number>();
  const envioDe = new Map<number, ToolItem>();
  const abierto: Record<string, number[]> = {}; // flujo → índices de sus pasos en curso
  lineas.forEach((l, i) => {
    if (l.quien !== "herramienta") return;
    const t = l.tool;
    const fallo = t.done && t.result && typeof t.result.error === "string";
    if (fallo && lineas.some((x, j) => j > i && x.quien === "herramienta" && x.tool.name === t.name)) return void ocultas.add(i);
    const paso = flujo(t.name, PASOS);
    const fin = flujo(t.name, FINALES);
    if (paso) {
      if (fallo) return;
      (abierto[paso] ??= []).forEach((j) => ocultas.add(j)); // el paso nuevo reemplaza al anterior
      abierto[paso].push(i);
    } else if (fin && t.done) {
      const pasos = abierto[fin] ?? [];
      const ultimo = pasos.length ? (lineas[pasos[pasos.length - 1]] as Herr).tool : null;
      if (ultimo && ultimo.done && !ultimo.result?.error) {
        ocultas.add(i); // el final lo muestra la tarjeta del último paso
        envioDe.set(pasos[pasos.length - 1], t);
      } else if (ultimo) {
        pasos.forEach((j) => ocultas.add(j)); // el paso se cortó: se muestra el final solo
      }
      abierto[fin] = [];
    }
  });
  // Movilidad: las búsquedas de lugar/parada son pasos para armar el viaje; si en la misma respuesta hay una
  // ruta, un viaje o los micros de una parada, queda solo esa tarjeta (la última).
  const FINAL_MV = /^(como_llegar|viaje_planear|micro_cuando_viene)$/;
  let finTurno = lineas.length;
  for (let i = lineas.length - 1; i >= 0; i--) {
    const l = lineas[i];
    if (corteDeTurno(l)) {
      finTurno = i;
      continue;
    }
    if (l.quien !== "herramienta" || !/^(lugar_buscar|parada_buscar|como_llegar|viaje_planear|micro_cuando_viene)$/.test(corto(l.tool.name))) continue;
    const despues = lineas.slice(i + 1, finTurno);
    if (despues.some((x) => x.quien === "herramienta" && FINAL_MV.test(corto(x.tool.name)) && tieneTarjeta(x.tool))) ocultas.add(i);
  }
  // Líneas de lectura terminadas y sin tarjeta: ruido si en el mismo turno vino algo después.
  lineas.forEach((l, i) => {
    if (l.quien !== "herramienta" || ocultas.has(i) || !l.tool.done || tieneTarjeta(l.tool) || l.tool.result?.error) return;
    const sig = lineas[i + 1];
    if (sig && !corteDeTurno(sig)) ocultas.add(i);
  });
  // La plata de una misión se previsualiza para que el dueño la vea en la propuesta, pero no se manda ahora: si en el
  // mismo turno vino la propuesta de misión, el preview de Naranja X no queda como «¿transfiero?». Lo mismo un borrador
  // de WhatsApp que el secretario armó antes de proponer la misión (el mensaje va dentro de la propuesta), salvo que
  // ese mensaje se haya mandado de verdad.
  lineas.forEach((l, i) => {
    if (l.quien !== "herramienta" || corto(l.tool.name) !== "mision_preparar" || l.tool.result?.estado !== "listo_para_autorizar") return;
    let mandado = false;
    for (let j = i - 1; j >= 0 && !corteDeTurno(lineas[j]); j--) {
      const x = lineas[j];
      if (x.quien !== "herramienta") continue;
      const n = corto(x.tool.name);
      if (/^nx_(transfer_preview|transfer_armar|destino_resolver|transfer_cancelar)$/.test(n)) ocultas.add(j);
      else if (n === "wa_enviar" && x.tool.result?.estado === "enviado") mandado = true;
      else if (n === "wa_enviar_cancelar") ocultas.add(j);
      else if (n === "wa_enviar_preview") {
        if (!mandado) ocultas.add(j);
        mandado = false;
      }
    }
  });
  const ultimoVos = lineas.map(corteDeTurno).lastIndexOf(true);
  const out: { l: Linea; i: number; envio?: ToolItem; accion?: boolean }[] = [];
  let pendiente = -1;
  lineas.forEach((l, i) => {
    if (ocultas.has(i)) return;
    const envio = envioDe.get(i);
    if (l.quien === "herramienta" && flujo((l as Herr).tool.name, PASOS) && !envio && l.tool.done && i > ultimoVos) pendiente = out.length;
    out.push({ l, i, envio });
  });
  if (pendiente >= 0) out[pendiente].accion = true;
  return out;
}

export function Llamada() {
  const { tenant } = useConsole();
  const [estado, setEstado] = useState<Estado>("colgado");
  const [ocupado, setOcupado] = useState(false); // esperando respuesta (chat o llamada)
  const [lineas, setLineas] = useState<Linea[]>([]);
  const lineasRef = useRef(lineas);
  lineasRef.current = lineas;
  const [parcial, setParcial] = useState("");
  const [texto, setTexto] = useState("");
  // «?escribir=…» (desde un vacío de Tareas, por ejemplo): deja el pedido empezado en la caja para que lo completes.
  const [qs, setQs] = useSearchParams();
  useEffect(() => {
    const e = qs.get("escribir");
    if (e === null) return;
    setTexto(e);
    const q = new URLSearchParams(qs);
    q.delete("escribir");
    setQs(q, { replace: true });
    setTimeout(() => {
      const ta = document.querySelector<HTMLTextAreaElement>(".composer textarea");
      if (ta) {
        ta.focus();
        ta.setSelectionRange(ta.value.length, ta.value.length);
      }
    }, 50);
  }, [qs, setQs]);
  const [error, setError] = useState<string | null>(null);
  const [segundos, setSegundos] = useState(0);
  const [mute, setMute] = useState(false);
  const [enEsperaUI, setEnEsperaUI] = useState<string[]>([]);
  // Mientras trabaja, siempre se ve qué hace y hace cuánto (antes: solo «pensando» justo después de tu mensaje).
  const inicioRef = useRef(0);
  const herrDesde = useRef<Record<string, number>>({});
  const ultimoTextoRef = useRef(0);
  const [ahora, setAhora] = useState(Date.now());
  const [diciendoAhora, setDiciendoAhora] = useState("");
  const [enTurno, setEnTurno] = useState(false); // ya dijiste algo en este turno (cambia el texto de ayuda)
  const orb = useRef<HTMLButtonElement | null>(null);

  // Estado vivo para los callbacks del navegador (no esperan a React).
  const vivo = useRef({ enLlamada: false, estado: "colgado" as Estado, session: nuevaSesion(), cola: 0, streamTermino: true });
  const rec = useRef<Rec | null>(null);
  const abort = useRef<AbortController | null>(null);
  const fin = useRef<HTMLDivElement | null>(null);
  const input = useRef<HTMLTextAreaElement | null>(null);
  const ocupadoRef = useRef(false);

  const cambiar = (e: Estado) => {
    vivo.current.estado = e;
    setEstado(e);
  };
  const agregar = (l: Linea) => setLineas((xs) => [...xs, l]);
  const sumarAlUltimo = (t: string) =>
    setLineas((xs) => {
      const last = xs[xs.length - 1];
      if (last?.quien === "secretario") return [...xs.slice(0, -1), { ...last, texto: last.texto + t }];
      return [...xs, { quien: "secretario", texto: t }];
    });
  const terminarTool = (id: string, result: ToolItem["result"]) =>
    setLineas((xs) => xs.map((l) => (l.quien === "herramienta" && l.tool.id === id ? { ...l, tool: { ...l.tool, result, done: true } } : l)));

  useEffect(() => {
    if (!ocupado) return;
    const t = setInterval(() => setAhora(Date.now()), 500);
    return () => clearInterval(t);
  }, [ocupado]);

  // Se pega al final solo si ya estabas abajo: si subiste a leer, no te mueve (aparece «ir al final»).
  const panel = useRef<HTMLDivElement | null>(null);
  const pegado = useRef(true);
  const [lejos, setLejos] = useState(false);
  const alFinal = (suave = false) => {
    const el = panel.current;
    if (!el) return;
    pegado.current = true;
    setLejos(false);
    el.scrollTo({ top: el.scrollHeight, behavior: suave ? "smooth" : "auto" });
  };
  const alScrollear = () => {
    const el = panel.current;
    if (!el) return;
    const cerca = el.scrollHeight - el.scrollTop - el.clientHeight < 96;
    pegado.current = cerca;
    setLejos(!cerca);
  };
  useEffect(() => {
    if ((lineas.length || parcial) && pegado.current) alFinal();
  }, [lineas, parcial]); // eslint-disable-line react-hooks/exhaustive-deps

  const enLlamada = estado !== "colgado";
  useEffect(() => {
    if (!enLlamada) return;
    const t = setInterval(() => setSegundos((s) => s + 1), 1000);
    return () => clearInterval(t);
  }, [enLlamada]);

  useEffect(() => {
    speechSynthesis.getVoices(); // Chrome carga las voces en diferido
    return () => colgar();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Voz natural (Qwen-Omni Realtime): si está configurada, «llamar» usa esa en vez de la del navegador.
  const [vozCfg, setVozCfg] = useState<VozConfig | null>(null);
  const [verVozAjustes, setVerVozAjustes] = useState(false);
  const [conectando, setConectando] = useState(false);
  // Reseña opcional al colgar («¿salió lo que querías?»): alimenta la revisión de la charla. Se va sola si seguís.
  const [resenar, setResenar] = useState<{ sid: string; paso: "pregunta" | "mal" | "gracias" } | null>(null);
  const [resenaTexto, setResenaTexto] = useState("");
  useEffect(() => {
    if (resenar?.paso !== "gracias") return;
    const t = setTimeout(() => setResenar(null), 2500);
    return () => clearTimeout(t);
  }, [resenar]);
  const mandarResena = (sid: string, nota: "bien" | "mal", texto?: string) =>
    fetch(`/api/t/${tenant}/charlas/${encodeURIComponent(sid)}/resena`, {
      method: "POST",
      credentials: "same-origin",
      headers: { "x-np": "1", "content-type": "application/json" },
      body: JSON.stringify({ nota, texto: texto ?? "" }),
    }).catch(() => null);
  const rt = useRef<VozRealtime | null>(null);
  useEffect(() => {
    fetch(`/api/t/${tenant}/voz/config`, { credentials: "same-origin" })
      .then((r) => (r.ok ? r.json() : null))
      .then((c: VozConfig | null) => setVozCfg(c))
      .catch(() => setVozCfg(null));
  }, [tenant]);

  const llamarNatural = () => {
    setError(null);
    vivo.current.enLlamada = true;
    // Pulsar para hablar: el micrófono arranca cerrado y se abre mientras mantenés espacio (o el botón).
    oido.current.mute = true;
    setMute(true);
    setSegundos(0);
    setConectando(true);
    cambiar("pensando");
    const v = new VozRealtime(tenant, () => vivo.current.session, {
      estado: (e) => {
        if (e === "conectando") return setConectando(true); // al empezar o al reconectar
        setConectando(false);
        cambiar(e);
        const ocup = e === "pensando";
        setOcupado(ocup);
        ocupadoRef.current = ocup;
        if (ocup) inicioRef.current = Date.now();
      },
      parcial: (t) => setParcial(t),
      vos: (t) => agregar({ quien: "vos", texto: t, at: Date.now() }),
      diciendo: (t) => setDiciendoAhora(t),
      secretario: (t, tools) => {
        setLineas((xs) => [...xs, ...tools.map((tool) => ({ quien: "herramienta" as const, tool })), ...(t ? [{ quien: "secretario" as const, texto: t, at: Date.now() }] : [])]);
        traerLista();
      },
      // Mientras conecta no hay voz de Qwen: los avisos van con la del sistema (sin red, al toque).
      aviso: (t) => decirConSistema(t, () => {}),
      error: (m) => {
        setError(m);
        // Que se oiga también (puede no ver la pantalla). Después del colgar, que corta lo que esté sonando.
        setTimeout(() => decirConSistema(m, () => {}), 0);
      },
      cortada: () => {
        rt.current = null;
        colgar();
      },
    });
    rt.current = v;
    v.silenciar(true);
    tic(false);
    // El círculo se mueve con tu voz (y con la de Qwen cuando habla), igual que en la llamada común.
    const m = medidor.current;
    cancelAnimationFrame(m.raf);
    const latir = () => {
      if (rt.current !== v) return void orb.current?.style.setProperty("--nivel", "0");
      orb.current?.style.setProperty("--nivel", v.nivel().toFixed(3));
      m.raf = requestAnimationFrame(latir);
    };
    latir();
    v.empezar();
  };

  // Lo único de «estado» que se muestra: lo que está caído y le impide hacer cosas (una línea fina con su arreglo y
  // × para sacarla de acá; sigue contando en rojo al lado de la campana hasta que se arregla).
  const { enChat: caido, descartar: descartarCaido } = useCaidos(tenant);

  // Avisos de vigilancias pedidas en ESTA charla: fijos arriba del chat hasta que los marcás como vistos.
  const { avisos: todosAvisos, misionTurnos } = useAvisos(tenant);
  const avisos = todosAvisos.filter((a) => !a.visto && a.charla && a.charla === vivo.current.session);
  // Si tenés abierta la charla del aviso y estás viendo el final, ya lo leíste en la conversación (como WhatsApp al
  // abrir un chat): se marca visto solo, en vez de quedar fijo arriba repitiendo lo que dice abajo. En llamada no:
  // ahí se dice en voz alta y lo marca ese camino.
  const idsSinVer = avisos.map((a) => a.id).join(",");
  useEffect(() => {
    if (!idsSinVer || !tenant || enLlamada) return;
    const t = setTimeout(() => {
      if (document.visibilityState === "visible" && pegado.current) marcarVistos(tenant, idsSinVer.split(","));
    }, 2500);
    return () => clearTimeout(t);
  }, [idsSinVer, tenant, enLlamada]);
  // En llamada, los avisos nuevos de esta charla (una misión te consulta o terminó) se dicen en voz alta: puede que
  // no estés mirando la pantalla. Lo que ya estaba al empezar la llamada no se repite.
  const dichos = useRef<Set<string> | null>(null);
  useEffect(() => {
    if (!enLlamada) return void (dichos.current = null);
    if (!dichos.current) return void (dichos.current = new Set(avisos.map((a) => a.id)));
    for (const a of avisos) {
      if (dichos.current.has(a.id)) continue;
      dichos.current.add(a.id);
      const t = `Aviso: ${a.texto.replace(/^[^\p{L}\p{N}]+/u, "")}`;
      if (rt.current) rt.current.anunciar(t).catch(() => null);
      else decir(t);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [avisos, enLlamada]);
  // Una misión trabajó en ESTA charla (le contestó a alguien, cerró algo): se trae el historial al día.
  const turnoMision = misionTurnos[vivo.current.session] ?? 0;
  useEffect(() => {
    if (!turnoMision || ocupado) return;
    fetch(`/api/t/${tenant}/charla`, { credentials: "same-origin" })
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { sessionId: string; lineas: Linea[] } | null) => d && d.sessionId === vivo.current.session && setLineas(d.lineas ?? []))
      .catch(() => null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [turnoMision]);

  // La charla sigue entre recargas (y dispositivos): se trae la actual con su historial.
  const [cargando, setCargando] = useState(true);
  useEffect(() => {
    let vigente = true;
    setCargando(true);
    fetch(`/api/t/${tenant}/charla`, { credentials: "same-origin" })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`Error ${r.status}`))))
      .then((d: { sessionId: string; lineas: Linea[] }) => {
        if (!vigente) return;
        vivo.current.session = d.sessionId;
        pegado.current = true;
        setLineas(d.lineas ?? []);
      })
      .catch(() => vigente && setError("No pude traer la charla anterior; empezás una nueva."))
      .finally(() => vigente && setCargando(false));
    return () => {
      vigente = false;
    };
  }, [tenant]);

  // La bandeja abrió otra charla («ir a la charla»): se trae sin recargar la página.
  useEffect(() => {
    const traer = () => {
      if (vivo.current.enLlamada) return;
      setCargando(true);
      fetch(`/api/t/${tenant}/charla`, { credentials: "same-origin" })
        .then((r) => (r.ok ? r.json() : null))
        .then((d: { sessionId: string; lineas: Linea[] } | null) => {
          if (!d) return;
          vivo.current.session = d.sessionId;
          pegado.current = true;
          setLineas(d.lineas ?? []);
          setError(null);
        })
        .catch(() => null)
        .finally(() => {
          setCargando(false);
          traerLista();
        });
    };
    window.addEventListener("np-charla", traer);
    return () => window.removeEventListener("np-charla", traer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tenant]);

  // ---------- oído: micrófono abierto toda la llamada; el turno se cierra por silencio ----------
  const oido = useRef({
    consumido: 0, // resultados de esta sesión de reconocimiento ya usados en turnos anteriores
    arrastre: "", // lo dicho antes de que Chrome reiniciara el reconocimiento
    turno: "", // lo que va diciendo en este turno
    largo: 0, // resultados vistos en esta sesión de reconocimiento
    ultimoResultado: 0,
    espera: 1300,
    narro: false,
    mute: false,
    diciendo: "", // lo que el secretario está diciendo (para no tomarse su propia voz como interrupción)
    ultimaPregunta: "", // para juntar lo que agrega mientras piensa
    respondio: false,
    usoHerramienta: false, // en este turno ya arrancó una herramienta: no se corta (podría ser un envío o una transferencia)
    enEspera: [] as string[], // lo que dijiste mientras él trabajaba: se manda al terminar
    ultimoTexto: "",
    ultimoTextoAt: 0,
    callado: false, // lo interrumpiste: la respuesta sigue (queda escrita) pero ya no se dice
  });

  const palabras = (t: string) =>
    t
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[^\p{L}\p{N}\s]/gu, "")
      .split(/\s+/)
      .filter(Boolean);
  // ¿Lo que escuchó es el eco del parlante? (mayoría de palabras que él mismo está diciendo)
  const esEco = (t: string) => {
    const ws = palabras(t);
    if (!ws.length) return true;
    const dicho = new Set(palabras(oido.current.diciendo));
    return ws.filter((w) => dicho.has(w)).length / ws.length >= 0.6;
  };
  // El micrófono a veces agarra el final de lo que él dijo y lo pega adelante de lo tuyo: se saca.
  const sinEcoAlPrincipio = (t: string) => {
    const dicho = new Set(palabras(oido.current.diciendo));
    if (!dicho.size) return t;
    const ws = t.split(/\s+/);
    let i = 0;
    while (i < ws.length && palabras(ws[i]).every((w) => dicho.has(w))) i++;
    return i >= 2 ? ws.slice(i).join(" ").trim() : t; // con una sola palabra no alcanza para decir que es eco
  };
  // Si la frase queda colgada en un conector, espera más: está por seguir.
  const SIGUE = /\b(y|o|que|pero|porque|entonces|eh+|em+|este|tipo|o sea|ponele|a|de|con|en|para|el|la|los|las|un|una|mi|tu)$/i;
  const esperaPara = (t: string) => (SIGUE.test(t.trim().replace(/[.,…]+$/, "")) ? 2400 : 1300);

  // ---------- medidor: nivel real del micrófono (mueve el círculo y decide cuándo te callaste) ----------
  const medidor = useRef({ stream: null as MediaStream | null, raf: 0, tick: 0 as ReturnType<typeof setInterval> | 0, piso: 0.01, ultimaVoz: 0 });

  const prenderMedidor = async () => {
    const m = medidor.current;
    try {
      m.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    } catch {
      setError("El navegador no dejó usar el micrófono. Permitilo en el candado de la barra de direcciones.");
      colgar();
      return;
    }
    audioCtx ??= new AudioContext();
    const an = audioCtx.createAnalyser();
    an.fftSize = 1024;
    audioCtx.createMediaStreamSource(m.stream).connect(an);
    const buf = new Float32Array(an.fftSize);
    const loop = () => {
      an.getFloatTimeDomainData(buf);
      let sum = 0;
      for (const x of buf) sum += x * x;
      const rms = Math.sqrt(sum / buf.length);
      const voz = rms > Math.max(0.012, m.piso * 3);
      if (voz) m.ultimaVoz = performance.now();
      else m.piso = m.piso * 0.97 + rms * 0.03; // ruido de fondo, se adapta solo
      let nivel = oido.current.mute ? 0 : Math.min(1, rms * 9);
      const an2 = boca.current.an;
      if (vivo.current.estado === "hablando" && boca.current.fuente && an2) {
        const b2 = new Float32Array(an2.fftSize);
        an2.getFloatTimeDomainData(b2);
        let s2 = 0;
        for (const x of b2) s2 += x * x;
        nivel = Math.min(1, Math.sqrt(s2 / b2.length) * 6);
      }
      orb.current?.style.setProperty("--nivel", nivel.toFixed(3));
      m.raf = requestAnimationFrame(loop);
    };
    loop();
    // Reloj de turno: si dijiste algo y hace `espera` ms que no hay voz ni texto nuevo, se manda. El anillo lo anticipa.
    m.tick = setInterval(() => {
      const o = oido.current;
      const hay = (o.arrastre + o.turno).trim();
      const e = vivo.current.estado;
      if (!hay || o.mute || !(e === "escuchando" || e === "pensando")) {
        orb.current?.style.setProperty("--prog", "0");
        return;
      }
      const quieto = performance.now() - Math.max(m.ultimaVoz, o.ultimoResultado);
      const prog = Math.max(0, Math.min(1, (quieto - 250) / (o.espera - 250)));
      orb.current?.style.setProperty("--prog", prog.toFixed(3));
      if (quieto >= o.espera) {
        o.consumido = o.largo;
        cerrarTurno();
      }
    }, 80);
  };

  const apagarMedidor = () => {
    const m = medidor.current;
    cancelAnimationFrame(m.raf);
    if (m.tick) clearInterval(m.tick);
    m.tick = 0;
    m.stream?.getTracks().forEach((t) => t.stop());
    m.stream = null;
  };

  const cerrarTurno = () => {
    const o = oido.current;
    const t = (o.arrastre + " " + o.turno).replace(/\s+/g, " ").trim();
    o.arrastre = "";
    o.turno = "";
    setParcial("");
    setEnTurno(false);
    orb.current?.style.setProperty("--prog", "0");
    if (!t || !vivo.current.enLlamada) return;
    tic();
    preguntar(t, true);
  };

  const prenderOido = () => {
    if (!vivo.current.enLlamada || !RecCtor || rec.current) return;
    const r = new RecCtor();
    r.lang = "es-AR";
    r.interimResults = true;
    r.continuous = true;
    oido.current.consumido = 0;
    r.onresult = (e) => {
      const o = oido.current;
      o.largo = e.results.length;
      if (o.mute) {
        o.consumido = e.results.length;
        return;
      }
      let t = "";
      for (let i = o.consumido; i < e.results.length; i++) t += " " + e.results[i][0].transcript;
      t = t.replace(/\s+/g, " ").trim();
      if (!t) return;
      // Mientras habla él: si es su eco, se descarta; si sos vos, se calla y te escucha.
      if (vivo.current.estado === "hablando") {
        if (esEco(t) || palabras(t).length < 2) {
          o.consumido = e.results.length;
          return;
        }
        callarlo();
      }
      t = sinEcoAlPrincipio(t);
      if (!t) return;
      o.turno = t;
      o.ultimoResultado = performance.now();
      o.espera = esperaPara(t);
      setParcial((o.arrastre + " " + t).trim());
      setEnTurno(true);
      if (vivo.current.estado !== "pensando") cambiar("escuchando");
    };
    r.onerror = (e) => {
      if (e.error === "not-allowed" || e.error === "service-not-allowed") {
        setError("El navegador no dejó usar el micrófono. Permitilo en el candado de la barra de direcciones.");
        colgar();
      }
    };
    r.onend = () => {
      // Chrome corta el reconocimiento cada tanto: se rearma sin perder lo que venías diciendo.
      if (rec.current === r) rec.current = null;
      const o = oido.current;
      if (o.turno) {
        o.arrastre = (o.arrastre + " " + o.turno).trim();
        o.turno = "";
      }
      if (vivo.current.enLlamada) setTimeout(prenderOido, 150);
    };
    rec.current = r;
    try {
      r.start();
    } catch {
      rec.current = null;
    }
  };

  // ---------- boca: voz de Piper (servicio tts), en cola; si falla, la del sistema ----------
  // Cada frase se pide apenas llega (así la siguiente ya está lista cuando termina la anterior) y suenan en orden.
  const boca = useRef({ cola: [] as { texto: string; audio: Promise<AudioBuffer | null> }[], fuente: null as AudioBufferSourceNode | null, sonando: false, gen: 0, an: null as AnalyserNode | null });

  const pedirAudio = async (texto: string): Promise<AudioBuffer | null> => {
    try {
      const r = await fetch(`/api/t/${tenant}/voz`, {
        method: "POST",
        credentials: "same-origin",
        headers: { "x-np": "1", "content-type": "application/json" },
        body: JSON.stringify({ texto }),
      });
      if (!r.ok) return null;
      audioCtx ??= new AudioContext();
      return await audioCtx.decodeAudioData(await r.arrayBuffer());
    } catch {
      return null;
    }
  };

  const terminoFrase = () => {
    vivo.current.cola = Math.max(0, vivo.current.cola - 1);
    if (vivo.current.cola === 0 && vivo.current.streamTermino && vivo.current.estado === "hablando") {
      cambiar("escuchando");
      setDiciendoAhora("");
      setTimeout(() => (oido.current.diciendo = ""), 3000); // el eco tarda en llegar (a veces viene pegado a lo tuyo)
    }
  };

  const decirConSistema = (texto: string, listo: () => void) => {
    const u = new SpeechSynthesisUtterance(texto);
    const v = vozEs();
    if (v) u.voice = v;
    u.lang = v?.lang ?? "es-AR";
    u.rate = 1.05;
    u.onend = u.onerror = listo;
    speechSynthesis.speak(u);
  };

  const sonarSiguiente = async () => {
    const b = boca.current;
    if (b.sonando) return;
    const item = b.cola.shift();
    if (!item) return;
    b.sonando = true;
    const gen = b.gen;
    const buf = await item.audio;
    if (gen !== b.gen) return; // lo callaron mientras se generaba
    setDiciendoAhora(item.texto);
    const listo = () => {
      if (gen !== b.gen) return;
      b.fuente = null;
      b.sonando = false;
      terminoFrase();
      sonarSiguiente();
    };
    if (!buf || !audioCtx) return decirConSistema(item.texto, listo);
    const src = audioCtx.createBufferSource();
    src.buffer = buf;
    b.an ??= audioCtx.createAnalyser();
    b.an.fftSize = 512;
    src.connect(b.an);
    b.an.connect(audioCtx.destination);
    src.onended = listo;
    b.fuente = src;
    src.start();
  };

  const cortarVoz = () => {
    const b = boca.current;
    b.gen++;
    b.cola = [];
    b.sonando = false;
    try {
      b.fuente?.stop();
    } catch {
      /* ya terminó */
    }
    b.fuente = null;
    speechSynthesis.cancel();
  };
  const hablandoAhora = () => boca.current.sonando || boca.current.cola.length > 0 || speechSynthesis.speaking;

  const decir = (t: string) => {
    const limpio = t.replace(/[*_`#>]/g, "").trim();
    if (!limpio || !vivo.current.enLlamada) return;
    vivo.current.cola++;
    oido.current.diciendo = (oido.current.diciendo + " " + limpio).slice(-600);
    cambiar("hablando");
    boca.current.cola.push({ texto: limpio, audio: pedirAudio(limpio) });
    sonarSiguiente();
  };

  // Te interrumpe / lo interrumpís: se calla y deja de leer lo que faltaba.
  // No corta la respuesta (termina y queda escrita, aunque esté usando herramientas): solo deja de decirla.
  const callarlo = () => {
    vivo.current.cola = 0;
    oido.current.callado = true;
    cortarVoz();
    cambiar("escuchando");
  };

  // Manda un mensaje (escrito o dicho). En llamada, la respuesta además se dice en voz alta.
  const preguntar = async (t: string, hablado = false) => {
    const o = oido.current;
    // Respuesta en curso que ya usa herramientas: NO se corta. Lo nuevo se manda cuando termine.
    // El mismo mensaje dos veces seguidas (doble toque, doble Enter): el segundo no va.
    if (o.enEspera.includes(t) || (t === o.ultimoTexto && Date.now() - o.ultimoTextoAt < 4000)) return;
    o.ultimoTexto = t;
    o.ultimoTextoAt = Date.now();
    // Llamada con voz natural: lo que tocás o escribís va por esa voz (si no, contestaba Piper encima de Qwen).
    if (rt.current) return rt.current.escribir(t);
    if (ocupadoRef.current && o.usoHerramienta) {
      o.enEspera.push(t); // se manda al terminar la respuesta en curso; mientras, se ve «en espera»
      setEnEsperaUI([...o.enEspera]);
      return;
    }
    // Agregaste algo antes de que contestara (y antes de que usara nada): se junta y se pregunta todo junto.
    const agrega = hablado && ocupadoRef.current && !o.respondio && o.ultimaPregunta;
    const pregunta = agrega ? `${o.ultimaPregunta} ${t}` : t;
    abort.current?.abort();
    cortarVoz();
    if (agrega) {
      setLineas((xs) => {
        const i = xs.map((x) => x.quien).lastIndexOf("vos");
        return i < 0 ? [...xs, { quien: "vos", texto: pregunta }] : [...xs.slice(0, i), { quien: "vos", texto: pregunta }];
      });
    } else agregar({ quien: "vos", texto: t, at: Date.now() });
    o.ultimaPregunta = pregunta;
    o.respondio = false;
    o.narro = false;
    o.usoHerramienta = false;
    o.callado = false;
    let primerTexto = true;
    let tramoConTexto = false; // hubo texto desde la última herramienta
    setParcial("");
    setError(null);
    setOcupado(true);
    ocupadoRef.current = true;
    inicioRef.current = Date.now();
    ultimoTextoRef.current = 0;
    if (vivo.current.enLlamada) cambiar("pensando");
    vivo.current.streamTermino = false;
    vivo.current.cola = 0;
    const ctrl = new AbortController();
    abort.current = ctrl;
    let buffer = ""; // texto todavía sin decir (se dice por frase)
    const soltarFrases = (todo: boolean) => {
      const re = todo ? /[\s\S]+/ : /[\s\S]*?[.!?…:;\n](?=\s|$)/;
      for (;;) {
        const m = buffer.match(re);
        if (!m || !m[0].trim()) break;
        buffer = buffer.slice(m[0].length);
        decir(m[0]);
        if (todo) break;
      }
    };
    try {
      const res = await fetch(`/api/t/${tenant}/llamada`, {
        method: "POST",
        credentials: "same-origin",
        headers: { "x-np": "1", "content-type": "application/json" },
        body: JSON.stringify({ text: pregunta, sessionId: vivo.current.session, voz: vivo.current.enLlamada }),
        signal: ctrl.signal,
      });
      if (!res.ok || !res.body) {
        const d = await res.json().catch(() => null);
        throw new Error(d?.message ?? `Error ${res.status}`);
      }
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let sse = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        sse += dec.decode(value, { stream: true });
        let corte: number;
        while ((corte = sse.indexOf("\n\n")) >= 0) {
          const frame = sse.slice(0, corte);
          sse = sse.slice(corte + 2);
          const ev = /^event: *(.+)$/m.exec(frame)?.[1]?.trim();
          const data = frame
            .split("\n")
            .filter((l) => l.startsWith("data:"))
            .map((l) => l.slice(5).trim())
            .join("\n");
          if (!data) continue;
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          let j: any;
          try {
            j = JSON.parse(data);
          } catch {
            continue;
          }
          if (ctrl.signal.aborted) break;
          if (ev === "tool") {
            o.usoHerramienta = true;
            // Lo que escribió justo antes de usar una herramienta es narración («primero miro el saldo…»):
            // se saca, así queda solo la respuesta. En voz tampoco se dice lo que faltaba de esa frase.
            if (tramoConTexto) {
              setLineas((xs) => (xs[xs.length - 1]?.quien === "secretario" ? xs.slice(0, -1) : xs));
              buffer = "";
              primerTexto = true;
              tramoConTexto = false;
            }
            if (vivo.current.enLlamada && !o.respondio && !o.narro && !o.callado) {
              o.narro = true;
              decir(AVISO[familia(String(j.name))]);
            }
            herrDesde.current[String(j.id)] = Date.now();
            agregar({ quien: "herramienta", tool: { id: String(j.id), name: String(j.name), args: j.args ?? {}, done: false } });
          } else if (ev === "tool_done") {
            terminarTool(String(j.id), j.result ?? null);
          } else if (ev === "error") {
            setError(String(j.message ?? "El secretario falló."));
          } else if (ev === "delta" && typeof j.text === "string") {
            o.respondio = true;
            tramoConTexto = true;
            ultimoTextoRef.current = Date.now();
            if (primerTexto) agregar({ quien: "secretario", texto: j.text, at: Date.now() });
            else sumarAlUltimo(j.text);
            primerTexto = false;
            if (!o.callado) {
              buffer += j.text;
              soltarFrases(false);
            }
          }
        }
      }
      if (!ctrl.signal.aborted && !o.callado) soltarFrases(true);
    } catch (e) {
      if (ctrl.signal.aborted) return;
      setError((e as Error).message);
    } finally {
      // Lo que quedó sin terminar (se cortó la conexión): que no quede «preparando…» para siempre.
      setLineas((xs) =>
        xs.map((l) => (l.quien === "herramienta" && !l.tool.done ? { ...l, tool: { ...l.tool, done: true, result: { error: "interrumpida", mensaje: "se cortó antes de terminar" } } } : l)),
      );
      if (abort.current === ctrl) {
        vivo.current.streamTermino = true;
        setOcupado(false);
        ocupadoRef.current = false;
        if (vivo.current.enLlamada && vivo.current.cola === 0 && !hablandoAhora()) cambiar("escuchando");
      }
    }
    traerLista(); // la charla sube en la lista (y una nueva toma su título)
    // Lo que dijiste mientras trabajaba, ahora sí (todo junto, como un mensaje).
    if (abort.current === ctrl && o.enEspera.length) {
      setEnEsperaUI([]);
      const junto = o.enEspera.splice(0).join(" ");
      o.ultimoTexto = ""; // no es un duplicado: es lo que esperaba
      preguntar(junto, true);
    }
  };

  const enviar = (e?: FormEvent) => {
    e?.preventDefault();
    const t = texto.trim();
    if (!t) return;
    setTexto("");
    if (input.current) input.current.style.height = "";
    if (resenar?.paso !== "mal") setResenar(null); // seguiste: la reseña se va sola
    pegado.current = true; // lo que mandás siempre se ve
    preguntar(t);
    input.current?.focus();
  };

  const llamar = () => {
    setResenar(null);
    if (vozCfg?.configurada) return llamarNatural();
    setError(null);
    if (!RecCtor) {
      setError("Este navegador no reconoce voz. Abrí la consola en Chrome o Edge.");
      return;
    }
    vivo.current.enLlamada = true;
    vivo.current.cola = 0;
    vivo.current.streamTermino = true;
    oido.current = { ...oido.current, arrastre: "", turno: "", diciendo: "", respondio: true, mute: true };
    setMute(true); // pulsar para hablar
    setSegundos(0);
    cambiar("escuchando");
    tic(false);
    prenderMedidor();
    decir("Hola, ¿qué necesitás?");
    prenderOido();
  };

  const colgar = () => {
    if (vivo.current.enLlamada && lineasRef.current.some((l) => l.quien === "vos")) {
      setResenaTexto("");
      setResenar({ sid: vivo.current.session, paso: "pregunta" });
    }
    vivo.current.enLlamada = false;
    if (rt.current) {
      const v = rt.current;
      rt.current = null;
      v.cortar();
      setConectando(false);
      setOcupado(false);
      ocupadoRef.current = false;
    }
    const o = oido.current;
    o.turno = o.arrastre = "";
    apagarMedidor();
    setDiciendoAhora("");
    setEnTurno(false);
    rec.current?.abort();
    rec.current = null;
    cortarVoz();
    vivo.current.cola = 0;
    cambiar("colgado");
    setParcial("");
  };

  // ---------- charlas anteriores ----------
  type Charla = { sessionId: string; titulo: string | null; ultima: string; actual: boolean };
  const [lista, setLista] = useState<Charla[] | null>(null);
  const [verLista, setVerLista] = useState(false);
  const [listaFallo, setListaFallo] = useState(false);
  const traerLista = () =>
    fetch(`/api/t/${tenant}/charlas`, { credentials: "same-origin" })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((d: { charlas: Charla[] }) => {
        setLista(d.charlas ?? []);
        setListaFallo(false);
      })
      .catch(() => setListaFallo(true)); // no es «no hay charlas»: no se pudo traer
  const abrirLista = () => {
    setVerLista(true);
    traerLista();
  };
  useEffect(() => {
    traerLista();
  }, [tenant]); // eslint-disable-line react-hooks/exhaustive-deps
  const abrir = async (c: Charla) => {
    setVerLista(false);
    if (c.actual) return;
    colgar();
    abort.current?.abort();
    setOcupado(false);
    ocupadoRef.current = false;
    setCargando(true);
    setLineas([]);
    try {
      const r = await fetch(`/api/t/${tenant}/charla/abrir`, {
        method: "POST",
        credentials: "same-origin",
        headers: { "x-np": "1", "content-type": "application/json" },
        body: JSON.stringify({ sessionId: c.sessionId }),
      });
      const d = (await r.json()) as { sessionId: string; lineas: Linea[] };
      vivo.current.session = d.sessionId;
      pegado.current = true;
      setLineas(d.lineas ?? []);
    } catch {
      setError("No pude abrir esa charla.");
    } finally {
      setCargando(false);
      traerLista();
    }
  };

  const nueva = async (modo?: "conocer") => {
    let retomada = false;
    colgar();
    abort.current?.abort();
    setOcupado(false);
    ocupadoRef.current = false;
    setLineas([]);
    setError(null);
    try {
      const r = await fetch(`/api/t/${tenant}/charla/nueva`, {
        method: "POST",
        credentials: "same-origin",
        headers: { "x-np": "1", "content-type": "application/json" },
        body: JSON.stringify(modo ? { modo } : {}),
      });
      const d = (await r.json()) as { sessionId: string; lineas?: Linea[]; retomada?: boolean };
      vivo.current.session = d.sessionId;
      if (d.lineas?.length) {
        pegado.current = true;
        setLineas(d.lineas);
      }
      retomada = !!d.retomada;
    } catch {
      vivo.current.session = nuevaSesion(); // sin servidor: al menos no se mezcla con la anterior
    }
    setVerLista(false);
    traerLista();
    // «Conocerme»: arranca él, preguntando. Es una sola charla que sigue: si ya existía, se retoma donde quedó.
    if (modo === "conocer" && vivo.current.session.startsWith("llamada-conocer-")) preguntar(retomada ? "Sigamos donde quedamos." : "Quiero que me conozcas.");
  };

  // Tocar la pantalla mientras habla: se calla.
  const cortar = () => {
    if (vivo.current.estado !== "hablando") return;
    if (rt.current) rt.current.callarlo();
    else callarlo();
  };
  // Pulsar para hablar (espacio o mantener el botón/círculo): solo te escucha mientras lo mantenés. Así no toma lo que
  // dicen otros alrededor. Al soltar se deja una cola corta para no cortar la última sílaba.
  const ptt = useRef({ apretado: false, soltarT: 0 as ReturnType<typeof setTimeout> | 0 });
  const hablar = (on: boolean) => {
    if (!vivo.current.enLlamada) return;
    const p = ptt.current;
    if (on === p.apretado) return;
    p.apretado = on;
    if (p.soltarT) clearTimeout(p.soltarT);
    p.soltarT = 0;
    if (on) {
      if (vivo.current.estado === "hablando") cortar(); // apretar mientras habla = cortarlo
      oido.current.mute = false;
      setMute(false);
      rt.current?.silenciar(false);
      return;
    }
    p.soltarT = setTimeout(() => {
      p.soltarT = 0;
      oido.current.mute = true;
      setMute(true);
      rt.current?.silenciar(true);
      // Voz del navegador: se manda ya lo que dijiste (sin esperar el silencio).
      if (!rt.current) {
        const o = oido.current;
        if ((o.arrastre + o.turno).trim()) {
          o.consumido = o.largo;
          cerrarTurno();
        }
      }
    }, rt.current ? 300 : 700);
  };
  const hablarRef = useRef(hablar);
  hablarRef.current = hablar;
  useEffect(() => {
    if (!enLlamada) return;
    const escribiendo = (el: EventTarget | null) =>
      el instanceof HTMLElement && (el.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName));
    const abajo = (e: KeyboardEvent) => {
      if (e.code !== "Space" || escribiendo(e.target)) return;
      e.preventDefault(); // que no haga scroll ni «clic» en el botón enfocado
      if (!e.repeat) hablarRef.current(true);
    };
    const arriba = (e: KeyboardEvent) => {
      if (e.code !== "Space" || escribiendo(e.target)) return;
      e.preventDefault();
      hablarRef.current(false);
    };
    const soltar = () => hablarRef.current(false); // si se va el foco con la tecla apretada
    window.addEventListener("keydown", abajo);
    window.addEventListener("keyup", arriba);
    window.addEventListener("blur", soltar);
    return () => {
      window.removeEventListener("keydown", abajo);
      window.removeEventListener("keyup", arriba);
      window.removeEventListener("blur", soltar);
    };
  }, [enLlamada]);
  const apretar = {
    onPointerDown: (e: RPointerEvent) => {
      e.currentTarget.setPointerCapture?.(e.pointerId);
      hablar(true);
    },
    onPointerUp: () => hablar(false),
    onPointerCancel: () => hablar(false),
    onContextMenu: (e: RMouseEvent) => e.preventDefault(), // mantener apretado en el celu no abre el menú
  };
  const vis = visibles(lineas);
  // Lo que espera tu respuesta (mandar, transferir, guardar, «¿es esta persona?»): sale del chat y queda fijo
  // a la derecha (desktop) o arriba de la caja de texto (celu). Lo informativo sigue en el chat.
  const pend = ocupado ? undefined : vis.find((x) => x.accion && x.l.quien === "herramienta");
  const pendTool = pend && pend.l.quien === "herramienta" ? pend.l.tool : null;
  // Abierto de entrada: con un pendiente a la vista, «mandalo» queda a un toque (antes eran dos: abrir y tocar).
  const [pendAbierto, setPendAbierto] = useState(true);
  const pendId = pendTool?.id;
  useEffect(() => {
    if (pendId) setPendAbierto(true);
  }, [pendId]);
  // Qué espera, en una frase (no lo que estaba haciendo).
  const resumenPend = (t: ToolItem) => {
    const r = (t.result ?? {}) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
    const n = corto(t.name);
    if (n === "wa_enviar_preview") return `mensaje a ${r.destinatario?.nombre ?? r.destinatario?.numero ?? "alguien"}`;
    if (n === "nx_transfer_preview" || n === "nx_transfer_armar")
      return `transferencia de $${Number(r.monto ?? 0).toLocaleString("es-AR")} a ${r.destinatario?.titular ?? r.destinatario?.etiqueta ?? "alguien"}`;
    if (n === "nx_destino_resolver") return `¿es ${r.destinatario?.titular ?? "esta persona"}?`;
    if (n === "regla_preparar") return `regla «${r.regla?.nombre ?? ""}»`;
    if (n === "mision_preparar") return `misión «${r.mision?.objetivo ?? ""}»`;
    return etiqueta(t.name);
  };
  const tarjetaPend = pendTool ? <ToolView t={pendTool} envio={pend!.envio} onSay={(t) => preguntar(t)} /> : null;
  // Mientras sigue trabajando, un preview (mensaje, transferencia, misión…) de este turno puede no ser la decisión final
  // (pasó: mostraba «¿Le mando?» y a los segundos lo reemplazaba la propuesta de misión). Hasta que termine, una línea.
  const desdeVos = lineas.map(corteDeTurno).lastIndexOf(true);
  const armando = (t: ToolItem, i: number) => ocupado && i > desdeVos && !!flujo(t.name, PASOS);
  const ayuda = conectando
    ? "conectando la voz…"
    : mute
    ? estado === "hablando"
      ? "hablando · mantené espacio para cortarlo y hablar"
      : estado === "pensando"
        ? "pensando · mantené espacio si querés agregar algo"
        : "mantené espacio (o el botón) para hablar"
    : estado === "hablando"
      ? "hablando · hablale encima o tocá para cortarlo"
      : estado === "pensando"
        ? enTurno
          ? "te sigo escuchando…"
          : oido.current.enEspera.length
            ? "te escuché, termino esto y sigo"
            : "pensando"
        : enTurno
          ? "seguí, o hacé una pausa y lo mando"
          : "te escucho";

  // Qué está haciendo ahora: la herramienta que corre, o «pensando». Mientras escribe (texto hace <1,5 s), nada.
  const enCurso = [...lineas].reverse().find((l) => l.quien === "herramienta" && !l.tool.done) as Extract<Linea, { quien: "herramienta" }> | undefined;
  const actividad = enCurso ? `${APP_DE[familia(enCurso.tool.name)] ?? "herramienta"} · ${etiqueta(enCurso.tool.name)}` : "pensando";
  const escribiendo = !enCurso && ahora - ultimoTextoRef.current < 1500;
  const segs = Math.max(0, Math.round((ahora - inicioRef.current) / 1000));

  // ¿Tu último mensaje quedó sin respuesta (se cortó, error, se colgó)? → «reintentar».
  const iVos = lineas.map((l) => l.quien).lastIndexOf("vos");
  const cortado =
    !ocupado && iVos >= 0 && !lineas.slice(iVos + 1).some((l) => l.quien === "secretario") ? (lineas[iVos] as { texto: string }).texto : null;
  // Si lo cortado estaba mandando o transfiriendo, reintentar sin mirar podría hacerlo dos veces.
  const delicado = cortado
    ? lineas
        .slice(iVos + 1)
        .map((l) => (l.quien === "herramienta" ? corto(l.tool.name) : ""))
        .find((n) => /^(nx_transfer|nx_transfer_y_comprobante|wa_enviar)$/.test(n))
    : undefined;
  const reintentar = async () => {
    if (!cortado) return;
    if (
      delicado &&
      !(await confirmar({
        titulo: delicado.startsWith("nx_") ? "Se cortó mientras transfería" : "Se cortó mientras mandaba el WhatsApp",
        texto: delicado.startsWith("nx_")
          ? "Fijate en Naranja X si la plata salió antes de reintentar: si salió, reintentar la manda otra vez."
          : "Fijate si el mensaje llegó antes de reintentar: si llegó, reintentar lo manda otra vez.",
        si: "reintentar igual",
        no: "no, dejalo",
        peligro: true,
      }))
    )
      return;
    oido.current.ultimoTexto = ""; // es a propósito: no es un duplicado
    setError(null);
    preguntar(cortado);
  };
  // Una herramienta que tarda: aclarar que sigue (el celu es lento) para que no parezca colgado.
  const tardeHerr = enCurso ? Math.round((ahora - (herrDesde.current[enCurso.tool.id] ?? ahora)) / 1000) : 0;
  const aclaracion =
    tardeHerr > 20 ? (familia(enCurso!.tool.name) === "naranjax" ? "el celu es lento, sigue" : "sigue, a veces tarda") : segs > 45 ? "sigue trabajando" : "";

  const reloj = `${String(Math.floor(segundos / 60)).padStart(2, "0")}:${String(segundos % 60).padStart(2, "0")}`;

  const actual = lista?.find((c) => c.actual) ?? null;
  const [filtroCharlas, setFiltroCharlas] = useState("");
  const listaFiltrada = (lista ?? []).filter((c) => !filtroCharlas.trim() || (c.titulo ?? "charla nueva").toLowerCase().includes(filtroCharlas.trim().toLowerCase()));
  const grupos: { nombre: string; charlas: Charla[] }[] = [];
  for (const c of listaFiltrada) {
    const g = grupoDe(c.ultima);
    const ultimo = grupos[grupos.length - 1];
    if (ultimo?.nombre === g) ultimo.charlas.push(c);
    else grupos.push({ nombre: g, charlas: [c] });
  }
  const listaCharlas = (
    <>
      <div className="charlas-acciones">
        <button className="btn charlas-nueva" type="button" onClick={() => nueva()}>
          <Icon name="plus" size={16} />
          nueva charla
        </button>
        <button
          className="btn quiet charlas-conocer"
          type="button"
          onClick={() => nueva("conocer")}
          title="Una charla para que te conozca: te pregunta por tu vida y tu gente, y los vincula con tus contactos de WhatsApp"
        >
          <Icon name="user" size={16} />
          que me conozca
        </button>
        {(lista?.length ?? 0) > 8 && (
          <label className="charlas-buscar">
            <span className="sr-only">buscar charla</span>
            <Icon name="search" size={14} />
            <input className="input" type="search" value={filtroCharlas} onChange={(e) => setFiltroCharlas(e.target.value)} placeholder="buscar charla" />
          </label>
        )}
      </div>
      {listaFallo && !lista?.length ? (
        <div className="charlas-vacio">
          <p className="meta">No pude traer las charlas.</p>
          <button className="btn small" type="button" onClick={() => void traerLista()}>
            <Icon name="reload" size={14} />
            reintentar
          </button>
        </div>
      ) : !lista ? (
        <div className="charlas-cargando" aria-busy="true">
          <span className="skeleton" style={{ width: "80%" }} />
          <span className="skeleton" style={{ width: "60%" }} />
          <span className="skeleton" style={{ width: "70%" }} />
        </div>
      ) : lista.length === 0 ? (
        <p className="meta charlas-vacio">Todavía no hay charlas.</p>
      ) : listaFiltrada.length === 0 ? (
        <p className="meta charlas-vacio">Ninguna charla con «{filtroCharlas}».</p>
      ) : (
        <div className="charlas-grupos">
          {grupos.map((g) => (
            <section key={g.nombre} className="charlas-grupo" aria-label={g.nombre}>
              <h3 className="charlas-grupo-nombre">{g.nombre}</h3>
              <ol>
                {g.charlas.map((c) => (
                  <li key={c.sessionId}>
                    <button type="button" className="charla" data-actual={c.actual} onClick={() => abrir(c)} aria-current={c.actual ? "true" : undefined}>
                      <span className="charla-titulo">{c.titulo ?? "charla nueva"}</span>
                      <span className="charla-cuando">{c.actual ? "abierta" : horaDe(c.ultima)}</span>
                    </button>
                  </li>
                ))}
              </ol>
            </section>
          ))}
        </div>
      )}
    </>
  );

  const vacia = !cargando && lineas.length === 0 && !parcial;
  return (
    <div className="call-layout" data-llamada={enLlamada} data-pendiente={!!tarjetaPend && !enLlamada}>
      {/* Charlas: columna fija a la izquierda; en pantallas angostas, en una hoja que se abre con el botón de menú. */}
      <aside className="charlas-panel" aria-label="charlas">
        {listaCharlas}
      </aside>
      <Dialog open={verLista} onClose={() => setVerLista(false)} title="charlas" className="dlg-charlas">
        {listaCharlas}
      </Dialog>

      <div className="call">
        <header className="chat-head">
          <button className="btn quiet icon-only solo-angosto" type="button" onClick={abrirLista} aria-label="ver charlas" title="charlas">
            <Icon name="menu" size={20} />
          </button>
          <h1 className="chat-titulo" title={actual?.titulo ?? undefined}>
            {actual?.titulo ?? "charla nueva"}
          </h1>
          <div className="chat-head-acciones">
            <button className="btn quiet icon-only solo-angosto" type="button" onClick={() => nueva()} aria-label="nueva charla" title="nueva charla">
              <Icon name="plus" size={20} />
            </button>
            {!enLlamada && (
              <button
                className="btn quiet chat-voz"
                type="button"
                onClick={() => setVerVozAjustes(true)}
                aria-haspopup="dialog"
                aria-label="ajustes de la voz de la llamada"
                title={vozCfg?.configurada ? `voz de la llamada: ${vozCfg.voz}` : "configurar la voz natural de la llamada"}
              >
                <Icon name="sliders" size={16} />
                <span className="chat-voz-txt">voz</span>
              </button>
            )}
          </div>
        </header>

        {(avisos.length > 0 || caido.length > 0) && (
          <div className="avisos-fijos" role="status">
            {caido.slice(0, 2).map((l) => (
              <div key={l.id} className="aviso-caido">
                <Icon name="alert" size={14} />
                <span className="aviso-caido-texto">{l.title}</span>
                <Link className="aviso-caido-accion" to={l.to}>
                  {l.action}
                </Link>
                <button className="aviso-caido-x" type="button" onClick={() => descartarCaido(l.id)} aria-label={`descartar: ${l.title}`} title="descartar">
                  <Icon name="close" size={14} />
                </button>
              </div>
            ))}
            {avisos.slice(0, 3).map((a) => (
              <div key={a.id} className="aviso-fijo" data-tono="info">
                <Icon name="bell" size={16} />
                <span className="aviso-texto">{a.texto.replace(/^[^\p{L}\p{N}«"(¿¡]+/u, "")}</span>
                <span className="meta">{new Date(a.at).toLocaleTimeString("es-AR", { hour: "2-digit", minute: "2-digit", hour12: false })}</span>
                <button className="btn small quiet" type="button" onClick={() => marcarVistos(tenant, [a.id])}>
                  <Icon name="check" size={14} />
                  visto
                </button>
              </div>
            ))}
          </div>
        )}

        <div className="call-panel" data-estado={estado} onClick={cortar} ref={panel} onScroll={alScrollear}>
          {cargando && lineas.length === 0 ? (
            <div className="chat-cargando" aria-busy="true" aria-label="trayendo la charla">
              <span className="skeleton" style={{ width: "40%", marginLeft: "auto" }} />
              <span className="skeleton" style={{ width: "70%" }} />
              <span className="skeleton" style={{ width: "55%" }} />
            </div>
          ) : vacia && actual?.titulo ? (
            <div className="chat-vacio">
              <p className="chat-vacio-titulo">Esta charla quedó sin respuesta.</p>
              <p className="meta">Se cortó o se recargó antes de que contestara. Escribí abajo para seguir.</p>
            </div>
          ) : vacia ? (
            <div className="chat-vacio">
              <p className="chat-vacio-titulo">{enLlamada ? "Te escucho." : "¿En qué te ayudo?"}</p>
              <p className="meta">
                {enLlamada ? "Mantené apretado el botón (o la barra espaciadora) y hablá." : "Escribile abajo, o tocá «llamar» y hablale."}
              </p>
              {!enLlamada && (
                <div className="sugerencias" aria-label="ideas para empezar">
                  {SUGERENCIAS.map((t) => (
                    <button
                      key={t}
                      type="button"
                      className="sugerencia"
                      onClick={(e) => {
                        e.stopPropagation();
                        setTexto(t);
                        requestAnimationFrame(() => input.current?.focus());
                      }}
                    >
                      {t}
                    </button>
                  ))}
                </div>
              )}
            </div>
          ) : (
            <ol className="call-lines" aria-label="mensajes">
              {vis.map(({ l, i, envio, accion }) =>
                l.quien === "herramienta" ? (
                  <li key={l.tool.id} className="msg msg-herramienta">
                    {pendTool && l.tool.id === pendTool.id ? (
                      <p className="msg-fijado">
                        <Icon name="clock" size={14} />
                        <span>
                          {resumenPend(l.tool)} · <span className="solo-ancho">esperando tu respuesta, a la derecha</span>
                          <span className="solo-angosto-inline">esperando tu respuesta, arriba de la caja de texto</span>
                        </span>
                      </p>
                    ) : armando(l.tool, i) ? (
                      <p className="msg-armando">
                        <Icon name="clock" size={14} />
                        <span>armando: {resumenPend(l.tool)}…</span>
                      </p>
                    ) : (
                      <ToolView t={l.tool} envio={envio} onSay={accion && !ocupado ? (t) => preguntar(t) : undefined} />
                    )}
                  </li>
                ) : l.quien === "mision" ? (
                  <li key={i} className="msg msg-mision">
                    <div className="msg-evento">
                      <span className="chip" data-tono="info">
                        misión
                      </span>
                      <span className="msg-evento-texto">{l.texto}</span>
                      {l.at ? <time className="msg-hora">{horaCorta(l.at)}</time> : null}
                    </div>
                  </li>
                ) : (
                  <li key={i} className={`msg msg-${l.quien}`}>
                    <span className="sr-only">{l.quien === "vos" ? "vos:" : "secretario:"}</span>
                    <div className="msg-burbuja">{conNegritas(notaDeVoz(l.texto))}</div>
                    {l.at ? <time className="msg-hora">{horaCorta(l.at)}</time> : null}
                  </li>
                ),
              )}
              {parcial && (
                <li className="msg msg-vos msg-parcial">
                  <div className="msg-burbuja">{parcial}</div>
                </li>
              )}
              {enEsperaUI.map((t, i) => (
                <li key={`espera-${i}`} className="msg msg-vos msg-espera">
                  <div className="msg-burbuja">{t}</div>
                  <span className="msg-hora">en espera: lo mando cuando termine esto</span>
                </li>
              ))}
              {cortado && (
                <li className="msg msg-cortado">
                  <div className="aviso-fijo" data-tono="bad">
                    <Icon name="alert" size={16} />
                    <span className="aviso-texto">Tu último mensaje quedó sin respuesta.</span>
                    <button
                      className="btn small"
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        void reintentar();
                      }}
                    >
                      <Icon name="reload" size={14} />
                      reintentar
                    </button>
                  </div>
                </li>
              )}
              {ocupado && !escribiendo && (
                <li className="msg msg-pensando" aria-live="polite">
                  <span className="typing" aria-hidden="true">
                    <i />
                    <i />
                    <i />
                  </span>
                  <span className="msg-pensando-texto">
                    {actividad}
                    <span className="meta">
                      {" "}
                      · {segs} s{aclaracion ? ` · ${aclaracion}` : ""}
                    </span>
                  </span>
                </li>
              )}
            </ol>
          )}
          {error && <Failure error={error} />}
          {resenar && !enLlamada && (
            <div className="resena" role="group" aria-label="reseña de la llamada (opcional)">
              {resenar.paso === "pregunta" && (
                <>
                  <span>¿Salió lo que querías?</span>
                  <button className="btn small" type="button" onClick={() => (void mandarResena(resenar.sid, "bien"), setResenar({ ...resenar, paso: "gracias" }))}>
                    sí
                  </button>
                  <button className="btn small" type="button" onClick={() => (void mandarResena(resenar.sid, "mal"), setResenar({ ...resenar, paso: "mal" }))}>
                    no
                  </button>
                  <button className="btn small quiet icon-only" type="button" aria-label="cerrar" onClick={() => setResenar(null)}>
                    <Icon name="close" size={14} />
                  </button>
                </>
              )}
              {resenar.paso === "mal" && (
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    if (resenaTexto.trim()) void mandarResena(resenar.sid, "mal", resenaTexto.trim());
                    setResenar({ ...resenar, paso: "gracias" });
                  }}
                >
                  <input
                    className="input"
                    autoFocus
                    value={resenaTexto}
                    onChange={(e) => setResenaTexto(e.target.value)}
                    placeholder="¿qué esperabas? (opcional)"
                    maxLength={1000}
                  />
                  <button className="btn small" type="submit">
                    listo
                  </button>
                  <button className="btn small quiet icon-only" type="button" aria-label="cerrar" onClick={() => setResenar(null)}>
                    <Icon name="close" size={14} />
                  </button>
                </form>
              )}
              {resenar.paso === "gracias" && <span className="meta">Anotado, gracias.</span>}
            </div>
          )}
          <div ref={fin} className="call-end" />
        </div>
        <div className="call-bar" data-estado={estado}>
          {/* «ir al final» va pegado arriba de la barra (que crece con «te espera»): antes, a altura fija, tapaba los botones. */}
          {lejos && (
            <button className="btn small ir-final" type="button" onClick={() => alFinal(true)} aria-label="ir al último mensaje">
              <Icon name="chevronDown" size={16} />
              ir al final
            </button>
          )}
          {/* Estado vivo para el lector de pantalla y a la vista mientras trabaja. */}
          <p className="trabajo" data-ocupado={ocupado} aria-live="polite">
            {ocupado ? (
              <>
                <span className="trabajo-punto" aria-hidden="true" />
                <span className="trabajo-que">{escribiendo ? "escribiendo" : actividad}</span>
                <span className="meta">
                  · {segs} s{aclaracion ? ` · ${aclaracion}` : ""}
                </span>
              </>
            ) : (
              <span className="sr-only">libre</span>
            )}
          </p>
          {tarjetaPend && (
            <div className="pend-movil" data-abierto={pendAbierto}>
              <button className="pend-movil-boton" type="button" onClick={() => setPendAbierto(!pendAbierto)} aria-expanded={pendAbierto}>
                <span className="chip" data-tono="wait">
                  te espera
                </span>
                <span className="pend-movil-que">{resumenPend(pendTool!)}</span>
                <Icon name={pendAbierto ? "chevronDown" : "chevronRight"} size={16} />
              </button>
              {pendAbierto && tarjetaPend}
            </div>
          )}
          <form className="composer" onSubmit={enviar}>
            <label className="sr-only" htmlFor="chat-texto">
              mensaje
            </label>
            <textarea
              id="chat-texto"
              ref={input}
              className="composer-texto"
              rows={1}
              value={texto}
              onChange={(e) => {
                setTexto(e.target.value);
                const el = e.target;
                el.style.height = "";
                el.style.height = `${Math.min(el.scrollHeight, 168)}px`;
              }}
              onKeyDown={(e) => {
                // Enter manda (Mayús+Enter: renglón nuevo). En el celu, Enter es renglón y se manda con el botón.
                if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing && !matchMedia("(pointer: coarse)").matches) {
                  e.preventDefault();
                  enviar();
                }
              }}
              placeholder={enLlamada ? "o escribile…" : "Escribile al secretario…"}
              autoComplete="off"
              enterKeyHint="send"
              maxLength={2000}
            />
            <div className="composer-acciones">
              {!enLlamada && (
                <button className="btn composer-llamar" type="button" onClick={llamar} aria-label="llamar al secretario" title={vozCfg?.configurada ? `llamar con voz natural (${vozCfg.voz})` : "llamar con la voz del navegador"}>
                  <Icon name="phone" size={16} />
                  <span>llamar</span>
                </button>
              )}
              <button className="btn primary icon-only composer-enviar" type="submit" disabled={!texto.trim()} aria-label="enviar" title="enviar (Enter)">
                <Icon name="send" size={18} />
              </button>
            </div>
          </form>
        </div>
      </div>

      <Dialog
        open={verVozAjustes && !enLlamada}
        onClose={() => setVerVozAjustes(false)}
        title="Voz de la llamada"
        description="Qwen-Omni de Alibaba solo escucha y habla; el que piensa y hace las cosas sigue siendo tu secretario. Sin key, la llamada usa la voz del navegador."
      >
        <VozAjustes tenant={tenant} cfg={vozCfg} onCambio={setVozCfg} onCerrar={() => setVerVozAjustes(false)} />
      </Dialog>

      {tarjetaPend && !enLlamada && (
        <aside className="pend-panel" aria-label="esperando tu respuesta">
          <p className="pend-titulo">
            <span className="chip" data-tono="wait">
              te espera
            </span>
            {resumenPend(pendTool!)}
          </p>
          {tarjetaPend}
        </aside>
      )}
      {enLlamada && (
        <section className="cs" data-estado={estado} data-mute={mute} aria-label="llamada con el secretario">
          <div className="cs-top">
            <span className="cs-quien">
              <span className="cs-vivo" aria-hidden="true" />
              tu secretario
            </span>
            <span className="num">{reloj}</span>
          </div>
          <button ref={orb} type="button" className="cs-orb" {...apretar} aria-label="mantené apretado para hablar">
            <svg className="cs-ring" viewBox="0 0 120 120" aria-hidden="true">
              <circle cx="60" cy="60" r="56" />
            </svg>
            <span className="cs-core" />
          </button>
          <p className="cs-state" aria-live="polite">
            {ayuda}
          </p>
          <p className="cs-caption">{estado === "hablando" ? diciendoAhora : parcial || " "}</p>
          {tarjetaPend && <div className="cs-tool">{tarjetaPend}</div>}
          {error && <Failure error={error} />}
          {rt.current && vozCfg?.configurada && (
            <label className="cs-voz">
              <span className="meta">voz</span>
              <select
                className="select"
                value={vozCfg.voz}
                onChange={async (e) => {
                  const v = e.target.value;
                  rt.current?.cambiarVoz(v);
                  const r = await fetch(`/api/t/${tenant}/voz/config`, {
                    method: "PUT",
                    credentials: "same-origin",
                    headers: { "x-np": "1", "content-type": "application/json" },
                    body: JSON.stringify({ voz: v }),
                  }).catch(() => null);
                  if (r?.ok) setVozCfg((await r.json()) as VozConfig);
                }}
              >
                {[...new Set([vozCfg.voz, ...(vozCfg.favoritas?.length ? vozCfg.favoritas : vozCfg.voces.filter((x) => x.grupo === "castellano").map((x) => x.id))])].map((id) => (
                  <option key={id} value={id}>
                    {id}
                  </option>
                ))}
              </select>
            </label>
          )}
          <div className="cs-actions">
            <button className="btn cs-hablar" type="button" {...apretar} aria-pressed={!mute}>
              <Icon name="mic" size={18} />
              {mute ? "mantené para hablar" : "te escucho…"}
            </button>
            <button className="btn danger cs-colgar" type="button" onClick={colgar}>
              <Icon name="close" size={18} />
              colgar
            </button>
          </div>
        </section>
      )}
    </div>
  );
}

const SUGERENCIAS = ["¿Quién me escribió hoy?", "¿Cuánto tengo en Naranja X?", "¿Qué tengo programado?", "¿Cómo llego al centro?"];

// Para agrupar la lista de charlas: hoy · ayer · esta semana · antes.
function grupoDe(iso: string) {
  const d = new Date(iso);
  const dias = Math.round((new Date(new Date().toDateString()).getTime() - new Date(d.toDateString()).getTime()) / 86_400_000);
  if (dias <= 0) return "hoy";
  if (dias === 1) return "ayer";
  if (dias < 7) return "esta semana";
  return "antes";
}
// Hora dentro del grupo: hoy/ayer → «04:23»; más viejas → «lun 20/10».
function horaDe(iso: string) {
  const d = new Date(iso);
  const g = grupoDe(iso);
  if (g === "hoy" || g === "ayer") return d.toLocaleTimeString("es-AR", { hour: "2-digit", minute: "2-digit", hour12: false });
  return d.toLocaleDateString("es-AR", { weekday: "short", day: "2-digit", month: "2-digit" });
}
