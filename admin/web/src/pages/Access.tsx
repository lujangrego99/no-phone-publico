import { useState, type FormEvent } from "react";
import { api, type Session } from "../api";
import { Icon } from "../components/Icon";
import { Failure, Field, PASSWORD_HINT, PASSWORD_PATTERN } from "../components/kit";

// Contraseña con «ver»: escribirla bien a la primera, sobre todo en el celu.
function ClaveInput({ id, value, onChange, nueva }: { id: string; value: string; onChange: (v: string) => void; nueva?: boolean }) {
  const [ver, setVer] = useState(false);
  return (
    <div className="clave">
      <input
        id={id}
        className="input"
        type={ver ? "text" : "password"}
        autoComplete={nueva ? "new-password" : "current-password"}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        required
        {...(nueva ? { minLength: 10, pattern: PASSWORD_PATTERN, title: PASSWORD_HINT } : {})}
      />
      <button type="button" className="btn quiet small icon-only clave-ver" onClick={() => setVer(!ver)} aria-label={ver ? "ocultar contraseña" : "mostrar contraseña"} aria-pressed={ver} title={ver ? "ocultar" : "mostrar"}>
        <Icon name="eye" size={16} />
      </button>
    </div>
  );
}

export function Login({ onDone }: { onDone: (s: Session) => Promise<void> }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await onDone(await api.post<Session>("/login", { email, password }));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="access">
      <h1 className="display">
        no-phone<span className="caret" />
      </h1>
      <p className="access-lede">Entrá para hablarle a tu secretario, ver lo que hace y corregir lo que sabe.</p>
      <form className="access-form" onSubmit={submit}>
        <Field label="email">
          {(id) => <input id={id} className="input" type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus />}
        </Field>
        <Field label="contraseña">
          {(id) => <ClaveInput id={id} value={password} onChange={setPassword} />}
        </Field>
        {error && <Failure error={error} />}
        <button className="btn primary" type="submit" disabled={busy || !email || !password} aria-busy={busy}>
          {busy ? "entrando" : "entrar"}
        </button>
      </form>
    </main>
  );
}

const slug = (s: string) =>
  s
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 30);

export function Setup({ onDone }: { onDone: (s: Session) => Promise<void> }) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [tenantId, setTenantId] = useState("");
  const [bankId, setBankId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const id = tenantId || slug(name);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await onDone(await api.post<Session>("/setup", { name, email, password, tenantId: id, bankId: bankId || id }));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="access">
      <h1 className="display">
        primera vez<span className="caret" />
      </h1>
      <p className="meta access-lede">
        Vas a ser el administrador general. El secretario que ya corre en esta máquina queda registrado a tu nombre.
      </p>
      <form className="access-form" onSubmit={submit}>
        <Field label="tu nombre">{(fid) => <input id={fid} className="input" value={name} onChange={(e) => setName(e.target.value)} required autoFocus />}</Field>
        <Field label="email">
          {(fid) => <input id={fid} className="input" type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required />}
        </Field>
        <Field label="contraseña" hint={PASSWORD_HINT}>
          {(fid) => <ClaveInput id={fid} value={password} onChange={setPassword} nueva />}
        </Field>
        <Field label="id del secretario" hint="minúsculas y guiones; también nombra su memoria">
          {(fid) => <input id={fid} className="input" value={id} onChange={(e) => setTenantId(slug(e.target.value))} required pattern="[a-z0-9][a-z0-9-]{1,30}" />}
        </Field>
        <Field label="banco de memoria" hint={`por defecto «${id || "…"}»; si ya existe uno, poné su nombre`}>
          {(fid) => <input id={fid} className="input" value={bankId} placeholder={id} onChange={(e) => setBankId(slug(e.target.value))} />}
        </Field>
        {error && <Failure error={error} />}
        <button className="btn primary" type="submit" disabled={busy} aria-busy={busy}>
          configurar la consola
        </button>
      </form>
    </main>
  );
}
