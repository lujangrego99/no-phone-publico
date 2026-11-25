// Ajustes de la voz natural de la llamada (Qwen-Omni Realtime de Alibaba Cloud Model Studio).
// La key se manda una vez al servidor y no vuelve: acá solo se ven sus últimos 4 caracteres.
import { useState, type FormEvent } from "react";
import type { VozConfig } from "./vozRealtime";
import { VocesGestor } from "./VocesGestor";
import { Icon } from "../components/Icon";

const pedir = async (tenant: string, method: string, path: string, body?: unknown) => {
  const r = await fetch(`/api/t/${tenant}/voz/${path}`, {
    method,
    credentials: "same-origin",
    headers: { "x-np": "1", ...(body === undefined ? {} : { "content-type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((j as { message?: string }).message ?? `Error ${r.status}`);
  return j;
};

export function VozAjustes({ tenant, cfg, onCambio, onCerrar }: { tenant: string; cfg: VozConfig | null; onCambio: (c: VozConfig | null) => void; onCerrar: () => void }) {
  const [apiKey, setApiKey] = useState("");
  const [workspaceId, setWorkspaceId] = useState(cfg?.workspaceId ?? "");
  const [region, setRegion] = useState<"intl" | "cn">(cfg?.region ?? "intl");
  const voz = cfg?.voz ?? "Sonrisa";
  const [modelo, setModelo] = useState(cfg?.modelo ?? "qwen3.5-omni-flash-realtime");
  const modelos = cfg?.modelos ?? [{ id: "qwen3.5-omni-flash-realtime", nombre: "Qwen3.5-Omni-Flash-Realtime" }];
  const [msg, setMsg] = useState<{ ok: boolean; texto: string } | null>(null);
  const [ocupado, setOcupado] = useState(false);
  const [verVoces, setVerVoces] = useState(false);

  const guardar = async (e: FormEvent) => {
    e.preventDefault();
    setOcupado(true);
    setMsg(null);
    try {
      const c = (await pedir(tenant, "PUT", "config", { apiKey: apiKey.trim() || undefined, workspaceId, region, modelo })) as VozConfig;
      setApiKey("");
      onCambio(c);
      const p = (await pedir(tenant, "POST", "probar")) as { ok: boolean; mensaje?: string };
      setMsg(p.ok ? { ok: true, texto: "Listo: la voz natural anda. Tocá «llamar»." } : { ok: false, texto: p.mensaje ?? "No anduvo." });
    } catch (err) {
      setMsg({ ok: false, texto: (err as Error).message });
    } finally {
      setOcupado(false);
    }
  };
  const borrar = async () => {
    setOcupado(true);
    try {
      await pedir(tenant, "DELETE", "config");
      onCambio(cfg ? { ...cfg, configurada: false, keyFin: null } : null);
      setMsg({ ok: true, texto: "Borrada. La llamada vuelve a la voz del navegador." });
    } catch (err) {
      setMsg({ ok: false, texto: (err as Error).message });
    } finally {
      setOcupado(false);
    }
  };

  return (
    <form className="voz-ajustes" onSubmit={guardar}>
      <p className="voz-estado">
        {cfg?.configurada ? (
          <>
            <span className="chip" data-tono="ok">
              activa
            </span>
            <span>
              Llamás con la voz <strong>{cfg.voz}</strong>.
            </span>
          </>
        ) : (
          <>
            <span className="chip" data-tono="off">
              sin configurar
            </span>
            <span>La llamada usa la voz del navegador.</span>
          </>
        )}
      </p>
      {cfg?.configurada && (
        <div className="voz-elegir">
          <button className="btn" type="button" onClick={() => setVerVoces((x) => !x)} aria-expanded={verVoces}>
            {verVoces ? "ocultar voces" : `cambiar voz (${cfg?.voces?.length ?? 0} disponibles)`}
          </button>
          {verVoces && cfg && <VocesGestor tenant={tenant} cfg={cfg} onCambio={onCambio} />}
        </div>
      )}
      <details className="voz-cuenta" open={!cfg?.configurada}>
        <summary>cuenta de Alibaba Model Studio</summary>
        <div className="voz-cuenta-campos">
          <label className="field">
            <span className="label">API key</span>
            <input className="input" type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder={cfg?.keyFin ? `cargada (…${cfg.keyFin}): dejala vacía para no cambiarla` : "sk-…"} autoComplete="off" />
            <span className="hint">Sacala en Model Studio (región Singapur) → API Key.</span>
          </label>
          <label className="field">
            <span className="label">Workspace ID</span>
            <input className="input" value={workspaceId} onChange={(e) => setWorkspaceId(e.target.value)} placeholder="ID del workspace" autoComplete="off" required />
            <span className="hint">Está en la misma página que la key.</span>
          </label>
          <div className="form-grid">
            <label className="field">
              <span className="label">región</span>
              <select className="select" value={region} onChange={(e) => setRegion(e.target.value as "intl" | "cn")}>
                <option value="intl">Singapur (internacional)</option>
                <option value="cn">Beijing (China)</option>
              </select>
            </label>
            <label className="field">
              <span className="label">modelo</span>
              <select className="select" value={modelo} onChange={(e) => setModelo(e.target.value)}>
                {modelos.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.nombre}
                  </option>
                ))}
              </select>
              <span className="hint">Solo los «Realtime» sirven para llamar.</span>
            </label>
          </div>
          {msg && (
            <p className={msg.ok ? "voz-msg" : "notice"} data-ok={msg.ok} role="status">
              {msg.texto}
            </p>
          )}
          <div className="voz-ajustes-acciones">
            {cfg?.configurada && (
              <button className="btn quiet" type="button" onClick={borrar} disabled={ocupado}>
                <Icon name="trash" size={14} />
                borrar key
              </button>
            )}
            <button className="btn primary" type="submit" disabled={ocupado || (!apiKey.trim() && !cfg?.configurada) || !workspaceId.trim()} aria-busy={ocupado}>
              {ocupado ? "probando" : "guardar y probar"}
            </button>
          </div>
        </div>
      </details>
    </form>
  );
}
