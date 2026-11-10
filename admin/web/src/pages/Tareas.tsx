// Tareas: todo lo que el secretario hace solo — misiones (encargos largos), vigilancias de WhatsApp y tareas
// programadas (recordatorios). Uso: ver de un vistazo qué está en marcha y qué te espera, y pararlo si hace falta.
// Lo vivo arriba; lo terminado plegado. Pausar es reversible (se hace directo, con «deshacer»); cancelar no
// (se confirma).
import { useState } from "react";
import { Link, useNavigate } from "react-router";
import { useConsole } from "../App";
import { api, when, type Job } from "../api";
import { Icon } from "../components/Icon";
import { Empty, Failure, Loading, useAction, useLoad } from "../components/kit";
import { confirmar, toast } from "../components/ui";
import "../styles/tareas.css";

type Tono = "ok" | "bad" | "info" | "wait" | "off" | "signal";

/* ---------------- vigilancias ---------------- */

type Vig = { id: string; nombre: string; contiene: string | null; estado: string; hasta: string; avisos: number };
const ESTADO_VIG: Record<string, [string, Tono]> = {
  activa: ["vigilando", "info"],
  cancelando: ["cancelando", "off"],
  cancelada: ["cancelada", "off"],
  vencida: ["venció", "off"],
  cumplida: ["ya te avisó", "ok"],
};

/* ---------------- misiones ---------------- */

type Mision = {
  id: string;
  sessionId: string;
  objetivo: string;
  alcance: string;
  consultar: string;
  estado: string;
  nota: string;
  resultado: string | null;
  contactos: string[];
  transferencias: { a: string; monto: number; veces: number; usadas: number }[];
  esperaIngreso: boolean;
  mensajes: number;
  mensajesMax: number;
  turnos: number;
  vence: string;
  despertar: string | null;
  log: { at: string; tipo: string; texto: string }[];
};
const ESTADO_MIS: Record<string, [string, Tono]> = {
  esperando_dueno: ["te espera", "wait"],
  activa: ["en marcha", "info"],
  pausada: ["pausada", "off"],
  cumplida: ["cumplida", "ok"],
  fracaso: ["no se pudo", "bad"],
  vencida: ["venció", "off"],
  cancelada: ["cancelada", "off"],
};
const ORDEN_MIS: Record<string, number> = { esperando_dueno: 0, activa: 1, pausada: 2 };
const QUIEN_LOG: Record<string, string> = { evento: "pasó", secretario: "secretario", aviso: "te avisó", estado: "anotó", error: "falló", creada: "arrancó" };

/* ---------------- tareas programadas ---------------- */

// «once in 3m» → «una vez»; «every 2h» → «cada 2 h»; «0 9 * * *» → «todos los días a las 09:00».
function frecuencia(s: string) {
  const t = s.trim();
  if (/^once\b/i.test(t)) return "una vez"; // la hora la dice la etiqueta («próximo hoy 14:30») con la zona bien
  const cada = /^every (\d+)\s*([mhd])/i.exec(t);
  if (cada) return `cada ${cada[1]} ${{ m: "min", h: "h", d: cada[1] === "1" ? "día" : "días" }[cada[2].toLowerCase() as "m" | "h" | "d"]}`;
  const cron = /^(\d{1,2}) (\d{1,2}) \* \* (\*|[\d,-]+)$/.exec(t);
  if (cron) {
    const hm = `${cron[2].padStart(2, "0")}:${cron[1].padStart(2, "0")}`;
    if (cron[3] === "*") return `todos los días a las ${hm}`;
    const DIAS = ["dom", "lun", "mar", "mié", "jue", "vie", "sáb"];
    if (cron[3] === "1-5") return `de lunes a viernes a las ${hm}`;
    return `los ${cron[3]
      .split(",")
      .map((d) => DIAS[Number(d) % 7] ?? d)
      .join(", ")} a las ${hm}`;
  }
  return t;
}
const hecha = (j: Job) => j.state === "completed" || (!j.enabled && !j.next_run_at && (j.repeat?.times ?? 0) > 0 && j.repeat!.completed >= j.repeat!.times!);

function Chip({ tono, children }: { tono: Tono; children: string }) {
  return (
    <span className="chip" data-tono={tono}>
      {children}
    </span>
  );
}

/* ================= página ================= */

