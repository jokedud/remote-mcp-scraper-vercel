import { authorize } from "@/lib/auth";
import { SERVER_NAME, SERVER_VERSION } from "@/lib/mcp";
import { sessionCount } from "@/lib/sessions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const denied = authorize(request);
  if (denied) return denied;

  return Response.json({
    ok: true,
    server: SERVER_NAME,
    version: SERVER_VERSION,
    activeSessions: sessionCount(),
    timestamp: new Date().toISOString(),
  });
}
