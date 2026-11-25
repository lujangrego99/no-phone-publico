// Cada herramienta del secretario dibujada con el estilo de su app: burbuja de WhatsApp, tarjeta de
// Naranja X, mapa de movilidad. Son «ventanas» a otra app dentro de la consola: acá sí van sus colores
// y logos (excepción deliberada al sistema de la consola, que sigue mandando alrededor).
import { useEffect, useState, type ReactNode } from "react";
import { useConsole } from "../App";
import { api, when } from "../api";
import waLogo from "../assets/logos/whatsapp.svg?raw";
import mapsLogo from "../assets/logos/googlemaps.svg?raw";
import nxLogo from "../assets/logos/naranjax.svg?raw";
import busIcon from "pixelarticons/svg/bus.svg?raw";
import { AudioWa, GrabarNota, MvArribosVivo, MvViaje } from "./TarjetasVivas";
import { EnsayoMision, PlanMision } from "./MisionPlan";

export type ToolItem = { id: string; name: string; args: Json; result?: Json | null; done: boolean };
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

// ---------- familias ----------

type Familia = "whatsapp" | "naranjax" | "movilidad" | "reglas" | "otra";
const corto = (name: string) => name.replace(/^mcp__[a-z0-9_-]+?__/, "");
export function familia(name: string): Familia {
  const n = corto(name);
  if (name.includes("__whatsapp__") || n.startsWith("wa_")) return "whatsapp";
  if (name.includes("__reglas__") || name.includes("__secretario__") || /^reglas?_/.test(n)) return "reglas"; // __secretario__: charlas de antes del renombre
  if (name.includes("__naranjax__") || n.startsWith("nx_")) return "naranjax";
  if (name.includes("__movilidad__") || /^(lugar_buscar|como_llegar|parada_buscar|micro_cuando_viene|linea_info|viaje_planear)$/.test(n))
    return "movilidad";
  return "otra";
}

const ETIQUETAS: Record<string, string> = {
  wa_estado: "revisando la conexión",
  wa_chats: "mirando tus chats",
  wa_mensajes: "leyendo el chat",
  wa_recientes: "viendo qué te escribieron",
  wa_buscar_mensajes: "buscando mensajes",
  wa_buscar_contactos: "buscando el contacto",
  wa_descargar_media: "bajando el archivo",
  wa_transcribir: "escuchando el audio",
  wa_ver_imagen: "mirando la imagen",
  wa_enviar_preview: "preparando el mensaje",
  wa_enviar: "mandando",
  wa_enviar_cancelar: "cancelando el envío",
  wa_vigilar: "dejando una vigilancia",
  wa_vigilancias: "mirando las vigilancias",
  wa_vigilancia_cancelar: "sacando la vigilancia",
  nx_inicio: "abriendo la app",
  nx_saldo: "mirando tu saldo",
  nx_movimientos: "mirando movimientos",
  nx_actividad: "mirando actividad",
  nx_contactos: "mirando contactos",
  nx_destino_resolver: "buscando al destinatario",
  nx_transfer_armar: "armando la transferencia",
  nx_transfer_preview: "armando la transferencia",
  nx_transfer: "transfiriendo",
  nx_transfer_y_comprobante: "transfiriendo",
  nx_transfer_cancelar: "cancelando",
  nx_comprobante_buscar: "buscando comprobantes",
  nx_comprobante_guardar: "guardando el comprobante",
  reglas_listar: "mirando sus reglas",
  regla_preparar: "preparando la regla",
  mision_preparar: "preparando la misión",
  mision_estado: "anotando cómo va la misión",
  mision_listar: "mirando las misiones",
  mision_cancelar: "cancelando la misión",
  regla_guardar: "guardando la regla",
  regla_quitar: "sacando la regla",
  lugar_buscar: "buscando el lugar",
  como_llegar: "armando la ruta",
  parada_buscar: "buscando paradas",
  micro_cuando_viene: "viendo cuándo viene",
  linea_info: "mirando la línea",
  viaje_planear: "planeando el viaje",
};
const APP: Record<Familia, string> = { whatsapp: "WhatsApp", naranjax: "Naranja X", movilidad: "Movilidad", reglas: "reglas", otra: "herramienta" };
const LOGO: Record<Familia, string | null> = { whatsapp: waLogo, naranjax: nxLogo, movilidad: mapsLogo, reglas: null, otra: null };

export const etiqueta = (name: string) => ETIQUETAS[corto(name)] ?? corto(name).replace(/_/g, " ");

