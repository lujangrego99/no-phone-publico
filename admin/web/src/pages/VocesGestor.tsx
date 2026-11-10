// Gestor de voces de la llamada: todas las voces del modelo que hablan castellano, con búsqueda, filtros, «escuchar»
// (muestra real de Qwen con una frase editable; queda en caché), favoritas y «usar esta».
import { useMemo, useRef, useState } from "react";
import type { VozConfig, VozInfo } from "./vozRealtime";

const GRUPOS = [
  { id: "todas", nombre: "todas" },
  { id: "castellano", nombre: "para castellano" },
  { id: "neutra", nombre: "neutras" },
  { id: "acento", nombre: "con acento" },
  { id: "favoritas", nombre: "★ favoritas" },
] as const;
type Grupo = (typeof GRUPOS)[number]["id"];

const guardar = async (tenant: string, body: Record<string, unknown>) => {
  const r = await fetch(`/api/t/${tenant}/voz/config`, {
    method: "PUT",
    credentials: "same-origin",
    headers: { "x-np": "1", "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((j as { message?: string }).message ?? `Error ${r.status}`);
  return j as VozConfig;
};

export function VocesGestor({ tenant, cfg, onCambio }: { tenant: string; cfg: VozConfig; onCambio: (c: VozConfig) => void }) {
  const [grupo, setGrupo] = useState<Grupo>("castellano");
  const [genero, setGenero] = useState<"" | "f" | "m">("");
  const [buscar, setBuscar] = useState("");
  const [frase, setFrase] = useState("Hola Goyo, soy tu secretario. ¿Le paso diez lucas al Berna?");
  const [sonando, setSonando] = useState<string | null>(null);
  const [cargando, setCargando] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const audio = useRef<HTMLAudioElement | null>(null);
  const favs = new Set(cfg.favoritas ?? []);

  const lista = useMemo(() => {
    const q = buscar.trim().toLowerCase();
    return (cfg.voces as readonly VozInfo[]).filter(
      (v) =>
        (grupo === "todas" || (grupo === "favoritas" ? favs.has(v.id) : v.grupo === grupo)) &&
        (!genero || v.genero === genero) &&
        (!q || v.id.toLowerCase().includes(q) || v.desc.toLowerCase().includes(q)),
    );
  }, [cfg.voces, grupo, genero, buscar, cfg.favoritas]); // eslint-disable-line react-hooks/exhaustive-deps

  const escuchar = async (id: string) => {
    setError(null);
    audio.current?.pause();
    if (sonando === id) return setSonando(null);
    setCargando(id);
    try {
      const r = await fetch(`/api/t/${tenant}/voz/muestra`, {
        method: "POST",
        credentials: "same-origin",
        headers: { "x-np": "1", "content-type": "application/json" },
        body: JSON.stringify({ voz: id, frase }),
      });
      if (!r.ok) throw new Error(((await r.json().catch(() => ({}))) as { message?: string }).message ?? `Error ${r.status}`);
      const a = new Audio(URL.createObjectURL(await r.blob()));
      audio.current = a;
      a.onended = () => setSonando(null);
      setSonando(id);
      await a.play();
    } catch (e) {
      setError((e as Error).message);
      setSonando(null);
    } finally {
      setCargando(null);
    }
  };
  const usar = async (id: string) => {
    setError(null);
    try {
      onCambio(await guardar(tenant, { voz: id }));
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const favorita = async (id: string) => {
    setError(null);
    const nuevas = favs.has(id) ? [...favs].filter((x) => x !== id) : [...favs, id];
    try {
      onCambio(await guardar(tenant, { favoritas: nuevas }));
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <div className="voces">
      <p className="meta">
        {cfg.voces.length} voces del modelo que hablan castellano. Tocá ▶ para escucharlas con tu frase (la primera vez tarda unos
        segundos; después queda guardada). En uso: <b>{cfg.voz}</b>.
      </p>
      <label>
        <span className="meta">frase de prueba</span>
        <input className="input" value={frase} onChange={(e) => setFrase(e.target.value)} maxLength={200} />
      </label>
      <div className="voces-filtros">
        {GRUPOS.map((g) => (
          <button key={g.id} type="button" className={`btn quiet${grupo === g.id ? " activo" : ""}`} aria-pressed={grupo === g.id} onClick={() => setGrupo(g.id)}>
            {g.nombre}
          </button>
        ))}
        <select className="input" value={genero} onChange={(e) => setGenero(e.target.value as "" | "f" | "m")} aria-label="género">
          <option value="">mujer y hombre</option>
          <option value="f">mujer</option>
          <option value="m">hombre</option>
        </select>
        <input className="input" value={buscar} onChange={(e) => setBuscar(e.target.value)} placeholder="buscar…" aria-label="buscar voz" />
      </div>
      {error && (
        <p className="notice" role="status">
          {error}
        </p>
      )}
      <ol className="voces-lista">
        {lista.length === 0 && <li className="meta">no hay voces con ese filtro</li>}
        {lista.map((v) => (
          <li key={v.id} className="voz-fila" data-uso={v.id === cfg.voz}>
            <button type="button" className="btn quiet voz-fav" onClick={() => favorita(v.id)} aria-pressed={favs.has(v.id)} title={favs.has(v.id) ? "sacar de favoritas" : "marcar favorita"}>
              {favs.has(v.id) ? "★" : "☆"}
            </button>
            <span className="voz-nombre">
              <b>{v.id}</b> <span className="meta">· {v.genero === "f" ? "mujer" : "hombre"}</span>
              <span className="meta voz-desc">{v.desc}</span>
            </span>
            <button type="button" className="btn quiet" onClick={() => escuchar(v.id)} disabled={!cfg.configurada || cargando !== null} title={cfg.configurada ? "escuchar" : "cargá la key primero"}>
              {cargando === v.id ? "…" : sonando === v.id ? "■" : "▶"}
            </button>
            {v.id === cfg.voz ? (
              <span className="meta voz-uso">en uso</span>
            ) : (
              <button type="button" className="btn quiet" onClick={() => usar(v.id)} disabled={!cfg.configurada}>
                usar
              </button>
            )}
          </li>
        ))}
      </ol>
    </div>
  );
}
