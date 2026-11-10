import { useState, type FormEvent } from "react";
import { useConsole } from "../App";
import { api, when, type DeviceView, type Piece, type Status } from "../api";
import { Icon } from "../components/Icon";
import { Empty, Failure, Field, Health, Loading, Panel, useAction, useLoad } from "../components/kit";
import { confirmar, toast } from "../components/ui";
import { WhatsappLink } from "../components/Whatsapp";

// Los mismos modos que entiende naranjax.py (NX_UI_MODE).
const UI_MODES: { id: "fast" | "normal" | "safe"; label: string }[] = [
  { id: "fast", label: "rápido" },
  { id: "normal", label: "normal" },
  { id: "safe", label: "cuidadoso" },
];

export function Herramientas({ embebido = false }: { embebido?: boolean } = {}) {
  const { tenant } = useConsole();
  const [refreshing, setRefreshing] = useState(false);
  const status = useLoad(() => api.get<Status>(`/t/${tenant}/status`), [tenant]);

  const refresh = async () => {
    setRefreshing(true);
    try {
      status.setData(await api.get<Status>(`/t/${tenant}/status?refresh=1`));
    } catch {
      /* el estado anterior queda */
    } finally {
      setRefreshing(false);
    }
  };

  const piezas = status.data ? [status.data.memory, status.data.llm, status.data.scheduler, ...status.data.mcp].filter((p): p is Piece => !!p) : [];
  const caidas = piezas.filter((p) => p.health === "caido");
  return (
    <div>
      <div className="estado-general" data-ok={status.data ? caidas.length === 0 : undefined}>
        {!embebido && <h1 className="display">herramientas.</h1>}
        {status.data ? (
          caidas.length === 0 ? (
            <span className="chip" data-tono="ok">
              todo anda
            </span>
          ) : (
            <span className="chip" data-tono="bad">
              {caidas.length === 1 ? `${caidas[0].label} no anda` : `${caidas.length} cosas no andan`}
            </span>
          )
        ) : null}
        <span className="meta">{status.data ? `revisado ${when(status.data.checkedAt)}` : "lo que el secretario puede usar"}</span>
        <button className="btn small quiet" type="button" onClick={refresh} disabled={refreshing || !status.data} aria-busy={refreshing}>
          <Icon name="reload" size={14} />
          revisar de nuevo
        </button>
      </div>
      {status.loading && !status.data ? (
        <Loading lines={6} />
      ) : status.error && !status.data ? (
        <Failure error={status.error} onRetry={status.reload} />
      ) : status.data ? (
        <>
          <Panel title="servicios" desc="Lo que el secretario necesita andando para recordar y para disparar tareas a horario.">
            <ol className="queue">
              {[status.data.memory, status.data.llm, status.data.scheduler]
                .filter((p): p is Piece => !!p)
                .map((p) => (
                  <PieceLine key={p.id} piece={p} />
                ))}
            </ol>
          </Panel>
          <Panel title="WhatsApp" desc="El número con el que el secretario lee y manda mensajes.">
            <WhatsappLink onLinked={refresh} />
          </Panel>
          <Panel title="conectores" desc="Las apps que puede usar. «probar» las llama de verdad y mide cuánto tardan.">
            {status.data.mcp.length ? (
              <ol className="queue">
                {status.data.mcp.map((p) => (
                  <McpLine key={p.id} piece={p} />
                ))}
              </ol>
            ) : (
              <Empty title="Sin conectores">El secretario no tiene herramientas registradas en su configuración.</Empty>
            )}
          </Panel>
          <Celulares onChanged={refresh} />
        </>
      ) : null}
    </div>
  );
}

function PieceLine({ piece }: { piece: Piece }) {
  const down = piece.health === "caido";
  return (
    <li className="qline" data-depth={down ? 3 : 0}>
      <div className="qline-head">
        <span className="qline-mark">
          <Health health={piece.health} />
        </span>
        <span className="qline-title">{piece.label}</span>
        <span className="leader" aria-hidden="true" />
        {!down && <span className="qline-aside">{piece.detail}</span>}
      </div>
      {down && <div className="qline-detail">{piece.detail}</div>}
    </li>
  );
}