const MICRO = /^(parada_buscar|micro_cuando_viene|linea_info|viaje_planear)$/;
function Logo({ f, size = 16, name }: { f: Familia; size?: number; name?: string }) {
  const svg = f === "movilidad" && name && MICRO.test(corto(name)) ? busIcon : LOGO[f];
  if (!svg) return null;
  return <span className={`tc-logo tc-logo-${f}`} style={{ width: size, height: size }} aria-hidden="true" dangerouslySetInnerHTML={{ __html: svg }} />;
}

// Línea mínima con el logo de la app: lo que no tiene tarjeta propia, o mientras corre.
export function ToolLine({ t }: { t: ToolItem }) {
  const f = familia(t.name);
  const err = t.result && typeof t.result.error === "string";
  return (
    <div className={`tc-line tc-${f}`} data-done={t.done}>
      <Logo f={f} size={14} name={t.name} />
      <span className="tc-app">{APP[f]}</span>
      <span className="tc-what">
        {etiqueta(t.name)}
        {!t.done && <span className="tc-dots" aria-hidden="true" />}
      </span>
      {err && <span className="tc-err">{String(t.result!.mensaje ?? t.result!.error)}</span>}
    </div>
  );
}

// ---------- helpers ----------

const pesos = (n: unknown) =>
  typeof n === "number" ? n.toLocaleString("es-AR", { style: "currency", currency: "ARS", maximumFractionDigits: 2 }) : null;
const sinComillas = (s: string) => s.replace(/^«|»$/g, "");
const hora = (f?: string) => (f ? f.slice(-5) : "");

function Shell({ f, title, children, foot, name }: { f: Familia; title: ReactNode; children: ReactNode; foot?: ReactNode; name?: string }) {
  return (
    <figure className={`tc-card tc-${f}`}>
      <figcaption className="tc-head">
        <Logo f={f} size={18} name={name} />
        <span className="tc-title">{title}</span>
      </figcaption>
      <div className="tc-body">{children}</div>
      {foot && <div className="tc-foot">{foot}</div>}
    </figure>
  );
}

// Al tocar, los botones se van al instante y queda lo elegido: así no se toca dos veces (antes, si el secretario
// seguía contestando, el «sí» quedaba en espera sin ninguna señal y se volvía a tocar → mensaje doble).
function Acciones({ si, no, onSay, siTexto }: { si: string; no: string; onSay?: (t: string) => void; siTexto?: string }) {
  const [elegido, setElegido] = useState<string | null>(null);
  if (elegido) return <span className="tc-status tc-elegido">✓ {elegido} · en eso…</span>;
  if (!onSay) return null;
  const elegir = (etiqueta: string, texto: string) => {
    setElegido(etiqueta);
    onSay(texto);
  };
  return (
    <div className="tc-actions">
      <button type="button" className="tc-btn tc-btn-ok" onClick={() => elegir(si, siTexto ?? `sí, ${si}`)}>
        {si}
      </button>
      <button type="button" className="tc-btn" onClick={() => elegir(no, `no, ${no}`)}>
        {no}
      </button>
    </div>
  );
}

// ---------- WhatsApp ----------

// Errores de envío en criollo (el detalle técnico queda en el title).
function errorEnvio(res: Json): string {
  const m = String(res.mensaje ?? res.error ?? "");
  if (/no such file|archivo_inexistente|leer archivo/i.test(m)) return "No encontré el archivo para adjuntar.";
  if (/bridge_caido|conect/i.test(m)) return "WhatsApp no está conectado ahora.";
  if (/falta_confirmacion/.test(m)) return "Falta tu confirmación.";
  return "No se pudo mandar.";
}

function Adjunto({ a }: { a: Json }) {
  const { tenant } = useConsole();
  if (a.tipo === "imagen" && a.origen)
    return <img className="wa-img" src={`/api/t/${tenant}/adjunto?ruta=${encodeURIComponent(a.origen)}`} alt={a.nombre ?? "imagen"} loading="lazy" />;
  const ext = String(a.nombre ?? "").split(".").pop()?.toUpperCase() ?? "";
  return (
    <span className="wa-file">
      <span className="wa-file-ext">{ext.slice(0, 4) || "ARCH"}</span>
      <span className="wa-file-name">{a.nombre}</span>
    </span>
  );
}

