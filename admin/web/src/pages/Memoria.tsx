import { createContext, useContext, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { Link, useSearchParams } from "react-router";
import { useConsole } from "../App";
import { api, entitiesText, esRuido, parecidos, sinTildes, TIPOS, tipoPorDefecto, useDemorado, type TipoNombre, textoRecuerdo, type Alias, when, type ApiError, type Entities, type Entity, type EntityDetail, type MemoryUnit, type Status } from "../api";
import { Icon } from "../components/Icon";
import { Empty, Failure, Field, Loading, useAction, useLoad } from "../components/kit";
import { Dialog, toast } from "../components/ui";
import { Red } from "./MemoriaRed";
import "../styles/memoria.css";

// Tres vistas: a quién y qué conoce, quién aparece con quién, y lo que fue guardando. «probar» no es una vista: es un plano al frente.
type Tab = "entidades" | "red" | "recuerdos";
const TABS: Tab[] = ["entidades", "red", "recuerdos"];
const TAB_LABEL: Record<Tab, string> = { entidades: "nombres", red: "red", recuerdos: "recuerdos" };

// Nombres unidos por el dueño: lo comparten las tres vistas y la ficha (al unir o separar, recargan todas).
interface AliasCtx {
  items: Alias[];
  raiz: (id: string) => string;
  otros: (id: string) => Alias[];
  reload: () => void;
}
const AliasContext = createContext<AliasCtx>({ items: [], raiz: (id) => id, otros: () => [], reload: () => {} });
export const useAlias = () => useContext(AliasContext);

// Qué es cada nombre (gente, grupo, lugar…). Si falla, todo cae en el tipo por defecto: la lista sigue andando.
export function useTipos() {
  const { tenant } = useConsole();
  const { data } = useLoad(() => api.get<{ tipos: Record<string, TipoNombre> }>(`/t/${tenant}/memory/tipos`), [tenant]);
  return useMemo(() => {
    const t = data?.tipos ?? {};
    return (id: string, nombre: string): TipoNombre => t[id] ?? tipoPorDefecto(nombre);
  }, [data]);
}

function useAliasLoad(tenant: string): AliasCtx {
  const { data, reload } = useLoad(() => api.get<{ items: Alias[] }>(`/t/${tenant}/memory/aliases`), [tenant]);
  return useMemo(() => {
    const items = data?.items ?? [];
    const de = new Map(items.map((a) => [a.alias_id, a.canonico_id]));
    return {
      items,
      raiz: (id: string) => de.get(id) ?? id,
      otros: (id: string) => items.filter((a) => a.canonico_id === id),
      reload,
    };
  }, [data, reload]);
}

export function Memoria() {
  const [params, setParams] = useSearchParams();
  const tab = (TABS.includes(params.get("ver") as Tab) ? params.get("ver") : params.get("recuerdo") ? "recuerdos" : "entidades") as Tab;
  const { tenant, setStill } = useConsole();
  const [probando, setProbando] = useState(false);
  useEffect(() => {
    setStill(probando);
    return () => setStill(false);
  }, [probando, setStill]);
  const stats = useLoad(() => api.get<Record<string, unknown>>(`/t/${tenant}/memory/stats`), [tenant]);
  const s = stats.data as { nodes_by_fact_type?: Record<string, number>; total_observations?: number; last_memory_write_at?: string | null; pending_operations?: number } | null;
  const status = useLoad(() => api.get<Status>(`/t/${tenant}/status`), [tenant]);
  const llmDown = status.data?.llm.health === "caido";
  const total = Object.values(s?.nodes_by_fact_type ?? {}).reduce((a, b) => a + b, 0);
  const alias = useAliasLoad(tenant);

  return (
    <AliasContext.Provider value={alias}>
    <div className="memory">
      <div className="page-head with-action">
        <div>
          <h1 className="display">memoria.</h1>
          <p className="meta">{s ? `Lo que sabe de vos y tu gente: ${total.toLocaleString("es-AR")} recuerdos.` : "Lo que sabe de vos y tu gente."} Si algo está mal, corregilo acá.</p>
        </div>
        <button className="btn" type="button" onClick={() => setProbando(true)} aria-haspopup="dialog">
          <Icon name="search" size={16} />
          probar qué recuerda
        </button>
      </div>
      {llmDown && (
        <div className="failure" role="status">
          <Icon name="alert" size={16} />
          <span className="failure-text">No puede guardar recuerdos nuevos: {status.data!.llm.detail.split(" · ")[0]}.</span>
          <Link className="btn" to="/ajustes">
            revisar modelo
          </Link>
        </div>
      )}
      <div className="tabs" role="tablist" aria-label="vistas de la memoria">
        {TABS.map((t) => (
          <button
            key={t}
            role="tab"
            type="button"
            aria-selected={tab === t}
            className="tab"
            onClick={() => setParams(t === "entidades" ? {} : { ver: t })}
          >
            {TAB_LABEL[t]}
          </button>
        ))}
      </div>
      <div role="tabpanel" className="tabpanel">
        {tab === "entidades" && <Entidades />}
        {tab === "red" && <Red />}
        {tab === "recuerdos" && <Recuerdos focusId={params.get("recuerdo")} />}
      </div>
      <Dialog
        open={probando}
        onClose={() => setProbando(false)}
        size="lg"
        title="Probar qué recuerda"
        description="Escribí un pedido como se lo dirías: ves lo que el secretario recibiría de su memoria antes de contestar."
      >
        <Probar />
      </Dialog>
    </div>
    </AliasContext.Provider>
  );
}

// ---------- entidades ----------

// «Bernabe Sosa» → «BR»; «la facu» → «LF»; «+549…» → «#».
export function iniciales(n: string) {
  const ps = n
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter(Boolean);
  if (!ps.length) return "#";
  if (/^\d/.test(ps[0])) return "#";
  const a = [...ps[0]][0] ?? "";
  const b = ps.length > 1 ? ([...ps[ps.length - 1]][0] ?? "") : ([...ps[0]][1] ?? "");
  return (a + b).toUpperCase();
}

function Entidades() {
  const { tenant, setStill } = useConsole();
  const { data, error, loading, reload } = useLoad(() => api.get<{ items: Entity[]; total: number }>(`/t/${tenant}/memory/entities?limit=300`), [tenant]);
  const [params, setParams] = useSearchParams();
  const [filter, setFilter] = useState("");
  const [todos, setTodos] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const alias = useAlias();
  const tipoDe = useTipos();
  // Dividido por tipo (gente, grupos, lugares…): antes era una sola lista donde se mezclaban Berna, Mendoza y Naranja X.
  const tipo = (TIPOS.some((t) => t.id === params.get("tipo")) ? params.get("tipo") : "todo") as TipoNombre | "todo";
  const setTipo = (t: TipoNombre | "todo") => {
    const q = new URLSearchParams(params);
    if (t === "todo") q.delete("tipo");
    else q.set("tipo", t);
    setParams(q, { replace: true });
  };

  useEffect(() => {
    setStill(!!open);
    return () => setStill(false);
  }, [open, setStill]);

  // Sin etiquetas ni roles genéricos (esRuido). Lo nombrado una sola vez suele ser ruido («audio», «bridge»): queda
  // detrás de «ver todos» (la búsqueda sí lo encuentra).
  // Los nombres unidos se ven como una sola línea: menciones sumadas, «también …» al costado.
  const reales = useMemo(() => {
    const todas = (data?.items ?? []).filter((e) => !esRuido(e.canonical_name));
    const porId = new Map(todas.map((e) => [e.id, { ...e, tambien: [] as string[], tipo: tipoDe(e.id, e.canonical_name) }]));
    for (const e of todas) {
      const r = alias.raiz(e.id);
      const dest = r !== e.id ? porId.get(r) : undefined;
      if (!dest) continue;
      dest.mention_count += e.mention_count;
      if ((e.last_seen ?? "") > (dest.last_seen ?? "")) dest.last_seen = e.last_seen;
      dest.tambien.push(e.canonical_name);
      porId.delete(e.id);
    }
    return [...porId.values()];
  }, [data, alias, tipoDe]);
  // Lo que pasa la búsqueda (en vivo, sin tildes) y el «solo lo que se repite»; después, el tipo elegido.
  const base = useMemo(() => {
    const list = [...reales].sort((a, b) => b.mention_count - a.mention_count);
    const f = sinTildes(filter.trim());
    if (f) return list.filter((e) => [e.canonical_name, ...e.tambien].some((n) => sinTildes(n).includes(f)));
    return todos ? list : list.filter((e) => e.mention_count > 1);
  }, [reales, filter, todos]);
  const cuenta = useMemo(() => {
    const c: Record<string, number> = {};
    for (const e of base) c[e.tipo] = (c[e.tipo] ?? 0) + 1;
    return c;
  }, [base]);
  const items = tipo === "todo" ? base : base.filter((e) => e.tipo === tipo);
  const ocultos = reales.length - reales.filter((e) => e.mention_count > 1).length;
  const nombreTipo = (t: TipoNombre) => ({ gente: "persona", grupo: "grupo", lugar: "lugar", cuenta: "cuenta o empresa", otro: "cosa" })[t];

  if (loading && !data) return <Loading lines={8} />;
  if (error) return <Failure error={error} onRetry={reload} />;
  if (!data?.items.length)
    return (
      <Empty title="todavía no conoce a nadie">
        Cuando le cuentes quién es quién («mi familia son…», «Seba es mi amigo de la facu»), cada persona, grupo y lugar aparece acá con lo que sabe de él.
      </Empty>
    );

  return (
    <div className="entidades">
      <div className="buscador">
        <Icon name="search" size={16} />
        <label className="sr-only" htmlFor="buscar-entidad">
          buscar persona, grupo o lugar
        </label>
        <input id="buscar-entidad" className="input" type="search" value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Buscar persona, grupo o lugar…" />
      </div>
      <div className="tipos" role="radiogroup" aria-label="qué mostrar">
        {[{ id: "todo" as const, plural: "todo" }, ...TIPOS].map((t) => {
          const n = t.id === "todo" ? base.length : (cuenta[t.id] ?? 0);
          if (t.id !== "todo" && !n && tipo !== t.id) return null;
          return (
            <button key={t.id} type="button" role="radio" aria-checked={tipo === t.id} className="tipo-boton" data-tipo={t.id} onClick={() => setTipo(t.id)}>
              {t.id !== "todo" && <span className="tipo-punto" aria-hidden="true" />}
              {t.plural}
              <span className="tipo-n">{n}</span>
            </button>
          );
        })}
      </div>
      {items.length ? (
        <ol className="filas ents">
          {items.map((e) => (
            <li key={e.id}>
              <button type="button" className="ent" onClick={() => setOpen(e.id)} aria-haspopup="dialog">
                <span className="avatar" data-tipo={e.tipo} aria-hidden="true">
                  {iniciales(e.canonical_name)}
                </span>
                <span className="ent-main">
                  <span className="ent-nombre">{e.canonical_name}</span>
                  <span className="ent-tambien">
                    {tipo === "todo" && e.tipo !== "gente" && <span className="ent-tipo" data-tipo={e.tipo}>{nombreTipo(e.tipo)}</span>}
                    {tipo === "todo" && e.tipo !== "gente" && e.tambien.length > 0 && " · "}
                    {e.tambien.length > 0 && `también ${e.tambien.join(", ")}`}
                  </span>
                </span>
                <span className="ent-meta">
                  <span className="ent-n">
                    {e.mention_count} {e.mention_count === 1 ? "mención" : "menciones"}
                  </span>
                  <span>{when(e.last_seen)}</span>
                </span>
                <Icon name="chevronRight" size={16} />
              </button>
            </li>
          ))}
        </ol>
      ) : (
        <Empty title={filter ? `Nada con «${filter}»${tipo !== "todo" ? " en " + TIPOS.find((t) => t.id === tipo)!.plural : ""}` : "Todavía nada que se repita"}>
          {filter && tipo !== "todo" && base.length ? (
            <button className="btn small" type="button" onClick={() => setTipo("todo")}>
              ver en todo ({base.length})
            </button>
          ) : filter ? (
            "Probá con otro nombre o apodo."
          ) : null}
        </Empty>
      )}
      {!filter && ocultos > 0 && (
        <div className="row">
          <button className="btn quiet" type="button" onClick={() => setTodos(!todos)}>
            {todos ? "solo lo que más aparece" : `ver todos (${ocultos} más, nombrados una sola vez)`}
          </button>
        </div>
      )}
      {open && <EntityPlane id={open} onClose={() => setOpen(null)} onChanged={reload} />}
    </div>
  );
}

// La ficha junta todo lo de una persona aunque la memoria la tenga con varios nombres.
export function EntityPlane({
  id: pedido,
  onClose,
  onChanged,
  closeLabel = "volver a la lista",
}: {
  id: string;
  onClose: () => void;
  onChanged?: () => void;
  closeLabel?: string;
}) {
  const { tenant } = useConsole();
  const alias = useAlias();
  const id = alias.raiz(pedido);
  const otros = alias.otros(id);
  const miembros = [id, ...otros.map((a) => a.alias_id)];
  const clave = miembros.join(",");
  const ent = useLoad(async () => {
    // Los nombres unidos pueden ser apodos de la agenda («apodo:…»), que no son entidades de la memoria: si uno no se
    // puede traer, la ficha sale igual con los demás (solo falla si no se puede traer la principal).
    const rs = await Promise.allSettled(miembros.map((m) => api.get<EntityDetail>(`/t/${tenant}/memory/entities/${encodeURIComponent(m)}`)));
    if (rs[0].status === "rejected") throw rs[0].reason;
    const ds = rs.flatMap((r) => (r.status === "fulfilled" ? [r.value] : []));
    const [base, ...resto] = ds;
    const vistas = new Set<string>();
    return {
      ...base,
      mention_count: ds.reduce((a, d) => a + d.mention_count, 0),
      first_seen: ds.map((d) => d.first_seen).filter(Boolean).sort()[0] ?? base.first_seen,
      last_seen: ds.map((d) => d.last_seen).filter(Boolean).sort().at(-1) ?? base.last_seen,
      observations: [base, ...resto].flatMap((d) => d.observations).filter((o) => !vistas.has(o.text) && !!vistas.add(o.text)),
    };
  }, [tenant, clave]);
  const units = useLoad(async () => {
    const rs = await Promise.allSettled(miembros.map((m) => api.get<{ items: MemoryUnit[] }>(`/t/${tenant}/memory/units?entity=${encodeURIComponent(m)}&limit=50`)));
    if (rs[0].status === "rejected") throw rs[0].reason;
    const ls = rs.flatMap((r) => (r.status === "fulfilled" ? [r.value] : []));
    const porId = new Map(ls.flatMap((l) => l.items).map((u) => [u.id, u]));
    const items = [...porId.values()].sort((a, b) => (b.mentioned_at ?? b.date ?? "").localeCompare(a.mentioned_at ?? a.date ?? ""));
    return { items };
  }, [tenant, clave]);
  const [uniendo, setUniendo] = useState(false);
  const act = useAction();
  const [aviso, setAviso] = useState<string | null>(null);

  const separar = async (a: Alias) => {
    let r: { aviso: string | null } | null = null;
    const ok = await act.run(`sep-${a.alias_id}`, async () => {
      r = await api.del<{ aviso: string | null }>(`/t/${tenant}/memory/aliases/${encodeURIComponent(a.alias_id)}`);
    });
    if (ok) {
      toast(`«${a.alias_nombre}» separado: vuelve a ser otra persona.`, { tono: "ok" });
      setAviso((r as { aviso: string | null } | null)?.aviso ?? null);
      alias.reload();
      onChanged?.();
    }
  };

  void closeLabel; // antes era el texto de «volver»; ahora cierra el diálogo (×, Esc o tocando afuera)
  const nombreFicha = ent.data?.canonical_name ?? alias.items.find((a) => a.canonico_id === id)?.canonico_nombre ?? "…";
  return (
    <Dialog
      open
      onClose={onClose}
      size="lg"
      className="dlg-ficha"
      title={
        <span className="ficha-titulo">
          <span className="avatar avatar-lg" aria-hidden="true">
            {iniciales(nombreFicha)}
          </span>
          <span>{nombreFicha}</span>
        </span>
      }
      description={ent.data ? `${ent.data.mention_count} menciones · desde ${when(ent.data.first_seen)} · la última ${when(ent.data.last_seen)}` : undefined}
    >
      {ent.loading && !ent.data ? (
        <Loading lines={5} />
      ) : ent.error ? (
        <Failure error={ent.error} onRetry={ent.reload} />
      ) : ent.data ? (
        <>
          {otros.length > 0 && (
            <div className="nombres">
              <span className="meta">también le dice</span>
              {otros.map((a) => (
                <span key={a.alias_id} className="nombre">
                  <span>{a.alias_nombre}</span>
                  <button className="btn quiet" type="button" onClick={() => separar(a)} disabled={act.busy !== null} aria-busy={act.busy === `sep-${a.alias_id}`} aria-label={`separar ${a.alias_nombre}: no es la misma`}>
                    separar
                  </button>
                </span>
              ))}
            </div>
          )}
          {act.error && <Failure error={act.error} />}
          {aviso && (
            <p className="notice" role="status">
              <Icon name="info" size={16} />
              <span>{aviso}</span>
            </p>
          )}
          {uniendo ? (
            <Unir
              id={id}
              nombre={ent.data.canonical_name}
              menciones={ent.data.mention_count}
              onDone={(r) => {
                setUniendo(false);
                setAviso(r);
                alias.reload();
                onChanged?.();
              }}
              onCancel={() => setUniendo(false)}
            />
          ) : (
            <div className="row">
              <button className="btn small" type="button" onClick={() => setUniendo(true)}>
                <Icon name="users" size={14} />
                es la misma que…
              </button>
            </div>
          )}
          <h3 className="ficha-sub">lo que sabe</h3>
          {ent.data.observations.length ? (
            <ul className="facts">
              {ent.data.observations.map((o, i) => (
                <li key={i}>
                  <span>{o.text}</span>
                  <span className="meta">{when(o.mentioned_at)}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="meta">Todavía no armó una ficha consolidada; abajo están los recuerdos sueltos.</p>
          )}
          <h3 className="ficha-sub">recuerdos</h3>
          <UnitList units={units} />
        </>
      ) : null}
    </Dialog>
  );
}

// «es la misma que…»: sugeridos por nombre parecido + búsqueda; después elegís qué nombre queda.
function Unir({ id, nombre, menciones, onDone, onCancel }: { id: string; nombre: string; menciones: number; onDone: (aviso: string | null) => void; onCancel: () => void }) {
  const { tenant } = useConsole();
  const alias = useAlias();
  const lista = useLoad(() => api.get<{ items: Entity[] }>(`/t/${tenant}/memory/entities?limit=500`), [tenant]);
  const [q, setQ] = useState("");
  const [otra, setOtra] = useState<{ id: string; nombre: string; menciones: number } | null>(null);
  const [queda, setQueda] = useState<string | null>(null);
  const act = useAction();

  // Solo entidades «raíz» (no las que ya son otro nombre de alguien), sin ruido y sin esta misma.
  const candidatas = useMemo(() => {
    const unidas = new Set(alias.items.map((a) => a.alias_id));
    const mias = new Set([id, ...alias.otros(id).map((a) => a.alias_id)]);
    return (lista.data?.items ?? [])
      .filter((e) => !esRuido(e.canonical_name) && !unidas.has(e.id) && !mias.has(e.id))
      .sort((a, b) => b.mention_count - a.mention_count);
  }, [lista.data, alias, id]);
  const nombres = [nombre, ...alias.otros(id).map((a) => a.alias_nombre)];
  const sugeridas = candidatas.filter((e) => nombres.some((n) => parecidos(n, e.canonical_name))).slice(0, 6);
  const f = q.trim().toLowerCase();
  const encontradas = f ? candidatas.filter((e) => e.canonical_name.toLowerCase().includes(f)).slice(0, 8) : [];

  const elegir = (e: Entity) => {
    setOtra({ id: e.id, nombre: e.canonical_name, menciones: e.mention_count });
    // Por defecto queda el nombre más usado.
    setQueda(e.mention_count > menciones ? e.id : id);
  };

  const unir = async (ev: FormEvent) => {
    ev.preventDefault();
    if (!otra || !queda) return;
    const aliasId = queda === id ? otra.id : id;
    let r: { aviso: string | null } | null = null;
    const ok = await act.run("unir", async () => {
      r = await api.post<{ aviso: string | null }>(`/t/${tenant}/memory/aliases`, { alias_id: aliasId, canonico_id: queda });
    });
    if (ok) {
      toast(`Unidos: queda «${queda === id ? nombre : otra.nombre}».`, { tono: "ok" });
      onDone((r as { aviso: string | null } | null)?.aviso ?? null);
    }
  };

  const opcion = (e: Entity) => (
    <li key={e.id}>
      <button type="button" className="pick unir-opcion" onClick={() => elegir(e)} aria-pressed={otra?.id === e.id}>
        <span className="avatar" aria-hidden="true">
          {iniciales(e.canonical_name)}
        </span>
        <span className="unir-nombre">{e.canonical_name}</span>
        <span className="meta">
          {e.mention_count} {e.mention_count === 1 ? "mención" : "menciones"}
        </span>
        {otra?.id === e.id && <Icon name="check" size={16} />}
      </button>
    </li>
  );

  return (
    <form className="unir" onSubmit={unir}>
      <p className="meta">Si la memoria guardó a la misma persona, grupo o lugar con otro nombre, unilos: la ficha, la lista y la red los muestran como uno, y lo nuevo se guarda con el nombre que elijas.</p>
      {lista.loading && !lista.data ? (
        <Loading lines={3} />
      ) : (
        <>
          {sugeridas.length > 0 && (
            <>
              <h4 className="meta">¿alguna de estas?</h4>
              <ul className="unir-lista">{sugeridas.map(opcion)}</ul>
            </>
          )}
          <Field label="buscar otra">
            {(fid) => <input id={fid} className="input" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Goyo, Berna, la facu…" autoFocus={!sugeridas.length} />}
          </Field>
          {encontradas.length > 0 && <ul className="unir-lista">{encontradas.map(opcion)}</ul>}
          {f && !encontradas.length && <p className="meta">Nada con «{q}».</p>}
        </>
      )}
      {otra && (
        <fieldset className="checks">
          <legend>qué nombre queda</legend>
          {[
            { id, nombre },
            { id: otra.id, nombre: otra.nombre },
          ].map((o) => (
            <label key={o.id} className="toggle">
              <input type="radio" name="queda" checked={queda === o.id} onChange={() => setQueda(o.id)} />
              <span>{o.nombre}</span>
            </label>
          ))}
        </fieldset>
      )}
      {act.error && <Failure error={act.error} />}
      <div className="row">
        <button className="btn primary" type="submit" disabled={!otra || act.busy !== null} aria-busy={act.busy !== null}>
          {otra && queda ? `unir · queda «${queda === id ? nombre : otra.nombre}»` : "unir"}
        </button>
        <button className="btn quiet" type="button" onClick={onCancel}>
          cancelar
        </button>
      </div>
    </form>
  );
}

// ---------- recuerdos ----------

function Recuerdos({ focusId }: { focusId: string | null }) {
  const { tenant } = useConsole();
  const [q, setQ] = useState("");
  // Busca mientras escribís (espera 300 ms a que pares, para no pedir una búsqueda por letra).
  const query = useDemorado(q.trim(), 300);
  const [discarded, setDiscarded] = useState(false);
  const units = useLoad(
    () =>
      api.get<{ items: MemoryUnit[]; total: number }>(
        `/t/${tenant}/memory/units?limit=120${query ? `&q=${encodeURIComponent(query)}` : ""}${discarded ? "&state=invalidated" : ""}`,
      ),
    [tenant, query, discarded],
  );

  return (
    <div>
      <div className="recuerdos-arriba">
        <form
          className="buscador"
          role="search"
          onSubmit={(e) => e.preventDefault()}
        >
          <Icon name="search" size={16} />
          <label className="sr-only" htmlFor="buscar-recuerdo">
            buscar en los recuerdos
          </label>
          <input
            id="buscar-recuerdo"
            className="input"
            type="search"
            enterKeyHint="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Buscar: Seba, facu, comprobante…"
          />
        </form>
        <div className="choice" role="radiogroup" aria-label="qué recuerdos">
          <label>
            <input type="radio" name="rec-estado" checked={!discarded} onChange={() => setDiscarded(false)} />
            vigentes
          </label>
          <label>
            <input type="radio" name="rec-estado" checked={discarded} onChange={() => setDiscarded(true)} />
            descartados
          </label>
        </div>
      </div>
      {query && (
        <p className="meta recuerdos-q" aria-live="polite">
          {units.loading ? `Buscando «${query}»…` : `${units.data?.items.length ?? 0} recuerdos con «${query}»`}
        </p>
      )}
      <UnitList units={sinRepetidos(units)} focusId={focusId} discardedView={discarded} />
    </div>
  );
}

// Cuando la memoria resume datos sueltos en una ficha, mostrar los dos es leer lo mismo dos veces: queda la ficha.
function sinRepetidos<T extends { data: { items: MemoryUnit[] } | null }>(units: T): T {
  const items = units.data?.items;
  if (!items) return units;
  const resumidos = new Set(items.flatMap((u) => (u.fact_type === "observation" ? (u.source_memory_ids ?? []) : [])));
  return { ...units, data: { ...units.data!, items: items.filter((u) => !resumidos.has(u.id)) } };
}

function UnitList({
  units,
  focusId,
  discardedView,
}: {
  units: { data: { items: MemoryUnit[] } | null; error: ApiError | null; loading: boolean; reload: () => void };
  focusId?: string | null;
  discardedView?: boolean;
}) {
  if (units.loading && !units.data) return <Loading lines={5} />;
  if (units.error) return <Failure error={units.error} onRetry={units.reload} />;
  const items = units.data?.items ?? [];
  if (!items.length)
    return discardedView ? (
      <Empty title="Nada descartado">Lo que descartes deja de usarse pero queda acá, por si te equivocaste.</Empty>
    ) : (
      <Empty title="Sin recuerdos">Lo que el secretario guarde de tus charlas aparece acá, con fecha y de dónde salió.</Empty>
    );
  return (
    <ol className="filas units">
      {items.map((u) => (
        <Unit key={u.id} unit={u} focused={u.id === focusId} onChanged={units.reload} />
      ))}
    </ol>
  );
}

function Unit({ unit, focused, onChanged }: { unit: MemoryUnit; focused: boolean; onChanged: () => void }) {
  const { tenant } = useConsole();
  const [mode, setMode] = useState<"ver" | "corregir" | "descartar">("ver");
  const [text, setText] = useState(textoRecuerdo(unit.text));
  const [reason, setReason] = useState("");
  const act = useAction();
  const invalid = unit.state === "invalidated";
  const esFicha = unit.fact_type === "observation";

  const save = async (e: FormEvent) => {
    e.preventDefault();
    const ok = await act.run("save", () =>
      api.patch(`/t/${tenant}/memory/units/${encodeURIComponent(unit.id)}`, mode === "corregir" ? { text } : { invalidate: true, reason: reason || undefined }),
    );
    if (ok) {
      const era = mode;
      setMode("ver");
      onChanged();
      toast(
        era === "corregir"
          ? "Recuerdo corregido: rehace las fichas que dependían de él."
          : esFicha
            ? "Ficha descartada: invalidé los datos sueltos de origen."
            : "Recuerdo descartado: ya no lo usa.",
        { tono: "ok" },
      );
    }
  };

  return (
    <li className="unit" data-foco={focused} data-estado={invalid ? "descartado" : esFicha ? "ficha" : "suelto"}>
      <p className="unit-text">{textoRecuerdo(unit.text)}</p>
      <div className="unit-meta">
        {esFicha && (
          <span className="chip" data-tono="info">
            ficha
          </span>
        )}
        {invalid && (
          <span className="chip" data-tono="off">
            descartado
          </span>
        )}
        <span>{when(unit.mentioned_at ?? unit.date)}</span>
        {entitiesText(unit.entities) ? <span className="unit-ents">{entitiesText(unit.entities)}</span> : null}
        {unit.proof_count && unit.proof_count > 1 ? <span>{unit.proof_count} pruebas</span> : null}
        {unit.edited_at ? <span>corregido {when(unit.edited_at)}</span> : null}
        {invalid && unit.invalidation_reason ? <span>por: {unit.invalidation_reason}</span> : null}
        {!invalid && mode === "ver" && (
          <span className="unit-actions">
            {!esFicha && (
              <button className="btn small quiet" type="button" onClick={() => setMode("corregir")}>
                <Icon name="pencil" size={14} />
                corregir
              </button>
            )}
            <button className="btn small quiet" type="button" onClick={() => setMode("descartar")}>
              <Icon name="trash" size={14} />
              descartar
            </button>
          </span>
        )}
      </div>
      {mode !== "ver" && (
        <form className="unit-edit" onSubmit={save}>
          {mode === "corregir" ? (
            <Field label="texto corregido" hint="re-guarda el recuerdo y rehace las fichas que dependían de él">
              {(id) => <textarea id={id} className="textarea" rows={3} value={text} onChange={(e) => setText(e.target.value)} autoFocus />}
            </Field>
          ) : (
            <Field
              label="por qué lo descartás"
              hint={
                esFicha
                  ? "opcional; invalida los datos sueltos de los que sale esta ficha (ella sola no se puede editar)"
                  : "opcional; deja de usarse pero queda en el historial"
              }
            >
              {(id) => <input id={id} className="input" value={reason} onChange={(e) => setReason(e.target.value)} autoFocus placeholder="estaba mal, ya no es así…" />}
            </Field>
          )}
          {act.error && <Failure error={act.error} />}
          <div className="row">
            <button className="btn primary" type="submit" disabled={act.busy !== null || (mode === "corregir" && text.trim() === textoRecuerdo(unit.text))} aria-busy={act.busy !== null}>
              {mode === "corregir" ? "guardar corrección" : esFicha ? "descartar ficha" : "descartar recuerdo"}
            </button>
            <button
              className="btn quiet"
              type="button"
              onClick={() => {
                setMode("ver");
                setText(textoRecuerdo(unit.text));
              }}
            >
              cancelar
            </button>
          </div>
        </form>
      )}
    </li>
  );
}

// ---------- probar ----------

interface RecallOut {
  results: { id: string; text: string; type: string | null; entities: Entities; mentioned_at: string | null }[];
}

function Probar() {
  const { tenant } = useConsole();
  const [query, setQuery] = useState("");
  const [out, setOut] = useState<RecallOut | null>(null);
  const [ms, setMs] = useState<number | null>(null);
  const act = useAction();

  const ultima = useRef("");
  const recordar = async (texto: string) => {
    const t = texto.trim();
    if (!t || t === ultima.current) return;
    ultima.current = t;
    const t0 = performance.now();
    await act.run("ask", async () => {
      const r = await api.post<RecallOut>(`/t/${tenant}/memory/recall`, { query: t });
      if (ultima.current !== t) return; // ya escribiste otra cosa: esta respuesta quedó vieja
      setOut(r);
      setMs(Math.round(performance.now() - t0));
    });
  };
  // Prueba sola cuando dejás de escribir (700 ms) con al menos 4 letras; Enter la fuerza.
  const demorada = useDemorado(query, 700);
  useEffect(() => {
    if (demorada.trim().length >= 4) void recordar(demorada);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [demorada]);
  const ask = (e: FormEvent) => {
    e.preventDefault();
    ultima.current = "";
    void recordar(query);
  };

  return (
    <div className="probe">
      <form className="probe-form" onSubmit={ask}>
        <Field label="pedido de prueba">
          {(id) => (
            <input id={id} className="input" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="¿mi familia me escribió?" autoFocus enterKeyHint="search" />
          )}
        </Field>
        <button className="btn primary" type="submit" disabled={act.busy !== null || !query.trim()} aria-busy={act.busy !== null}>
          <Icon name="search" size={14} />
          recordar
        </button>
      </form>
      {act.error && <Failure error={act.error} />}
      {out &&
        (out.results.length ? (
          <>
            <p className="meta">
              {out.results.length} recuerdos en {ms} ms
            </p>
            <ol className="filas units">
              {out.results.map((r, i) => (
                <li key={r.id} className="unit">
                  <p className="unit-text">
                    <span className="probe-n">{i + 1}</span>
                    {textoRecuerdo(r.text)}
                  </p>
                  <div className="unit-meta">
                    {r.type === "observation" && (
                      <span className="chip" data-tono="info">
                        ficha
                      </span>
                    )}
                    {[when(r.mentioned_at), entitiesText(r.entities)].filter(Boolean).map((x, k) => (
                      <span key={k}>{x}</span>
                    ))}
                  </div>
                </li>
              ))}
            </ol>
          </>
        ) : (
          <Empty title="No recuerda nada sobre eso">Con este pedido el secretario tendría que preguntar.</Empty>
        ))}
    </div>
  );
}
