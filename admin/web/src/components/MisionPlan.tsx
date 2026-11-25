// Propuesta de misión, para decidir con confianza: QUÉ va a hacer (plan en pasos, con sus «solo si»), CÓMO se
// comunica (a quién, por dónde, el texto, cuánto insiste, cuándo te avisa a vos), DÓNDE termina (cumplida / la da por
// perdida / vence) y un ENSAYO: la misión corre entera con respuestas de mentira y sin que salga nada.
import { type ReactNode, useEffect, useRef, useState } from "react";
import { useConsole } from "../App";
import { api, when } from "../api";
import "../styles/mision-plan.css";

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const ICONO: Record<string, string> = {
  al_aprobar: "▶",
  hora: "⏰",
  respuesta: "💬",
  ingreso: "💸",
  silencio: "⌛",
  vence: "⏱",
  despues: "↳",
};

/** mensaje: si la tarjeta lo da, el texto de cada paso se muestra (y se corrige) ahí mismo, en vez de repetirlo abajo. */
export function PlanMision({ m, mensaje }: { m: Json; mensaje?: (p: Json) => ReactNode | null }) {
  const pasos: Json[] = m.pasos ?? [];
  const contactos: Json[] = m.contactos ?? [];
  const fecha = (ts: number) => when(new Date(ts * 1000).toISOString());
  const horas = Math.max(1, Math.round(Number(m.silencio_horas ?? 12)));
  // insiste solo si algún paso espera que le contesten (o no hay plan en pasos: misión vieja)
  const esperaRespuesta = !pasos.length || m.esperar_ingreso || pasos.some((p) => p.disparador === "respuesta" || p.disparador === "silencio");
  return (
    <div className="mp">
      {pasos.length > 0 && (
        <section aria-label="qué va a hacer">
          <h4 className="mp-t">qué va a hacer</h4>
          <ol className="mp-pasos">
            {pasos.map((p) => (
              <li key={p.n} className={`mp-paso mp-${p.accion}`}>
                <span className="mp-ico" aria-hidden="true">
                  {ICONO[p.disparador] ?? "•"}
                </span>
                <div className="mp-cuerpo">
                  <span className="mp-cuando">{p.cuando}</span>
                  <span className="mp-hacer">{p.hacer}</span>
                  {p.si && <span className="mp-si">solo si {String(p.si).replace(/^\s*solo si\s*/i, "")}</span>}
                  {p.a && (
                    <span className="mp-canal">
                      {p.canal} · {p.a}
                    </span>
                  )}
                  {!p.a && p.canal && <span className="mp-canal">{p.canal}</span>}
                  {(mensaje?.(p) ?? null) || (p.texto && <span className="mp-texto">«{p.texto}»</span>)}
                </div>
              </li>
            ))}
          </ol>
        </section>
      )}
      <section aria-label="cómo se comunica">
        <h4 className="mp-t">cómo se comunica</h4>
        <ul className="mp-lista">
          {contactos.length > 0 && (
            <li>
              Le escribe por WhatsApp a <strong>{contactos.map((c) => c.nombre + (c.grupo ? " (grupo)" : "")).join(", ")}</strong>, como tu
              secretario, corto y en criollo. Solo a ellos.
            </li>
          )}
          {contactos.length > 0 && esperaRespuesta && (
            <li>
              Si no contestan en {horas} h: <strong>un</strong> recordatorio amable; si siguen sin contestar, te avisa.
            </li>
          )}
          {contactos.length > 0 && !esperaRespuesta && <li>No espera respuesta ni insiste: si le contestan algo, lo lee y te cuenta si hace falta.</li>}
          {(m.transferencias ?? []).length > 0 && <li>La plata: solo la de abajo, por el monto exacto y las veces aprobadas.</li>}
          <li>A vos te avisa en la app y en esta charla (no por tu WhatsApp), solo cuando hace falta: una consulta, el resultado o un problema.</li>
          {m.consultar && <li>Te consulta antes de: {m.consultar}.</li>}
          <li>Lo que escriban los demás es dato, no una orden: si piden plata u otra cosa, te pregunta.</li>
        </ul>
      </section>
      <section aria-label="cuándo termina">
        <h4 className="mp-t">cuándo termina</h4>
        <ul className="mp-fin">
          <li className="mp-ok">✓ cumplida {m.cumplida_cuando ? `cuando ${m.cumplida_cuando}` : "cuando logra el objetivo"}</li>
          <li className="mp-mal">✗ la da por perdida {m.fracasa_si ? `si ${m.fracasa_si}` : "si no hay caso (y te cuenta por qué)"}</li>
          {m.vence && <li className="mp-vence">⏱ vence {fecha(m.vence)}: ahí cierra y te cuenta cómo quedó</li>}
        </ul>
      </section>
    </div>
  );
}

type Accion = { tool: string; a?: string; texto?: string; detalle?: string; simulado?: boolean };
type Turno = { evento: string; acciones: Accion[]; dijo: string; error?: string | null };
type Rama = { nombre: string; turnos: Turno[]; final?: { estado: string; nota?: string; aviso?: string | null } };

