// Celulares por tenant. Registro ÚNICO: el phones.json que usan el MCP naranjax y la API
// (phones.py). La consola solo agrega campos opcionales (kind, adb_server, ui_mode, hw) que
// phones.py respeta. Secretos de solo escritura en <secretos>/<id>.env, clave = pin_env.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, mkdirSync } from "node:fs";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tenantTools, type Tenant } from "./db.ts";
import { HttpError } from "./auth.ts";

const run = promisify(execFile);

const CONFIG_DIR = join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "no-phone");
/** Rutas del tenant por defecto: las mismas que lee phones.py sin variables de entorno. */
export const DEFAULT_PHONES_FILE = process.env.NX_PHONES_FILE ?? join(CONFIG_DIR, "phones.json");
export const DEFAULT_SECRETS_DIR = process.env.DEVICE_SECRETS_DIR ?? process.env.NX_PHONE_SECRETS_DIR ?? join(CONFIG_DIR, "devices");

/** Secretos que la consola acepta (por clave). Solo escritura. */
export const SECRET_KEYS = {
  NX_PIN: { label: "PIN de Naranja X", pattern: /^\d{6}$/, hint: "6 dígitos", min: 6, max: 6 },
  // PIN de la pantalla de bloqueo: con él el secretario desbloquea el celu antes de usarlo (phones.py: DEVICE_PIN).
  DEVICE_PIN: { label: "PIN de desbloqueo del celu", pattern: /^\d{4,16}$/, hint: "4 a 16 dígitos", min: 4, max: 16 },
} as const;
export type SecretKey = keyof typeof SECRET_KEYS;

export type UiMode = "fast" | "normal" | "safe";
export const UI_MODES: UiMode[] = ["fast", "normal", "safe"];

interface Hw {
  fabricante?: string;
  modelo?: string;
  android?: string;
  resolucion?: string;
}

/** Un perfil tal como vive en phones.json (+ su id). */
interface PhoneProfile extends Hw {
  id: string;
  label: string;
  serial: string;
  pin_env: string;
  notas?: string | null;
  kind?: "fisico" | "virtual";
  adb_server?: string | null;
  ui_mode?: UiMode;
  hw?: Hw;
}
interface PhonesFile {
  activo?: string;
  perfiles: Record<string, Omit<PhoneProfile, "id">>;
  [k: string]: unknown;
}

export interface DeviceView {
  id: string;
  kind: "fisico" | "virtual";
  label: string;
  serial: string | null;
  adbServer: string | null;
  active: boolean;
  profile: Hw & { ui_mode?: UiMode };
  secrets: Record<SecretKey, boolean>;
  health: "ok" | "caido" | "desconocido";
  detail: string;
}

const ID = /^[a-z0-9][a-z0-9_-]{1,40}$/;
const SERIAL = /^[A-Za-z0-9.:_-]{3,64}$/;
const HOSTPORT = /^[A-Za-z0-9.-]{1,253}:\d{2,5}$/;

// ---------- rutas por tenant ----------

export function phonesFile(t: Tenant): string {
  return tenantTools(t).phones_file ?? DEFAULT_PHONES_FILE;
}
export function secretsDir(t: Tenant): string {
  return tenantTools(t).phone_secrets_dir ?? DEFAULT_SECRETS_DIR;
}

async function load(t: Tenant): Promise<PhonesFile> {
  const p = phonesFile(t);
  if (!existsSync(p)) return { perfiles: {} };
  try {
    const data = JSON.parse(await readFile(p, "utf8")) as PhonesFile;
    data.perfiles ??= {};
    return data;
  } catch {
    throw new HttpError(500, "phones_roto", `No pude leer ${p}: el JSON está roto.`);
  }
}

