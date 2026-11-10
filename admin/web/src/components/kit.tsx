// Piezas comunes: carga de datos, estados, línea de cola y campos.
import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router";
import { ApiError, type Depth } from "../api";
import { Icon } from "./Icon";

export function useLoad<T>(fn: () => Promise<T>, deps: unknown[]) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [loading, setLoading] = useState(true);
  const seq = useRef(0);
  const reload = useCallback(async () => {
    const n = ++seq.current;
    setLoading(true);
    try {
      const v = await fn();
      if (n === seq.current) {
        setData(v);
        setError(null);
      }
    } catch (e) {
      if (n === seq.current) setError(e instanceof ApiError ? e : new ApiError(0, "error", String(e)));
    } finally {
      if (n === seq.current) setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  useEffect(() => {
    reload();
  }, [reload]);
  return { data, error, loading, reload, setData };
}

/** Acción con estado ocupado y error propio. */
export function useAction() {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const run = useCallback(async (key: string, fn: () => Promise<unknown>) => {
    setBusy(key);
    setError(null);
    try {
      await fn();
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return false;
    } finally {
      setBusy(null);
    }
  }, []);
  return { busy, error, run, setError };
}

export function Loading({ lines = 4 }: { lines?: number }) {
  return (
    <div className="loading" aria-busy="true" aria-label="cargando">
      {Array.from({ length: lines }, (_, i) => (
        <span key={i} className="skeleton" style={{ width: `${82 - i * 13}%` }} />
      ))}
    </div>
  );
}

export function Failure({ error, onRetry }: { error: ApiError | string; onRetry?: () => void }) {
  const message = typeof error === "string" ? error : error.message;
  return (
    <div className="failure" role="alert">
      <span className="reversed">!</span>
      <span className="failure-text">{message}</span>
      {onRetry && (
        <button className="btn quiet" type="button" onClick={onRetry}>
          reintentar
        </button>
      )}
    </div>
  );
}

export function Empty({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="empty">
      <p className="line-title" data-depth="2">
        {title}
      </p>
      {children && <div className="meta empty-body">{children}</div>}
      {action && <div className="empty-action">{action}</div>}
    </div>
  );
}

/** Una línea de la cola: el rango es profundidad. */
export function QueueLine({
  depth,
  failed,
  title,
  detail,
  aside,
  action,
}: {
  depth: Depth;
  failed?: boolean;
  title: ReactNode;
  detail?: ReactNode;
  aside?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <li className="qline" data-depth={depth}>
      <div className="qline-head">
        {failed && (
          <span className="qline-mark">
            <span className="reversed" role="img" aria-label="falla">
              !
            </span>
          </span>
        )}
        <span className={depth === 3 ? "qline-title front" : "qline-title"}>{title}</span>
        <span className="leader" aria-hidden="true" />
        {aside && <span className="qline-aside">{aside}</span>}
        {action && <span className="qline-action">{action}</span>}
      </div>
      {detail && <div className="qline-detail">{detail}</div>}
    </li>
  );
}

export function GoTo({ to, children, primary }: { to: string; children: ReactNode; primary?: boolean }) {
  return (
    <Link className={primary ? "btn primary" : "btn"} to={to}>
      {children}
    </Link>
  );
}

// Misma regla que checkPassword en server/main.ts.
export const PASSWORD_PATTERN = "(?=.*[a-z])(?=.*[A-Z])(?=.*\\d)(?=.*[^A-Za-z0-9]).{10,}";
export const PASSWORD_HINT = "10+ caracteres, con mayúscula, minúscula, número y símbolo";

export function Field({
  label,
  hint,
  error,
  children,
}: {
  label: string;
  hint?: ReactNode;
  error?: string | null;
  children: (id: string) => ReactNode;
}) {
  const id = useId();
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      {children(id)}
      {error ? <span className="error">{error}</span> : hint ? <span className="hint">{hint}</span> : null}
    </div>
  );
}

export function Health({ health }: { health: "ok" | "caido" | "desconocido" }) {
  if (health === "caido")
    return (
      <span className="health-bad" title="no anda">
        <Icon name="alert" size={16} label="no anda" />
      </span>
    );
  if (health === "ok")
    return (
      <span className="health-ok" title="en línea">
        <Icon name="check" size={14} label="en línea" />
      </span>
    );
  return (
    <span className="health-unk" title="sin datos todavía" role="img" aria-label="sin datos todavía">
      ?
    </span>
  );
}

export function Saved({ when: at }: { when: number | null }) {
  if (!at) return null;
  return (
    <span className="saved" role="status">
      guardado
    </span>
  );
}

/** Bloque de ajustes: superficie con título (y explicación corta), contenido y pie con la acción de guardar. */
export function Panel({
  title,
  desc,
  aside,
  footer,
  children,
  id,
}: {
  title: string;
  desc?: ReactNode;
  aside?: ReactNode;
  footer?: ReactNode;
  children: ReactNode;
  id?: string;
}) {
  return (
    <section className="panel" id={id} aria-label={title}>
      <header className="panel-head">
        <div className="panel-titles">
          <h2 className="panel-title">{title}</h2>
          {desc && <p className="panel-desc">{desc}</p>}
        </div>
        {aside && <div className="panel-aside">{aside}</div>}
      </header>
      <div className="panel-body">{children}</div>
      {footer && <footer className="panel-foot">{footer}</footer>}
    </section>
  );
}

export function Section({ title, children, aside }: { title: string; children: ReactNode; aside?: ReactNode }) {
  return (
    <section className="section">
      <div className="section-head">
        <h2 className="line-title">{title}</h2>
        {aside}
      </div>
      {children}
    </section>
  );
}