function WaPreview({ r, envio, onSay }: { r: Json; envio?: ToolItem; onSay?: (t: string) => void }) {
  const d = r.destinatario ?? {};
  const nombre = d.nombre || d.numero || "contacto";
  const sent = envio?.result?.estado === "enviado";
  const cancel = envio && corto(envio.name) === "wa_enviar_cancelar";
  const fallo = envio?.result?.error;
  return (
    <Shell
      f="whatsapp"
      title={
        <>
          <span className="tc-avatar">{String(nombre).slice(0, 1).toUpperCase()}</span>
          <span>
            <strong>{nombre}</strong>
            {d.nombre && d.numero && <small>{d.numero}</small>}
          </span>
        </>
      }
      foot={
        sent ? null : cancel ? (
          <span className="tc-status">envío cancelado</span>
        ) : fallo ? (
          <span className="tc-status tc-bad" title={String(envio!.result!.mensaje ?? fallo)}>
            {errorEnvio(envio!.result!)}
          </span>
        ) : (
          <>
            <span className="tc-status">sin enviar · ¿lo mando?</span>
            <Acciones si="mandalo" no="no lo mandes" onSay={onSay} />
          </>
        )
      }
    >
      <div className="wa-chat">
        <div className={`wa-bubble wa-out${sent ? "" : " wa-draft"}${cancel ? " wa-cancel" : ""}${r.adjunto ? " wa-con-adjunto" : ""}`}>
          {r.adjunto && <Adjunto a={r.adjunto} />}
          {r.adjunto ? r.texto ? <span className="wa-caption">{r.texto}</span> : null : sinComillas(String(r.contenido ?? ""))}
          <span className="wa-meta">
            {sent ? (
              <>
                {hora(envio!.result!.fecha)} <span className="wa-ticks">✓✓</span>
              </>
            ) : (
              "borrador"
            )}
          </span>
        </div>
      </div>
    </Shell>
  );
}

function WaMensajes({ r }: { r: Json }) {
  const c = r.chat ?? {};
  const ms: Json[] = (r.mensajes ?? []).slice(-6);
  return (
    <Shell
      f="whatsapp"
      title={
        <>
          <span className="tc-avatar">{String(c.nombre ?? "?").slice(0, 1).toUpperCase()}</span>
          <span>
            <strong>{c.nombre ?? "chat"}</strong>
            {c.numero && <small>{c.numero}</small>}
          </span>
        </>
      }
    >
      <div className="wa-chat">
        {ms.map((m, i) => (
          <div key={m.id ?? i} className={`wa-bubble ${m.de === "yo" ? "wa-out" : "wa-in"}`}>
            {c.grupo && m.de !== "yo" && <span className="wa-from">{m.de}</span>}
            {m.media === "audio" || m.media === "nota_de_voz" ? (
              <>
                <AudioWa chat={c.jid} id={m.id} de={m.de === "yo" ? undefined : m.de} />
                {m.transcripcion ? <span className="wa-transcript">{m.transcripcion}</span> : !m.texto && <em className="wa-media">🎤 audio sin transcribir</em>}
              </>
            ) : null}
            {m.texto ||
              (m.media && m.media !== "audio" && m.media !== "nota_de_voz" ? <em className="wa-media">📎 {m.media}</em> : !m.media ? "—" : null)}
            <span className="wa-meta">{hora(m.fecha)}</span>
          </div>
        ))}
      </div>
    </Shell>
  );
}

const dur = (s: unknown) => (typeof s === "number" ? `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}` : "");

function WaAudio({ r }: { r: Json }) {
  const c = r.chat ?? {};
  const yo = r.de === "yo";
  return (
    <Shell
      f="whatsapp"
      title={
        <>
          <span className="tc-avatar">{String(c.nombre ?? "?").slice(0, 1).toUpperCase()}</span>
          <span>
            <strong>{c.nombre ?? "chat"}</strong>
            <small>nota de voz · {r.fecha}</small>
          </span>
        </>
      }
    >
      <div className="wa-chat">
        <div className={`wa-bubble ${yo ? "wa-out" : "wa-in"}`}>
          {c.grupo && !yo && <span className="wa-from">{r.de}</span>}
          <AudioWa chat={c.jid} id={r.mensaje_id} duracion={typeof r.duracion_s === "number" ? r.duracion_s : undefined} de={yo ? undefined : r.de} />
          {r.texto !== undefined && <span className="wa-transcript">{r.texto || "(no se entiende nada)"}</span>}
          <span className="wa-meta">{hora(r.fecha)}</span>
        </div>
      </div>
    </Shell>
  );
}

function WaVigilando({ r }: { r: Json }) {
  const v = r.vigilancia ?? {};
  return (
    <Shell
      f="whatsapp"
      title={
        <>
          <span className="tc-avatar">{String(v.nombre ?? "?").slice(0, 1).toUpperCase()}</span>
          <span>
            <strong>{v.nombre}</strong>
            <small>vigilando hasta las {r.hasta}</small>
          </span>
        </>
      }
    >
      <p className="wa-vig">
        👁 Si te escribe{v.contiene ? ` algo con «${v.contiene}»` : ""}, te aviso al toque por WhatsApp y acá.{v.una_vez ? " Solo la primera vez." : ""}
      </p>
    </Shell>
  );
}