function McpLine({ piece }: { piece: Status["mcp"][number] }) {
  const { tenant } = useConsole();
  const [p, setP] = useState(piece);
  const act = useAction();
  const name = piece.id.replace(/^mcp-/, "");

  const test = () =>
    act.run("test", async () => {
      const r = await api.post<{ ok: boolean; tools: number | null; ms: number | null; error: string | null }>(`/t/${tenant}/tools/${encodeURIComponent(name)}/test`);
      setP({
        ...p,
        health: r.ok ? "ok" : "caido",
        tools: r.tools,
        ms: r.ms,
        detail: r.ok ? `${r.tools ?? "?"} herramientas · ${r.ms ?? "?"} ms` : (r.error ?? "no responde"),
      });
    });

  return (
    <li className="qline" data-depth={p.health === "caido" ? 3 : 0}>
      <div className="qline-head">
        <span className="qline-mark">
          <Health health={p.health} />
        </span>
        <span className="qline-title">{p.label}</span>
        <span className="leader" aria-hidden="true" />
        {p.health !== "caido" && <span className="qline-aside">{p.detail}</span>}
        <span className="qline-action">
          <button className="btn quiet" type="button" onClick={test} disabled={act.busy !== null} aria-busy={act.busy !== null}>
            probar
          </button>
        </span>
      </div>
      {p.health === "caido" && <div className="qline-detail">{p.detail}</div>}
      {act.error && <div className="qline-detail">{act.error}</div>}
      {name === "movilidad" && <MapsKey />}
    </li>
  );
}

// Key de Google Maps para movilidad: solo se escribe (nunca vuelve). Sin key, busca con OpenStreetMap.
function MapsKey() {
  const { tenant } = useConsole();
  const est = useLoad(() => api.get<{ tieneKey: boolean }>(`/t/${tenant}/tools/movilidad/maps`), [tenant]);
  const [abierto, setAbierto] = useState(false);
  const [key, setKey] = useState("");
  const act = useAction();
  const tiene = est.data?.tieneKey;
  const guardar = async (e: FormEvent) => {
    e.preventDefault();
    if (await act.run("guardar", () => api.put(`/t/${tenant}/tools/movilidad/maps`, { key: key.trim() }))) {
      setKey("");
      setAbierto(false);
      est.reload();
      toast("Key de Google Maps guardada y probada.", { tono: "ok" });
    }
  };
  const quitar = async () => {
    if (
      !(await confirmar({
        titulo: "¿Quitar la key de Google Maps?",
        texto: "Las búsquedas de lugares y rutas vuelven a OpenStreetMap, donde los negocios casi no aparecen. Para volver, la tenés que pegar de nuevo.",
        si: "quitar key",
        no: "dejarla",
        peligro: true,
      }))
    )
      return;
    if (await act.run("quitar", () => api.del(`/t/${tenant}/tools/movilidad/maps`))) {
      est.reload();
      toast("Key de Google Maps quitada.", { tono: "ok" });
    }
  };
  return (
    <div className="qline-detail maps-key">
      <p className="meta">
        {est.loading && !est.data
          ? "…"
          : tiene
            ? "Google Maps: key cargada · busca lugares y rutas con Google"
            : "sin key de Google Maps · busca con OpenStreetMap (los negocios casi no aparecen)"}
      </p>
      {abierto ? (
        <form className="device-secret" onSubmit={guardar}>
          <Field label="API key de Google Maps" hint="con Places API (New) y Routes API habilitadas · se prueba antes de guardar y nunca se vuelve a mostrar">
            {(id) => <input id={id} className="input" type="password" autoComplete="off" value={key} onChange={(e) => setKey(e.target.value)} placeholder="AIza…" autoFocus />}
          </Field>
          <div className="row">
            <button className="btn primary" type="submit" disabled={key.trim().length < 20 || act.busy !== null} aria-busy={act.busy === "guardar"}>
              {act.busy === "guardar" ? "probando…" : "guardar"}
            </button>
            <button className="btn quiet" type="button" onClick={() => setAbierto(false)}>
              cancelar
            </button>
          </div>
        </form>
      ) : (
        <div className="row">
          <button className="btn quiet" type="button" onClick={() => setAbierto(true)}>
            {tiene ? "cambiar key" : "cargar key de Google Maps"}
          </button>
          {tiene && (
            <button className="btn quiet danger" type="button" onClick={quitar} disabled={act.busy !== null}>
              quitar
            </button>
          )}
        </div>
      )}
      {act.error && <Failure error={act.error} />}
    </div>
  );
}

