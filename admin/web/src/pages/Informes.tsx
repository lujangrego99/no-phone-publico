// Informes de calidad (mejora continua): cada noche se revisan las charlas con actividad nueva y sale un informe de qué
// mejorar, con temas agrupados, dónde está la falla y qué cambiar. También se puede generar a pedido.
// Uso: leer el último informe de un vistazo (cómo vino, qué arreglar primero), mirar anteriores y el detalle por charla.
import { useState } from "react";
import { useConsole } from "../App";
import { api, when } from "../api";
import { Icon } from "../components/Icon";
import { Empty, Failure, Loading, useAction, useLoad } from "../components/kit";
import { toast } from "../components/ui";
import "../styles/informes.css";

type Tema = {
  titulo: string;
  gravedad: number;
  veces: number;
  charlas?: string[];
  que_pasa?: string;
  donde?: string;
  que_cambiar?: string;
  evidencia?: string;
};
type Informe = {
  id: number;
  at: string;
  charlas: number;
  modelo: string;
  resumen?: string;
  numeros?: { charlas?: number; bien?: number; regular?: number; mal?: number; con_resena?: number };
  temas?: Tema[];
  anda_bien?: string[];
};
type Problema = { tipo: string; gravedad: number; que_paso: string; evidencia?: string; causa_probable?: string; sugerencia?: string };
type Revision = {
  sessionId: string;
  titulo: string | null;
  at: string;
  resena: { nota: string; texto: string | null } | null;
  ficha: { resumen?: string; satisfaccion?: string; problemas?: Problema[]; vacia?: boolean; inferido?: boolean };
};

const DONDE: Record<string, string> = {
  instrucciones: "instrucciones",
  memoria: "memoria",
  herramienta: "herramienta",
  codigo: "código",
  voz: "voz",
  externo: "algo externo",
  desconocida: "sin saber",
};
const GRAVEDAD: Record<number, [string, string]> = { 3: ["grave", "bad"], 2: ["media", "warn"], 1: ["leve", "off"] };
const grav = (g: number) => GRAVEDAD[Math.max(1, Math.min(3, g))];
const SATIS: Record<string, [string, string]> = { bien: ["salió bien", "ok"], regular: ["a medias", "warn"], mal: ["salió mal", "bad"] };

function Reparto({ n }: { n: NonNullable<Informe["numeros"]> }) {
  const b = n.bien ?? 0;
  const r = n.regular ?? 0;
  const m = n.mal ?? 0;
  const tot = b + r + m;
  if (!tot) return null;
  return (
    <div className="reparto" role="img" aria-label={`${b} bien, ${r} a medias, ${m} mal`}>
      <div className="reparto-barra" aria-hidden="true">
        {b > 0 && <span data-tono="ok" style={{ flexGrow: b }} />}
        {r > 0 && <span data-tono="warn" style={{ flexGrow: r }} />}
        {m > 0 && <span data-tono="bad" style={{ flexGrow: m }} />}
      </div>
      <div className="reparto-leyenda" aria-hidden="true">
        <span data-tono="ok">{b} bien</span>
        <span data-tono="warn">{r} a medias</span>
        <span data-tono="bad">{m} mal</span>
      </div>
    </div>
  );
}

