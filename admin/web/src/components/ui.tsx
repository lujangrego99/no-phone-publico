// Piezas de interfaz compartidas: diálogo, avisos (toasts) y confirmación propia.
// Reemplazan a alert()/confirm() del navegador: se ven como la consola, se leen con lector de pantalla
// y cierran como se espera (Esc, tocar afuera, botón ×).
import { useEffect, useId, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { Icon } from "./Icon";

/* ---------------- diálogo ---------------- */

export function Dialog({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  size = "md",
  className,
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  size?: "sm" | "md" | "lg";
  className?: string;
}) {
  const ref = useRef<HTMLDialogElement | null>(null);
  const titleId = useId();
  const descId = useId();
  const cerrar = useRef(onClose);
  cerrar.current = onClose;

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) {
      const antes = document.activeElement as HTMLElement | null;
      d.showModal();
      // Foco en la caja (no en la ×): el lector anuncia el título; si algo pide autofocus, gana eso.
      (d.querySelector<HTMLElement>("[data-autofocus]") ?? d.querySelector<HTMLElement>(".dlg-box"))?.focus({ preventScroll: true });
      document.documentElement.dataset.dialogo = "abierto";
      return () => {
        if (d.open) d.close();
        delete document.documentElement.dataset.dialogo;
        antes?.focus?.({ preventScroll: true });
      };
    }
  }, [open]);

  if (!open) return null;
  return (
    <dialog
      ref={ref}
      className={`dlg dlg-${size}${className ? ` ${className}` : ""}`}
      aria-labelledby={titleId}
      aria-describedby={description ? descId : undefined}
      onCancel={(e) => {
        e.preventDefault(); // Esc: cerramos nosotros (así el estado de React manda)
        cerrar.current();
      }}
      onPointerDown={(e) => {
        // Tocar el fondo (fuera de la caja) cierra. El <dialog> ocupa todo; la caja es .dlg-box.
        if (e.target === e.currentTarget) cerrar.current();
      }}
    >
      <div className="dlg-box" tabIndex={-1}>
        <header className="dlg-head">
          <div className="dlg-titles">
            <h2 id={titleId} className="dlg-title">
              {title}
            </h2>
            {description && (
              <p id={descId} className="dlg-desc">
                {description}
              </p>
            )}
          </div>
          <button type="button" className="btn quiet icon-only dlg-x" onClick={() => cerrar.current()} aria-label="cerrar">
            <Icon name="close" size={18} />
          </button>
        </header>
        {children && <div className="dlg-body">{children}</div>}
        {footer && <footer className="dlg-foot">{footer}</footer>}
      </div>
    </dialog>
  );
}

/* ---------------- tienda mínima para toasts y confirmaciones ---------------- */

type Tono = "ok" | "bad" | "info";
type Toast = { id: number; texto: string; tono?: Tono; accion?: { label: string; fn: () => void }; ms: number };
type Pregunta = {
  id: number;
  titulo: string;
  texto?: ReactNode;
  si: string;
  no: string;
  peligro: boolean;
  responder: (v: boolean) => void;
};

let toasts: Toast[] = [];
let preguntas: Pregunta[] = [];
let seq = 0;
const oyentes = new Set<() => void>();
const avisar = () => oyentes.forEach((f) => f());
const suscribir = (f: () => void) => {
  oyentes.add(f);
  return () => oyentes.delete(f);
};

/** Aviso corto abajo. Con `accion` (p. ej. «deshacer») dura más. */
export function toast(texto: string, opts: { tono?: Tono; accion?: { label: string; fn: () => void }; ms?: number } = {}) {
  const t: Toast = { id: ++seq, texto, tono: opts.tono, accion: opts.accion, ms: opts.ms ?? (opts.accion ? 7000 : 3600) };
  toasts = [...toasts.slice(-2), t];
  avisar();
  return t.id;
}
export function cerrarToast(id: number) {
  toasts = toasts.filter((t) => t.id !== id);
  avisar();
}

/** Confirmación propia (en vez de window.confirm). Resuelve true solo con el botón de sí. */
export function confirmar(o: { titulo: string; texto?: ReactNode; si?: string; no?: string; peligro?: boolean }): Promise<boolean> {
  return new Promise((resolve) => {
    const p: Pregunta = {
      id: ++seq,
      titulo: o.titulo,
      texto: o.texto,
      si: o.si ?? "sí",
      no: o.no ?? "cancelar",
      peligro: o.peligro ?? false,
      responder: (v) => {
        preguntas = preguntas.filter((x) => x.id !== p.id);
        avisar();
        resolve(v);
      },
    };
    preguntas = [...preguntas, p];
    avisar();
  });
}

/* ---------------- anfitrión: se monta una vez en App ---------------- */

export function UiHost() {
  const ts = useSyncExternalStore(suscribir, () => toasts);
  const ps = useSyncExternalStore(suscribir, () => preguntas);
  const p = ps[0];
  return (
    <>
      <div className="toasts" role="region" aria-label="avisos" aria-live="polite">
        {ts.map((t) => (
          <ToastView key={t.id} t={t} />
        ))}
      </div>
      {p && (
        <Dialog
          open
          size="sm"
          onClose={() => p.responder(false)}
          title={p.titulo}
          footer={
            <>
              <button type="button" className="btn quiet" onClick={() => p.responder(false)} data-autofocus={p.peligro ? "" : undefined}>
                {p.no}
              </button>
              <button type="button" className={p.peligro ? "btn danger" : "btn primary"} onClick={() => p.responder(true)} data-autofocus={p.peligro ? undefined : ""}>
                {p.si}
              </button>
            </>
          }
        >
          {p.texto && <div className="dlg-text">{p.texto}</div>}
        </Dialog>
      )}
    </>
  );
}

function ToastView({ t }: { t: Toast }) {
  const [pausa, setPausa] = useState(false);
  useEffect(() => {
    if (pausa) return;
    const h = setTimeout(() => cerrarToast(t.id), t.ms);
    return () => clearTimeout(h);
  }, [t.id, t.ms, pausa]);
  return (
    <div className="toast" data-tono={t.tono} onPointerEnter={() => setPausa(true)} onPointerLeave={() => setPausa(false)}>
      {t.tono === "ok" && <Icon name="check" size={16} />}
      {t.tono === "bad" && <Icon name="alert" size={16} />}
      <span className="toast-text">{t.texto}</span>
      {t.accion && (
        <button
          type="button"
          className="btn small quiet toast-accion"
          onClick={() => {
            t.accion!.fn();
            cerrarToast(t.id);
          }}
        >
          {t.accion.label}
        </button>
      )}
      <button type="button" className="btn small quiet icon-only" aria-label="cerrar aviso" onClick={() => cerrarToast(t.id)}>
        <Icon name="close" size={14} />
      </button>
    </div>
  );
}