function WaRecientes({ r }: { r: Json }) {
  const chats: Json[] = (r.chats ?? []).slice(0, 6);
  return (
    <Shell f="whatsapp" title={<strong>te escribieron</strong>}>
      <ul className="wa-list">
        {chats.map((c, i) => {
          const last = (c.mensajes ?? [])[c.mensajes?.length - 1] ?? {};
          return (
            <li key={c.chat_jid ?? i}>
              <span className="tc-avatar">{String(c.chat ?? "?").slice(0, 1).toUpperCase()}</span>
              <span className="wa-list-main">
                <strong>{c.chat}</strong>
                <small>
                  {last.de && last.de !== c.chat ? `${last.de}: ` : ""}
                  {last.texto || (last.media ? `📎 ${last.media}` : "")}
                </small>
              </span>
              <span className="wa-meta">{hora(last.fecha)}</span>
            </li>
          );
        })}
        {!chats.length && <li className="tc-status">nada nuevo</li>}
      </ul>
    </Shell>
  );
}

// ---------- Naranja X ----------

function NxTransfer({ r, envio, onSay }: { r: Json; envio?: ToolItem; onSay?: (t: string) => void }) {
  const d = r.destinatario ?? {};
  const ok = envio?.result?.estado === "ok";
  const cancel = envio && /cancel/.test(corto(envio.name));
  const fallo = envio?.result?.error;
  const puede = r.puede_transferir !== false;
  // Cuenta nueva: la consola solo la habilita si el dueño nombra al titular (un «sí» solo no alcanza). El botón lo
  // nombra por él: tocarlo, viendo el nombre en la tarjeta, es esa confirmación.
  const nueva = r.historial?.conocida === false && !!d.titular;
  const siLabel = nueva ? `sí, es ${d.titular}` : "transferí";
  const siTexto = nueva ? `sí, es ${d.titular}, transferí` : undefined;
  return (
    <Shell f="naranjax" title={<strong>{ok ? "transferencia enviada" : "transferencia"}</strong>}>
      <div className="nx-amount">{pesos(r.monto) ?? "—"}</div>
      <dl className="nx-rows">
        <div>
          <dt>para</dt>
          <dd>{d.titular || d.etiqueta || r.destino_pedido || "—"}</dd>
        </div>
        {d.entidad && (
          <div>
            <dt>banco</dt>
            <dd>{d.entidad}</dd>
          </div>
        )}
        {(d.alias || d.cvu_cbu) && (
          <div>
            <dt>{d.alias ? "alias" : "CVU/CBU"}</dt>
            <dd className="mono-id">{d.alias || d.cvu_cbu}</dd>
          </div>
        )}
        {r.disponible_monto != null && (
          <div>
            <dt>tu saldo</dt>
            <dd>{pesos(r.disponible_monto)}</dd>
          </div>
        )}
      </dl>
      {ok ? (
        <p className="nx-state nx-ok">✓ {String(envio!.result!.mensaje ?? "listo").replace(/\s*Comprobante:\s*\S+/i, "").trim()}</p>
      ) : cancel ? (
        <p className="nx-state">cancelada</p>
      ) : fallo ? (
        <p className="nx-state nx-bad">{String(envio!.result!.mensaje ?? fallo)}</p>
      ) : !puede ? (
        <p className="nx-state nx-bad">no alcanza{r.faltante ? ` · faltan ${pesos(r.faltante)}` : ""}</p>
      ) : (
        <>
          <p className="nx-state">{nueva ? "cuenta nueva · " : ""}alcanza · todavía no se mandó</p>
          <Acciones si={siLabel} siTexto={siTexto} no="no transfieras" onSay={onSay} />
        </>
      )}
    </Shell>
  );
}

function NxDestino({ r, onSay }: { r: Json; onSay?: (t: string) => void }) {
  const d = r.destinatario ?? {};
  return (
    <Shell f="naranjax" title={<strong>¿es esta persona?</strong>}>
      <dl className="nx-rows">
        <div>
          <dt>titular</dt>
          <dd>{d.titular || d.etiqueta || "—"}</dd>
        </div>
        {d.entidad && (
          <div>
            <dt>banco</dt>
            <dd>{d.entidad}</dd>
          </div>
        )}
        {d.cuil && (
          <div>
            <dt>CUIL</dt>
            <dd className="mono-id">{d.cuil}</dd>
          </div>
        )}
      </dl>
      <Acciones si="es esa" no="no es" onSay={onSay} />
    </Shell>
  );
}