async function save(t: Tenant, data: PhonesFile) {
  const p = phonesFile(t);
  mkdirSync(dirname(p), { recursive: true, mode: 0o700 });
  // Escritura atómica: el MCP puede estar leyéndolo.
  const tmp = `${p}.tmp-${process.pid}`;
  await writeFile(tmp, JSON.stringify(data, null, 2) + "\n", { mode: 0o600 });
  await rename(tmp, p);
}

function profileOf(id: string, raw: Omit<PhoneProfile, "id">): PhoneProfile {
  return { ...raw, id, label: raw.label || id, serial: (raw.serial ?? "").trim(), pin_env: raw.pin_env || "NX_PIN" };
}

export async function getDevice(t: Tenant, id: string): Promise<PhoneProfile> {
  const raw = (await load(t)).perfiles[id];
  if (!raw) throw new HttpError(404, "no_existe", "Ese celular no existe.");
  return profileOf(id, raw);
}

// ---------- adb ----------

type AdbTarget = { serial: string | null; adb_server?: string | null };

function adbArgs(d: AdbTarget, rest: string[]) {
  const args: string[] = [];
  if (d.adb_server) {
    const [h, p] = d.adb_server.split(":");
    args.push("-H", h, "-P", p);
  }
  if (d.serial) args.push("-s", d.serial);
  return [...args, ...rest];
}

async function adb(d: AdbTarget, rest: string[], timeout = 8000) {
  const { stdout } = await run("adb", adbArgs(d, rest), { timeout });
  return stdout.trim();
}

/** Lee el perfil real del celu: fabricante, modelo, Android y resolución. */
export async function detectProfile(d: AdbTarget): Promise<Hw> {
  try {
    const [fabricante, modelo, android, size] = await Promise.all([
      adb(d, ["shell", "getprop", "ro.product.manufacturer"]),
      adb(d, ["shell", "getprop", "ro.product.model"]),
      adb(d, ["shell", "getprop", "ro.build.version.release"]),
      adb(d, ["shell", "wm", "size"]),
    ]);
    return { fabricante, modelo, android, resolucion: size.match(/(\d+x\d+)\s*$/)?.[1] ?? size };
  } catch {
    throw new HttpError(409, "celu_inaccesible", "No pude leer el celular por adb. Revisá el serial y que esté conectado.");
  }
}

async function healthApk(d: PhoneProfile): Promise<Pick<DeviceView, "health" | "detail">> {
  const id = d.serial.slice(4);
  const hub = (process.env.AGENTE_HUB_URL ?? "ws://agente:8766").replace(/^ws/, "http").replace(/\/$/, "");
  try {
    const r = await fetch(`${hub}/estado`, {
      headers: { "X-Token": process.env.AGENTE_CTL_TOKEN ?? "" },
      signal: AbortSignal.timeout(4000),
    });
    if (!r.ok) return { health: "caido", detail: `el hub de agentes respondió ${r.status}` };
    const st = (await r.json()) as { celus: Record<string, { conectado_hace_s?: number; version?: string }> };
    const c = st.celus?.[id];
    return c
      ? { health: "ok", detail: `conectado por la app no-phone ${c.version ?? ""}`.trim() }
      : { health: "caido", detail: "la app no-phone del celu no está conectada (¿sin red, apagado o accesibilidad apagada?)" };
  } catch {
    return { health: "caido", detail: "el hub de agentes no responde" };
  }
}

async function health(d: PhoneProfile): Promise<Pick<DeviceView, "health" | "detail">> {
  if (d.kind === "virtual") return { health: "desconocido", detail: "celulares virtuales: próximamente" };
  if (!d.serial) return { health: "desconocido", detail: "falta el serial adb" };
  if (d.serial.startsWith("apk:")) return healthApk(d);
  try {
    const st = await adb(d, ["get-state"]);
    return st === "device"
      ? { health: "ok", detail: d.adb_server ? `conectado vía ${d.adb_server}` : "conectado por adb" }
      : { health: "caido", detail: st };
  } catch (e) {
    const msg = String((e as { stderr?: string }).stderr ?? (e as Error).message);
    const why = /unauthorized/.test(msg)
      ? "falta aceptar la depuración en el celu"
      : /not found/.test(msg)
        ? "no está conectado"
        : d.adb_server
          ? `el adb server ${d.adb_server} no responde`
          : "adb no responde";
    return { health: "caido", detail: why };
  }
}

