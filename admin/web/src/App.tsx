import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { BrowserRouter, Link, NavLink, Navigate, Route, Routes, useNavigate } from "react-router";
import { api, when, type Session } from "./api";
import { Dust } from "./components/Dust";
import { Icon, type IconName } from "./components/Icon";
import { UiHost } from "./components/ui";
import { Loading } from "./components/kit";
import { Login, Setup } from "./pages/Access";
import { Ajustes } from "./pages/Ajustes";
import { Llamada } from "./pages/Llamada";
import { Memoria } from "./pages/Memoria";
import { Tareas } from "./pages/Tareas";
import { Informes } from "./pages/Informes";
import { Tenants } from "./pages/Tenants";
import { marcarVistos, useAvisos } from "./avisos";
import { useCaidos } from "./caidos";

interface Ctx {
  session: Session;
  tenant: string;
  setTenant: (id: string) => void;
  refreshSession: (s?: Session) => Promise<void>;
  /** Un plano jalado hacia adelante congela el polvo. */
  setStill: (v: boolean) => void;
}
const SessionCtx = createContext<Ctx | null>(null);
export const useConsole = () => useContext(SessionCtx)!;

const TENANT_KEY = "np.tenant";

export function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [tenant, setTenantState] = useState<string>("");
  const [still, setStill] = useState(false);

  const pickTenant = useCallback((s: Session) => {
    let saved = "";
    try {
      saved = localStorage.getItem(TENANT_KEY) ?? "";
    } catch {
      /* sin storage */
    }
    const ids = s.tenants.map((t) => t.id);
    setTenantState(ids.includes(saved) ? saved : (s.user?.tenantId && ids.includes(s.user.tenantId) ? s.user.tenantId : ids[0]) ?? "");
  }, []);

  const refreshSession = useCallback(
    async (s?: Session) => {
      try {
        const next = s ?? (await api.get<Session>("/session"));
        setSession(next);
        setFailed(null);
        pickTenant(next);
      } catch (e) {
        setFailed((e as Error).message);
      }
    },
    [pickTenant],
  );

  useEffect(() => {
    refreshSession();
  }, [refreshSession]);

  const setTenant = (id: string) => {
    setTenantState(id);
    try {
      localStorage.setItem(TENANT_KEY, id);
    } catch {
      /* sin storage */
    }
  };

  let body: ReactNode;
  if (failed && !session) {
    body = (
      <main className="access">
        <p className="display">
          sin señal<span className="caret" />
        </p>
        <p className="meta">{failed}</p>
      </main>
    );
  } else if (!session) {
    body = (
      <main className="access">
        <Loading lines={3} />
      </main>
    );
  } else if (session.needsSetup) {
    body = <Setup onDone={refreshSession} />;
  } else if (!session.user) {
    body = <Login onDone={refreshSession} />;
  } else {
    body = (
      <SessionCtx.Provider value={{ session, tenant, setTenant, refreshSession, setStill }}>
        <Shell />
      </SessionCtx.Provider>
    );
  }

  return (
    <BrowserRouter>
      <Dust still={still} />
      <div className="stage">{body}</div>
      <UiHost />
    </BrowserRouter>
  );
}

// Pestañas: hablarle, lo que sabe, lo que tiene programado, cómo viene funcionando (informes) y la configuración.
const NAV: { to: string; label: string; icon: IconName; end?: boolean }[] = [
  { to: "/", label: "chat", icon: "message", end: true },
  { to: "/memoria", label: "memoria", icon: "book" },
  { to: "/tareas", label: "tareas", icon: "target" },
  { to: "/informes", label: "informes", icon: "sparkles" },
  { to: "/ajustes", label: "ajustes", icon: "settings" },
];