function NxSaldo({ r }: { r: Json }) {
  const movs: Json[] = (r.movimientos_preview ?? []).slice(0, 4);
  return (
    <Shell f="naranjax" title={<strong>tu cuenta</strong>}>
      <div className="nx-amount">{pesos(r.pesos ?? r.saldo) ?? r.pesos_raw ?? r.saldo_raw ?? "—"}</div>
      {(r.dolares != null || r.rendimientos_mes != null) && (
        <dl className="nx-rows">
          {r.dolares != null && (
            <div>
              <dt>dólares</dt>
              <dd>US$ {Number(r.dolares).toLocaleString("es-AR")}</dd>
            </div>
          )}
          {r.rendimientos_mes != null && (
            <div>
              <dt>rindió este mes</dt>
              <dd>{pesos(r.rendimientos_mes)}</dd>
            </div>
          )}
        </dl>
      )}
      {movs.length > 0 && (
        <ul className="nx-movs">
          {movs.map((m, i) => (
            <li key={i}>
              <span>{m.contraparte ?? m.tipo}</span>
              <span className={/recibida/i.test(m.tipo ?? "") ? "nx-in" : ""}>{m.monto_raw ?? pesos(m.monto)}</span>
            </li>
          ))}
        </ul>
      )}
    </Shell>
  );
}

// ---------- Movilidad ----------

// Mapa embebido de Google Maps (versión embebible, sin key): un punto, o la ruta origen → destino.
function gmapsEmbed(pts: { lat: number; lng: number }[], modo?: string) {
  if (pts.length >= 2) {
    const dirflg = { auto: "d", bici: "b", transporte: "r" }[modo ?? ""] ?? "w";
    const [o, d] = [pts[0], pts[pts.length - 1]];
    return `https://maps.google.com/maps?saddr=${o.lat},${o.lng}&daddr=${d.lat},${d.lng}&dirflg=${dirflg}&hl=es&output=embed`;
  }
  return `https://maps.google.com/maps?q=${pts[0].lat},${pts[0].lng}&z=16&hl=es&output=embed`;
}
const gmaps = (o: Json, d: Json, modo?: string) =>
  `https://www.google.com/maps/dir/?api=1&origin=${o.lat},${o.lng}&destination=${d.lat},${d.lng}&travelmode=${
    { auto: "driving", bici: "bicycling", transporte: "transit" }[modo ?? ""] ?? "walking"
  }`;
const hayPunto = (p: Json | undefined): p is { lat: number; lng: number } => typeof p?.lat === "number" && typeof p?.lng === "number";

function Mapa({ pts, link, modo }: { pts: { lat: number; lng: number }[]; link?: string; modo?: string }) {
  if (!pts.length) return null;
  return (
    <div className="mv-map">
      <iframe title="mapa" src={gmapsEmbed(pts, modo)} loading="lazy" referrerPolicy="no-referrer-when-downgrade" />
      {link && (
        <a className="mv-open" href={link} target="_blank" rel="noreferrer">
          abrir en Google Maps ↗
        </a>
      )}
    </div>
  );
}

function MapaViaje({ r }: { r: Json }) {
  const pts = [r.origen ?? {}, r.destino ?? {}].filter(hayPunto);
  return <Mapa pts={pts} modo="transporte" link={pts.length === 2 ? gmaps(pts[0], pts[1], "transporte") : undefined} />;
}

function MvRuta({ r, args, onSay }: { r: Json; args?: Json; onSay?: (t: string) => void }) {
  const o = r.origen ?? {};
  const d = r.destino ?? {};
  const ruta = (r.rutas ?? [])[0] ?? {};
  const opciones: Json[] = r.opciones ?? [];
  const pts = [o, d].filter(hayPunto);
  if (r.opciones)
    return (
      <Shell f="movilidad" title={<strong>cómo llegar en micro</strong>}>
        <MvViaje r={r} destino={typeof args?.destino === "string" ? args.destino : undefined} onSay={onSay} Mapa={MapaViaje} />
      </Shell>
    );
  return (
    <Shell
      f="movilidad"
      title={
        <span>
          <strong>{o.nombre ?? "origen"}</strong> → <strong>{d.nombre ?? "destino"}</strong>
        </span>
      }
    >
      <Mapa pts={pts} modo={opciones.length ? "transporte" : r.modo} link={pts.length === 2 ? gmaps(o, d, opciones.length ? "transporte" : r.modo) : undefined} />
      {opciones.length ? (
        <ol className="mv-opts">
          {opciones.map((op, i) => (
            <li key={i}>
              <span className="mv-line">{op.lineas ?? "a pie"}</span>
              <span>
                salís {op.sali} · llegás {op.llegas} · {op.duracion_min} min{op.caminata_min ? ` (${op.caminata_min} a pie)` : ""}
              </span>
            </li>
          ))}
        </ol>
      ) : ruta.duracion_min != null ? (
        <p className="mv-sum">
          {ruta.duracion_min} min · {ruta.distancia_m >= 1000 ? `${(ruta.distancia_m / 1000).toFixed(1)} km` : `${ruta.distancia_m} m`} {r.modo ? `· ${r.modo}` : ""}
        </p>
      ) : null}
    </Shell>
  );
}