// ---------- celulares ----------

interface DevicesOut {
  devices: DeviceView[];
  secretKeys: Record<string, { label: string; hint?: string; min?: number; max?: number }>;
}

function Celulares({ onChanged }: { onChanged: () => void }) {
  const { tenant } = useConsole();
  const devs = useLoad(() => api.get<DevicesOut>(`/t/${tenant}/devices`), [tenant]);
  const [adding, setAdding] = useState(false);
  const reload = () => {
    devs.reload();
    onChanged();
  };

  return (
    <Panel
      title="celulares"
      desc="El celular que maneja Naranja X y las apps. Tiene que estar conectado por adb."
      aside={
        !adding && (
          <button className={devs.data?.devices.length ? "btn quiet" : "btn"} type="button" onClick={() => setAdding(true)}>
            <Icon name="plus" size={16} />
            {devs.data?.devices.length ? "agregar otro" : "agregar celular"}
          </button>
        )
      }
    >
      {devs.loading && !devs.data ? (
        <Loading lines={3} />
      ) : devs.error && !devs.data ? (
        <Failure error={devs.error} onRetry={devs.reload} />
      ) : (
        <>
          {adding && (
            <NewDevice
              onDone={() => {
                setAdding(false);
                reload();
              }}
              onCancel={() => setAdding(false)}
            />
          )}
          {devs.data?.devices.length ? (
            <ol className="devices">
              {devs.data.devices.map((d) => (
                <DeviceCard key={d.id} device={d} secretKeys={devs.data!.secretKeys} multiple={devs.data!.devices.length > 1} onChanged={reload} />
              ))}
            </ol>
          ) : (
            !adding && (
              <Empty title="sin celulares">
                Naranja X y las apps del celular necesitan un celular conectado por adb. Agregá el tuyo con su serial (<code>adb devices</code>).
              </Empty>
            )
          )}
        </>
      )}
    </Panel>
  );
}