// Bandeja de avisos (arriba a la derecha): campana con los que no viste; abre la lista. Ir a la charla / visto.
function Bandeja() {
  const { tenant } = useConsole();
  const navigate = useNavigate();
  const { avisos, sinVer } = useAvisos(tenant);
  const { caidos } = useCaidos(tenant);
  const [abierta, setAbierta] = useState(false);
  const [filtro, setFiltro] = useState<"sinver" | "todos">("sinver");
  const caja = useRef<HTMLDivElement | null>(null);
  // Notificación del sistema por cada aviso nuevo sin ver (si el navegador lo permite: hace falta https o localhost).
  const conocidos = useRef<Set<string> | null>(null);
  const puedeNotificar = typeof Notification !== "undefined" && window.isSecureContext;
  const [permiso, setPermiso] = useState(puedeNotificar ? Notification.permission : "denied");
  useEffect(() => {
    const ids = new Set(avisos.map((a) => a.id));
    if (conocidos.current && puedeNotificar && Notification.permission === "granted")
      for (const a of avisos) if (!a.visto && !conocidos.current.has(a.id)) new Notification("no-phone", { body: a.texto, tag: a.id });
    if (avisos.length) conocidos.current = ids; // la primera carga no notifica lo que ya estaba
  }, [avisos, puedeNotificar]);
  // Se cierra con Esc o tocando afuera.
  useEffect(() => {
    if (!abierta) return;
    const tecla = (e: KeyboardEvent) => e.key === "Escape" && setAbierta(false);
    const afuera = (e: PointerEvent) => {
      if (caja.current && !caja.current.contains(e.target as Node)) setAbierta(false);
    };
    window.addEventListener("keydown", tecla);
    document.addEventListener("pointerdown", afuera);
    return () => {
      window.removeEventListener("keydown", tecla);
      document.removeEventListener("pointerdown", afuera);
    };
  }, [abierta]);
  if (!tenant) return null;
  const hora = (at: string) => {
    const d = new Date(at);
    const hoy = new Date().toDateString() === d.toDateString();
    return hoy
      ? d.toLocaleTimeString("es-AR", { hour: "2-digit", minute: "2-digit", hour12: false })
      : when(at);
  };
  // Abre la charla del aviso sin recargar la página: el chat escucha «np-charla» y la trae.
  const irA = async (charla: string, id: string, visto: boolean) => {
    setAbierta(false);
    await api.post(`/t/${tenant}/charla/abrir`, { sessionId: charla }).catch(() => null);
    if (!visto) marcarVistos(tenant, [id]);
    navigate("/");
    window.dispatchEvent(new Event("np-charla"));
  };
  const lista = filtro === "sinver" && sinVer > 0 ? avisos.filter((a) => !a.visto) : avisos;
  // Quita el emoji del principio («🎯 Misión cumplida…»): el tono lo da la etiqueta.
  const limpio = (t: string) => t.replace(/^[^\p{L}\p{N}«"(¿¡]+/u, "");
  return (
    <div className="bandeja" ref={caja}>
      {caidos.length > 0 && (
        <button
          className="bandeja-caidos"
          type="button"
          onClick={() => setAbierta(!abierta)}
          aria-expanded={abierta}
          aria-label={caidos.length === 1 ? "1 cosa caída" : `${caidos.length} cosas caídas`}
          title="problemas"
        >
          <Icon name="alert" size={14} />
          {caidos.length > 9 ? "9+" : caidos.length}
        </button>
      )}
      <button
        className="btn quiet icon-only bandeja-boton"
        type="button"
        onClick={() => setAbierta(!abierta)}
        aria-expanded={abierta}
        aria-label={sinVer ? `avisos, ${sinVer} sin ver` : "avisos"}
        title="avisos"
      >
        <Icon name="bell" size={18} />
        {sinVer > 0 && <span className="bandeja-n">{sinVer > 9 ? "9+" : sinVer}</span>}
      </button>
      {abierta && (
        <div className="bandeja-panel" role="dialog" aria-label="avisos">
          <div className="bandeja-head">
            <span className="bandeja-titulo">avisos</span>
            {sinVer > 0 && (
              <div className="choice bandeja-filtro" role="radiogroup" aria-label="mostrar">
                <label>
                  <input type="radio" name="bandeja-filtro" checked={filtro === "sinver"} onChange={() => setFiltro("sinver")} />
                  sin ver ({sinVer})
                </label>
                <label>
                  <input type="radio" name="bandeja-filtro" checked={filtro === "todos"} onChange={() => setFiltro("todos")} />
                  todos
                </label>
              </div>
            )}
          </div>
          {caidos.length > 0 && (
            <section className="bandeja-problemas" aria-label="problemas">
              <span className="bandeja-seccion">problemas</span>
              <ul>
                {caidos.map((l) => (
                  <li key={l.id}>
                    <Icon name="alert" size={14} />
                    <span className="bandeja-problema-texto">{l.title}</span>
                    <Link className="btn small quiet" to={l.to} onClick={() => setAbierta(false)}>
                      {l.action}
                    </Link>
                  </li>
                ))}
              </ul>
            </section>
          )}
          {puedeNotificar && permiso === "default" && (
            <button className="btn small quiet bandeja-permiso" type="button" onClick={() => Notification.requestPermission().then(setPermiso)}>
              <Icon name="bell" size={14} />
              avisarme también con notificaciones del sistema
            </button>
          )}
          {lista.length === 0 ? (
            <div className="bandeja-vacia">
              <Icon name="inbox" size={24} />
              <p>Nada nuevo.</p>
              <p className="meta">Acá llegan las vigilancias, las tareas que terminan y las misiones que te necesitan.</p>
            </div>
          ) : (
            <ol className="bandeja-lista">
              {lista.map((a) => (
                <li key={a.id} className="bandeja-aviso" data-visto={a.visto}>
                  <span className="bandeja-punto" aria-hidden="true" />
                  <div className="bandeja-cuerpo">
                    <p className="bandeja-texto">{limpio(a.texto)}</p>
                    <div className="bandeja-pie">
                      <span className="meta">{hora(a.at)}</span>
                      {a.charla && (
                        <button className="btn small quiet" type="button" onClick={() => irA(a.charla!, a.id, a.visto)}>
                          ir a la charla
                          <Icon name="chevronRight" size={14} />
                        </button>
                      )}
                      {!a.visto && (
                        <button className="btn small quiet" type="button" onClick={() => marcarVistos(tenant, [a.id])}>
                          <Icon name="check" size={14} />
                          visto
                        </button>
                      )}
                    </div>
                  </div>
                </li>
              ))}
            </ol>
          )}
          {sinVer > 0 && (
            <div className="bandeja-acciones">
              <button className="btn small" type="button" onClick={() => marcarVistos(tenant, avisos.filter((a) => !a.visto).map((a) => a.id))}>
                <Icon name="check" size={14} />
                marcar todo como visto
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function Shell() {
  const { session, tenant, setTenant, refreshSession } = useConsole();
  const navigate = useNavigate();
  const user = session.user!;
  const isSuper = user.role === "superadmin";

  const logout = async () => {
    await api.post("/logout").catch(() => null);
    await refreshSession();
    navigate("/");
  };

  if (!tenant && !isSuper) {
    return (
      <main className="access">
        <p className="display">sin secretario asignado.</p>
        <p className="meta">Pedile al administrador que te dé acceso a un secretario.</p>
        <button className="btn" type="button" onClick={logout}>
          salir
        </button>
      </main>
    );
  }

  return (
    <>
      <a className="skip sr-only" href="#contenido">
        ir al contenido
      </a>
      <header className="topbar">
        <div className="brand">
          <NavLink to="/" className="wordmark" aria-label="no-phone, ir al chat">
            no-phone<span className="caret" />
          </NavLink>
          {session.tenants.length > 1 ? (
            <label className="tenant-pick">
              <span className="sr-only">secretario</span>
              <select className="select" value={tenant} onChange={(e) => setTenant(e.target.value)}>
                {session.tenants.map((t) => (
                  <option key={t.id} value={t.id}>
                    secretario de {t.name}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
        </div>
        {tenant && (
          <nav className="nav" aria-label="secciones">
            {NAV.map((n) => (
              <NavLink key={n.to} to={n.to} end={n.end} className="nav-link">
                <Icon name={n.icon} size={18} />
                <span className="nav-label">{n.label}</span>
              </NavLink>
            ))}
          </nav>
        )}
        <div className="who">
          <Bandeja />
          <button className="btn quiet who-salir" type="button" onClick={logout} title={`salir (${user.email})`}>
            <Icon name="logout" size={16} />
            <span className="who-salir-txt">salir</span>
          </button>
        </div>
      </header>
      <main id="contenido" className="page" key={tenant}>
        {tenant ? (
          <Routes>
            <Route path="/" element={<Llamada />} />
            <Route path="/memoria" element={<Memoria />} />
            <Route path="/tareas" element={<Tareas />} />
            <Route path="/informes" element={<Informes />} />
            <Route path="/ajustes" element={<Ajustes />} />
            {/* direcciones viejas */}
            <Route path="/chat" element={<Navigate to="/" replace />} />
            <Route path="/llamada" element={<Navigate to="/" replace />} />
            <Route path="/secretario" element={<Navigate to="/ajustes" replace />} />
            <Route path="/herramientas" element={<Navigate to="/ajustes?ver=conexiones" replace />} />
            <Route path="/tenants" element={<Navigate to={isSuper ? "/ajustes?ver=personas" : "/"} replace />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        ) : (
          <Tenants />
        )}
      </main>
    </>
  );
}
