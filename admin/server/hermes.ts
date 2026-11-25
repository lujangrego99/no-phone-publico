// Lo que la consola toca de Hermes, siempre dentro del HERMES_HOME del tenant.
// Nunca devuelve secretos: ni .env, ni auth.json, ni los `env` de los MCP.
import { readFile, writeFile, copyFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { parse, stringify } from "yaml";
import { HttpError } from "./auth.ts";
import type { Tenant } from "./db.ts";

const run = promisify(execFile);
const HERMES_BIN = process.env.HERMES_BIN ?? "hermes";

function hermesEnv(t: Tenant) {
  return { ...process.env, HERMES_HOME: t.hermes_home, NO_COLOR: "1", TERM: "dumb" };
}

async function hermes(t: Tenant, args: string[], timeout = 60000) {
  try {
    const { stdout } = await run(HERMES_BIN, args, { env: hermesEnv(t), timeout, maxBuffer: 4 * 1024 * 1024 });
    return stdout;
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; message: string };
    throw new HttpError(502, "hermes_error", (err.stderr || err.stdout || err.message).trim().split("\n").slice(-3).join(" "));
  }
}

async function backup(path: string) {
  if (!existsSync(path)) return;
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "").replace("T", "_");
  await copyFile(path, `${path}.bak.${stamp}`);
}

// ---------- personalidad ----------

export async function readSoul(t: Tenant): Promise<string> {
  const p = join(t.hermes_home, "SOUL.md");
  return existsSync(p) ? readFile(p, "utf8") : "";
}

export async function writeSoul(t: Tenant, text: string) {
  const p = join(t.hermes_home, "SOUL.md");
  await backup(p);
  await writeFile(p, text.endsWith("\n") ? text : text + "\n", { mode: 0o600 });
}

// ---------- config.yaml (solo campos seguros) ----------

async function readConfig(t: Tenant): Promise<Record<string, any>> {
  const p = join(t.hermes_home, "config.yaml");
  if (!existsSync(p)) return {};
  return (parse(await readFile(p, "utf8")) as Record<string, any>) ?? {};
}

async function writeConfig(t: Tenant, c: Record<string, any>) {
  const p = join(t.hermes_home, "config.yaml");
  await backup(p);
  await writeFile(p, stringify(c, { lineWidth: 0 }), { mode: 0o600 });
}

export interface AgentSettings {
  model: { provider: string | null; default: string | null; base_url: string | null };
  memoryProvider: string | null;
  mcpServers: { name: string; command: string; args: string[]; hasEnv: boolean }[];
}

export async function readAgentSettings(t: Tenant): Promise<AgentSettings> {
  const c = await readConfig(t);
  const mcp = (c.mcp_servers ?? {}) as Record<string, { command?: string; args?: string[]; env?: object; url?: string }>;
  return {
    model: {
      provider: c.model?.provider ?? null,
      default: c.model?.default ?? null,
      base_url: c.model?.base_url ?? null,
    },
    memoryProvider: c.memory?.provider ?? null,
    mcpServers: Object.entries(mcp).map(([name, s]) => ({
      name,
      command: s.command ?? s.url ?? "",
      args: s.args ?? [],
      hasEnv: !!s.env && Object.keys(s.env).length > 0,
    })),
  };
}

/** Agrega variables de entorno a un MCP del perfil (p. ej. dónde están los celulares del tenant). */
export async function setMcpEnv(t: Tenant, server: string, env: Record<string, string>) {
  const c = await readConfig(t);
  const s = c.mcp_servers?.[server];
  if (!s) return false;
  s.env = { ...(s.env ?? {}), ...env };
  await writeConfig(t, c);
  return true;
}

export async function writeModel(t: Tenant, model: { provider?: string; default?: string; base_url?: string | null }) {
  const c = await readConfig(t);
  c.model = { ...(c.model ?? {}) };
  if (model.provider !== undefined) c.model.provider = model.provider;
  if (model.default !== undefined) c.model.default = model.default;
  if (model.base_url !== undefined) {
    if (model.base_url) c.model.base_url = model.base_url;
    else delete c.model.base_url;
  }
  await writeConfig(t, c);
}

// ---------- plugin de memoria (hindsight/config.json, sin claves) ----------

const RECALL_KEYS = ["recall_budget", "recall_max_tokens", "recall_types", "auto_recall", "auto_retain", "retain_every_n_turns", "memory_mode"] as const;

export async function readRecallSettings(t: Tenant): Promise<Record<string, unknown>> {
  const p = join(t.hermes_home, "hindsight/config.json");
  if (!existsSync(p)) return {};
  const c = JSON.parse(await readFile(p, "utf8"));
  return Object.fromEntries(RECALL_KEYS.filter((k) => k in c).map((k) => [k, c[k]]));
}

export async function writeRecallSettings(t: Tenant, updates: Record<string, unknown>) {
  const p = join(t.hermes_home, "hindsight/config.json");
  const c = existsSync(p) ? JSON.parse(await readFile(p, "utf8")) : {};
  for (const k of RECALL_KEYS) if (k in updates) c[k] = updates[k];
  await backup(p);
  await mkdir(join(t.hermes_home, "hindsight"), { recursive: true });
  await writeFile(p, JSON.stringify(c, null, 2) + "\n", { mode: 0o600 });
}

// ---------- tareas (cron) ----------