export function Tareas() {
  const { tenant } = useConsole();
  const ms = useLoad(() => api.get<{ misiones: Mision[] }>(`/t/${tenant}/misiones`), [tenant]);
  const vs = useLoad(() => api.get<{ vigilancias: Vig[] }>(`/t/${tenant}/vigilancias`), [tenant]);
  const jobs = useLoad(() => api.get<{ jobs: Job[]; schedulerRunning: boolean | null }>(`/t/${tenant}/jobs`), [tenant]);

  const misiones = ms.data?.misiones ?? [];
  const vigs = vs.data?.vigilancias ?? [];
  const tareas = jobs.data?.jobs ?? [];
  const nMis = misiones.filter((m) => m.estado in ORDEN_MIS).length;
  const nVig = vigs.filter((v) => v.estado === "activa").length;
  const nJob = tareas.filter((j) => j.enabled && !hecha(j)).length;
  const teEspera = misiones.filter((m) => m.estado === "esperando_dueno").length;

  const [ver, setVer] = useState<"misiones" | "vigilancias" | "programadas">("misiones");

  return (
    <div className="tareas">
      <div className="page-head">
        <h1 className="display">tareas.</h1>
        <p className="meta">Lo que el secretario hace solo: encargos largos, vigilancias de WhatsApp y recordatorios. Se piden en el chat.</p>
      </div>

      <div className="tabs" role="tablist" aria-label="tipos de tareas">
        <button role="tab" type="button" className="tab" aria-selected={ver === "misiones"} onClick={() => setVer("misiones")}>
          misiones
          {teEspera > 0 ? (
            <span className="tab-n" data-tono="wait" title={`${teEspera} te espera`}>
              {teEspera}
            </span>
          ) : nMis > 0 ? (
            <span className="tab-n">{nMis}</span>
          ) : null}
        </button>
        <button role="tab" type="button" className="tab" aria-selected={ver === "vigilancias"} onClick={() => setVer("vigilancias")}>
          vigilancias
          {nVig > 0 && <span className="tab-n">{nVig}</span>}
        </button>
        <button role="tab" type="button" className="tab" aria-selected={ver === "programadas"} onClick={() => setVer("programadas")}>
          recordatorios
          {nJob > 0 && <span className="tab-n">{nJob}</span>}
        </button>
      </div>

      <div role="tabpanel">
        {ver === "misiones" && <Misiones data={ms} />}
        {ver === "vigilancias" && <Vigilancias data={vs} />}
        {ver === "programadas" && <Programadas data={jobs} />}
      </div>
    </div>
  );
}

type Carga<T> = { data: T | null; error: unknown; loading: boolean; reload: () => Promise<void> };

/* ---------------- misiones ---------------- */

