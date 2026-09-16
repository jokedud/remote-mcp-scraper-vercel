import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { armSseKeepAlive } from "@modelcontextprotocol/sdk/server/sseKeepAlive.js";
import type { NextRequest } from "next/server";
import { authorize } from "@/lib/auth";
import { createMcpServer } from "@/lib/mcp";
import {
  asServerResponse,
  SseResponseAdapter,
} from "@/lib/node-shims";
import {
  destroySession,
  registerSession,
  sweepSessions,
} from "@/lib/sessions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** How often to emit an SSE comment heartbeat (keeps proxies/alb alive). */
const HEARTBEAT_MS = 15_000;

/**
 * MCP SSE endpoint (legacy HTTP+SSE transport).
 * Opens a text/event-stream; the client receives an `endpoint` event pointing
 * at /api/message?sessionId=<id> where it POSTs JSON-RPC messages.
 */
export async function GET(request: NextRequest) {
  const denied = authorize(request);
  if (denied) return denied;

  sweepSessions();

  const encoder = new TextEncoder();
  let adapter!: SseResponseAdapter;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      adapter = new SseResponseAdapter(
        (chunk) => {
          try {
            controller.enqueue(encoder.encode(chunk));
          } catch {
            /* stream already closed */
          }
        },
        () => {
          try {
            controller.close();
          } catch {
            /* already closed */
          }
        },
      );
    },
    cancel() {
      adapter?.close();
    },
  });

  const transport = new SSEServerTransport(
    "/api/message",
    asServerResponse(adapter),
  );
  const server = createMcpServer();
  const now = Date.now();
  const sessionId = transport.sessionId;

  transport.onclose = () => destroySession(sessionId);
  transport.onerror = () => undefined;

  await server.connect(transport); // calls transport.start() → writes endpoint event

  const keepAlive = armSseKeepAlive(HEARTBEAT_MS, () => {
    adapter.write(`: heartbeat ${new Date().toISOString()}\n\n`);
  });
  keepAlive?.unref?.();

  registerSession({
    id: sessionId,
    transport,
    server,
    adapter,
    keepAlive,
    createdAt: now,
    lastSeen: now,
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
      "MCP-Session-Id": sessionId,
    },
  });
}
