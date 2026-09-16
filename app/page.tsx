export default function Home() {
  return (
    <main style={{ fontFamily: "system-ui, sans-serif", margin: "3rem auto", maxWidth: 720, lineHeight: 1.6 }}>
      <h1>remote-mcp-scraper-vercel</h1>
      <p>Remote Model Context Protocol server on Vercel Serverless (HTTP+SSE transport).</p>
      <h2>Endpoints</h2>
      <ul>
        <li><code>GET /api/sse</code> — open an MCP SSE session</li>
        <li><code>POST /api/message?sessionId=…</code> — send JSON-RPC frames</li>
        <li><code>GET /api/health</code> — liveness/status</li>
      </ul>
      <h2>Tools</h2>
      <ul>
        <li><code>take_screenshot</code> — headless Chromium screenshots</li>
        <li><code>fetch_url</code> — stealth-oriented fetch (rotating UA, proxy support, retries)</li>
        <li><code>movie_metadata</code> — TMDB / OMDb / Wikipedia lookups</li>
        <li><code>ping</code> — liveness probe</li>
      </ul>
      <p>See the repository README for client configuration, env vars and responsible-use notes.</p>
    </main>
  );
}
