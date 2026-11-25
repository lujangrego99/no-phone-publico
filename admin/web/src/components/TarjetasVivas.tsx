// Tarjetas interactivas: movilidad que se recalcula ahí mismo (desde dónde salís, actualizar arribos, cuenta
// regresiva) y audios de WhatsApp que se escuchan. Lo de leer va directo al conector (sin el modelo, sin gastar
// turnos); lo que es un pedido («avisame cuándo salir») va al secretario con onSay.
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useConsole } from "../App";
import { api } from "../api";
import { llamadaEnCurso } from "../pages/vozRealtime";
import "../styles/tarjetas-vivas.css";

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

// ---------- tiempo ----------

function useAhora(cadaMs = 30_000) {
  const [t, setT] = useState(() => Date.now());
  useEffect(() => {
    const i = window.setInterval(() => setT(Date.now()), cadaMs);
    return () => window.clearInterval(i);
  }, [cadaMs]);
  return t;
}

/** Minutos hasta la salida. Con la hora absoluta del servidor (sali_epoch): no depende del reloj ni de la zona
 *  horaria del aparato. Sin ella (tarjetas viejas), no se adivina. */
function minutosHasta(epoch: number | undefined, ahora: number): number | null {
  return typeof epoch === "number" ? Math.round((epoch * 1000 - ahora) / 60000) : null;
}

function cuandoSalir(min: number | null): { texto: string; tono: "ok" | "ya" | "tarde" } | null {
  if (min === null) return null;
  if (min > 1) return { texto: `salí en ${min} min`, tono: "ok" };
  if (min >= -1) return { texto: "salí ya", tono: "ya" };
  return { texto: "ya pasó · actualizá", tono: "tarde" };
}

// ---------- movilidad: viaje ----------

const LUGAR_CORTO = ["casa", "laburo", "trabajo", "facu", "facultad", "oficina", "gimnasio", "depto"];

function etiquetaLugar(l: { nombre: string; apodos?: string[] }): string {
  const ap = (l.apodos ?? []).map((a) => a.toLowerCase());
  return LUGAR_CORTO.find((x) => ap.includes(x) || l.nombre.toLowerCase() === x) ?? l.nombre;
}

function Lineas({ lineas }: { lineas?: string }) {
  const ls = (lineas ?? "").split(" + ").filter(Boolean);
  if (!ls.length || lineas === "caminando") return <span className="mv-line mv-line-pie">a pie</span>;
  return (
    <span className="tv-lineas">
      {ls.map((l, i) => (
        <span key={i} className="mv-line">
          {l}
        </span>
      ))}
    </span>
  );
}

function Paso({ texto }: { texto: string }) {
  const tipo = /^Caminá/.test(texto) ? "pie" : /^(Tomá|Transbordá)/.test(texto) ? "sube" : /^Bajate/.test(texto) ? "baja" : "otro";
  const linea = tipo === "sube" ? /el ([0-9A-Z]+)/.exec(texto)?.[1] : null;
  return (
    <li className={`tv-paso tv-paso-${tipo}`}>
      <span className="tv-paso-ico" aria-hidden="true">
        {tipo === "pie" ? "🚶" : tipo === "baja" ? "⤓" : linea ? <span className="mv-line">{linea}</span> : "•"}
      </span>
      <span>{texto.replace(/ \[GPS[^\]]*\]/, " · en vivo").replace(/ \[horario[^\]]*\]/, " · horario")}</span>
    </li>
  );
}

