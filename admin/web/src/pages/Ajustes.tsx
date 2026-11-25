// Todo lo que se configura de vez en cuando, en un solo lugar: el secretario (modelo, personalidad, reglas),
// las conexiones (celular, WhatsApp, conectores) y, para quien administra, las personas con su secretario.
import { useSearchParams } from "react-router";
import { useConsole } from "../App";
import { Herramientas } from "./Herramientas";
import { Secretario } from "./Secretario";
import { Tenants } from "./Tenants";

const PARTES = [
  { id: "secretario", label: "secretario" },
  { id: "conexiones", label: "conexiones" },
  { id: "personas", label: "personas", soloAdmin: true },
] as const;

export function Ajustes() {
  const { session } = useConsole();
  const esAdmin = session.user?.role === "superadmin";
  const [params, setParams] = useSearchParams();
  const partes = PARTES.filter((p) => !("soloAdmin" in p) || esAdmin);
  const ver = partes.find((p) => p.id === params.get("ver"))?.id ?? "secretario";

  return (
    <div className="ajustes">
      <div className="page-head">
        <h1 className="display">ajustes.</h1>
      </div>
      <div className="tabs" role="tablist" aria-label="partes de los ajustes">
        {partes.map((p) => (
          <button key={p.id} role="tab" type="button" aria-selected={ver === p.id} className="tab" onClick={() => setParams(p.id === "secretario" ? {} : { ver: p.id })}>
            {p.label}
          </button>
        ))}
      </div>
      <div role="tabpanel" className="tabpanel">
        {ver === "secretario" && <Secretario embebido />}
        {ver === "conexiones" && <Herramientas embebido />}
        {ver === "personas" && <Tenants embebido />}
      </div>
    </div>
  );
}
