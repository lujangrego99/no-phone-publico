// Vincular WhatsApp desde la web: estado del puente, QR que se renueva solo, código por número y desvincular.
import { useEffect, useRef, useState, type FormEvent } from "react";
import { useConsole } from "../App";
import { api, type WaStatus } from "../api";
import { Icon } from "./Icon";
import { Failure, Field, Loading, useAction } from "./kit";
import { confirmar, toast } from "./ui";

/** Mientras no está vinculado se consulta seguido (el QR vence cada ~20 s); vinculado, cada tanto. */
function useWaStatus(tenant: string) {
  const [s, setS] = useState<WaStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const alive = useRef(true);

  const poll = async () => {
    clearTimeout(timer.current);
    let next = 30_000;
    try {
      const v = await api.get<WaStatus>(`/t/${tenant}/whatsapp`);
      if (!alive.current) return;
      setS(v);
      setError(null);
      next = v.linked && v.estado === "conectado" ? 30_000 : 2500;
    } catch (e) {
      if (!alive.current) return;
      setError((e as Error).message);
      next = 5000;
    }
    timer.current = setTimeout(poll, document.hidden ? 15_000 : next);
  };

  useEffect(() => {
    alive.current = true;
    poll();
    return () => {
      alive.current = false;
      clearTimeout(timer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tenant]);

  return { s, error, poll };
}

export function WhatsappLink({ onLinked, compact }: { onLinked?: () => void; compact?: boolean }) {
  const { tenant, session } = useConsole();
  const { s, error, poll } = useWaStatus(tenant);
  const [restarting, setRestarting] = useState(false);
  const wasLinked = useRef<boolean | null>(null);
  const act = useAction();
  const isSuper = session.user?.role === "superadmin";

  const connected = !!s?.linked && s.estado === "conectado";
  useEffect(() => {
    if (!s) return;
    if (wasLinked.current === false && connected) onLinked?.();
    wasLinked.current = connected;
    if (restarting && s.reachable && s.estado !== "deslogueado") setRestarting(false);
  }, [s, connected, restarting, onLinked]);

  const unlink = async () => {
    if (
      !(await confirmar({
        titulo: "¿Desvincular WhatsApp?",
        texto: "El secretario deja de leer y mandar mensajes y se borra el historial guardado. Después podés vincular otra vez con el QR.",
        si: "desvincular",
        no: "dejarlo vinculado",
        peligro: true,
      }))
    )
      return;
    if (await act.run("logout", () => api.post(`/t/${tenant}/whatsapp/logout`))) {
      toast("WhatsApp desvinculado. Generando un QR nuevo…", { tono: "ok" });
      setRestarting(true);
      setTimeout(poll, 1500);
    }
  };

  if (!s && !error) return <Loading lines={3} />;
  if (!s) return <Failure error={error!} onRetry={poll} />;

  if (!s.configured)
    return (
      <div className="wa">
        <p className="meta">Este secretario no tiene puente de WhatsApp.</p>
        {isSuper ? <BridgeForm current={null} onSaved={poll} /> : <p className="meta">Pedile al administrador que lo configure.</p>}
      </div>
    );

  return (
    <div className="wa">
      {connected ? (
        <div className="wa-linked">
          <p className="wa-estado">
            <span className="chip" data-tono="ok">
              vinculado
            </span>
            <span>
              como <strong>{s.nombre ?? "—"}</strong>
            </span>
          </p>
          <dl className="device-profile wa-facts">
            <div>
              <dt>número</dt>
              <dd className="mono-id">{s.numero ? `+${s.numero}` : "—"}</dd>
            </div>
            <div>
              <dt>chats</dt>
              <dd>{s.chats.toLocaleString("es-AR")}</dd>
            </div>
            <div>
              <dt>mensajes guardados</dt>
              <dd>{s.mensajes.toLocaleString("es-AR")}</dd>
            </div>
          </dl>
          {!compact && (
            <div className="row">
              <button className="btn quiet wa-desvincular" type="button" onClick={unlink} disabled={act.busy !== null} aria-busy={act.busy === "logout"}>
                <Icon name="logout" size={14} />
                desvincular
              </button>
            </div>
          )}
        </div>
      ) : restarting || s.estado === "deslogueado" || (s.reachable && s.estado === "conectando" && !s.linked) ? (
        <p className="wa-wait" role="status">
          <span className="spinner" aria-hidden="true" />
          Reiniciando el puente para generar un QR nuevo…
        </p>
      ) : !s.reachable ? (
        <div className="failure" role="status">
          <Icon name="alert" size={16} />
          <span className="failure-text">
            El puente no responde{s.error && !/no responde/.test(s.error) ? `: ${s.error}` : ""}. En la máquina del puente:{" "}
            <code>systemctl --user restart no-phone-whatsapp</code>
          </span>
        </div>
      ) : s.linked ? (
        <p className="wa-wait" role="status">
          <span className="spinner" aria-hidden="true" />
          Vinculado como {s.nombre ?? s.numero}, reconectando…
        </p>
      ) : (
        <Pairing tenant={tenant} qr={s.qr} />
      )}
      {act.error && <Failure error={act.error} />}
      {isSuper && !compact && <BridgeForm current={s.url} onSaved={poll} />}
    </div>
  );
}

function Pairing({ tenant, qr }: { tenant: string; qr: string | null }) {
  const [mode, setMode] = useState<"qr" | "numero">("qr");
  const [phone, setPhone] = useState("");
  const [code, setCode] = useState<string | null>(null);
  const act = useAction();

  const ask = async (e: FormEvent) => {
    e.preventDefault();
    await act.run("pair", async () => setCode((await api.post<{ code: string }>(`/t/${tenant}/whatsapp/pair-phone`, { phone })).code));
  };

  return (
    <div className="wa-pair">
      <fieldset className="choice">
        <legend>vincular con</legend>
        <label>
          <input type="radio" name="wa-mode" checked={mode === "qr"} onChange={() => setMode("qr")} />
          código QR
        </label>
        <label>
          <input type="radio" name="wa-mode" checked={mode === "numero"} onChange={() => setMode("numero")} />
          número de teléfono
        </label>
      </fieldset>

      {mode === "qr" ? (
        <div className="wa-qr-row">
          {qr ? (
            <img className="wa-qr" src={`/api/t/${tenant}/whatsapp/qr?v=${qr}`} width={264} height={264} alt="código QR para vincular WhatsApp" />
          ) : (
            <p className="wa-wait wa-qr-espera" role="status">
              <span className="spinner" aria-hidden="true" />
              Esperando el QR…
            </p>
          )}
          <ol className="wa-steps">
            <li>Abrí WhatsApp en el celular.</li>
            <li>Ajustes → Dispositivos vinculados → Vincular dispositivo.</li>
            <li>Escaneá este código. Se renueva solo cada unos segundos.</li>
          </ol>
        </div>
      ) : code ? (
        <div className="wa-code-row">
          <p className="display wa-code" aria-label={`código ${code.split("").join(" ")}`}>
            {code}
          </p>
          <ol className="wa-steps">
            <li>En WhatsApp: Dispositivos vinculados → Vincular dispositivo.</li>
            <li>Tocá «Vincular con número de teléfono».</li>
            <li>Escribí este código.</li>
          </ol>
          <div className="row">
            <button className="btn quiet" type="button" onClick={() => setCode(null)}>
              pedir otro código
            </button>
          </div>
        </div>
      ) : (
        <form className="wa-phone" onSubmit={ask}>
          <Field label="número de WhatsApp" hint="con código de país, sin + ni espacios: 5492611234567">
            {(id) => (
              <input id={id} className="input num" inputMode="tel" autoComplete="tel" value={phone} onChange={(e) => setPhone(e.target.value.replace(/[^\d]/g, ""))} />
            )}
          </Field>
          {act.error && <Failure error={act.error} />}
          <div className="row">
            <button className="btn primary" type="submit" disabled={phone.length < 10 || act.busy !== null} aria-busy={act.busy !== null}>
              pedir código
            </button>
          </div>
        </form>
      )}
    </div>
  );
}

function BridgeForm({ current, onSaved }: { current: string | null; onSaved: () => void }) {
  const { tenant } = useConsole();
  const [open, setOpen] = useState(!current);
  const [url, setUrl] = useState(current ?? "http://127.0.0.1:8801");
  const [token, setToken] = useState("");
  const act = useAction();

  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (await act.run("bridge", () => api.put(`/t/${tenant}/whatsapp/bridge`, { url, ...(token ? { token } : {}) }))) {
      setToken("");
      setOpen(false);
      toast("Puente guardado.", { tono: "ok" });
      onSaved();
    }
  };

  if (!open)
    return (
      <div className="row wa-bridge-line">
        <span className="meta">puente {current}</span>
        <button className="btn quiet" type="button" onClick={() => setOpen(true)}>
          cambiar puente
        </button>
      </div>
    );

  return (
    <form className="wa-bridge" onSubmit={save}>
      <div className="form-grid">
        <Field label="URL del puente" hint="un puente por cuenta de WhatsApp; en el VPS, solo por la red privada">
          {(id) => <input id={id} className="input" value={url} onChange={(e) => setUrl(e.target.value.trim())} required />}
        </Field>
        <Field label="token del puente" hint="solo si corre con WA_BRIDGE_TOKEN; no se vuelve a mostrar">
          {(id) => <input id={id} className="input" type="password" autoComplete="off" value={token} onChange={(e) => setToken(e.target.value)} />}
        </Field>
      </div>
      {act.error && <Failure error={act.error} />}
      <div className="row">
        <button className="btn" type="submit" disabled={act.busy !== null} aria-busy={act.busy !== null}>
          guardar puente
        </button>
        {current && (
          <button className="btn quiet" type="button" onClick={() => setOpen(false)}>
            cancelar
          </button>
        )}
      </div>
    </form>
  );
}
