// Nombres unidos («Goyo», «Grego» y «Juan Gregorio Pérez» son la misma persona) — ahora viven en la AGENDA
// (conector «agenda», mcp_agenda.py; diseño en el vault, no-phone/AGENDA.md). Esta ruta solo traduce lo que pide la
// pantalla de memoria («es la misma que…», «separar») y la lista de grupos a la agenda. La agenda se encarga de que
// la memoria se entere: apodos en la misión de guardado y reprocesar lo viejo que quedó guardado con un apodo.
//
// Antes (hasta 22/10) esto guardaba los grupos en la tabla entidad_alias y escribía la misión directo. Al arrancar,
// lo que haya en esa tabla se pasa a la agenda una sola vez y se borra.
import type { FastifyInstance, FastifyRequest } from "fastify";
import { HttpError } from "./auth.ts";
import { db, listTenants, logEvent, type Tenant } from "./db.ts";
import { hindsight } from "./hindsight.ts";
import { agenda, AgendaCaida } from "./agenda.ts";

db.exec(`
CREATE TABLE IF NOT EXISTS entidad_alias (
  tenant_id       TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  alias_id        TEXT NOT NULL,
  alias_nombre    TEXT NOT NULL,
  canonico_id     TEXT NOT NULL,
  canonico_nombre TEXT NOT NULL,
  at              TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (tenant_id, alias_id)
);
`);

const caida = (e: unknown): never => {
  if (e instanceof AgendaCaida) throw new HttpError(502, "agenda_caida", e.message);
  throw e;
};

async function nombreDe(t: Tenant, id: string): Promise<string> {
  const e = (await hindsight.entity(t.bank_id, id)) as { canonical_name?: string } | null;
  if (!e?.canonical_name) throw new HttpError(404, "no_existe", "Esa entidad ya no está en la memoria.");
  return e.canonical_name;
}

export async function unir(t: Tenant, userId: number, aliasId: string, canonicoId: string) {
  if (aliasId === canonicoId) throw new HttpError(400, "misma", "Ya son la misma.");
  const [aliasNombre, canonicoNombre] = await Promise.all([nombreDe(t, aliasId), nombreDe(t, canonicoId)]);
  await agenda.unir({ alias_id: aliasId, alias_nombre: aliasNombre, canonico_id: canonicoId, canonico_nombre: canonicoNombre }).catch(caida);
  logEvent(t.id, userId, "memoria", `unió «${aliasNombre}» con «${canonicoNombre}»`);
  return { ok: true, aviso: null };
}

export async function separar(t: Tenant, userId: number, aliasId: string) {
  const g = (await agenda.grupos().catch(caida)).items.find((x) => x.alias_id === aliasId);
  if (!g) throw new HttpError(404, "no_existe", "Ese nombre no estaba unido.");
  await agenda.separar(aliasId).catch(caida);
  logEvent(t.id, userId, "memoria", `separó «${g.alias_nombre}» de «${g.canonico_nombre}»`);
  return { ok: true, aviso: null };
}

// Lo que quedó en la tabla vieja → agenda (una vez). Si la agenda todavía no arrancó, se reintenta más tarde.
async function migrar() {
  for (const t of listTenants()) {
    const filas = db.prepare("SELECT alias_id, alias_nombre, canonico_id, canonico_nombre FROM entidad_alias WHERE tenant_id = ?").all(t.id) as unknown as {
      alias_id: string;
      alias_nombre: string;
      canonico_id: string;
      canonico_nombre: string;
    }[];
    for (const f of filas) {
      await agenda.unir(f);
      db.prepare("DELETE FROM entidad_alias WHERE tenant_id = ? AND alias_id = ?").run(t.id, f.alias_id);
    }
  }
}
let intentos = 0;
const reintentar = () =>
  migrar().catch(() => {
    if (++intentos < 30) setTimeout(reintentar, 60_000);
  });
setTimeout(reintentar, 15_000);

export function rutas(app: FastifyInstance, T: string, tenantOf: (req: FastifyRequest) => Tenant) {
  // Entidad de la memoria (uuid) o «apodo:<ficha>:<nombre>» (un apodo de la agenda sin entidad propia).
  const id = (v: unknown) => {
    if (typeof v !== "string" || !/^[\p{L}\p{N}_:. -]{1,120}$/u.test(v)) throw new HttpError(400, "id_invalido", "Falta la entidad.");
    return v;
  };
  app.get(`${T}/memory/aliases`, async (req) => {
    tenantOf(req);
    const { items } = await agenda.grupos().catch(caida);
    return { items };
  });
  app.post(`${T}/memory/aliases`, async (req) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    return unir(tenantOf(req), req.user!.id, id(b.alias_id), id(b.canonico_id));
  });
  app.delete(`${T}/memory/aliases/:id`, async (req) => separar(tenantOf(req), req.user!.id, id((req.params as { id: string }).id)));
}