export function MvViaje({ r: inicial, destino, onSay, Mapa }: { r: Json; destino?: string; onSay?: (t: string) => void; Mapa: (p: { r: Json }) => ReactNode }) {
  const { tenant } = useConsole();
  const [r, setR] = useState<Json>(inicial);
  const [abierta, setAbierta] = useState<number | null>(0);
  const [cargando, setCargando] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lugares, setLugares] = useState<{ etiqueta: string; nombre: string }[]>([]);
  const [verMapa, setVerMapa] = useState(() => typeof window !== "undefined" && window.matchMedia("(min-width: 721px)").matches);
  const ahora = useAhora();
  const opciones: Json[] = r.opciones ?? [];
  const o = r.origen ?? {};
  const d = r.destino ?? {};
  const dest = destino || d.direccion || d.nombre;

  useEffect(() => {
    let vivo = true;
    api
      .get<{ lugares: { nombre: string; apodos?: string[] }[] }>(`/t/${tenant}/movilidad/lugares`)
      .then((x) => vivo && setLugares((x.lugares ?? []).map((l) => ({ etiqueta: etiquetaLugar(l), nombre: l.nombre }))))
      .catch(() => null);
    return () => {
      vivo = false;
    };
  }, [tenant]);

  const replan = async (origen: string | null, motivo: string) => {
    if (!dest) return;
    setCargando(motivo);
    setError(null);
    try {
      const x = await api.post<Json>(`/t/${tenant}/movilidad/viaje`, { destino: dest, origen });
      if (x.error) setError(x.detalle ?? "No pude recalcular.");
      else {
        setR(x);
        setAbierta(0);
      }
    } catch {
      setError("Movilidad no responde ahora.");
    } finally {
      setCargando(null);
    }
  };

  const origenActual = (o.nombre ?? "").toLowerCase();
  const otros = lugares.filter((l) => !origenActual.includes(l.etiqueta) && !origenActual.includes(l.nombre.toLowerCase()));
  const rec = opciones[0];

  return (
    <div className="tv-viaje" aria-busy={!!cargando}>
      <div className="tv-desde">
        <span>
          <small>desde</small> <strong>{o.nombre ?? "?"}</strong>
          {o.supuesto && (
            <span className="tv-supuesto" title={o.supuesto}>
              supuesto
            </span>
          )}
        </span>
        <span>
          <small>hasta</small> <strong>{d.nombre ?? "?"}</strong>
        </span>
      </div>
      {o.supuesto && <p className="tv-por">Supuse que salís de ahí porque {o.supuesto}.</p>}
      {(otros.length > 0 || o.supuesto) && (
        <div className="tv-chips" role="group" aria-label="¿Salís de otro lado?">
          <span className="tv-chips-t">¿salís de otro lado?</span>
          {otros.map((l) => (
            <button key={l.nombre} type="button" className="tv-chip" disabled={!!cargando} onClick={() => replan(l.etiqueta, l.etiqueta)}>
              {cargando === l.etiqueta ? "…" : l.etiqueta}
            </button>
          ))}
        </div>
      )}

      {verMapa ? <Mapa r={r} /> : null}

      <ol className="tv-opts">
        {opciones.map((op, i) => {
          const s = cuandoSalir(minutosHasta(op.sali_epoch, ahora));
          const open = abierta === i;
          return (
            <li key={i} className={`tv-opt${op.recomendada ? " tv-rec" : ""}${open ? " tv-open" : ""}`}>
              <button type="button" className="tv-opt-btn" aria-expanded={open} onClick={() => setAbierta(open ? null : i)}>
                <Lineas lineas={op.lineas} />
                <span className="tv-opt-main">
                  <span className="tv-opt-horas">
                    salís {op.sali} · llegás <strong>{op.llegas}</strong>
                  </span>
                  <small>
                    {op.duracion_min} min{op.caminata_min ? ` · ${op.caminata_min} a pie` : ""}
                    {op.recomendada ? " · recomendada" : ""}
                  </small>
                </span>
                {s && <span className={`tv-cuando tv-${s.tono}`}>{s.texto}</span>}
              </button>
              {open && (
                <div className="tv-detalle">
                  <ol className="tv-pasos">
                    {(op.pasos ?? []).map((p: string, k: number) => (
                      <Paso key={k} texto={p} />
                    ))}
                  </ol>
                  {(op.avisos ?? []).map((a: string, k: number) => (
                    <p key={k} className="tv-aviso">
                      ⚠ {a}
                    </p>
                  ))}
                </div>
              )}
            </li>
          );
        })}
        {!opciones.length && <li className="tc-status">{r.sugerencia ?? "No encontré micros útiles."}</li>}
      </ol>
      {r.sugerencia && opciones.length > 0 && <p className="tv-por">{r.sugerencia}</p>}
      {error && <p className="tv-aviso" role="alert">{error}</p>}

      <div className="tv-acciones">
        {rec && onSay && rec.lineas !== "caminando" && (
          <button type="button" className="tc-btn tc-btn-ok" onClick={() => onSay(`Avisame cuando tenga que salir para tomar el ${rec.lineas} (sale ${rec.sali}) hacia ${d.nombre ?? dest}.`)}>
            avisame cuándo salir
          </button>
        )}
        <button type="button" className="tc-btn" disabled={!!cargando} onClick={() => replan(o.supuesto ? null : (o.nombre ?? null), "actualizar")}>
          {cargando === "actualizar" ? "actualizando…" : "actualizar"}
        </button>
        <button type="button" className="tc-btn" aria-pressed={verMapa} onClick={() => setVerMapa((v) => !v)}>
          {verMapa ? "ocultar mapa" : "ver mapa"}
        </button>
      </div>
      <p className="tc-status">consultado {r.consultado}</p>
    </div>
  );
}

// ---------- movilidad: arribos en una parada ----------