// ---------- secretos ----------

async function secretFile(t: Tenant, id: string): Promise<Record<string, string>> {
  const p = join(secretsDir(t), `${id}.env`);
  if (!existsSync(p)) return {};
  const out: Record<string, string> = {};
  for (const line of (await readFile(p, "utf8")).split("\n")) {
    const i = line.indexOf("=");
    if (i > 0 && !line.trimStart().startsWith("#")) out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return out;
}

// El .env del repo: el MCP naranjax y la API lo cargan al arrancar (fallback de PIN de phones.py).
const REPO_ENV = process.env.NX_ENV_FILE ?? join(dirname(fileURLToPath(import.meta.url)), "../../.env");

async function envKeys(path: string): Promise<Set<string>> {
  if (!existsSync(path)) return new Set();
  const keys = new Set<string>();
  for (const line of (await readFile(path, "utf8")).split("\n")) {
    const i = line.indexOf("=");
    if (i > 0 && !line.trimStart().startsWith("#") && line.slice(i + 1).trim()) keys.add(line.slice(0, i).trim());
  }
  return keys;
}

/** ¿El PIN está donde phones.py lo busca? Archivo del perfil > env pin_env > NX_PIN. Solo presencia, nunca el valor. */
async function hasPin(t: Tenant, d: PhoneProfile): Promise<boolean> {
  if ((await secretFile(t, d.id))[d.pin_env]) return true;
  const repo = secretsDir(t) === DEFAULT_SECRETS_DIR ? await envKeys(REPO_ENV) : new Set<string>();
  // Caer al NX_PIN general cuenta solo si ese ES su pin_env: si no, usaría el PIN de otro celu.
  return !!process.env[d.pin_env] || repo.has(d.pin_env);
}

export async function setSecret(t: Tenant, d: PhoneProfile, key: SecretKey, value: string) {
  const spec = SECRET_KEYS[key];
  if (!spec) throw new HttpError(400, "secreto_desconocido", "Ese dato no se puede guardar acá.");
  if (!spec.pattern.test(value)) throw new HttpError(400, "secreto_invalido", `${spec.label}: ${spec.hint}.`);
  const dir = secretsDir(t);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const current = await secretFile(t, d.id);
  // phones.py busca la clave con el nombre de pin_env del perfil (NX_PIN, NX_PIN_MOTO, …).
  current[key === "NX_PIN" ? d.pin_env : key] = value;
  const body = Object.entries(current).map(([k, v]) => `${k}=${v}`).join("\n") + "\n";
  await writeFile(join(dir, `${d.id}.env`), body, { mode: 0o600 });
}

// ---------- vistas ----------

async function view(t: Tenant, d: PhoneProfile, activo: string | undefined): Promise<DeviceView> {
  const hw = d.hw ?? {};
  return {
    id: d.id,
    kind: d.kind ?? "fisico",
    label: d.label,
    serial: d.serial || null,
    adbServer: d.adb_server ?? null,
    active: d.id === activo,
    profile: { ...hw, ui_mode: d.ui_mode },
    secrets: {
      NX_PIN: await hasPin(t, d),
      // Solo los celus físicos tienen pantalla de bloqueo propia.
      ...((d.kind ?? "fisico") === "fisico" ? { DEVICE_PIN: !!(await secretFile(t, d.id)).DEVICE_PIN } : {}),
    },
    ...(await health(d)),
  };
}

export async function viewDevice(t: Tenant, id: string): Promise<DeviceView> {
  const data = await load(t);
  const raw = data.perfiles[id];
  if (!raw) throw new HttpError(404, "no_existe", "Ese celular no existe.");
  return view(t, profileOf(id, raw), data.activo);
}

export async function viewDevices(t: Tenant): Promise<DeviceView[]> {
  const data = await load(t);
  return Promise.all(Object.entries(data.perfiles).map(([id, raw]) => view(t, profileOf(id, raw), data.activo)));
}

export async function countDevices(t: Tenant): Promise<number> {
  return Object.keys((await load(t)).perfiles).length;
}

// ---------- alta / cambios ----------

export interface DeviceInput {
  id: string;
  kind: "fisico" | "virtual";
  label: string;
  serial?: string | null;
  adbServer?: string | null;
  uiMode?: UiMode;
}

export async function createDevice(t: Tenant, input: DeviceInput): Promise<PhoneProfile> {
  if (input.kind === "virtual") throw new HttpError(400, "proximamente", "Los celulares virtuales todavía no están disponibles.");
  if (!ID.test(input.id)) throw new HttpError(400, "id_invalido", "El id va en minúsculas, números, guiones o guion bajo.");
  if (!input.label?.trim()) throw new HttpError(400, "falta_nombre", "Poné un nombre para reconocerlo.");
  if (!input.serial || !SERIAL.test(input.serial)) throw new HttpError(400, "serial_invalido", "Serial adb inválido.");
  if (input.adbServer && !HOSTPORT.test(input.adbServer)) throw new HttpError(400, "adb_server_invalido", "El adb server va como host:puerto.");
  const data = await load(t);
  if (data.perfiles[input.id]) throw new HttpError(409, "id_repetido", "Ya hay un celular con ese id.");
  const hw = await detectProfile({ serial: input.serial, adb_server: input.adbServer || null });
  // Cada celular nuevo con su propia variable de PIN, para no pisar la de otro.
  const usados = new Set(Object.values(data.perfiles).map((p) => p.pin_env || "NX_PIN"));
  const pinEnv = usados.has("NX_PIN") ? `NX_PIN_${input.id.toUpperCase().replace(/[^A-Z0-9]/g, "_")}` : "NX_PIN";
  data.perfiles[input.id] = {
    label: input.label.trim(),
    serial: input.serial,
    pin_env: pinEnv,
    kind: "fisico",
    adb_server: input.adbServer || null,
    ui_mode: input.uiMode ?? "fast",
    hw,
  };
  data.activo ??= input.id;
  await save(t, data);
  return getDevice(t, input.id);
}

export async function updateDevice(
  t: Tenant,
  id: string,
  patch: { label?: string; serial?: string; uiMode?: UiMode; redetect?: boolean; activate?: boolean },
) {
  const data = await load(t);
  const cur = data.perfiles[id];
  if (!cur) throw new HttpError(404, "no_existe", "Ese celular no existe.");
  if (patch.label?.trim()) cur.label = patch.label.trim();
  if (patch.serial !== undefined) {
    if (!SERIAL.test(patch.serial)) throw new HttpError(400, "serial_invalido", "Serial adb inválido.");
    cur.serial = patch.serial;
  }
  if (patch.uiMode) cur.ui_mode = patch.uiMode;
  if (patch.redetect || (patch.serial !== undefined && !cur.hw?.modelo)) {
    cur.hw = { ...(cur.hw ?? {}), ...(await detectProfile({ serial: cur.serial, adb_server: cur.adb_server ?? null })) };
  }
  if (patch.activate) {
    if (!cur.serial) throw new HttpError(409, "sin_serial", "Cargá el serial antes de usarlo.");
    data.activo = id;
  }
  await save(t, data);
}

export async function deleteDevice(t: Tenant, id: string) {
  const data = await load(t);
  if (!data.perfiles[id]) throw new HttpError(404, "no_existe", "Ese celular no existe.");
  delete data.perfiles[id];
  if (data.activo === id) data.activo = Object.keys(data.perfiles)[0];
  await save(t, data);
  await rm(join(secretsDir(t), `${id}.env`), { force: true });
}
