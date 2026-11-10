import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router";
import { useConsole } from "../App";
import { api, esRuido, sinTildes, TIPOS, when, type ApiError, type EntityGraph, type TipoNombre } from "../api";
import { Icon } from "../components/Icon";
import { Empty, Failure, Loading } from "../components/kit";
import { EntityPlane, iniciales, useAlias, useTipos } from "./Memoria";

// «red»: el grafo de la memoria, como la vista de grafo de Obsidian. Cada punto es alguien (persona, grupo, lugar);
// dos puntos se unen si aparecieron juntos en lo que guardó (más gruesa = más veces). Se acomoda solo con física,
// se arrastra, se hace zoom (rueda o pellizco) y se mueve el lienzo. Tocar un punto lo elige: se encienden sus
// vínculos y al costado aparece con quién aparece; doble toque (o «ver ficha») abre su ficha. Lo de al costado es
// también la versión en texto (teclado, lector de pantalla). Las líneas son co-ocurrencia: no dicen qué relación hay.

interface Nodo {
  id: string;
  label: string;
  menciones: number;
  tipo: TipoNombre;
}
interface Vecino extends Nodo {
  peso: number;
  ultimo: string | null;
}

const RECIENTE_MS = 3 * 24 * 3600 * 1000;
const key = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`);


export function Red() {
  const { tenant, setStill } = useConsole();
  const [params, setParams] = useSearchParams();
  const graph = useGrafo(tenant);
  const alias = useAlias();
  const tipoDe = useTipos();
  const [ficha, setFicha] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [verTipo, setVerTipo] = useState<TipoNombre | null>(null);

  useEffect(() => {
    setStill(!!ficha);
    return () => setStill(false);
  }, [ficha, setStill]);

  // Nodos y aristas sin ruido. Los nombres unidos (agenda) son un solo nodo, con pesos sumados.
  const red = useMemo(() => {
    const g = graph.data;
    if (!g) return null;
    const nombreDe = new Map(alias.items.map((a) => [a.canonico_id, a.canonico_nombre]));
    const nodos = new Map<string, Nodo>();
    for (const n of g.nodes) {
      if (esRuido(n.data.label)) continue;
      const r = alias.raiz(n.data.id);
      const x = nodos.get(r) ?? nodos.set(r, { id: r, label: nombreDe.get(r) ?? n.data.label, menciones: 0, tipo: tipoDe(r, nombreDe.get(r) ?? n.data.label) }).get(r)!;
      x.menciones += n.data.mentionCount;
    }
    const peso = new Map<string, { a: string; b: string; peso: number; ultimo: string | null }>();
    const vecinos = new Map<string, Set<string>>();
    for (const e of g.edges) {
      const { weight, lastCooccurred } = e.data;
      const a = alias.raiz(e.data.source);
      const b = alias.raiz(e.data.target);
      if (a === b || !nodos.has(a) || !nodos.has(b)) continue;
      const k = key(a, b);
      const previo = peso.get(k);
      peso.set(k, {
        a,
        b,
        peso: (previo?.peso ?? 0) + weight,
        ultimo: previo?.ultimo && (!lastCooccurred || previo.ultimo > lastCooccurred) ? previo.ultimo : lastCooccurred,
      });
      (vecinos.get(a) ?? vecinos.set(a, new Set()).get(a)!).add(b);
      (vecinos.get(b) ?? vecinos.set(b, new Set()).get(b)!).add(a);
    }
    const lista = [...nodos.values()].filter((n) => vecinos.has(n.id)).sort((x, y) => y.menciones - x.menciones);
    return { nodos, peso, vecinos, lista };
  }, [graph.data, alias, tipoDe]);

  const pedido = params.get("centro") ? alias.raiz(params.get("centro")!) : null;
  const sel = red && pedido && red.nodos.has(pedido) ? pedido : null;
  const elegir = (id: string | null) => setParams(id ? { ver: "red", centro: id } : { ver: "red" }, { replace: true });

  const vecinosDe = (id: string): Vecino[] =>
    red
      ? [...(red.vecinos.get(id) ?? [])]
          .map((v) => ({ ...red.nodos.get(v)!, ...red.peso.get(key(id, v))! }))
          .sort((a, b) => b.peso - a.peso || b.menciones - a.menciones)
      : [];

  if (graph.loading && !graph.data) return <Loading lines={8} />;
  if (graph.error) return <Failure error={graph.error} onRetry={graph.reload} />;
  if (!red || !red.lista.length)
    return (
      <Empty title="todavía no hay red">
        Cuando en tus charlas aparezcan personas, grupos o lugares juntos («le pasé a Seba la plata del asado»), acá se ve quién aparece con quién.
      </Empty>
    );

  const elegido = sel ? red.nodos.get(sel)! : null;
  const suyos = sel ? vecinosDe(sel) : [];
  const f = sinTildes(q.trim());
  const coinciden = f ? red.lista.filter((n) => sinTildes(n.label).includes(f)) : [];
  const encontrados = coinciden.slice(0, 6);
  // Mientras escribís se encienden en el grafo los que coinciden (y el resto se apaga); lo mismo al tocar un tipo.
  const resaltar = f ? new Set(coinciden.map((n) => n.id)) : verTipo ? new Set(red.lista.filter((n) => n.tipo === verTipo).map((n) => n.id)) : null;
  const porTipo = (t: TipoNombre) => red.lista.filter((n) => n.tipo === t).length;

  return (
    <div className="red">
      <div className="grafo">
        <div className="grafo-col">
          <form
            className="buscador grafo-buscar"
            role="search"
            onSubmit={(e) => {
              e.preventDefault();
              if (encontrados[0]) {
                elegir(encontrados[0].id);
                setQ("");
              }
            }}
          >
            <Icon name="search" size={16} />
            <label className="sr-only" htmlFor="buscar-red">
              buscar en la red
            </label>
            <input
              id="buscar-red"
              className="input"
              type="search"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => e.key === "Escape" && setQ("")}
              placeholder="Buscar: Berna, la facu, Mendoza…"
              autoComplete="off"
              enterKeyHint="search"
            />
            {f && (
              <ul className="grafo-sugeridos" aria-label={`${coinciden.length} coinciden`}>
                {encontrados.map((n) => (
                  <li key={n.id}>
                    <button
                      type="button"
                      onClick={() => {
                        elegir(n.id);
                        setQ("");
                      }}
                    >
                      <span className="tipo-punto" data-tipo={n.tipo} aria-hidden="true" />
                      <span className="grafo-sug-nombre">{n.label}</span>
                      <span className="meta">{n.menciones}</span>
                    </button>
                  </li>
                ))}
                {!coinciden.length && <li className="meta grafo-sug-vacio">Nadie con «{q.trim()}» en la red.</li>}
                {coinciden.length > encontrados.length && <li className="meta grafo-sug-vacio">y {coinciden.length - encontrados.length} más, encendidos en la red</li>}
              </ul>
            )}
          </form>
          <Grafo red={red} sel={sel} resaltar={resaltar} onSel={elegir} onAbrir={setFicha} />
          <div className="grafo-leyenda" role="group" aria-label="encender por tipo">
            {TIPOS.map((t) =>
              porTipo(t.id) ? (
                <button key={t.id} type="button" className="tipo-boton" data-tipo={t.id} aria-pressed={verTipo === t.id} onClick={() => setVerTipo(verTipo === t.id ? null : t.id)}>
                  <span className="tipo-punto" aria-hidden="true" />
                  {t.plural}
                  <span className="tipo-n">{porTipo(t.id)}</span>
                </button>
              ) : null,
            )}
          </div>
          <p className="meta grafo-ayuda">Tocá un punto para ver con quién aparece; dos toques abren su ficha. Arrastrá para moverte, rueda o pellizco para acercar.</p>
        </div>
        <aside className="grafo-lado" aria-live="polite">
          {elegido ? (
            <>
              <div className="grafo-lado-cabeza">
                <span className="avatar avatar-lg" data-tipo={elegido.tipo} aria-hidden="true">
                  {iniciales(elegido.label)}
                </span>
                <div>
                  <h2 className="grafo-titulo">{elegido.label}</h2>
                  <p className="meta">
                    {elegido.menciones} {elegido.menciones === 1 ? "mención" : "menciones"} · aparece con {suyos.length}
                  </p>
                </div>
              </div>
              <div className="row">
                <button className="btn primary" type="button" onClick={() => setFicha(elegido.id)}>
                  ver ficha
                </button>
                <button className="btn quiet" type="button" onClick={() => elegir(null)}>
                  soltar
                </button>
              </div>
              <h3 className="ficha-sub">aparece con</h3>
              <ol className="grafo-vecinos">
                {suyos.slice(0, 14).map((v) => (
                  <li key={v.id}>
                    <button type="button" className="grafo-vecino" onClick={() => elegir(v.id)}>
                      <span className="tipo-punto" data-tipo={v.tipo} aria-hidden="true" />
                      <span className="grafo-vecino-nombre">{v.label}</span>
                      <span className="meta">
                        {v.peso} {v.peso === 1 ? "vez" : "veces"} · {when(v.ultimo)}
                      </span>
                    </button>
                  </li>
                ))}
              </ol>
              {suyos.length > 14 && <p className="meta">y {suyos.length - 14} más</p>}
            </>
          ) : (
            <>
              <h2 className="grafo-titulo">Quién aparece más</h2>
              <ol className="grafo-vecinos">
                {red.lista.slice(0, 12).map((n) => (
                  <li key={n.id}>
                    <button type="button" className="grafo-vecino" onClick={() => elegir(n.id)}>
                      <span className="tipo-punto" data-tipo={n.tipo} aria-hidden="true" />
                      <span className="grafo-vecino-nombre">{n.label}</span>
                      <span className="meta">
                        {n.menciones} {n.menciones === 1 ? "mención" : "menciones"}
                      </span>
                    </button>
                  </li>
                ))}
              </ol>
            </>
          )}
        </aside>
      </div>
      {ficha && <EntityPlane id={ficha} onClose={() => setFicha(null)} onChanged={graph.reload} />}
    </div>
  );
}

function useGrafo(tenant: string) {
  // Todas las aristas (son pocas: cientos). Hindsight las devuelve ordenadas por peso.
  const [state, setState] = useState<{ data: EntityGraph | null; error: ApiError | null; loading: boolean }>({ data: null, error: null, loading: true });
  const [n, setN] = useState(0);
  useEffect(() => {
    let vivo = true;
    setState((s) => ({ ...s, loading: true }));
    api
      .get<EntityGraph>(`/t/${tenant}/memory/graph?limit=1000`)
      .then((data) => vivo && setState({ data, error: null, loading: false }))
      .catch((error) => vivo && setState({ data: null, error, loading: false }));
    return () => {
      vivo = false;
    };
  }, [tenant, n]);
  return { ...state, reload: () => setN((x) => x + 1) };
}

// ---------- grafo de fuerzas (canvas) ----------

interface P extends Nodo {
  r: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  fx: number | null;
  fy: number | null;
  grado: number;
}
interface L {
  s: P;
  t: P;
  w: number; // 0..1
  reciente: boolean;
}

type RedDatos = {
  nodos: Map<string, Nodo>;
  peso: Map<string, { a: string; b: string; peso: number; ultimo: string | null }>;
  vecinos: Map<string, Set<string>>;
  lista: Nodo[];
};

function colores() {
  const cs = getComputedStyle(document.documentElement);
  const v = (n: string, d: string) => cs.getPropertyValue(n).trim() || d;
  return {
    dust: v("--line-2", "#3b3b34"),
    frost: v("--tx-3", "#8d8a80"),
    ivory: v("--tx", "#ece8dc"),
    signal: v("--signal", "#ffb000"),
    void: v("--bg", "#0a0a09"),
    tipo: {
      gente: v("--tipo-gente", "#ece8dc"),
      grupo: v("--tipo-grupo", "#f0a3c4"),
      lugar: v("--tipo-lugar", "#66cfc0"),
      cuenta: v("--tipo-cuenta", "#8fb4ff"),
      otro: v("--tipo-otro", "#8d8a80"),
    } as Record<TipoNombre, string>,
  };
}

function Grafo({
  red,
  sel,
  resaltar,
  onSel,
  onAbrir,
}: {
  red: RedDatos;
  sel: string | null;
  resaltar: Set<string> | null;
  onSel: (id: string | null) => void;
  onAbrir: (id: string) => void;
}) {
  const caja = useRef<HTMLDivElement>(null);
  const lienzo = useRef<HTMLCanvasElement>(null);
  const [tam, setTam] = useState({ w: 0, h: 0 });
  // Todo lo que se mueve vive en refs: React no se entera de cada cuadro.
  const sim = useRef<{ nodos: P[]; porId: Map<string, P>; links: L[]; alpha: number; alphaTarget: number } | null>(null);
  // Cámara: (x, y, k) es lo que se ve; (tx, ty, tk) adonde va. vx/vy = inercia al soltar un arrastre del lienzo.
  const cam = useRef({ x: 0, y: 0, k: 1, tx: 0, ty: 0, tk: 1, vx: 0, vy: 0, siguiendo: true });
  const estado = useRef({
    hover: null as string | null,
    sel: null as string | null,
    resaltar: null as Set<string> | null,
    arrastra: null as P | null,
    mov: 0,
    raf: 0,
    pinta: () => {},
    desdeLienzo: false,
  });
  estado.current.resaltar = resaltar;
  useEffect(() => estado.current.pinta(), [resaltar]);
  const cbs = useRef({ onSel, onAbrir });
  cbs.current = { onSel, onAbrir };
  const quieto = typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  useLayoutEffect(() => {
    const el = caja.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => {
      const w = Math.round(e.contentRect.width);
      setTam({ w, h: w < 720 ? Math.round(Math.min(600, w * 1.3)) : Math.round(Math.min(680, Math.max(460, w * 0.66))) });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Armar (o rearmar) la simulación cuando cambian los datos. Conserva la posición de los que ya estaban.
  useEffect(() => {
    const viejos = sim.current?.porId;
    const lista = red.lista;
    const maxM = Math.max(1, ...lista.map((n) => n.menciones));
    const porId = new Map<string, P>();
    const nodos = lista.map((n, i) => {
      const v = viejos?.get(n.id);
      // Filotaxis: los más nombrados en el medio; arranca chico y se abre solo (se ve acomodarse).
      const ang = i * 2.399963;
      const rad = 8 * Math.sqrt(i + 0.5);
      const p: P = {
        ...n,
        r: 3.5 + 11 * Math.sqrt(n.menciones / maxM),
        x: v?.x ?? Math.cos(ang) * rad,
        y: v?.y ?? Math.sin(ang) * rad,
        vx: 0,
        vy: 0,
        fx: null,
        fy: null,
        grado: red.vecinos.get(n.id)?.size ?? 0,
      };
      porId.set(n.id, p);
      return p;
    });
    const maxW = Math.max(1, ...[...red.peso.values()].map((e) => e.peso));
    const ahora = Date.now();
    const links: L[] = [...red.peso.values()]
      .filter((e) => porId.has(e.a) && porId.has(e.b))
      .map((e) => ({ s: porId.get(e.a)!, t: porId.get(e.b)!, w: Math.sqrt(e.peso / maxW), reciente: !!e.ultimo && ahora - new Date(e.ultimo).getTime() < RECIENTE_MS }));
    sim.current = { nodos, porId, links, alpha: viejos ? 0.3 : 1, alphaTarget: 0 };
    if (!viejos) cam.current.siguiendo = true;
    if (quieto) for (let i = 0; i < 300; i++) paso(sim.current);
    estado.current.pinta();
  }, [red, quieto]);

  // Elegido desde afuera (lista, búsqueda, URL): la cámara va hacia él.
  useEffect(() => {
    estado.current.sel = sel;
    // Si lo eligió tocando el lienzo, la cámara no se mueve (como Obsidian): solo se encienden sus vínculos.
    const desdeLienzo = estado.current.desdeLienzo;
    estado.current.desdeLienzo = false;
    const p = sel && !desdeLienzo ? sim.current?.porId.get(sel) : null;
    const c = cam.current;
    if (p && sim.current) {
      // Encuadrar al elegido con sus vínculos (que se vean todos), sin acercar de más.
      const grupo = [p, ...[...(red.vecinos.get(p.id) ?? [])].map((id) => sim.current!.porId.get(id)!).filter(Boolean)];
      const xs = grupo.map((n) => n.x);
      const ys = grupo.map((n) => n.y);
      const ancho = Math.max(...xs) - Math.min(...xs) || 1;
      const alto = Math.max(...ys) - Math.min(...ys) || 1;
      const w = caja.current?.clientWidth ?? 800;
      const h = caja.current?.clientHeight ?? 600;
      c.siguiendo = false;
      c.tk = Math.min(1.8, Math.max(0.45, Math.min((w - 140) / ancho, (h - 120) / alto)));
      c.tx = -((Math.max(...xs) + Math.min(...xs)) / 2) * c.tk;
      c.ty = -((Math.max(...ys) + Math.min(...ys)) / 2) * c.tk;
    }
    estado.current.pinta();
  }, [sel, red]);

  // Bucle de dibujo + física.
  useEffect(() => {
    const cv = lienzo.current;
    if (!cv || !tam.w) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    cv.width = tam.w * dpr;
    cv.height = tam.h * dpr;
    cv.style.width = `${tam.w}px`;
    cv.style.height = `${tam.h}px`;
    const ctx = cv.getContext("2d")!;
    const col = colores();
    const E = estado.current;

    const encuadrar = () => {
      const s = sim.current;
      if (!s?.nodos.length) return;
      // Encuadra el 90 % del medio: los sueltos de la punta no achican todo.
      const xs = s.nodos.map((n) => n.x).sort((a, b) => a - b);
      const ys = s.nodos.map((n) => n.y).sort((a, b) => a - b);
      const q = (v: number[], f: number) => v[Math.min(v.length - 1, Math.max(0, Math.round(f * (v.length - 1))))];
      const x0 = q(xs, 0.05), x1 = q(xs, 0.95), y0 = q(ys, 0.05), y1 = q(ys, 0.95);
      const k = Math.min(2, Math.max(0.45, Math.min((tam.w - 120) / (x1 - x0 || 1), (tam.h - 120) / (y1 - y0 || 1))));
      const c = cam.current;
      c.tk = k;
      c.tx = -((x0 + x1) / 2) * k;
      c.ty = -((y0 + y1) / 2) * k;
    };

    const dibujar = () => {
      const s = sim.current;
      if (!s) return;
      const c = cam.current;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, tam.w, tam.h);
      ctx.translate(tam.w / 2 + c.x, tam.h / 2 + c.y);
      ctx.scale(c.k, c.k);
      const foco = E.arrastra?.id ?? E.hover ?? E.sel;
      const cerca = foco ? red.vecinos.get(foco) : null;
      const R = foco ? null : E.resaltar; // la búsqueda/tipo enciende solo si no hay nadie elegido
      // líneas
      for (const l of s.links) {
        const tocada = foco !== null && (l.s.id === foco || l.t.id === foco);
        ctx.globalAlpha = foco ? (tocada ? 0.9 : 0.06) : R ? (R.has(l.s.id) && R.has(l.t.id) ? 0.5 : 0.04) : (l.reciente ? 0.2 : 0.12) + 0.55 * l.w;
        ctx.strokeStyle = tocada ? col.ivory : l.reciente ? col.frost : col.dust;
        ctx.lineWidth = (0.5 + 2.2 * l.w) / Math.sqrt(c.k);
        ctx.beginPath();
        ctx.moveTo(l.s.x, l.s.y);
        ctx.lineTo(l.t.x, l.t.y);
        ctx.stroke();
      }
      // puntos (al alejar se achican menos que el resto, para que se sigan viendo)
      const escala = Math.pow(c.k, -0.45);
      for (const n of s.nodos) {
        const esFoco = n.id === foco;
        const vecino = !!cerca?.has(n.id);
        ctx.globalAlpha = (foco && !esFoco && !vecino) || (R && !R.has(n.id)) ? 0.18 : 1;
        ctx.fillStyle = esFoco ? col.signal : col.tipo[n.tipo];
        ctx.beginPath();
        ctx.arc(n.x, n.y, n.r * escala + (esFoco ? 2 / c.k : 0), 0, Math.PI * 2);
        ctx.fill();
      }
      // nombres: los grandes siempre; el resto aparece al acercar (como Obsidian) o si están encendidos
      const fs = 12 / c.k;
      ctx.font = `600 ${fs}px "Atkinson Hyperlegible Next", system-ui, sans-serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "top";
      // Nombres que se pisarían con uno ya escrito (de más arriba en el ranking) no se escriben.
      const puestos: { x0: number; y0: number; x1: number; y1: number }[] = [];
      s.nodos.forEach((n, rango) => {
        const esFoco = n.id === foco;
        const vecino = !!cerca?.has(n.id);
        // sin foco: los más nombrados siempre llevan nombre; al acercar aparecen todos
        const a = foco ? (esFoco || vecino ? 1 : 0) : R ? (R.has(n.id) ? 1 : 0) : rango < 10 ? 0.9 : Math.max(0, Math.min(1, (c.k - 1.2) * 2 - rango / 80));
        if (a <= 0.02) return;
        ctx.globalAlpha = a;
        const texto = n.label.length > 26 ? n.label.slice(0, 25) + "…" : n.label;
        const y = n.y + n.r * escala + 4 / c.k;
        // fondo negro detrás del nombre para que las líneas no lo tapen
        ctx.fillStyle = col.void;
        const ancho = ctx.measureText(texto).width;
        const caja = { x0: n.x - ancho / 2 - 3 / c.k, y0: y, x1: n.x + ancho / 2 + 3 / c.k, y1: y + fs + 2 / c.k };
        if (!esFoco && puestos.some((b) => caja.x0 < b.x1 && caja.x1 > b.x0 && caja.y0 < b.y1 && caja.y1 > b.y0)) return;
        puestos.push(caja);
        ctx.globalAlpha = a * 0.7;
        ctx.fillRect(n.x - ancho / 2 - 2 / c.k, y - 1 / c.k, ancho + 4 / c.k, fs + 2 / c.k);
        ctx.globalAlpha = a;
        ctx.fillStyle = esFoco ? col.signal : vecino || R?.has(n.id) ? col.ivory : col.frost;
        ctx.fillText(texto, n.x, y);
      });
      ctx.globalAlpha = 1;
    };

    let vivo = true;
    const cuadro = () => {
      E.raf = 0;
      if (!vivo) return;
      const s = sim.current;
      const c = cam.current;
      let sigue = false;
      if (s && (s.alpha > 0.004 || s.alphaTarget > 0)) {
        paso(s);
        sigue = true;
        if (c.siguiendo) encuadrar();
      }
      // inercia: después de soltar un arrastre del lienzo sigue deslizando y frena solo
      if (!paneo && (Math.abs(c.vx) > 0.15 || Math.abs(c.vy) > 0.15)) {
        c.tx += c.vx;
        c.ty += c.vy;
        c.x = c.tx;
        c.y = c.ty;
        c.vx *= 0.9;
        c.vy *= 0.9;
        sigue = true;
      } else {
        c.vx = c.vy = 0;
      }
      // cámara suave hacia su objetivo
      const d = Math.abs(c.tx - c.x) + Math.abs(c.ty - c.y) + Math.abs(c.tk - c.k) * 200;
      if (d > 0.3) {
        const f = quieto ? 1 : 0.22;
        c.x += (c.tx - c.x) * f;
        c.y += (c.ty - c.y) * f;
        c.k += (c.tk - c.k) * f;
        sigue = true;
      } else {
        c.x = c.tx;
        c.y = c.ty;
        c.k = c.tk;
      }
      dibujar();
      if (sigue) E.raf = requestAnimationFrame(cuadro);
    };
    E.pinta = () => {
      if (!E.raf && vivo) E.raf = requestAnimationFrame(cuadro);
    };
    if (cam.current.siguiendo) encuadrar();
    E.pinta();
    // Solo en desarrollo: para probar el grafo desde afuera (posición en pantalla de cada punto).
    if (import.meta.env.DEV)
      (window as unknown as Record<string, unknown>).__grafo = () => {
        const b = cv.getBoundingClientRect();
        const c = cam.current;
        return (sim.current?.nodos ?? []).map((n) => ({ id: n.id, label: n.label, x: b.left + tam.w / 2 + c.x + n.x * c.k, y: b.top + tam.h / 2 + c.y + n.y * c.k }));
      };

    // ---------- interacción ----------
    const mundo = (ev: { clientX: number; clientY: number }) => {
      const b = cv.getBoundingClientRect();
      const c = cam.current;
      return { x: (ev.clientX - b.left - tam.w / 2 - c.x) / c.k, y: (ev.clientY - b.top - tam.h / 2 - c.y) / c.k };
    };
    const tocado = (m: { x: number; y: number }) => {
      const s = sim.current;
      if (!s) return null;
      let mejor: P | null = null;
      let dm = Infinity;
      for (const n of s.nodos) {
        const d = Math.hypot(n.x - m.x, n.y - m.y);
        if (d < n.r * Math.pow(cam.current.k, -0.45) + 8 / cam.current.k && d < dm) {
          dm = d;
          mejor = n;
        }
      }
      return mejor;
    };
    const dedos = new Map<number, { x: number; y: number }>();
    let pinza: { d: number; k: number; mx: number; my: number; cx: number; cy: number } | null = null;
    let huella: { x: number; y: number; t: number }[] = []; // últimos puntos del arrastre, para la inercia
    let paneo: { x: number; y: number; cx: number; cy: number } | null = null;
    let inicio = { x: 0, y: 0 };
    let ultimoToque = { id: "", t: 0, x: 0, y: 0 };

    const abajo = (ev: PointerEvent) => {
      cv.setPointerCapture(ev.pointerId);
      dedos.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
      cam.current.siguiendo = false;
      cam.current.vx = cam.current.vy = 0;
      if (dedos.size === 2) {
        const [a, b] = [...dedos.values()];
        const bx = cv.getBoundingClientRect();
        pinza = { d: Math.hypot(a.x - b.x, a.y - b.y), k: cam.current.tk, mx: (a.x + b.x) / 2 - bx.left - tam.w / 2, my: (a.y + b.y) / 2 - bx.top - tam.h / 2, cx: cam.current.tx, cy: cam.current.ty };
        if (E.arrastra) {
          E.arrastra.fx = E.arrastra.fy = null;
          if (sim.current) sim.current.alphaTarget = 0;
        }
        E.arrastra = null;
        paneo = null;
        return;
      }
      inicio = { x: ev.clientX, y: ev.clientY };
      huella = [{ x: ev.clientX, y: ev.clientY, t: performance.now() }];
      E.mov = 0;
      const n = tocado(mundo(ev));
      if (n) {
        // Se fija y recalienta la física recién cuando de verdad lo arrastra (un toque no mueve nada).
        E.arrastra = n;
      } else {
        paneo = { x: ev.clientX, y: ev.clientY, cx: cam.current.tx, cy: cam.current.ty };
      }
      E.pinta();
    };
    const mueve = (ev: PointerEvent) => {
      if (dedos.has(ev.pointerId)) dedos.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
      if (pinza && dedos.size === 2) {
        // Pellizco anclado entre los dedos (lo que está entre los dedos queda entre los dedos) y, si los movés juntos,
        // también desplaza. Sin suavizado: tiene que seguir al dedo exacto.
        const [a, b] = [...dedos.values()];
        const bx = cv.getBoundingClientRect();
        const k = Math.min(4, Math.max(0.2, (pinza.k * Math.hypot(a.x - b.x, a.y - b.y)) / pinza.d));
        const mx = (a.x + b.x) / 2 - bx.left - tam.w / 2;
        const my = (a.y + b.y) / 2 - bx.top - tam.h / 2;
        const c = cam.current;
        c.tx = c.x = mx - ((pinza.mx - pinza.cx) * k) / pinza.k;
        c.ty = c.y = my - ((pinza.my - pinza.cy) * k) / pinza.k;
        c.tk = c.k = k;
        E.pinta();
        return;
      }
      E.mov = Math.max(E.mov, Math.hypot(ev.clientX - inicio.x, ev.clientY - inicio.y));
      if (E.arrastra && E.mov >= 4) {
        const m = mundo(ev);
        E.arrastra.fx = m.x;
        E.arrastra.fy = m.y;
        if (sim.current && sim.current.alphaTarget === 0) {
          sim.current.alphaTarget = 0.25;
          sim.current.alpha = Math.max(sim.current.alpha, 0.25);
        }
        E.pinta();
      } else if (paneo) {
        const c = cam.current;
        c.tx = c.x = paneo.cx + ev.clientX - paneo.x;
        c.ty = c.y = paneo.cy + ev.clientY - paneo.y;
        const ahora = performance.now();
        huella.push({ x: ev.clientX, y: ev.clientY, t: ahora });
        huella = huella.filter((h) => ahora - h.t < 100);
        E.pinta();
      } else if (ev.pointerType === "mouse") {
        const n = tocado(mundo(ev));
        const id = n?.id ?? null;
        cv.style.cursor = n ? "pointer" : "grab";
        if (id !== E.hover) {
          E.hover = id;
          E.pinta();
        }
      }
    };
    const arriba = (ev: PointerEvent) => {
      dedos.delete(ev.pointerId);
      if (pinza) {
        if (dedos.size < 2) pinza = null;
        return;
      }
      // Soltar un arrastre del lienzo con velocidad: sigue deslizando (como un mapa).
      if (paneo && huella.length > 1 && E.mov >= 6) {
        const a = huella[0];
        const b = huella[huella.length - 1];
        const dt = Math.max(16, b.t - a.t);
        if (performance.now() - b.t < 60) {
          cam.current.vx = Math.max(-40, Math.min(40, ((b.x - a.x) / dt) * 16));
          cam.current.vy = Math.max(-40, Math.min(40, ((b.y - a.y) / dt) * 16));
        }
      }
      const n = E.arrastra;
      if (n) {
        n.fx = null;
        n.fy = null;
        if (sim.current) sim.current.alphaTarget = 0;
      }
      if (E.mov < 6) {
        // toque (no arrastre): elegir; dos toques seguidos en el mismo lugar abren la ficha
        const ahora = performance.now();
        const doble = ahora - ultimoToque.t < 450 && Math.hypot(ev.clientX - ultimoToque.x, ev.clientY - ultimoToque.y) < 14;
        if (doble && ultimoToque.id && n?.id === ultimoToque.id) {
          cbs.current.onAbrir(ultimoToque.id);
          ultimoToque = { id: "", t: 0, x: 0, y: 0 };
        } else if (n) {
          ultimoToque = { id: n.id, t: ahora, x: ev.clientX, y: ev.clientY };
          E.desdeLienzo = true;
          cbs.current.onSel(n.id);
        } else if (paneo) {
          // doble toque en el vacío: acerca ahí (como en un mapa); un toque suelta al elegido
          const vacioDoble = ahora - ultimoToque.t < 350 && !ultimoToque.id && Math.hypot(ev.clientX - ultimoToque.x, ev.clientY - ultimoToque.y) < 24;
          if (vacioDoble) {
            acercarEn(ev.clientX, ev.clientY, 1.8);
            ultimoToque = { id: "", t: 0, x: 0, y: 0 };
          } else {
            ultimoToque = { id: "", t: ahora, x: ev.clientX, y: ev.clientY };
            E.desdeLienzo = true;
            cbs.current.onSel(null);
          }
        }
      }
      E.arrastra = null;
      paneo = null;
      E.pinta();
    };
    const sale = () => {
      if (E.hover) {
        E.hover = null;
        E.pinta();
      }
    };
    const acercarEn = (clientX: number, clientY: number, f: number, inmediato = false) => {
      const b = cv.getBoundingClientRect();
      const c = cam.current;
      c.siguiendo = false;
      c.vx = c.vy = 0;
      const k = Math.min(4, Math.max(0.2, c.tk * f));
      // zoom hacia el cursor: el punto bajo el cursor no se mueve
      const px = clientX - b.left - tam.w / 2;
      const py = clientY - b.top - tam.h / 2;
      c.tx = px - ((px - c.tx) * k) / c.tk;
      c.ty = py - ((py - c.ty) * k) / c.tk;
      c.tk = k;
      if (inmediato) {
        c.x = c.tx;
        c.y = c.ty;
        c.k = c.tk;
      }
      E.pinta();
    };
    const rueda = (ev: WheelEvent) => {
      ev.preventDefault();
      const px = ev.deltaMode === 1 ? 16 : ev.deltaMode === 2 ? tam.h : 1;
      const dx = ev.deltaX * px;
      const dy = ev.deltaY * px;
      // Pellizco del touchpad (llega como rueda con Ctrl): acerca, pegado al gesto.
      if (ev.ctrlKey) return acercarEn(ev.clientX, ev.clientY, Math.exp(-dy * 0.01), true);
      // Dos dedos en el touchpad (deltas finos o de costado): desplaza, como en cualquier mapa o en Figma.
      const touchpad = ev.deltaMode === 0 && (Math.abs(dx) > 0 || (Math.abs(dy) < 40 && !Number.isInteger(dy / 4)));
      if (touchpad) {
        const c = cam.current;
        c.siguiendo = false;
        c.vx = c.vy = 0;
        c.tx = c.x = c.x - dx;
        c.ty = c.y = c.y - dy;
        E.pinta();
        return;
      }
      // Rueda del mouse: acerca o aleja de a pasos suaves.
      acercarEn(ev.clientX, ev.clientY, Math.exp(-Math.max(-300, Math.min(300, dy)) * 0.0018));
    };
    cv.addEventListener("pointerdown", abajo);
    cv.addEventListener("pointermove", mueve);
    cv.addEventListener("pointerup", arriba);
    cv.addEventListener("pointercancel", arriba);
    cv.addEventListener("pointerleave", sale);
    cv.addEventListener("wheel", rueda, { passive: false });
    return () => {
      vivo = false;
      cancelAnimationFrame(E.raf);
      E.raf = 0;
      cv.removeEventListener("pointerdown", abajo);
      cv.removeEventListener("pointermove", mueve);
      cv.removeEventListener("pointerup", arriba);
      cv.removeEventListener("pointercancel", arriba);
      cv.removeEventListener("pointerleave", sale);
      cv.removeEventListener("wheel", rueda);
    };
  }, [tam, red, quieto]);

  const zoom = (f: number) => {
    const c = cam.current;
    c.siguiendo = false;
    const k = Math.min(4, Math.max(0.2, c.tk * f));
    c.tx = (c.tx * k) / c.tk;
    c.ty = (c.ty * k) / c.tk;
    c.tk = k;
    estado.current.pinta();
  };

  return (
    <div className="grafo-lienzo" ref={caja}>
      <canvas ref={lienzo} role="img" aria-label={`Grafo de ${red.lista.length} personas, grupos y lugares de la memoria. Al costado está la misma información en texto.`} />
      <div className="grafo-controles">
        <button className="btn quiet" type="button" onClick={() => zoom(1.3)} aria-label="acercar">
          +
        </button>
        <button className="btn quiet" type="button" onClick={() => zoom(1 / 1.3)} aria-label="alejar">
          −
        </button>
        <button
          className="btn quiet"
          type="button"
          onClick={() => {
            cam.current.siguiendo = true;
            if (sim.current) sim.current.alpha = Math.max(sim.current.alpha, 0.05);
            estado.current.pinta();
          }}
        >
          encuadrar
        </button>
      </div>
    </div>
  );
}

