/**
 * In-memory MCP session registry.
 *
 * A session = one SSE stream + its SSEServerTransport + its McpServer.
 * Suitable for the lifetime of a single serverless instance: GET /api/sse
 * and the subsequent POST /api/message calls must land on the SAME warm
 * instance. On Vercel this holds while the client keeps the SSE stream to a
 * warm function; a cold start or a second instance will not know the session
 * (documented limitation — see README).
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import type { SseResponseAdapter } from "./node-shims";

export interface SessionRecord {
  id: string;
  transport: SSEServerTransport;
  server: McpServer;
  adapter: SseResponseAdapter;
  keepAlive?: ReturnType<typeof setInterval>;
  createdAt: number;
  lastSeen: number;
}

const globalStore = globalThis as unknown as {
  __mcpSessions?: Map<string, SessionRecord>;
};

/** Survive Next.js dev-mode hot reloads; plain Map in production. */
export const sessions = (globalStore.__mcpSessions ??=
  new Map<string, SessionRecord>());

const SESSION_TTL_MS = intEnv("SESSION_TTL_MS", 10 * 60 * 1000);

function intEnv(name: string, fallback: number): number {
  const v = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

export function registerSession(rec: SessionRecord): void {
  sessions.set(rec.id, rec);
}

export function getSession(id: string): SessionRecord | undefined {
  const rec = sessions.get(id);
  if (rec) rec.lastSeen = Date.now();
  return rec;
}

/** Full teardown: heartbeat, transport, server, registry entry. */
export function destroySession(id: string): void {
  const rec = sessions.get(id);
  if (!rec) return;
  sessions.delete(id);
  if (rec.keepAlive) clearInterval(rec.keepAlive);
  Promise.allSettled([rec.transport.close(), rec.server.close()]).catch(
    () => undefined,
  );
}

/** Close sessions idle longer than SESSION_TTL_MS. */
export function sweepSessions(now = Date.now()): number {
  let swept = 0;
  for (const [id, rec] of sessions) {
    if (now - rec.lastSeen > SESSION_TTL_MS) {
      destroySession(id);
      swept++;
    }
  }
  return swept;
}

export function sessionCount(): number {
  return sessions.size;
}