function Misiones({ data: ms }: { data: Carga<{ misiones: Mision[] }> }) {
  const { tenant } = useConsole();
  const navigate = useNavigate();
  const act = useAction();
  const hacer = async (m: Mision, que: "pausar" | "reanudar" | "cancelar") => {
    if (
      que === "cancelar" &&
      !(await confirmar({
        titulo: "¿Cancelar esta misión?",
        texto: <>«{m.objetivo}». El secretario deja de seguirla y no se puede retomar: para volver a hacerla, pedísela de nuevo en el chat.</>,
        si: "cancelar misión",
        no: "seguir con la misión",
        peligro: true,
      }))
    )
      return;
    const ok = await act.run(`${m.id}-${que}`, () => api.post(`/t/${tenant}/misiones/${m.id}/${que}`));
    await ms.reload();
    if (!ok) return;
    if (que === "pausar") toast("Misión pausada.", { tono: "ok", accion: { label: "deshacer", fn: () => void hacer(m, "reanudar") } });
    else if (que === "reanudar") toast("Misión otra vez en marcha.", { tono: "ok" });
    else toast("Misión cancelada.", { tono: "ok" });
  };
  const irA = async (m: Mision) => {
    await api.post(`/t/${tenant}/charla/abrir`, { sessionId: m.sessionId }).catch(() => null);
    navigate("/");
  };

  if (ms.loading && !ms.data) return <Loading lines={3} />;
  if (ms.error && !ms.data) return <Failure error={String((ms.error as Error).message ?? ms.error)} onRetry={ms.reload} />;
  const lista = ms.data?.misiones ?? [];
  const vivas = lista.filter((m) => m.estado in ORDEN_MIS).sort((a, b) => ORDEN_MIS[a.estado] - ORDEN_MIS[b.estado]);
  const terminadas = lista.filter((m) => !(m.estado in ORDEN_MIS));

  const tarjeta = (m: Mision, compacta = false) => {
    const [estado, tono] = ESTADO_MIS[m.estado] ?? [m.estado, "off" as Tono];
    const viva = m.estado === "activa" || m.estado === "esperando_dueno";
    const busy = act.busy?.startsWith(`${m.id}-`) ?? false;
    const datos: [string, string][] = [];
    if (m.contactos.length) datos.push(["con", `${m.contactos.join(", ")} · ${m.mensajes} de ${m.mensajesMax} mensajes`]);
    if (m.alcance) datos.push(["decide solo", m.alcance]);
    if (m.consultar) datos.push(["te consulta", m.consultar]);
    for (const t of m.transferencias) datos.push(["plata", `$${t.monto.toLocaleString("es-AR")} a ${t.a} · ${t.usadas} de ${t.veces}`]);
    if (m.esperaIngreso && viva) datos.push(["mira", "si te entra plata"]);
    if (m.despertar && viva) datos.push(["se despierta", when(m.despertar)]);
    if (viva) datos.push(["vence", when(m.vence)]);
    return (
      <li key={m.id} className="mis" data-estado={m.estado}>
        <div className="mis-head">
          <Chip tono={tono}>{estado}</Chip>
          <h3 className="mis-objetivo">{m.objetivo}</h3>
        </div>
        {(m.resultado || m.nota) && <p className="mis-nota">{m.resultado || m.nota}</p>}
        {compacta ? (
          <div className="mis-compacta">
            <details className="mis-log">
              <summary>detalle</summary>
              <dl className="kv">
                {datos.map(([k, v], i) => (
                  <div key={i}>
                    <dt>{k}</dt>
                    <dd>{v}</dd>
                  </div>
                ))}
              </dl>
              {m.log.length > 0 && (
                <ol>
                  {[...m.log].reverse().map((l, i) => (
                    <li key={i} data-tipo={l.tipo}>
                      <span className="mis-log-cuando">
                        {when(l.at)} · {QUIEN_LOG[l.tipo] ?? l.tipo}
                      </span>
                      <span className="mis-log-texto">{l.texto}</span>
                    </li>
                  ))}
                </ol>
              )}
            </details>
            <button className="btn small quiet" type="button" onClick={() => irA(m)}>
              <Icon name="message" size={14} />
              ir a la charla
            </button>
          </div>
        ) : null}
        {!compacta && datos.length > 0 && (
          <dl className="kv">
            {datos.map(([k, v], i) => (
              <div key={i}>
                <dt>{k}</dt>
                <dd>{v}</dd>
              </div>
            ))}
          </dl>
        )}
        {!compacta && m.log.length > 0 && (
          <details className="mis-log">
            <summary>
              qué hizo · {m.turnos} {m.turnos === 1 ? "vuelta" : "vueltas"}
            </summary>
            <ol>
              {[...m.log].reverse().map((l, i) => (
                <li key={i} data-tipo={l.tipo}>
                  <span className="mis-log-cuando">
                    {when(l.at)} · {QUIEN_LOG[l.tipo] ?? l.tipo}
                  </span>
                  <span className="mis-log-texto">{l.texto}</span>
                </li>
              ))}
            </ol>
          </details>
        )}
        {!compacta && (
          <div className="mis-acciones">
            <button className={m.estado === "esperando_dueno" ? "btn primary" : "btn"} type="button" onClick={() => irA(m)}>
              <Icon name="message" size={16} />
              {m.estado === "esperando_dueno" ? "responder en la charla" : "ir a la charla"}
            </button>
            {viva && (
              <button className="btn quiet" type="button" disabled={busy} aria-busy={act.busy === `${m.id}-pausar`} onClick={() => hacer(m, "pausar")}>
                <Icon name="pause" size={16} />
                pausar
              </button>
            )}
            {m.estado === "pausada" && (
              <button className="btn quiet" type="button" disabled={busy} aria-busy={act.busy === `${m.id}-reanudar`} onClick={() => hacer(m, "reanudar")}>
                <Icon name="play" size={16} />
                reanudar
              </button>
            )}
            {(viva || m.estado === "pausada") && (
              <button
                className="btn quiet mis-cancelar"
                type="button"
                disabled={busy}
                aria-busy={act.busy === `${m.id}-cancelar`}
                onClick={() => hacer(m, "cancelar")}
              >
                cancelar
              </button>
            )}
          </div>
        )}
      </li>
    );
  };

  return (
    <section className="section">
      {act.error && <Failure error={act.error} />}
      {vivas.length ? (
        <ol className="mis-lista">{vivas.map((m) => tarjeta(m))}</ol>
      ) : (
        <Empty title="Ninguna misión en marcha" action={
            <Link className="btn" to={`/?escribir=${encodeURIComponent("Tengo una misión: ")}`}>
              <Icon name="message" size={16} />
              pedir una en el chat
            </Link>
          }>
          Son encargos que sigue solo: le escribe a la gente, espera respuestas y te avisa. Pedíselos en el chat: «hablale a Pepín y quedá para juntarnos este
          finde».
        </Empty>
      )}
      {terminadas.length > 0 && (
        <details className="plegado">
          <summary>
            terminadas <span className="tab-n">{terminadas.length}</span>
          </summary>
          <ol className="mis-lista mis-terminadas">{terminadas.map((m) => tarjeta(m, true))}</ol>
        </details>
      )}
    </section>
  );
}