// Un paso de la física (al estilo d3-force): resortes en las líneas, repulsión entre todos, un poco de gravedad al
// centro y sin superponerse. alpha baja sola hasta que todo queda quieto; arrastrar la vuelve a subir.
function paso(s: { nodos: P[]; links: L[]; alpha: number; alphaTarget: number }) {
  const { nodos, links } = s;
  const a = s.alpha;
  for (const l of links) {
    const dx = l.t.x + l.t.vx - l.s.x - l.s.vx || 0.01;
    const dy = l.t.y + l.t.vy - l.s.y - l.s.vy || 0.01;
    const d = Math.hypot(dx, dy);
    const largo = 110 - 50 * l.w + l.s.r + l.t.r;
    const fuerza = ((d - largo) / d) * a * (0.25 + 0.6 * l.w) / Math.min(l.s.grado, l.t.grado);
    const bs = l.t.grado / (l.s.grado + l.t.grado);
    l.t.vx -= dx * fuerza * bs;
    l.t.vy -= dy * fuerza * bs;
    l.s.vx += dx * fuerza * (1 - bs);
    l.s.vy += dy * fuerza * (1 - bs);
  }
  for (let i = 0; i < nodos.length; i++) {
    const p = nodos[i];
    for (let j = i + 1; j < nodos.length; j++) {
      const q = nodos[j];
      let dx = q.x - p.x;
      let dy = q.y - p.y;
      let d2 = dx * dx + dy * dy;
      if (d2 < 1) {
        dx = (Math.random() - 0.5) * 2;
        dy = (Math.random() - 0.5) * 2;
        d2 = dx * dx + dy * dy + 1;
      }
      if (d2 > 360000) continue; // más de 600 px: no se empujan
      const f = (-(380 + 40 * (p.r + q.r)) * a) / d2;
      p.vx += dx * f;
      p.vy += dy * f;
      q.vx -= dx * f;
      q.vy -= dy * f;
      const min = p.r + q.r + 6;
      if (d2 < min * min) {
        const d = Math.sqrt(d2);
        const empuje = ((min - d) / d) * 0.5;
        p.x -= dx * empuje;
        p.y -= dy * empuje;
        q.x += dx * empuje;
        q.y += dy * empuje;
      }
    }
  }
  for (const n of nodos) {
    n.vx -= n.x * 0.006 * a;
    n.vy -= n.y * 0.006 * a;
    if (n.fx !== null && n.fy !== null) {
      n.x = n.fx;
      n.y = n.fy;
      n.vx = n.vy = 0;
      continue;
    }
    n.vx *= 0.6;
    n.vy *= 0.6;
    n.x += n.vx;
    n.y += n.vy;
  }
  s.alpha += (s.alphaTarget - s.alpha) * 0.0228;
}