function MvArribos({ r }: { r: Json }) {
  const p = r.parada ?? {};
  const arr: Json[] = (r.arribos ?? []).slice(0, 6);
  return (
    <Shell
      f="movilidad"
      name="micro_cuando_viene"
      title={
        <span>
          <strong>parada {p.codigo}</strong> <small>{p.ubicacion}</small>
        </span>
      }
    >
      <MvArribosVivo r={r} />
    </Shell>
  );
}

function MvLugares({ r }: { r: Json }) {
  const rs: Json[] = (r.resultados ?? r.paradas ?? []).slice(0, 4);
  const pts = rs.filter(hayPunto);
  return (
    <Shell f="movilidad" name={r.paradas ? "parada_buscar" : "lugar_buscar"} title={<strong>{r.paradas ? "paradas cerca" : "lugares"}</strong>}>
      <Mapa pts={pts.slice(0, 1)} />
      <ul className="mv-places">
        {rs.map((x, i) => (
          <li key={i}>
            <strong>{x.nombre ?? x.codigo}</strong>
            <small>
              {x.direccion ?? x.ubicacion}
              {x.lineas?.length ? ` · ${x.lineas.join(", ")}` : ""}
            </small>
          </li>
        ))}
      </ul>
    </Shell>
  );
}

// ---------- Reglas del secretario (estilo de la consola: es él mismo, no otra app) ----------

function Regla({ r, envio, onSay }: { r: Json; envio?: ToolItem; onSay?: (t: string) => void }) {
  const g = r.regla ?? {};
  const ok = envio?.result?.estado === "guardada";
  const fallo = envio?.result?.error && envio.result.error !== "falta_confirmacion";
  return (
    <div className="rg-card" data-ok={ok}>
      <div className="rg-head">
        <span className="rg-kind">{r.reemplaza ? "regla que reemplaza otra" : "regla nueva"}</span>
        <span className="rg-name">{g.nombre}</span>
      </div>
      {r.reemplaza && <p className="rg-old">antes: {r.reemplaza.contenido}</p>}
      <p className="rg-text">{g.contenido}</p>
      {ok ? (
        <p className="rg-state">guardada · la ves y la cambiás en secretario → reglas</p>
      ) : fallo ? (
        <p className="rg-state rg-bad">{String(envio!.result!.mensaje ?? "no se guardó")}</p>
      ) : (
        onSay && (
          <div className="row">
            <button type="button" className="btn primary" onClick={() => onSay("sí, guardala")}>
              guardar
            </button>
            <button type="button" className="btn quiet" onClick={() => onSay("no, no la guardes")}>
              no
            </button>
          </div>
        )
      )}
    </div>
  );
}

// ---------- Misión (un encargo largo que sigue solo): el alcance que el dueño aprueba ----------

