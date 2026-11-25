import { useState, type FormEvent } from "react";
import { useConsole } from "../App";
import { api, when } from "../api";
import { Icon } from "../components/Icon";
import { Empty, Failure, Field, Loading, PASSWORD_HINT, PASSWORD_PATTERN, Panel, useAction, useLoad } from "../components/kit";
import { confirmar, toast } from "../components/ui";

interface TenantRow {
  id: string;
  name: string;
  bankId: string;
  hermesHome: string;
  createdAt: string;
  devices: number;
  users: { id: number; name: string; email: string; role: "superadmin" | "owner" }[];
}

const slug = (s: string) =>
  s
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 30);

export function Tenants({ embebido = false }: { embebido?: boolean } = {}) {
  const { session, refreshSession, setTenant } = useConsole();
  const rows = useLoad(() => api.get<TenantRow[]>("/admin/tenants"), []);
  const [adding, setAdding] = useState(false);

  const created = async (id: string) => {
    setAdding(false);
    rows.reload();
    await refreshSession();
    setTenant(id);
  };

  return (
    <div>
      <div className="page-head with-action">
        <div>
          {!embebido && <h1 className="display">tenants.</h1>}
          <p className="meta">cada persona con su propio secretario, memoria y celulares</p>
        </div>
        {!adding && (
          <button className="btn primary" type="button" onClick={() => setAdding(true)}>
            nuevo secretario
          </button>
        )}
      </div>
      {adding && <NewTenant onDone={created} onCancel={() => setAdding(false)} />}
      {rows.loading && !rows.data ? (
        <Loading lines={4} />
      ) : rows.error && !rows.data ? (
        <Failure error={rows.error} onRetry={rows.reload} />
      ) : rows.data?.length ? (
        rows.data.map((t) => <TenantBlock key={t.id} t={t} me={session.user!.id} onChanged={rows.reload} />)
      ) : (
        <Empty title="sin secretarios">Creá el primero con su dueño.</Empty>
      )}
    </div>
  );
}

function TenantBlock({ t, me, onChanged }: { t: TenantRow; me: number; onChanged: () => void }) {
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const act = useAction();

  const add = async (e: FormEvent) => {
    e.preventDefault();
    if (await act.run("add", () => api.post(`/admin/tenants/${t.id}/users`, { name, email, password }))) {
      setAdding(false);
      setName("");
      setEmail("");
      setPassword("");
      onChanged();
    }
  };
  const remove = async (u: TenantRow["users"][number]) => {
    if (
      !(await confirmar({
        titulo: `¿Quitarle el acceso a ${u.name}?`,
        texto: `${u.email} ya no va a poder entrar a la consola. Para devolvérselo, hay que crearle el usuario de nuevo.`,
        si: "quitar acceso",
        no: "cancelar",
        peligro: true,
      }))
    )
      return;
    if (await act.run(`d-${u.id}`, () => api.del(`/admin/users/${u.id}`))) {
      onChanged();
      toast(`${u.name} ya no tiene acceso.`, { tono: "ok" });
    }
  };

  return (
    <Panel
      title={`secretario de ${t.name}`}
      aside={
        <span className="meta">
          {t.id} · memoria {t.bankId} · {t.devices} {t.devices === 1 ? "celular" : "celulares"} · desde {when(t.createdAt)}
        </span>
      }
    >
      <ol className="queue">
        {t.users.map((u) => (
          <li key={u.id} className="qline" data-depth={u.role === "superadmin" ? 2 : 1}>
            <div className="qline-head">
              <span className="qline-mark" aria-hidden="true">
                {u.role === "superadmin" ? ">" : "·"}
              </span>
              <span className="qline-title">{u.name}</span>
              <span className="leader" aria-hidden="true" />
              <span className="qline-aside">
                {u.email} · {u.role === "superadmin" ? "administra todo" : "dueño"}
              </span>
              <span className="qline-action">
                {u.id !== me && (
                  <button className="btn quiet danger" type="button" onClick={() => remove(u)} disabled={act.busy !== null} aria-label={`quitar acceso a ${u.name}`}>
                    <Icon name="close" size={14} />
                    quitar
                  </button>
                )}
              </span>
            </div>
          </li>
        ))}
      </ol>
      {adding ? (
        <form className="inline-form" onSubmit={add}>
          <div className="form-grid">
            <Field label="nombre">{(id) => <input id={id} className="input" value={name} onChange={(e) => setName(e.target.value)} required autoFocus />}</Field>
            <Field label="email">{(id) => <input id={id} className="input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />}</Field>
            <Field label="contraseña" hint={PASSWORD_HINT}>
              {(id) => <input id={id} className="input" type="password" autoComplete="new-password" minLength={10} pattern={PASSWORD_PATTERN} title={PASSWORD_HINT} value={password} onChange={(e) => setPassword(e.target.value)} required />}
            </Field>
          </div>
          {act.error && <Failure error={act.error} />}
          <div className="row">
            <button className="btn primary" type="submit" disabled={act.busy !== null} aria-busy={act.busy === "add"}>
              dar acceso
            </button>
            <button className="btn quiet" type="button" onClick={() => setAdding(false)}>
              cancelar
            </button>
          </div>
        </form>
      ) : (
        <div className="row">
          <button className="btn quiet" type="button" onClick={() => setAdding(true)}>
            dar acceso a alguien más
          </button>
          {act.error && <Failure error={act.error} />}
        </div>
      )}
    </Panel>
  );
}

function NewTenant({ onDone, onCancel }: { onDone: (id: string) => void; onCancel: () => void }) {
  const [ownerName, setOwnerName] = useState("");
  const [id, setId] = useState("");
  const [ownerEmail, setOwnerEmail] = useState("");
  const [ownerPassword, setOwnerPassword] = useState("");
  const act = useAction();
  const tid = id || slug(ownerName);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (await act.run("create", () => api.post("/admin/tenants", { id: tid, ownerName, ownerEmail, ownerPassword }))) onDone(tid);
  };

  return (
    <form className="inline-form plane-card" onSubmit={submit}>
      <h2 className="line-title" data-depth="3">
        secretario nuevo
      </h2>
      <p className="meta">Crea su perfil de agente, su memoria vacía con la plantilla y el acceso del dueño. Tarda unos segundos.</p>
      <div className="form-grid">
        <Field label="nombre del dueño">{(fid) => <input id={fid} className="input" value={ownerName} onChange={(e) => setOwnerName(e.target.value)} required autoFocus />}</Field>
        <Field label="id" hint="minúsculas y guiones; también nombra su memoria">
          {(fid) => <input id={fid} className="input" value={tid} onChange={(e) => setId(slug(e.target.value))} required pattern="[a-z0-9][a-z0-9-]{1,30}" />}
        </Field>
        <Field label="email del dueño">{(fid) => <input id={fid} className="input" type="email" value={ownerEmail} onChange={(e) => setOwnerEmail(e.target.value)} required />}</Field>
        <Field label="contraseña inicial" hint={PASSWORD_HINT}>
          {(fid) => (
            <input id={fid} className="input" type="password" autoComplete="new-password" minLength={10} pattern={PASSWORD_PATTERN} title={PASSWORD_HINT} value={ownerPassword} onChange={(e) => setOwnerPassword(e.target.value)} required />
          )}
        </Field>
      </div>
      {act.error && <Failure error={act.error} />}
      <div className="row">
        <button className="btn primary" type="submit" disabled={act.busy !== null} aria-busy={act.busy !== null}>
          crear secretario
        </button>
        <button className="btn quiet" type="button" onClick={onCancel}>
          cancelar
        </button>
      </div>
    </form>
  );
}
