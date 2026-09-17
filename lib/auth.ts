/**
 * Bearer-token gate for the MCP endpoints.
 * Requests fail closed when MCP_AUTH_TOKEN is not configured or when the
 * supplied credential is missing or invalid.
 */

export function authorize(request: Request): Response | null {
  const token = process.env.MCP_AUTH_TOKEN;
  const header = request.headers.get("authorization") ?? "";
  const bearer = /^Bearer\s+(.+)$/i.exec(header)?.[1]?.trim() ?? "";

  const url = new URL(request.url);
  const queryToken = url.searchParams.get("token") ?? url.searchParams.get("auth") ?? "";
  const credential = bearer || queryToken;

  if (token && credential === token) return null;

  return new Response(JSON.stringify({ error: "unauthorized" }), {
    status: 401,
    headers: { "Content-Type": "application/json" },
  });
}
