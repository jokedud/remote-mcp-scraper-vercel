import type { NextRequest } from "next/server";
import { authorize } from "@/lib/auth";
import {
  makePostRequestShim,
  makePostResponseShim,
} from "@/lib/node-shims";
import { getSession, sessionCount, sweepSessions } from "@/lib/sessions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * MCP message endpoint — the client POSTs JSON-RPC frames here with the
 * sessionId issued by the `endpoint` SSE event. The response to each request
 * frame is delivered over the open SSE stream, so this returns 202.
 */
export async function POST(request: NextRequest) {
  const denied = authorize(request);
  if (denied) return denied;

  sweepSessions();

  const url = new URL(request.url);
  const sessionId = url.searchParams.get("sessionId");
  if (!sessionId) {
    return json({ error: "missing sessionId query parameter" }, 400);
  }
  const rec = getSession(sessionId);
  if (!rec) {
    // Almost always means the POST hit a different/cold serverless instance
    // than the one holding the SSE stream — see README "Known limitations".
    return json(
      {
        error: "unknown_session",
        hint: "SSE stream and POST must reach the same warm instance",
        activeSessions: sessionCount(),
      },
      404,
    );
  }

  let parsed: unknown;
  const raw = await request.text();
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = raw; // transport will validate and 400 it
  }

  const req = makePostRequestShim(request);
  const { res, done } = makePostResponseShim();

  try {
    await rec.transport.handlePostMessage(req, res, parsed);
  } catch (err) {
    return json(
      { error: err instanceof Error ? err.message : String(err) },
      500,
    );
  }

  // Every SDK path ends the shimmed response; race a safety timeout anyway.
  return Promise.race([
    done,
    sleep(5_000).then(
      () => new Response("Accepted", { status: 202 }),
    ),
  ]);
}

export async function GET() {
  return json(
    { error: "method not allowed", hint: "POST JSON-RPC frames with ?sessionId=" },
    405,
  );
}
