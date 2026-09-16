/**
 * Optional bearer-token gate for the MCP endpoints.
 * When MCP_AUTH_TOKEN is unset the endpoints are intentionally open
 * (documented in README); set it for anything public-facing.
 */

export function authorize(request: Request): Response | null {
  const token = process.env.MCP_AUTH_TOKEN;
  if (!token) return null; // open mode

  const url = new URL(request.url);
  const header = request.headers.get("authorization") ?? "";
  const bearer = header.toLowerCase().startsWith("bearer ")
    ? header.slice(7).trim()
    : "";
  const fromQuery = url.searchParams.get("token") ?? "";

  if (bearer === token || fromQuery === token) return null;

  return new Response(JSON.stringify({ error: "unauthorized" }), {
    status: 401,
    headers: { "Content-Type": "application/json" },
  });
}