function VerInforme({ inf, titulos }: { inf: Informe; titulos: Map<string, string> }) {
  const n = inf.numeros ?? {};
  const temas = [...(inf.temas ?? [])].sort((a, b) => b.gravedad - a.gravedad || b.veces - a.veces);
  return (
    <article className="informe">
      <header className="informe-cabeza surface surface-pad">
        <p className="informe-cuando">
          {when(inf.at)} · {inf.charlas} {inf.charlas === 1 ? "charla revisada" : "charlas revisadas"}
          {n.con_resena ? ` · ${n.con_resena} con tu reseña` : ""}
        </p>
        {inf.resumen && <p className="informe-resumen">{inf.resumen}</p>}
        <Reparto n={n} />
      </header>

      <section className="informe-temas" aria-label="qué mejorar">
        <h2 className="line-title">qué mejorar {temas.length > 0 && <span className="tab-n">{temas.length}</span>}</h2>
        {temas.length ? (
          <ol className="temas">
            {temas.map((t, i) => {
              const [g, tono] = grav(t.gravedad);
              return (
                <li key={i} className="tema" data-gravedad={t.gravedad}>
                  <div className="tema-etiquetas">
                    <span className="chip" data-tono={tono}>
                      {g}
                    </span>
                    {t.veces > 1 && <span className="chip plain">{t.veces} veces</span>}
                    {t.donde && <span className="chip plain">en: {DONDE[t.donde] ?? t.donde}</span>}
                  </div>
                  <h3 className="tema-titulo">{t.titulo}</h3>
                  {t.que_pasa && <p className="tema-texto">{t.que_pasa}</p>}
                  {t.que_cambiar && (
                    <div className="tema-cambiar">
                      <span className="tema-cambiar-label">qué cambiar</span>
                      <p>{t.que_cambiar}</p>
                    </div>
                  )}
                  {(t.evidencia || t.charlas?.length) && (
                    <details className="tema-evidencia">
                      <summary>evidencia{t.charlas?.length ? ` · ${t.charlas.length} ${t.charlas.length === 1 ? "charla" : "charlas"}` : ""}</summary>
                      {t.evidencia && <blockquote>{t.evidencia}</blockquote>}
                      {t.charlas?.length ? (
                        <ul className="tema-charlas">
                          {t.charlas.map((c) => (
                            <li key={c}>{titulos.get(c) ?? "charla sin título"}</li>
                          ))}
                        </ul>
                      ) : null}
                    </details>
                  )}
                </li>
              );
            })}
          </ol>
        ) : (
          <Empty title="Nada para arreglar">En las charlas de este informe no apareció ningún problema.</Empty>
        )}
      </section>

      {inf.anda_bien?.length ? (
        <section className="informe-bien" aria-label="lo que anda bien">
          <h2 className="line-title">lo que anda bien</h2>
          <ul>
            {inf.anda_bien.map((b, i) => (
              <li key={i}>
                <Icon name="check" size={16} />
                <span>{b}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      <p className="meta informe-modelo">revisó: {inf.modelo}</p>
    </article>
  );
}

export function Informes() {
  const { tenant } = useConsole();
  const inf = useLoad(() => api.get<{ informes: Informe[]; corriendo: boolean }>(`/t/${tenant}/informes`), [tenant]);
  const rev = useLoad(() => api.get<{ revisiones: Revision[] }>(`/t/${tenant}/revisiones?limit=60`), [tenant]);
  const act = useAction();
  const [elegido, setElegido] = useState<number | null>(null);
  const [ver, setVer] = useState<"informe" | "charlas">("informe");
  const lista = inf.data?.informes ?? [];
  const revisiones = (rev.data?.revisiones ?? []).filter((r) => !r.ficha.vacia);
  const titulos = new Map(revisiones.map((r) => [r.sessionId, r.titulo ?? "charla sin título"]));
  const corriendo = act.busy === "generar" || !!inf.data?.corriendo;
  const generar = async () => {
    let r: { revisadas: number; informe: number | null; errores: string[] } | null = null;
    const ok = await act.run("generar", async () => {
      r = await api.post(`/t/${tenant}/informes/generar`);
    });
    if (ok && r) {
      const x = r as { revisadas: number; informe: number | null; errores: string[] };
      toast(
        `${x.revisadas} ${x.revisadas === 1 ? "charla revisada" : "charlas revisadas"}${x.informe ? " · informe nuevo" : " · nada nuevo para el informe"}${x.errores.length ? ` · ${x.errores.length} con error` : ""}`,
        { tono: x.errores.length ? "bad" : "ok", ms: 6000 },
      );
      if (x.informe) {
        setElegido(x.informe);
        setVer("informe");
      }
    }
    inf.reload();
    rev.reload();
  };
  const actual = lista.find((i) => i.id === elegido) ?? lista[0] ?? null;

  return (
    <div className="informes">
      <div className="page-head with-action">
        <div>
          <h1 className="display">informes.</h1>
          <p className="meta">
            Cada noche se revisan las charlas con algo nuevo y sale un informe de qué mejorar. Tu reseña al colgar, si la dejaste, manda. No cambia nada solo.
          </p>
        </div>
        <button className="btn primary" type="button" onClick={generar} disabled={act.busy !== null || inf.data?.corriendo} aria-busy={corriendo}>
          <Icon name="sparkles" size={16} />
          {corriendo ? "revisando charlas" : "generar ahora"}
        </button>
      </div>
      {corriendo && <p className="meta informes-corriendo">Puede tardar unos minutos. Podés seguir usando la consola.</p>}
      {act.error && <Failure error={act.error} />}

      <div className="tabs" role="tablist" aria-label="informes o charlas">
        <button role="tab" type="button" className="tab" aria-selected={ver === "informe"} onClick={() => setVer("informe")}>
          informe
        </button>
        <button role="tab" type="button" className="tab" aria-selected={ver === "charlas"} onClick={() => setVer("charlas")}>
          charlas revisadas
          {revisiones.length > 0 && <span className="tab-n">{revisiones.length}</span>}
        </button>
      </div>

      {ver === "informe" &&
        (inf.loading && !inf.data ? (
          <Loading lines={4} />
        ) : inf.error && !inf.data ? (
          <Failure error={inf.error} onRetry={inf.reload} />
        ) : actual ? (
          <>
            {lista.length > 1 && (
              <label className="informe-elegir">
                <span className="meta">ver el de</span>
                <select className="select" value={actual.id} onChange={(e) => setElegido(Number(e.target.value))}>
                  {lista.map((i, k) => (
                    <option key={i.id} value={i.id}>
                      {when(i.at)} · {i.temas?.length ?? 0} {i.temas?.length === 1 ? "tema" : "temas"}
                      {k === 0 ? " (el último)" : ""}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <VerInforme inf={actual} titulos={titulos} />
          </>
        ) : (
          <Empty title="Todavía no hay informes">El primero sale esta noche, o tocá «generar ahora».</Empty>
        ))}

      {ver === "charlas" &&
        (rev.loading && !rev.data ? (
          <Loading lines={3} />
        ) : rev.error && !rev.data ? (
          <Failure error={rev.error} onRetry={rev.reload} />
        ) : revisiones.length ? (
          <ol className="filas revisiones">
            {revisiones.map((r) => {
              const [s, tono] = SATIS[r.ficha.satisfaccion ?? ""] ?? ["sin dato", "off"];
              return (
                <li key={r.sessionId} className="fila revision">
                  <div className="fila-main">
                    <span className="fila-titulo">{r.titulo ?? "charla sin título"}</span>
                    <span className="fila-meta">
                      {when(r.at)} · {r.resena ? `tu reseña: ${r.resena.nota}` : "inferido por la revisión"}
                    </span>
                    {r.ficha.resumen && <p className="revision-resumen">{r.ficha.resumen}</p>}
                    {r.resena?.texto && <p className="revision-resena">Esperabas: «{r.resena.texto}»</p>}
                    {r.ficha.problemas?.length ? (
                      <ul className="revision-problemas">
                        {r.ficha.problemas.map((p, k) => {
                          const [g, t] = grav(p.gravedad);
                          return (
                            <li key={k}>
                              <span className="chip" data-tono={t}>
                                {g}
                              </span>
                              <span>
                                {p.que_paso}
                                {p.causa_probable ? <span className="meta"> · {DONDE[p.causa_probable] ?? p.causa_probable}</span> : null}
                              </span>
                            </li>
                          );
                        })}
                      </ul>
                    ) : null}
                  </div>
                  <span className="chip" data-tono={tono}>
                    {s}
                  </span>
                </li>
              );
            })}
          </ol>
        ) : (
          <Empty title="Todavía no se revisó ninguna charla">Se revisan solas a los 15 minutos de quedar quietas.</Empty>
        ))}
    </div>
  );
}