function DeviceCard({ device: d, secretKeys, multiple, onChanged }: { device: DeviceView; secretKeys: DevicesOut["secretKeys"]; multiple: boolean; onChanged: () => void }) {
  const { tenant } = useConsole();
  const [secretOpen, setSecretOpen] = useState<string | null>(null);
  const [secret, setSecret] = useState("");
  const [serial, setSerial] = useState("");
  const [more, setMore] = useState(false);
  const act = useAction();
  const base = `/t/${tenant}/devices/${encodeURIComponent(d.id)}`;
  const missing = Object.entries(d.secrets).filter(([, v]) => !v).map(([k]) => k);
  const down = d.health === "caido";
  const p = d.profile;

  const patch = (key: string, body: object) => act.run(key, () => api.patch(base, body)).then((ok) => ok && onChanged());
  const saveSecret = async (e: FormEvent) => {
    e.preventDefault();
    if (!secretOpen) return;
    if (await act.run("secret", () => api.put(`${base}/secrets/${secretOpen}`, { value: secret }))) {
      toast(`${secretKeys[secretOpen]?.label ?? "Dato"} guardado.`, { tono: "ok" });
      setSecret("");
      setSecretOpen(null);
      onChanged();
    }
  };
  const saveSerial = async (e: FormEvent) => {
    e.preventDefault();
    if (await act.run("serial", () => api.patch(base, { serial }))) onChanged();
  };
  const remove = async () => {
    if (
      !(await confirmar({
        titulo: `¿Quitar «${d.label}»?`,
        texto: "Se borran también sus datos guardados (como el PIN). Naranja X y las apps del celular dejan de andar hasta que agregues otro.",
        si: "quitar celular",
        no: "dejarlo",
        peligro: true,
      }))
    )
      return;
    if (await act.run("delete", () => api.del(base))) {
      onChanged();
      toast(`«${d.label}» quitado.`, { tono: "ok" });
    }
  };

  // Simple por defecto: estado + lo único que falta. Lo demás, en «opciones».
  return (
    <li className="device" data-estado={down ? "caido" : missing.length ? "falta" : "ok"}>
      <div className="device-head">
        <span className="qline-mark">
          <Health health={d.health} />
        </span>
        <h3 className="device-name">{d.label}</h3>
        {d.active && multiple && (
          <span className="chip" data-tono="info">
            en uso
          </span>
        )}
        <span className="leader" aria-hidden="true" />
        <span className="meta">{d.detail}</span>
      </div>

      {!d.serial && (
        <form className="device-secret" onSubmit={saveSerial}>
          <Field label="serial adb" hint="enchufalo y copiá el que muestra adb devices">
            {(id) => <input id={id} className="input mono-id" value={serial} onChange={(e) => setSerial(e.target.value.trim())} autoComplete="off" />}
          </Field>
          <div className="row">
            <button className="btn" type="submit" disabled={serial.length < 3 || act.busy !== null} aria-busy={act.busy === "serial"}>
              guardar y detectar
            </button>
          </div>
        </form>
      )}

      <div className="device-controls">
        <div className="row">
          {d.serial &&
            missing.map((k) => (
              <button key={k} className="btn primary" type="button" onClick={() => setSecretOpen(secretOpen === k ? null : k)}>
                <Icon name="lock" size={16} />
                cargar {secretKeys[k]?.label ?? k}
              </button>
            ))}
          {multiple && !d.active && d.serial && (
            <button className="btn quiet" type="button" onClick={() => patch("activate", { activate: true })} disabled={act.busy !== null} aria-busy={act.busy === "activate"}>
              usar este
            </button>
          )}
          <button className="btn quiet" type="button" aria-expanded={more} onClick={() => setMore(!more)}>
            <Icon name={more ? "chevronDown" : "chevronRight"} size={14} />
            {more ? "menos" : "opciones"}
          </button>
        </div>
      </div>

      {more && (
        <>
          <dl className="device-profile">
            <div>
              <dt>modelo</dt>
              <dd>{[p.fabricante, p.modelo].filter(Boolean).join(" ") || "—"}</dd>
            </div>
            <div>
              <dt>android</dt>
              <dd>{p.android ?? "—"}</dd>
            </div>
            <div>
              <dt>serial</dt>
              <dd className="mono-id">{d.serial ?? "—"}</dd>
            </div>
            {Object.entries(d.secrets).map(([k, has]) => (
              <div key={k}>
                <dt>{secretKeys[k]?.label ?? k}</dt>
                <dd>
                  {has ? (
                    <span className="chip" data-tono="ok">
                      cargado
                    </span>
                  ) : (
                    <span className="chip" data-tono="bad">
                      falta
                    </span>
                  )}
                </dd>
              </div>
            ))}
          </dl>
          <div className="device-controls">
            <fieldset className="choice compact">
              <legend>manejo de la pantalla</legend>
              {UI_MODES.map((m) => (
                <label key={m.id}>
                  <input type="radio" name={`ui-${d.id}`} checked={(p.ui_mode ?? "fast") === m.id} onChange={() => patch("ui", { uiMode: m.id })} disabled={act.busy !== null} />
                  {m.label}
                </label>
              ))}
            </fieldset>
            <div className="row">
              {Object.keys(d.secrets)
                .filter((k) => d.secrets[k])
                .map((k) => (
                  <button key={k} className="btn quiet" type="button" onClick={() => setSecretOpen(secretOpen === k ? null : k)}>
                    cambiar {secretKeys[k]?.label ?? k}
                  </button>
                ))}
              <button className="btn quiet" type="button" onClick={() => patch("redetect", { redetect: true })} disabled={act.busy !== null || !d.serial} aria-busy={act.busy === "redetect"}>
                <Icon name="reload" size={14} />
                volver a detectar
              </button>
              <button className="btn quiet danger" type="button" onClick={remove} disabled={act.busy !== null} aria-busy={act.busy === "delete"}>
                <Icon name="trash" size={14} />
                quitar
              </button>
            </div>
          </div>
        </>
      )}

      {secretOpen && (
        <form className="device-secret" onSubmit={saveSecret}>
          <Field label={secretKeys[secretOpen]?.label ?? secretOpen} hint="se guarda solo en este servidor; nunca se vuelve a mostrar">
            {(id) => (
              <input
                id={id}
                className="input num"
                type="password"
                inputMode="numeric"
                autoComplete="off"
                value={secret}
                onChange={(e) => setSecret(e.target.value.replace(/\D/g, "").slice(0, secretKeys[secretOpen]?.max ?? 6))}
                autoFocus
                placeholder={secretKeys[secretOpen]?.hint ?? "6 dígitos"}
              />
            )}
          </Field>
          <div className="row">
            <button className="btn primary" type="submit" disabled={secret.length < (secretKeys[secretOpen]?.min ?? 6) || secret.length > (secretKeys[secretOpen]?.max ?? 6) || act.busy !== null} aria-busy={act.busy === "secret"}>
              guardar
            </button>
            <button className="btn quiet" type="button" onClick={() => setSecretOpen(null)}>
              cancelar
            </button>
          </div>
        </form>
      )}
      {act.error && <Failure error={act.error} />}
    </li>
  );
}

