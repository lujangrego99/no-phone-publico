// Usuarios, tenants, sesiones y bitácora de la consola. SQLite nativo de Node (sin módulos nativos).
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const DATA_DIR = process.env.ADMIN_DATA_DIR ?? join(homedir(), ".local/share/no-phone/admin");
mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
const DB_PATH = join(DATA_DIR, "admin.db");

export const db = new DatabaseSync(DB_PATH);
try {
  chmodSync(DB_PATH, 0o600);
} catch {
  /* el archivo lo crea la primera escritura */
}

db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS tenants (
  id          TEXT PRIMARY KEY,              -- slug: goyo, ana…
  name        TEXT NOT NULL,                 -- cómo se llama el dueño
  hermes_home TEXT NOT NULL,                 -- HERMES_HOME del perfil
  bank_id     TEXT NOT NULL,                 -- banco de Hindsight
  tools       TEXT NOT NULL DEFAULT '{}',    -- {"wa_bridge_url": "…"} (sin secretos)
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS users (
  id         INTEGER PRIMARY KEY,
  email      TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name       TEXT NOT NULL,
  pass_hash  TEXT NOT NULL,
  role       TEXT NOT NULL CHECK (role IN ('superadmin', 'owner')),
  tenant_id  TEXT REFERENCES tenants(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (role = 'superadmin' OR tenant_id IS NOT NULL)
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL
);

-- Celulares de cada tenant. Cada modelo se maneja distinto: el perfil guarda lo que cambia
-- (modelo, Android, resolución, modo de UI). Los secretos (PIN de Naranja X…) NO van acá:
-- van a un archivo 600 por dispositivo y la consola solo sabe si están cargados.
-- Qué cambió desde la consola (alimenta la señal del pulso). Nunca guarda valores secretos.
CREATE TABLE IF NOT EXISTS events (
  id         INTEGER PRIMARY KEY,
  tenant_id  TEXT REFERENCES tenants(id) ON DELETE CASCADE,
  user_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  kind       TEXT NOT NULL,
  text       TEXT NOT NULL,
  at         TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS events_tenant_at ON events (tenant_id, at DESC);

-- Charla en curso del chat (como WhatsApp: sigue hasta que tocás «nueva charla»). El contenido vive en Hermes;
-- acá solo el nombre de la conversación de su API.
CREATE TABLE IF NOT EXISTS charlas (
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tenant_id  TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, tenant_id)
);
-- Todas las charlas de cada usuario (para retomarlas): título = su primer mensaje.
CREATE TABLE IF NOT EXISTS charlas_lista (
  session_id TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tenant_id  TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  titulo     TEXT,
  creada     TEXT NOT NULL DEFAULT (datetime('now')),
  ultima     TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS charlas_lista_user ON charlas_lista (user_id, tenant_id, ultima DESC);
-- Avisos del vigía que cada usuario ya vio (bandeja y aviso fijo en la charla).
CREATE TABLE IF NOT EXISTS avisos_vistos (
  user_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  aviso_id TEXT NOT NULL,
  at       TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, aviso_id)
);
-- En qué charla se pidió cada vigilancia (lo anota la consola al ver pasar wa_vigilar): ahí queda fijo su aviso.
CREATE TABLE IF NOT EXISTS vigilancia_charla (
  vigilancia_id TEXT PRIMARY KEY,
  session_id    TEXT NOT NULL,
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE
);
`);

export type Role = "superadmin" | "owner";
export interface Tenant {
  id: string;
  name: string;
  hermes_home: string;
  bank_id: string;
  tools: string;
  created_at: string;
}

export interface TenantTools {
  wa_bridge_url?: string;
  /** Solo si el puente corre con WA_BRIDGE_TOKEN (p. ej. fuera de loopback). Nunca vuelve al front. */
  wa_bridge_token?: string;
  /** Registro de celulares (phones.json de phones.py). Sin valor = el por defecto de la máquina. */
  phones_file?: string;
  /** Carpeta de secretos por celular (<id>.env). Sin valor = el por defecto. */
  phone_secrets_dir?: string;
}

export function tenantTools(t: Tenant): TenantTools {
  try {
    return JSON.parse(t.tools || "{}");
  } catch {
    return {};
  }
}
export interface User {
  id: number;
  email: string;
  name: string;
  role: Role;
  tenant_id: string | null;
}

export function logEvent(tenantId: string | null, userId: number | null, kind: string, text: string) {
  db.prepare("INSERT INTO events (tenant_id, user_id, kind, text) VALUES (?, ?, ?, ?)").run(tenantId, userId, kind, text);
}

export function getTenant(id: string): Tenant | undefined {
  return db.prepare("SELECT * FROM tenants WHERE id = ?").get(id) as Tenant | undefined;
}

export function listTenants(): Tenant[] {
  return db.prepare("SELECT * FROM tenants ORDER BY created_at").all() as unknown as Tenant[];
}