/* ---------------- vigilancias ---------------- */

function Vigilancias({ data: vs }: { data: Carga<{ vigilancias: Vig[] }> }) {
  const { tenant } = useConsole();
  const act = useAction();
  const cancelar = async (v: Vig) => {
    if (
      !(await confirmar({
        titulo: `¿Dejar de vigilar a ${v.nombre}?`,
        texto: "Si te escribe, ya no te va a avisar. Para volver a vigilar, pedíselo en el chat.",
        si: "dejar de vigilar",
        no: "seguir vigilando",
        peligro: true,
      }))
    )
      return;
    const ok = await act.run(v.id, () => api.post(`/t/${tenant}/vigilancias/${v.id}/cancelar`));
    await vs.reload();
    if (ok) {
      toast(`Ya no vigila a ${v.nombre}.`, { tono: "ok" });
      setTimeout(() => void vs.reload(), 6000); // el vigía tarda unos segundos en soltarla
    }
  };
  if (vs.loading && !vs.data) return <Loading lines={2} />;
  if (vs.error && !vs.data) return <Failure error={String((vs.error as Error).message ?? vs.error)} onRetry={vs.reload} />;
  const lista = vs.data?.vigilancias ?? [];
  const activas = lista.filter((v) => v.estado === "activa" || v.estado === "cancelando");
  const viejas = lista.filter((v) => !(v.estado === "activa" || v.estado === "cancelando"));
  const fila = (v: Vig) => {
    const [estado, tono] = ESTADO_VIG[v.estado] ?? [v.estado, "off" as Tono];
    return (
      <li key={v.id} className="fila">
        <div className="fila-main">
          <span className="fila-titulo">
            {v.nombre}
            {v.contiene ? <span className="fila-sub"> · si dice «{v.contiene}»</span> : null}
          </span>
          <span className="fila-meta">
            {v.estado === "activa" ? `hasta ${when(v.hasta)}` : when(v.hasta)}
            {v.avisos ? ` · ${v.avisos} ${v.avisos === 1 ? "aviso" : "avisos"}` : " · sin avisos"}
          </span>
        </div>
        <Chip tono={tono}>{estado}</Chip>
        <div className="fila-acciones">
          {v.estado === "activa" && (
            <button className="btn small quiet" type="button" disabled={act.busy !== null} aria-busy={act.busy === v.id} onClick={() => cancelar(v)}>
              dejar de vigilar
            </button>
          )}
        </div>
      </li>
    );
  };
  return (
    <section className="section">
      <p className="section-lede">«Avisame si Pepín me escribe»: no gastan nada y te avisan en la campana y en el chat. Siguen aunque cierres la consola.</p>
      {act.error && <Failure error={act.error} />}
      {activas.length ? (
        <ol className="filas">{activas.map(fila)}</ol>
      ) : (
        <Empty title="No está vigilando a nadie" action={
            <Link className="btn" to={`/?escribir=${encodeURIComponent("Avisame si ")}`}>
              <Icon name="message" size={16} />
              pedir una en el chat
            </Link>
          }>Pedíselo en el chat: «avisame si Pepín me escribe en las próximas 2 horas».</Empty>
      )}
      {viejas.length > 0 && (
        <details className="plegado">
          <summary>
            anteriores <span className="tab-n">{viejas.length}</span>
          </summary>
          <ol className="filas">{viejas.map(fila)}</ol>
        </details>
      )}
    </section>
  );
}

/* ---------------- tareas programadas ---------------- */