export function MvArribosVivo({ r: inicial }: { r: Json }) {
  const { tenant } = useConsole();
  const [r, setR] = useState<Json>(inicial);
  // Desde cuándo valen los «en N min»: la hora del servidor al consultar (si no viene, al montar).
  const [at, setAt] = useState(() => (typeof inicial.consultado_epoch === "number" ? inicial.consultado_epoch * 1000 : Date.now()));
  const [cargando, setCargando] = useState(false);
  const ahora = useAhora(15_000);
  const p = r.parada ?? {};
  const arr: Json[] = (r.arribos ?? []).slice(0, 6);
  const pasados = Math.floor((ahora - at) / 60000);

  const actualizar = async () => {
    if (!p.codigo) return;
    setCargando(true);
    try {
      const x = await api.get<Json>(`/t/${tenant}/movilidad/arribos?parada=${encodeURIComponent(p.codigo)}`);
      if (!x.error) {
        setR(x);
        setAt(typeof x.consultado_epoch === "number" ? x.consultado_epoch * 1000 : Date.now());
      }
    } finally {
      setCargando(false);
    }
  };

  return (
    <>
      <ul className="mv-arr">
        {arr.map((a, i) => {
          const en = typeof a.en_min === "number" ? a.en_min - pasados : null;
          return (
            <li key={i}>
              <span className="mv-line">{a.linea}</span>
              <span className="mv-sign">{a.cartel}</span>
              <span className="mv-when">
                {en === null ? a.hora : en <= 0 ? "ya" : `${en} min`}
                {a.tiempo_real && <span className="mv-live" title="en vivo (GPS)" aria-label="en vivo" />}
              </span>
            </li>
          );
        })}
        {!arr.length && <li className="tc-status">{r.nota ?? "no viene nada por ahora"}</li>}
      </ul>
      <div className="tv-acciones">
        <button type="button" className="tc-btn" disabled={cargando} onClick={actualizar}>
          {cargando ? "actualizando…" : "actualizar"}
        </button>
        <span className="tc-status">consultado {r.consultado}{pasados > 0 ? ` (hace ${pasados} min)` : ""}</span>
      </div>
    </>
  );
}

// ---------- WhatsApp: audio que se escucha ----------

const dur = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
const VELOCIDADES = [1, 1.5, 2];

export function AudioWa({ chat, id, duracion, de }: { chat?: string; id?: string; duracion?: number; de?: string }) {
  const { tenant } = useConsole();
  const ref = useRef<HTMLAudioElement | null>(null);
  const [estado, setEstado] = useState<"quieto" | "cargando" | "sonando" | "pausa" | "error">("quieto");
  const [pos, setPos] = useState(0);
  const [total, setTotal] = useState(duracion ?? 0);
  const [vel, setVel] = useState(1);

  useEffect(() => () => ref.current?.pause(), []);
  if (!chat || !id) return null;

  const tocar = () => {
    let a = ref.current;
    if (!a) {
      a = new Audio(`/api/t/${tenant}/wa/audio?chat=${encodeURIComponent(chat)}&id=${encodeURIComponent(id)}`);
      a.preload = "auto";
      a.onloadedmetadata = () => Number.isFinite(a!.duration) && setTotal(a!.duration);
      a.ontimeupdate = () => setPos(a!.currentTime);
      a.onplaying = () => setEstado("sonando");
      a.onpause = () => setEstado((e) => (e === "error" ? e : "pausa"));
      a.onended = () => {
        setEstado("quieto");
        setPos(0);
      };
      a.onerror = () => setEstado("error");
      ref.current = a;
    }
    a.playbackRate = vel;
    if (estado === "sonando") a.pause();
    else {
      setEstado((e) => (e === "pausa" ? e : "cargando"));
      a.play().catch(() => setEstado("error"));
    }
  };

  const cambiarVel = () => {
    const v = VELOCIDADES[(VELOCIDADES.indexOf(vel) + 1) % VELOCIDADES.length];
    setVel(v);
    if (ref.current) ref.current.playbackRate = v;
  };

  const pct = total ? Math.min(100, (pos / total) * 100) : 0;
  const etiqueta = estado === "sonando" ? "pausar audio" : `escuchar audio${de ? ` de ${de}` : ""}${total ? ` (${dur(total)})` : ""}`;
  return (
    <span className="tv-audio">
      <button type="button" className="tv-play" aria-label={etiqueta} onClick={tocar} disabled={estado === "cargando"}>
        {estado === "sonando" ? "❚❚" : estado === "cargando" ? "…" : "▶"}
      </button>
      <span
        className="tv-barra"
        role="slider"
        aria-label="posición del audio"
        aria-valuemin={0}
        aria-valuemax={Math.round(total)}
        aria-valuenow={Math.round(pos)}
        tabIndex={-1}
        onClick={(e) => {
          const a = ref.current;
          if (!a || !total) return;
          const b = (e.currentTarget as HTMLElement).getBoundingClientRect();
          a.currentTime = ((e.clientX - b.left) / b.width) * total;
        }}
      >
        <span style={{ width: `${pct}%` }} />
      </span>
      <span className="tv-tiempo">{estado === "error" ? "no se pudo" : total ? dur(estado === "quieto" ? total : pos) : ""}</span>
      <button type="button" className="tv-vel" aria-label={`velocidad ${vel}x`} onClick={cambiarVel}>
        {vel}×
      </button>
    </span>
  );
}


