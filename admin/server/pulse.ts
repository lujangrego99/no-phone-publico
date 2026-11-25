// El pulso: una sola cola de lo que el secretario necesita de su dueño, ordenada por profundidad.
// depth 3 = lo roto (adelante, quieto, brillante) · 2 = lo que vence pronto · 1 = lo nuevo · 0 = lo que anda.
import { db, type Tenant } from "./db.ts";
import { getStatus, type Piece } from "./status.ts";
import { listJobs } from "./hermes.ts";
import { hindsight } from "./hindsight.ts";

export interface PulseLine {
  id: string;
  depth: 0 | 1 | 2 | 3;
  failed: boolean;
  title: string;
  detail: string;
  to: string; // ruta de la consola donde se resuelve
  action: string; // verbo del botón
}

export interface SignalLine {
  at: string;
  who: string;
  text: string;
}

export interface Pulse {
  lines: PulseLine[];
  signal: SignalLine[];
  counts: { memories: number; observations: number; jobs: number; devices: number; tools: number; toolsUp: number };
  checkedAt: string;
}

const HOUR = 3600_000;

function pieceLine(p: Piece, to: string, actionDown: string): PulseLine {
  const down = p.health === "caido";
  return {
    id: p.id,
    depth: down ? 3 : 0,
    failed: down,
    title: down ? `${p.label} caído` : `${p.label} en línea`,
    detail: p.detail,
    to,
    action: down ? actionDown : "ver",
  };
}

export async function getPulse(t: Tenant, refresh = false): Promise<Pulse> {
  const [status, jobs, stats, recent] = await Promise.all([
    getStatus(t, refresh),
    listJobs(t).catch(() => []),
    hindsight.stats(t.bank_id).catch(() => null),
    hindsight.memories(t.bank_id, { limit: 6, time_field: "created_at" }).catch(() => null),
  ]);

  const lines: PulseLine[] = [];
  lines.push(pieceLine(status.llm, "/secretario", "revisar modelo"));
  lines.push(pieceLine(status.memory, "/herramientas", "revisar"));
  const active = jobs.filter((j) => j.enabled);
  // El programador apagado solo importa de verdad si hay tareas esperando.
  const sched = pieceLine(status.scheduler, "/tareas", "ver tareas");
  if (sched.failed && !active.length) sched.depth = 1;
  lines.push(sched);
  for (const d of status.devices) {
    if (!d.serial) {
      lines.push({
        id: `celu-${d.id}`,
        depth: 1,
        failed: false,
        title: `${d.label} sin serial`,
        detail: "enchufalo, mirá adb devices y cargá el serial",
        to: "/ajustes?ver=conexiones",
        action: "completar",
      });
      continue;
    }
    lines.push({
      id: `celu-${d.id}`,
      depth: d.health === "caido" ? (d.active ? 3 : 1) : 0,
      failed: d.health === "caido",
      title: d.health === "caido" ? `${d.label} desconectado` : `${d.label} conectado${d.active ? " · en uso" : ""}`,
      detail: [d.profile.modelo, d.profile.android && `android ${d.profile.android}`, d.detail].filter(Boolean).join(" · "),
      to: "/ajustes?ver=conexiones",
      action: d.health === "caido" ? "reconectar" : "ver",
    });
    if (d.kind === "fisico" && !d.secrets.NX_PIN) {
      lines.push({
        id: `pin-${d.id}`,
        depth: 2,
        failed: false,
        title: `${d.label} sin PIN de Naranja X`,
        detail: "si la app pide la clave, el secretario no puede entrar",
        to: "/ajustes?ver=conexiones",
        action: "cargar PIN",
      });
    }
  }
  if (status.whatsapp) {
    const l = pieceLine(status.whatsapp, "/herramientas", "vincular");
    if (l.failed) l.title = /vincular|QR/.test(l.detail) ? "whatsapp sin vincular" : "whatsapp caído";
    lines.push(l);
  }
  for (const m of status.mcp) lines.push(pieceLine({ ...m, label: `herramienta ${m.label}` }, "/herramientas", "probar de nuevo"));

  const now = Date.now();
  for (const j of active) {
    const next = j.next_run_at ? Date.parse(j.next_run_at) : NaN;
    if (j.last_status === "error" || j.last_error) {
      lines.push({ id: `job-${j.id}`, depth: 3, failed: true, title: `falló «${j.name}»`, detail: j.last_error ?? "la última corrida dio error", to: "/tareas", action: "ver tarea" });
    } else if (!Number.isNaN(next) && next - now < 24 * HOUR) {
      const hh = new Date(next).toLocaleTimeString("es-AR", { hour: "2-digit", minute: "2-digit" });
      lines.push({ id: `job-${j.id}`, depth: 2, failed: false, title: `«${j.name}» a las ${hh}`, detail: j.schedule, to: "/tareas", action: "ver tarea" });
    }
  }

  const items = (recent?.items ?? []) as { id: string; text: string; created_at?: string; date?: string; mentioned_at?: string }[];
  for (const m of items.slice(0, 3)) {
    lines.push({ id: `mem-${m.id}`, depth: 1, failed: false, title: "aprendió algo nuevo", detail: m.text, to: `/memoria?recuerdo=${encodeURIComponent(m.id)}`, action: "revisar" });
  }

  lines.sort((a, b) => b.depth - a.depth || Number(b.failed) - Number(a.failed));

  const events = db
    .prepare("SELECT e.at, e.text, COALESCE(u.name, 'sistema') AS who FROM events e LEFT JOIN users u ON u.id = e.user_id WHERE e.tenant_id = ? ORDER BY e.at DESC LIMIT 12")
    .all(t.id) as unknown as { at: string; who: string; text: string }[];
  const signal: SignalLine[] = [
    ...events.map((e) => ({ at: e.at.replace(" ", "T") + "Z", who: e.who, text: e.text })),
    ...items.map((m) => ({ at: m.mentioned_at ?? m.date ?? "", who: "memoria", text: m.text })),
    ...jobs.filter((j) => j.last_run_at).map((j) => ({ at: j.last_run_at as string, who: "tareas", text: `corrió «${j.name}» · ${j.last_status ?? "?"}` })),
  ]
    .filter((s) => s.at)
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at))
    .slice(0, 12);

  const nodes = (stats?.nodes_by_fact_type ?? {}) as Record<string, number>;
  return {
    lines,
    signal,
    counts: {
      memories: Object.values(nodes).reduce((a, b) => a + b, 0),
      observations: Number(stats?.total_observations ?? 0),
      jobs: active.length,
      devices: status.devices.length,
      tools: status.mcp.length,
      toolsUp: status.mcp.filter((m) => m.health === "ok").length,
    },
    checkedAt: status.checkedAt,
  };
}
