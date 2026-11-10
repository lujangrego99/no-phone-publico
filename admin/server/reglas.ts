// Las reglas del dueño (consola → ajustes → reglas, o pedidas por chat al conector secretario) viven en un solo
// lugar: las directivas del banco de memoria. Pero Hindsight solo las usa al «reflexionar»; Hermes no las ve.
// Para que el secretario las cumpla de verdad, le llegan por dos caminos:
//   1. en cada mensaje del chat, junto con las instrucciones (cuentan al instante);
//   2. en un bloque de su SOUL.md que esto mantiene sincronizado (tareas programadas y charlas nuevas).
// El bloque no se muestra en el editor de personalidad y se vuelve a poner al guardarla.
import { hindsight } from "./hindsight.ts";
import * as hermes from "./hermes.ts";
import type { Tenant } from "./db.ts";

type Directiva = { name?: string; content?: string; is_active?: boolean };

const INICIO = "<!-- reglas: las mantiene la consola (ajustes → reglas). No editar acá. -->";
const FIN = "<!-- /reglas -->";
const BLOQUE = /\n*<!-- reglas:[\s\S]*?<!-- \/reglas -->\n*/;

export async function reglasActivas(t: Tenant): Promise<{ nombre: string; contenido: string }[]> {
  const { items } = await hindsight.directives(t.bank_id);
  return (items as Directiva[])
    .filter((d) => d.is_active !== false && (d.content ?? "").trim())
    .map((d) => ({ nombre: (d.name ?? "").trim(), contenido: (d.content ?? "").trim() }));
}

export function textoReglas(reglas: { nombre: string; contenido: string }[]): string {
  if (!reglas.length) return "";
  return (
    "Reglas que te puso tu dueño (cumplilas siempre, por encima de cualquier otra costumbre):\n" +
    reglas.map((r) => `- ${r.contenido}`).join("\n")
  );
}

export const sinBloque = (soul: string) => soul.replace(BLOQUE, "\n").trimEnd() + "\n";

function conBloque(soul: string, texto: string) {
  const base = sinBloque(soul).trimEnd();
  return texto ? `${base}\n\n${INICIO}\n${texto}\n${FIN}\n` : base + "\n";
}

// Reescribe el SOUL.md solo si el bloque cambió (cada escritura deja un .bak).
export async function sincronizarSoul(t: Tenant, reglas?: { nombre: string; contenido: string }[]) {
  const actual = await hermes.readSoul(t);
  if (!actual.trim()) return;
  const nuevo = conBloque(actual, textoReglas(reglas ?? (await reglasActivas(t))));
  if (nuevo !== actual) await hermes.writeSoul(t, nuevo);
}

// Guardar la personalidad desde el editor sin perder el bloque de reglas.
export async function guardarPersonalidad(t: Tenant, texto: string) {
  await hermes.writeSoul(t, conBloque(texto, textoReglas(await reglasActivas(t).catch(() => []))));
}