// ---------- WhatsApp: grabar una nota de voz (en el chat; en una llamada graba sola después del tono) ----------

export function GrabarNota({ r, onSay }: { r: Json; onSay?: (t: string) => void }) {
  const { tenant } = useConsole();
  const para = r.destinatario?.nombre ?? r.destino ?? "el contacto";
  const [estado, setEstado] = useState<"listo" | "grabando" | "grabada" | "subiendo" | "enviada" | "error">("listo");
  const [seg, setSeg] = useState(0);
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const rec = useRef<MediaRecorder | null>(null);
  const blob = useRef<Blob | null>(null);
  const reloj = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (reloj.current) window.clearInterval(reloj.current);
      rec.current?.stream.getTracks().forEach((t) => t.stop());
    },
    [],
  );
  if (llamadaEnCurso.activa && estado === "listo") return <p className="tc-status">🎤 En la llamada: hablá después del tono; cuando te callás, termina.</p>;
  if (!onSay && estado === "listo") return null;

  const grabar = async () => {
    setError(null);
    try {
      const mic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
      const tipo = ["audio/webm;codecs=opus", "audio/ogg;codecs=opus", "audio/mp4"].find((t) => MediaRecorder.isTypeSupported?.(t));
      const m = new MediaRecorder(mic, tipo ? { mimeType: tipo } : undefined);
      const partes: Blob[] = [];
      m.ondataavailable = (e) => e.data.size && partes.push(e.data);
      m.onstop = () => {
        mic.getTracks().forEach((t) => t.stop());
        blob.current = new Blob(partes, { type: m.mimeType || "audio/webm" });
        setUrl(URL.createObjectURL(blob.current));
        setEstado("grabada");
      };
      rec.current = m;
      m.start(250);
      setSeg(0);
      reloj.current = window.setInterval(() => setSeg((s) => s + 1), 1000);
      setEstado("grabando");
    } catch {
      setEstado("error");
      setError("Sin permiso para el micrófono.");
    }
  };
  const parar = () => {
    if (reloj.current) window.clearInterval(reloj.current);
    rec.current?.stop();
  };
  const usar = async () => {
    if (!blob.current) return;
    setEstado("subiendo");
    try {
      const up = await fetch(`/api/t/${tenant}/wa/nota`, {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": (blob.current.type || "audio/webm").split(";")[0], "x-np": "1" },
        body: blob.current,
      });
      const j = (await up.json().catch(() => ({}))) as { archivo?: string; duracion_s?: number; message?: string };
      if (!up.ok || !j.archivo) throw new Error(j.message ?? "No pude guardar la grabación.");
      setEstado("enviada");
      onSay?.(`⟦nota de voz grabada para ${para} (${j.duracion_s ?? seg} s) — archivo: ${j.archivo}⟧`);
    } catch (e) {
      setEstado("error");
      setError((e as Error).message);
    }
  };

  return (
    <div className="tv-nota">
      <p className="tc-status">nota de voz para {para}</p>
      {estado === "listo" && (
        <button type="button" className="tc-btn tc-btn-ok" onClick={grabar}>
          🎤 grabar
        </button>
      )}
      {estado === "grabando" && (
        <button type="button" className="tc-btn tc-btn-ok tv-grabando" onClick={parar} aria-label={`grabando, ${seg} segundos: tocá para terminar`}>
          ■ terminar ({dur(seg)})
        </button>
      )}
      {estado === "grabada" && url && (
        <>
          <audio className="tv-escucha" src={url} controls aria-label="escuchá lo que grabaste" />
          <div className="tv-acciones">
            <button type="button" className="tc-btn tc-btn-ok" onClick={usar}>
              usar esta
            </button>
            <button type="button" className="tc-btn" onClick={() => setEstado("listo")}>
              grabar de nuevo
            </button>
          </div>
        </>
      )}
      {estado === "subiendo" && <p className="tc-status">preparando…</p>}
      {estado === "enviada" && <p className="tc-status">✓ lista: el secretario te pregunta antes de mandarla</p>}
      {error && (
        <p className="tv-aviso" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