function Programadas({ data: jobs }: { data: Carga<{ jobs: Job[]; schedulerRunning: boolean | null }> }) {
  const { tenant } = useConsole();
  const act = useAction();
  const run = async (j: Job, action: "pause" | "resume" | "remove") => {
    if (
      action === "remove" &&
      !hecha(j) &&
      !(await confirmar({
        titulo: `¿Cancelar «${j.name}»?`,
        texto: "Se borra y no se vuelve a disparar. Si la querés quieta un tiempo, pausala.",
        si: "cancelar recordatorio",
        no: "dejarlo",
        peligro: true,
      }))
    )
      return;
    const ok = await act.run(`${j.id}-${action}`, () => api.post(`/t/${tenant}/jobs/${encodeURIComponent(j.id)}/${action}`));
    await jobs.reload();
    if (!ok) return;
    if (action === "pause") toast(`«${j.name}» pausado.`, { tono: "ok", accion: { label: "deshacer", fn: () => void run(j, "resume") } });
    else if (action === "resume") toast(`«${j.name}» vuelve a correr.`, { tono: "ok" });
    else toast(hecha(j) ? "Quitado de la lista." : `«${j.name}» cancelado.`, { tono: "ok" });
  };

  if (jobs.loading && !jobs.data) return <Loading lines={4} />;
  if (jobs.error && !jobs.data) return <Failure error={String((jobs.error as Error).message ?? jobs.error)} onRetry={jobs.reload} />;
  const todas = jobs.data?.jobs ?? [];
  const pendientes = todas.filter((j) => !hecha(j)).sort((a, b) => (a.next_run_at ?? "z").localeCompare(b.next_run_at ?? "z"));
  const hechas = todas.filter(hecha).sort((a, b) => (b.last_run_at ?? "").localeCompare(a.last_run_at ?? ""));

  const fila = (j: Job) => {
    const busy = act.busy?.startsWith(`${j.id}-`) ?? false;
    const fallo = j.last_status === "error";
    const [estado, tono]: [string, Tono] = hecha(j)
      ? ["hecho", "ok"]
      : fallo
        ? ["falló", "bad"]
        : j.enabled
          ? [`próximo ${when(j.next_run_at)}`, "info"]
          : ["pausado", "off"];
    return (
      <li key={j.id} className="fila fila-job">
        <div className="fila-main">
          <span className="fila-titulo">{j.name}</span>
          <span className="fila-meta">
            {frecuencia(j.schedule)}
            {j.repeat?.times && j.repeat.times > 1 ? ` · ${j.repeat.completed} de ${j.repeat.times}` : ""}
            {j.last_run_at ? ` · ${hecha(j) ? "" : "última "}${when(j.last_run_at)}` : ""}
          </span>
          {j.last_error && <span className="fila-error">{j.last_error}</span>}
          <details className="fila-detalle">
            <summary>qué le pide al secretario</summary>
            <p>{j.prompt}</p>
          </details>
        </div>
        <Chip tono={tono}>{estado}</Chip>
        <div className="fila-acciones">
          {!hecha(j) &&
            (j.enabled ? (
              <button className="btn small quiet" type="button" disabled={busy} aria-busy={act.busy === `${j.id}-pause`} onClick={() => run(j, "pause")}>
                <Icon name="pause" size={14} />
                pausar
              </button>
            ) : (
              <button className="btn small quiet" type="button" disabled={busy} aria-busy={act.busy === `${j.id}-resume`} onClick={() => run(j, "resume")}>
                <Icon name="play" size={14} />
                reanudar
              </button>
            ))}
          <button
            className="btn small quiet icon-only"
            type="button"
            disabled={busy}
            aria-busy={act.busy === `${j.id}-remove`}
            onClick={() => run(j, "remove")}
            aria-label={hecha(j) ? `quitar «${j.name}» de la lista` : `cancelar «${j.name}»`}
            title={hecha(j) ? "quitar de la lista" : "cancelar"}
          >
            <Icon name="trash" size={14} />
          </button>
        </div>
      </li>
    );
  };

  return (
    <section className="section">
      {jobs.data?.schedulerRunning === false && (
        <div className="failure" role="status">
          <Icon name="alert" size={16} />
          <span className="failure-text">
            El programador está apagado: los recordatorios no se van a disparar. Se prende con <code>hermes gateway</code> en la máquina del secretario.
          </span>
        </div>
      )}
      {act.error && <Failure error={act.error} />}
      {pendientes.length ? (
        <ol className="filas">{pendientes.map(fila)}</ol>
      ) : (
        <Empty title="Nada programado" action={
            <Link className="btn" to={`/?escribir=${encodeURIComponent("Recordame ")}`}>
              <Icon name="message" size={16} />
              pedir uno en el chat
            </Link>
          }>Se crean hablándole, con hora: «a las 17 avisame qué micros tomar para ir a la facu».</Empty>
      )}
      {hechas.length > 0 && (
        <details className="plegado">
          <summary>
            ya hechos <span className="tab-n">{hechas.length}</span>
          </summary>
          <ol className="filas">{hechas.map(fila)}</ol>
        </details>
      )}
    </section>
  );
}
