// Correr la revisión + informe a pedido, desde la terminal:
//   docker exec -w /opt/no-phone-admin no-phone-admin-1 npx tsx server/informe-cli.ts [tenant]
// Revisa las charlas pendientes, arma el informe y lo imprime (también queda en «informes» de la consola).
import { getTenant } from "./db.ts";
import * as revision from "./revision.ts";

const tenant = process.argv[2] ? getTenant(process.argv[2]) : undefined;
if (process.argv[2] && !tenant) {
  console.error(`No existe el tenant ${process.argv[2]}`);
  process.exit(1);
}
const r = await revision.correr(tenant);
console.log(`revisadas: ${r.revisadas} · informe: ${r.informe ?? "sin novedades"}${r.errores.length ? ` · errores: ${r.errores.join(" | ")}` : ""}`);
if (r.informe && tenant) {
  const inf = revision.informes(tenant).informes.find((i) => i.id === r.informe);
  console.log(JSON.stringify(inf, null, 2));
}
process.exit(0);