const slug = (s: string) =>
  s
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
// (los ids viejos de phones.json usan guion bajo, p. ej. moto_g5: también valen)

function NewDevice({ onDone, onCancel }: { onDone: () => void; onCancel: () => void }) {
  const { tenant } = useConsole();
  const kind = "fisico"; // virtual: todavía no
  const [more, setMore] = useState(false);
  const [label, setLabel] = useState("");
  const [id, setId] = useState("");
  const [serial, setSerial] = useState("");
  const [adbServer, setAdbServer] = useState("");
  const [uiMode, setUiMode] = useState<"fast" | "normal" | "safe">("fast");
  const act = useAction();
  const devId = id || slug(label);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (await act.run("create", () => api.post(`/t/${tenant}/devices`, { id: devId, kind, label, serial, adbServer: adbServer || null, uiMode }))) onDone();
  };

  return (
    <form className="device-new" onSubmit={submit}>
      <h3 className="line-title" data-depth="3">
        celular nuevo
      </h3>
      <div className="form-grid">
        <Field label="nombre">{(fid) => <input id={fid} className="input" value={label} onChange={(e) => setLabel(e.target.value)} required autoFocus placeholder="Redmi de Goyo" />}</Field>
        <Field label="serial adb" hint="el que muestra adb devices (por WiFi: ip:5555)">
          {(fid) => <input id={fid} className="input mono-id" value={serial} onChange={(e) => setSerial(e.target.value.trim())} required autoComplete="off" />}
        </Field>
      </div>
      <div className="row">
        <button className="btn quiet" type="button" aria-expanded={more} onClick={() => setMore(!more)}>
          {more ? "menos opciones" : "más opciones"}
        </button>
      </div>
      {more && (
        <>
          <div className="form-grid">
            <Field label="id" hint="minúsculas y guiones">
              {(fid) => <input id={fid} className="input" value={devId} onChange={(e) => setId(slug(e.target.value))} required pattern="[a-z0-9][a-z0-9_-]{1,40}" />}
            </Field>
            <Field label="adb server" hint="vacío = el de esta máquina; si no, host:puerto en la red privada">
              {(fid) => <input id={fid} className="input" value={adbServer} onChange={(e) => setAdbServer(e.target.value.trim())} placeholder="100.64.0.5:5037" />}
            </Field>
          </div>
          <fieldset className="choice compact">
            <legend>manejo de la pantalla</legend>
            {UI_MODES.map((m) => (
              <label key={m.id}>
                <input type="radio" name="ui-new" checked={uiMode === m.id} onChange={() => setUiMode(m.id)} />
                {m.label}
              </label>
            ))}
          </fieldset>
        </>
      )}
      <p className="meta">Al guardarlo se lee el modelo, la versión de Android y la pantalla. Después cargás el PIN de Naranja X.</p>
      {act.error && <Failure error={act.error} />}
      <div className="row">
        <button className="btn primary" type="submit" disabled={act.busy !== null} aria-busy={act.busy !== null}>
          <Icon name="android" size={14} />
          agregar y detectar
        </button>
        <button className="btn quiet" type="button" onClick={onCancel}>
          cancelar
        </button>
      </div>
    </form>
  );
}