export interface Job {
  id: string;
  name: string;
  prompt: string;
  schedule: string;
  state: string;
  enabled: boolean;
  next_run_at: string | null;
  last_run_at: string | null;
  last_status: string | null;
  last_error: string | null;
  repeat: { times: number | null; completed: number } | null;
  created_at: string | null;
  deliver: string | null;
}

export async function listJobs(t: Tenant): Promise<Job[]> {
  const p = join(t.hermes_home, "cron/jobs.json");
  if (!existsSync(p)) return [];
  const raw = JSON.parse(await readFile(p, "utf8"));
  const jobs: any[] = Array.isArray(raw) ? raw : raw.jobs ?? [];
  return jobs.map((j) => {
    const prompt = typeof j.prompt === "string" ? j.prompt : "";
    const enabled = j.enabled !== false;
    return {
      id: String(j.id),
      name: (j.name || prompt.slice(0, 50) || j.id) as string,
      prompt,
      schedule: j.schedule_display || j.schedule?.display || j.schedule?.expr || j.schedule?.run_at || "?",
      state: j.state || (enabled ? "scheduled" : "paused"),
      enabled,
      next_run_at: j.next_run_at ?? null,
      last_run_at: j.last_run_at ?? null,
      last_status: j.last_status ?? null,
      last_error: j.last_error ?? null,
      repeat: j.repeat ?? null,
      created_at: j.created_at ?? null,
      deliver: typeof j.deliver === "string" ? j.deliver : null,
    };
  });
}

const JOB_ID = /^[A-Za-z0-9_-]{1,80}$/;

export async function jobAction(t: Tenant, id: string, action: "pause" | "resume" | "remove") {
  if (!JOB_ID.test(id)) throw new HttpError(400, "id_invalido", "Id de tarea inválido.");
  await hermes(t, ["cron", action, id]);
}

export async function schedulerRunning(t: Tenant): Promise<boolean | null> {
  try {
    const out = await hermes(t, ["cron", "status"], 20000);
    return !/not running|stopped|inactive/i.test(out);
  } catch {
    return null;
  }
}

// ---------- MCP ----------

export async function testMcp(t: Tenant, name: string): Promise<{ ok: boolean; tools: number | null; ms: number | null; error: string | null }> {
  if (!/^[A-Za-z0-9_.-]{1,64}$/.test(name)) throw new HttpError(400, "nombre_invalido", "Nombre de MCP inválido.");
  try {
    const out = await hermes(t, ["mcp", "test", name], 90000);
    const ok = /Connected/i.test(out) && !/✗|failed/i.test(out);
    const tools = out.match(/Tools discovered:\s*(\d+)/i);
    const ms = out.match(/Connected \((\d+)ms\)/i);
    return { ok, tools: tools ? Number(tools[1]) : null, ms: ms ? Number(ms[1]) : null, error: ok ? null : out.trim().split("\n").pop() ?? null };
  } catch (e) {
    return { ok: false, tools: null, ms: null, error: (e as Error).message };
  }
}

// ---------- alta de tenant ----------

export async function createProfile(slug: string) {
  // Perfil nuevo copiando la config del perfil por defecto (modelo, MCPs, plugin de memoria).
  const fake: Tenant = { id: slug, name: slug, hermes_home: process.env.HERMES_HOME ?? join(process.env.HOME ?? "", ".hermes"), bank_id: slug, tools: "{}", created_at: "" };
  await hermes(fake, ["profile", "create", slug, "--clone", "--no-alias"], 120000);
}

// ---------- API key del modelo (solo escritura, en el .env del perfil) ----------

export const PROVIDER_KEYS: Record<string, string> = {
  deepseek: "DEEPSEEK_API_KEY",
  openai: "OPENAI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
  gemini: "GEMINI_API_KEY",
};

async function readEnvKeys(t: Tenant): Promise<Set<string>> {
  const p = join(t.hermes_home, ".env");
  if (!existsSync(p)) return new Set();
  const keys = new Set<string>();
  for (const line of (await readFile(p, "utf8")).split("\n")) {
    const i = line.indexOf("=");
    if (i > 0 && !line.trimStart().startsWith("#") && line.slice(i + 1).trim()) keys.add(line.slice(0, i).trim());
  }
  return keys;
}

/** Qué proveedores tienen key cargada (sin valores). */
export async function providerKeysPresent(t: Tenant): Promise<Record<string, boolean>> {
  const keys = await readEnvKeys(t);
  // La key puede estar en el .env de Hermes o en el del compose (Hermes la recibe por entorno, igual que la consola).
  return Object.fromEntries(Object.entries(PROVIDER_KEYS).map(([p, k]) => [p, keys.has(k) || !!process.env[k]]));
}

export async function setProviderKey(t: Tenant, provider: string, value: string) {
  const name = PROVIDER_KEYS[provider];
  if (!name) throw new HttpError(400, "proveedor_desconocido", "Ese proveedor no está soportado.");
  if (!/^[A-Za-z0-9._-]{16,300}$/.test(value)) throw new HttpError(400, "key_invalida", "Esa API key no tiene un formato válido.");
  const p = join(t.hermes_home, ".env");
  const lines = existsSync(p) ? (await readFile(p, "utf8")).split("\n") : [];
  const i = lines.findIndex((l) => l.startsWith(`${name}=`));
  if (i >= 0) lines[i] = `${name}=${value}`;
  else lines.splice(lines.length && lines[lines.length - 1] === "" ? lines.length - 1 : lines.length, 0, `${name}=${value}`);
  await backup(p);
  await writeFile(p, lines.join("\n").replace(/\n*$/, "\n"), { mode: 0o600 });
}
