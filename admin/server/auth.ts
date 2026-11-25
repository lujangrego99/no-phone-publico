// Contraseñas con scrypt, sesiones opacas en cookie httpOnly. El token nunca se guarda en claro.
import { randomBytes, scryptSync, timingSafeEqual, createHash } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import { db, getTenant, type Tenant, type User } from "./db.ts";

export const SESSION_COOKIE = "np_session";
const SESSION_DAYS = 14;

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const key = scryptSync(password, salt, 64, { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  return `scrypt$${salt.toString("base64")}$${key.toString("base64")}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [scheme, saltB64, keyB64] = stored.split("$");
  if (scheme !== "scrypt" || !saltB64 || !keyB64) return false;
  const expected = Buffer.from(keyB64, "base64");
  const key = scryptSync(password, Buffer.from(saltB64, "base64"), expected.length, {
    N: 2 ** 15,
    r: 8,
    p: 1,
    maxmem: 64 * 1024 * 1024,
  });
  return timingSafeEqual(key, expected);
}

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

export function createSession(userId: number): { token: string; maxAge: number } {
  const token = randomBytes(32).toString("base64url");
  const maxAge = SESSION_DAYS * 24 * 3600;
  db.prepare("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, datetime('now', ?))").run(
    sha(token),
    userId,
    `+${SESSION_DAYS} days`,
  );
  db.prepare("DELETE FROM sessions WHERE expires_at < datetime('now')").run();
  return { token, maxAge };
}

export function destroySession(token: string | undefined) {
  if (token) db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(sha(token));
}

export function userFromToken(token: string | undefined): User | null {
  if (!token) return null;
  const row = db
    .prepare(
      `SELECT u.id, u.email, u.name, u.role, u.tenant_id FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = ? AND s.expires_at > datetime('now')`,
    )
    .get(sha(token)) as User | undefined;
  return row ?? null;
}

export function userCount(): number {
  return (db.prepare("SELECT COUNT(*) AS n FROM users").get() as { n: number }).n;
}

declare module "fastify" {
  interface FastifyRequest {
    user: User | null;
  }
}

export class HttpError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

export function requireUser(req: FastifyRequest): User {
  if (!req.user) throw new HttpError(401, "sin_sesion", "Iniciá sesión.");
  return req.user;
}

export function requireSuperadmin(req: FastifyRequest): User {
  const u = requireUser(req);
  if (u.role !== "superadmin") throw new HttpError(403, "prohibido", "Solo el administrador general puede hacer esto.");
  return u;
}

/** El dueño solo ve su tenant; el superadmin ve todos. */
export function tenantFor(req: FastifyRequest, tenantId: string): Tenant {
  const u = requireUser(req);
  if (u.role !== "superadmin" && u.tenant_id !== tenantId) {
    throw new HttpError(403, "prohibido", "No tenés acceso a este secretario.");
  }
  const t = getTenant(tenantId);
  if (!t) throw new HttpError(404, "no_existe", "Ese secretario no existe.");
  return t;
}

export function setSessionCookie(reply: FastifyReply, token: string, maxAge: number) {
  reply.setCookie(SESSION_COOKIE, token, {
    path: "/",
    httpOnly: true,
    sameSite: "strict",
    secure: process.env.ADMIN_SECURE_COOKIE === "1",
    maxAge,
  });
}