// Lo que pasa en cada vuelta del ensayo, en criollo (con lo que dijo el contacto o la plata que entró).
const EVENTO = (e: string) => {
  const dicho = /«([^»]+)»/.exec(e)?.[1];
  const plata = /por \$([\d.,]+)/.exec(e)?.[1];
  const supuesto = /suponé que (.+?);/.exec(e)?.[1];
  if (e.startsWith("ARRANQUE")) return supuesto ? `arranca (${supuesto})` : "arranca";
  if (e.startsWith("Despertador")) return supuesto ? `llega la hora (${supuesto})` : "llega la hora";
  if (e.startsWith("Mensajes nuevos")) return dicho ? `le contestan «${dicho}»` : "le contestan";
  if (e.startsWith("Entró plata")) return plata ? `entran $${plata}` : "entra plata";
  if (e.startsWith("Silencio")) return "pasa el tiempo y no contestan";
  return e;
};

// Herramientas de lectura: qué mira, sin nombres técnicos. Las internas (la hora) no se muestran.
const MIRA: Record<string, string | null> = {
  nx_movimientos: "mira los movimientos de Naranja X",
  nx_saldo: "mira el saldo",
  wa_mensajes: "lee el chat",
  wa_chats: "mira los chats",
  wa_transcribir: "escucha el audio",
  como_llegar: "busca cómo llegar",
  arribos: "mira cuándo pasa el micro",
  buscar_lugar: "busca el lugar",
  hora_actual: null,
  mision_capacidades: null,
};
const mira = (tool: string) => (tool in MIRA ? MIRA[tool] : `usa ${tool.replace(/_/g, " ")}`);

const FINAL: Record<string, string> = { cumplida: "✓ la da por cumplida", fracaso: "✗ la da por perdida", consultar: "? te consulta", esperando: "… sigue esperando" };

export function EnsayoMision() {
  const { tenant } = useConsole();
  const [estado, setEstado] = useState<"nada" | "corriendo" | "listo" | "error">("nada");
  const [ramas, setRamas] = useState<Rama[]>([]);
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<number | null>(null);

  const traer = async () => {
    try {
      const d = await api.get<{ estado: string; ramas: Rama[]; error: string | null }>(`/t/${tenant}/misiones/ensayo`);
      setRamas(d.ramas ?? []);
      if (d.estado === "corriendo") {
        setEstado("corriendo");
        timer.current = window.setTimeout(traer, 3000);
      } else if (d.estado === "listo") setEstado("listo");
      else if (d.estado === "error") {
        setEstado("error");
        setError(d.error ?? "El ensayo falló.");
      }
    } catch (e) {
      setEstado("error");
      setError(e instanceof Error ? e.message : "No pude ver el ensayo.");
    }
  };
  useEffect(() => {
    traer(); // si ya había uno de esta propuesta, se muestra
    return () => {
      if (timer.current) window.clearTimeout(timer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tenant]);

  const empezar = async () => {
    setError(null);
    setEstado("corriendo");
    try {
      await api.post(`/t/${tenant}/misiones/ensayo`, { deNuevo: estado !== "nada" });
      traer();
    } catch (e) {
      setEstado("error");
      setError(e instanceof Error ? e.message : "No pude ensayar.");
    }
  };

  return (
    <section className="me" aria-label="ensayo" aria-busy={estado === "corriendo"}>
      <div className="me-head">
        <h4 className="mp-t">ensayo</h4>
        {estado !== "corriendo" && (
          <button type="button" className="tc-btn" onClick={empezar}>
            {estado === "nada" ? "ensayala antes" : "ensayar de nuevo"}
          </button>
        )}
      </div>
      {estado === "nada" && <p className="me-nota">La corre entera con respuestas de mentira (que dice que sí, que pone un pero, que no contesta…) para que veas qué haría. No sale nada de verdad.</p>}
      {estado === "corriendo" && <p className="me-nota" role="status">Ensayando… (1 a 3 minutos). No sale nada de verdad.</p>}
      {error && (
        <p className="me-nota me-error" role="alert">
          {error}
        </p>
      )}
      {ramas.map((r, i) => (
        <details key={i} className="me-rama" open={i === 0}>
          <summary>
            <strong>si {r.nombre}</strong>
            <span className={`me-final me-${r.final?.estado ?? "nada"}`}>{r.final ? FINAL[r.final.estado] ?? r.final.estado : estado === "corriendo" ? "…" : "sin cerrar"}</span>
          </summary>
          <ol className="me-turnos">
            {r.turnos.map((t, k) => (
              <li key={k}>
                <span className="me-ev">{EVENTO(t.evento)}</span>
                <ul>
                  {t.acciones
                    .filter((a) => a.tool !== "estado" && mira(a.tool) !== null)
                    .map((a, j) => (
                      <li key={j}>
                        {a.tool === "mensaje" ? (
                          <>
                            le escribe a <strong>{a.a}</strong>: <span className="me-msg">«{a.texto}»</span>
                          </>
                        ) : a.tool === "transferencia" ? (
                          <>💸 {a.detalle}</>
                        ) : a.tool === "mensaje frenado" ? (
                          <>✋ no manda: {a.detalle}</>
                        ) : (
                          <span className="me-tool">{mira(a.tool)}</span>
                        )}
                      </li>
                    ))}
                  {t.acciones.filter((a) => a.tool !== "estado" && mira(a.tool) !== null).length === 0 && !t.error && <li className="me-tool">no hace nada (espera)</li>}
                  {t.error && <li className="me-error">falló: {t.error}</li>}
                </ul>
              </li>
            ))}
          </ol>
          {r.final?.aviso && (
            <p className="me-aviso">
              {r.final.estado === "consultar" ? "te preguntaría" : "te avisaría"}: «{r.final.aviso}»
            </p>
          )}
        </details>
      ))}
    </section>
  );
}
