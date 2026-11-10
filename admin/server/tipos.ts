// Qué es cada nombre de la memoria: gente, grupo, lugar, cuenta/empresa u otra cosa. Lo usa la pantalla de memoria
// para dividir la lista y pintar la red por tipo (antes era todo una sola lista mezclada y del mismo color).
//
// Hindsight no guarda tipos: la misión de guardado etiqueta cada hecho con entidades «tipo:persona», «tipo:grupo»,
// «tipo:lugar», «tipo:cuenta», «tipo:organizacion», así que el tipo de X sale de con cuál de esas aparece X en el grafo.
// Eso solo es ruidoso (los integrantes de un grupo aparecen con «tipo:grupo», el dueño aparece con todos), entonces
// primero manda la agenda, que sabe de verdad quién es persona y quién grupo (los grupos de WhatsApp son @g.us).
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Tenant } from "./db.ts";
import { hindsight } from "./hindsight.ts";
import { agenda } from "./agenda.ts";

export type Tipo = "gente" | "grupo" | "lugar" | "cuenta" | "otro";

interface Grafo {
  nodes: { data: { id: string; label: string; mentionCount: number } }[];
  edges: { data: { source: string; target: string; weight: number } }[];
}

const norm = (s: string) =>
  s
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .trim();

// Servicios que el secretario usa: son cuentas aunque la gente «aparezca» con ellos en cada hecho.
const SERVICIOS = /^(whatsapp|mercado ?pago|naranja ?x|google( maps)?|uber|cabify|banco .+|brubank|uala|ual[aá]|modo|cuenta dni|sube)$/i;

export function clasificar(label: string, w: Record<string, number>, deAgenda: Tipo | undefined): Tipo {
  const n = norm(label);
  // Servicios e instituciones primero: también pueden estar agendados como contacto (el WhatsApp de la facu).
  if (SERVICIOS.test(n)) return "cuenta";
  if (/\b(universidad|facu|facultad|colegio|escuela|hospital|clinica|sanatorio)\b/.test(n)) return "lugar";
  if (deAgenda) return deAgenda;
  if (/^\+?[\d*\s-]{7,}$/.test(n)) return "gente"; // un número de teléfono es alguien
  if (/\b(grupo|familia|equipo|amigos|chicos|consorcio)\b/.test(n)) return "grupo";
  if (/\b(universidad|facu|facultad|colegio|escuela|hospital|clinica|sanatorio|parque|plaza|barrio|calle)\b/.test(n)) return "lugar";
  if (/^\d{1,4}$|\b(licenciatura|carrera|materia)\b/.test(n)) return "otro"; // líneas de colectivo, carreras
  const p = w["tipo:persona"] ?? 0;
  const g = w["tipo:grupo"] ?? 0;
  const l = w["tipo:lugar"] ?? 0;
  const c = (w["tipo:cuenta"] ?? 0) + (w["tipo:organizacion"] ?? 0);
  if (l > 0 && l >= p && l >= c && l >= g) return /^\p{Ll}/u.test(label.trim()) ? "otro" : "lugar"; // «colectivo», «auto»: cosas
  if (c > 0 && c >= p) return "cuenta";
  if (/\.(mp|uala|nx)$|^[a-z0-9._-]+\.[a-z0-9._-]+$/.test(n)) return "cuenta"; // alias de cuenta (palta.camote.mp)
  // Con «tipo:grupo» solo, casi siempre es un integrante (Hilario, Milagros): los grupos de verdad los dice la agenda.
  if (p > 0 || g > 0) return "gente";
  // Sin etiqueta: un nombre propio es alguien; una palabra común (comprobante, mate) es otra cosa.
  return /^\p{Lu}/u.test(label.trim()) ? "gente" : "otro";
}

const cache = new Map<string, { at: number; tipos: Record<string, Tipo> }>();

async function tiposDe(t: Tenant): Promise<Record<string, Tipo>> {
  const c = cache.get(t.bank_id);
  if (c && Date.now() - c.at < 5 * 60_000) return c.tipos;
  const g = (await hindsight.entityGraph(t.bank_id, { limit: 1000 })) as Grafo;
  const label = new Map(g.nodes.map((n) => [n.data.id, n.data.label]));
  const tipoIds = new Set(g.nodes.filter((n) => /^tipo:/i.test(n.data.label)).map((n) => n.data.id));
  const pesos = new Map<string, Record<string, number>>();
  for (const e of g.edges) {
    const { source: s, target: d, weight } = e.data;
    for (const [a, b] of [
      [s, d],
      [d, s],
    ]) {
      if (!tipoIds.has(a) || tipoIds.has(b)) continue;
      const w = pesos.get(b) ?? pesos.set(b, {}).get(b)!;
      const k = norm(label.get(a)!);
      w[k] = (w[k] ?? 0) + weight;
    }
  }
  // La agenda: «nombre» = Canónico … WhatsApp <número o …@g.us>. Solo cuenta si el nombre coincide entero.
  const agendaTipo = new Map<string, Tipo>();
  const nombres = g.nodes.filter((n) => !tipoIds.has(n.data.id)).map((n) => n.data.label);
  // La agenda devuelve hasta 5 líneas por pedido: de a 3 nombres (los apodos pueden traer alguna de más), 6 a la vez.
  const tandas: string[][] = [];
  for (let i = 0; i < nombres.length; i += 3) tandas.push(nombres.slice(i, i + 3));
  try {
    for (let i = 0; i < tandas.length; i += 6) {
      const rs = await Promise.all(tandas.slice(i, i + 6).map((t) => agenda.identidad(t.join(", "), 5000)));
      for (const { lineas } of rs)
        for (const l of lineas) {
          const m = /^- «([^»]+)» = (.+?)(?: \(| ·|$)/.exec(l);
          if (!m) continue;
          const tipo: Tipo = /@g\.us/.test(l) ? "grupo" : "gente";
          agendaTipo.set(norm(m[1]), tipo);
          agendaTipo.set(norm(m[2]), tipo);
        }
    }
  } catch {
    // agenda caída: alcanza con el grafo
  }
  const tipos: Record<string, Tipo> = {};
  for (const n of g.nodes) {
    if (tipoIds.has(n.data.id)) continue;
    tipos[n.data.id] = clasificar(n.data.label, pesos.get(n.data.id) ?? {}, agendaTipo.get(norm(n.data.label)));
  }
  cache.set(t.bank_id, { at: Date.now(), tipos });
  return tipos;
}

export function rutas(app: FastifyInstance, T: string, tenantOf: (req: FastifyRequest) => Tenant) {
  app.get(`${T}/memory/tipos`, async (req) => ({ tipos: await tiposDe(tenantOf(req)) }));
}