function Mision({ r, onSay }: { r: Json; onSay?: (t: string) => void }) {
  const { tenant } = useConsole();
  const m = r.mision ?? {};
  const plata = (m.transferencias ?? []) as Json[];
  const [textos, setTextos] = useState<string[]>(((m.borradores ?? []) as Json[]).map((b) => String(b.texto ?? "")));
  const [editando, setEditando] = useState<number | null>(null);
  const [borrador, setBorrador] = useState("");
  const [error, setError] = useState<string | null>(null);
  // Si ya los corregiste (y recargaste), valen los guardados en la consola, no los de la propuesta original.
  useEffect(() => {
    if (!onSay) return;
    api
      .get<{ textos: string[] | null }>(`/t/${tenant}/misiones/borrador`)
      .then((d) => d.textos && d.textos.length === textos.length && setTextos(d.textos))
      .catch(() => null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tenant, !!onSay]);
  const fecha = (ts: number) => when(new Date(ts * 1000).toISOString());
  const cuando = m.despertar ? fecha(m.despertar) : null;
  const sale = cuando ? `sale sola el ${cuando}` : m.esperar_ingreso ? "sale sola cuando te entre plata" : "la manda la misión cuando toque";
  const guardar = async (i: number) => {
    setError(null);
    try {
      await api.post(`/t/${tenant}/misiones/borrador`, { i, texto: borrador.trim() });
      setTextos((xs) => xs.map((x, j) => (j === i ? borrador.trim() : x)));
      setEditando(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "No se pudo guardar el cambio.");
    }
  };
  // Cada mensaje aprobable va DENTRO de su paso del plan (con «corregir» ahí): antes se veía dos veces.
  const borr = (m.borradores ?? []) as Json[];
  const pasos = (m.pasos ?? []) as Json[];
  const enPaso = new Map<number, number>(); // n del paso → índice del borrador
  for (const p of pasos) {
    if (p.accion !== "mensaje" || !p.texto) continue;
    const i = borr.findIndex((b, j) => b.texto === p.texto && ![...enPaso.values()].includes(j));
    if (i >= 0) enPaso.set(p.n, i);
  }
  const usados = new Set(enPaso.values());
  const editor = (i: number, nombre: string) =>
    editando === i ? (
      <div className="mision-editar">
        <textarea className="input" rows={3} value={borrador} onChange={(e) => setBorrador(e.target.value)} aria-label={`mensaje para ${nombre}`} autoFocus />
        <div className="row">
          <button type="button" className="tc-btn tc-btn-ok" disabled={!borrador.trim()} onClick={() => guardar(i)}>
            guardar
          </button>
          <button type="button" className="tc-btn" onClick={() => setEditando(null)}>
            dejarlo como estaba
          </button>
        </div>
      </div>
    ) : (
      onSay && (
        <button
          type="button"
          className="tc-btn"
          onClick={() => {
            setBorrador(textos[i]);
            setEditando(i);
          }}
        >
          corregir
        </button>
      )
    );
  const mensajeDelPaso = (p: Json) => {
    const i = enPaso.get(p.n);
    if (i === undefined) return null;
    return (
      <div className="mp-msg">
        <div className="wa-bubble wa-out wa-draft">{textos[i]}</div>
        {editor(i, String(borr[i]?.nombre ?? ""))}
      </div>
    );
  };
  return (
    <div className="mision-card">
      <div className="rg-card">
        <div className="rg-head">
          <span className="rg-kind">{m.reemplaza ? "cambio de misión" : "misión nueva"}</span>
          <span className="rg-name">{m.objetivo}</span>
        </div>
        <dl className="rg-kv">
          {cuando && (
            <div>
              <dt>cuándo</dt>
              <dd>{cuando}</dd>
            </div>
          )}
          {(m.contactos ?? []).length > 0 && !pasos.length && (
            <div>
              <dt>habla con</dt>
              <dd>{(m.contactos as Json[]).map((c) => c.nombre + (c.grupo ? " (grupo)" : "")).join(", ")}</dd>
            </div>
          )}
          {m.alcance && (
            <div>
              <dt>decide solo</dt>
              <dd>{m.alcance}</dd>
            </div>
          )}
          {m.esperar_ingreso && !pasos.length && (
            <div>
              <dt>se despierta</dt>
              <dd>cuando te entra plata</dd>
            </div>
          )}
        </dl>
        {/* «te consulta» y «vence» van en el plan (cómo se comunica / cuándo termina): sin repetirlos acá */}
        <PlanMision m={m} mensaje={mensajeDelPaso} />
      </div>
      {plata.map((t, i) => (
        <Shell key={`nx-${i}`} f="naranjax" title={<strong>transferencia de la misión</strong>}>
          <div className="nx-amount">{pesos(t.monto) ?? "—"}</div>
          <dl className="nx-rows">
            <div>
              <dt>para</dt>
              <dd>{t.titular || t.etiqueta || t.destino}</dd>
            </div>
            {(t.alias || t.cvu_cbu) && (
              <div>
                <dt>{t.alias ? "alias" : "CVU/CBU"}</dt>
                <dd className="mono-id">{t.alias || t.cvu_cbu}</dd>
              </div>
            )}
            {t.veces > 1 && (
              <div>
                <dt>veces</dt>
                <dd>{t.veces}</dd>
              </div>
            )}
          </dl>
          <p className="nx-state">
            {t.conocida === false ? "cuenta nueva: para aprobar decí el nombre · " : ""}
            {sale} · todavía no se mandó
          </p>
        </Shell>
      ))}
      {borr.map((b, i) => usados.has(i) ? null : (
        <Shell
          key={`wa-${i}`}
          f="whatsapp"
          title={
            <>
              <span className="tc-avatar">{String(b.nombre ?? "?").slice(0, 1).toUpperCase()}</span>
              <span>
                <strong>{b.nombre}</strong>
                <small>mensaje de la misión</small>
              </span>
            </>
          }
          foot={
            editando === i ? (
              editor(i, String(b.nombre ?? ""))
            ) : (
              <>
                <span className="tc-status">{cuando ? `se manda el ${cuando}` : "lo manda la misión cuando toque"}</span>
                {editor(i, String(b.nombre ?? ""))}
              </>
            )
          }
        >
          <div className="wa-chat">
            <div className="wa-bubble wa-out wa-draft">{textos[i]}</div>
          </div>
        </Shell>
      ))}
      {error && <p className="nx-state nx-bad">{error}</p>}
      {onSay && <EnsayoMision />}
      {onSay && editando === null && (
        <div className="row">
          <button type="button" className="btn primary" onClick={() => onSay(m.reemplaza ? "sí, cambiala" : "sí, arrancala")}>
            {m.reemplaza ? "cambiar" : "arrancar"}
          </button>
          <button type="button" className="btn quiet" onClick={() => onSay("no, no la arranques")}>
            no
          </button>
        </div>
      )}
    </div>
  );
}

// ---------- router ----------


function tarjeta(t: ToolItem, envio?: ToolItem, onSay?: (t: string) => void): ReactNode | null {
  const r = t.result;
  const n = corto(t.name);
  if (!t.done || !r || typeof r !== "object" || r.error) return null;
  if (n === "wa_enviar_preview" && r.estado === "listo_para_enviar") return <WaPreview r={r} envio={envio} onSay={onSay} />;
  // Enviado sin un preview a la vista (se cortó, o vino de otra charla): la burbuja enviada sola.
  if (n === "wa_enviar" && r.estado === "enviado")
    return <WaPreview r={{ destinatario: r.destinatario ?? { nombre: r.a }, contenido: `«${r.texto ?? ""}»`, texto: r.texto, adjunto: r.adjunto }} envio={t} />;
  if (n === "wa_mensajes" && Array.isArray(r.mensajes)) return <WaMensajes r={r} />;
  if (n === "wa_recientes" && Array.isArray(r.chats)) return <WaRecientes r={r} />;
  if (n === "wa_transcribir" && typeof r.texto === "string") return <WaAudio r={r} />;
  if (n === "wa_reproducir" && r.estado === "reproducir") return <WaAudio r={{ ...r, texto: undefined }} />;
  if (n === "wa_grabar_nota" && r.estado === "grabar")
    return (
      <Shell f="whatsapp" title={<strong>{r.destinatario?.nombre ?? r.destino}</strong>}>
        <GrabarNota r={r} onSay={onSay} />
      </Shell>
    );
  if (n === "wa_vigilar" && r.estado === "vigilando") return <WaVigilando r={r} />;
  if ((n === "nx_transfer_preview" || n === "nx_transfer_armar") && r.monto != null) return <NxTransfer r={r} envio={envio} onSay={onSay} />;
  if (n === "nx_destino_resolver" && r.destinatario) return <NxDestino r={r} onSay={onSay} />;
  if (n === "regla_preparar" && r.estado === "listo_para_guardar") return <Regla r={r} envio={envio} onSay={onSay} />;
  if (n === "mision_preparar" && r.estado === "listo_para_autorizar") return <Mision r={r} onSay={onSay} />;
  if ((n === "nx_saldo" || n === "nx_inicio") && (r.pesos != null || r.saldo != null)) return <NxSaldo r={r} />;
  if ((n === "como_llegar" || n === "viaje_planear") && (r.rutas || r.opciones)) return <MvRuta r={r} args={t.args} onSay={onSay} />;
  if (n === "micro_cuando_viene" && Array.isArray(r.arribos)) return <MvArribos r={r} />;
  if ((n === "lugar_buscar" && Array.isArray(r.resultados)) || (n === "parada_buscar" && Array.isArray(r.paradas))) return <MvLugares r={r} />;
  return null;
}

export const tieneTarjeta = (t: ToolItem) => tarjeta(t) !== null;

export function ToolView({ t, envio, onSay }: { t: ToolItem; envio?: ToolItem; onSay?: (t: string) => void }) {
  return <>{tarjeta(t, envio, onSay) ?? <ToolLine t={t} />}</>;
}
