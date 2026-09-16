# remote-mcp-scraper-vercel

A production-ready **Remote Model Context Protocol (MCP)** server for **Vercel Serverless on Node.js**, built with **Next.js App Router** and TypeScript.

It exposes scraping-oriented MCP tools over the legacy **HTTP + SSE** transport:

| Endpoint | Purpose |
|---|---|
| `GET /api/sse` | Open an MCP session (`text/event-stream`, 15 s heartbeats) |
| `POST /api/message?sessionId=…` | Send JSON-RPC frames; responses stream back over SSE |
| `GET /api/health` | Liveness/status probe |

## Tools

| Tool | Description |
|---|---|
| `ping` | Liveness probe — server name, version, uptime. |
| `fetch_url` | Fetch an http(s) URL with browser-like headers: rotating real User-Agent profiles, `sec-ch-*` client hints and `Sec-Fetch-*` spoofing, gzip/deflate/br decoding, bounded retries with exponential backoff + `Retry-After` honouring, header/body timeouts, redirect following, and a hard body-size cap. |
| `take_screenshot` | Render a page in headless Chromium and return a PNG/JPEG image plus navigation metadata (final URL, status, bytes, duration). |
| `movie_metadata` | Movie lookup from **legitimate public sources only**: TMDB (`TMDB_API_KEY`), OMDb (`OMDB_API_KEY`), or Wikipedia (no key required). No fabricated results — a miss returns a structured error. |

All tool inputs are validated with strict [zod](https://zod.dev) schemas; outputs include `structuredContent`.

## Stack

- **Next.js 16 (App Router, Node.js runtime)** — route handlers on Vercel Functions
- **@modelcontextprotocol/sdk** — `McpServer` + `SSEServerTransport`, `armSseKeepAlive` heartbeats
- **puppeteer-core + @sparticuz/chromium** — brotli-packed chrome-headless-shell sized for the ~50 MB serverless bundle budget
- **undici** — `request` API (full header control incl. `Sec-*`, unlike `fetch`) + `ProxyAgent`
- **socks** — SOCKS4/5 CONNECT support via a custom undici connector (TLS-in-tunnel for HTTPS origins)
- **zod** — input/output validation
- **vitest + eslint + tsc** — validation (`npm run validate`)

## Project layout

```
app/
  page.tsx                  minimal status page
  layout.tsx
  api/
    sse/route.ts            GET — opens MCP session over SSE
    message/route.ts        POST — JSON-RPC ingress for a session
    health/route.ts         liveness
lib/
  mcp.ts                    McpServer factory + tool registration
  sessions.ts               in-memory session registry + TTL sweep
  node-shims.ts             ServerResponse/IncomingMessage adapters over Web Streams
  fetcher.ts                stealth fetch client (UA rotation, proxies, retries, caps)
  user-agents.ts            rotating browser-identity profiles
  browser.ts                dynamic launcher: CDP → local binary → bundled chromium
  movie.ts                  TMDB / OMDb / Wikipedia metadata providers
  schemas.ts                zod input schemas
  auth.ts                   optional MCP_AUTH_TOKEN bearer gate
  rate-limit.ts             per-IP fixed-window limiter
tests/                      vitest unit tests
vercel.json                 function memory (1024 MB) + maxDuration + headers
```

## Local development

```bash
npm install
cp .env.example .env   # fill in what you need (all optional for a first run)
npm run dev            # http://localhost:3000
```

Validate everything:

```bash
npm run validate       # eslint + tsc --noEmit + vitest + next build
```

### Smoke-testing the MCP transport

```bash
# terminal 1 — open the SSE stream, note the sessionId in the `endpoint` event
curl -N http://localhost:3000/api/sse

# terminal 2 — drive the session
SID=<sessionId from the endpoint event>
curl -X POST "http://localhost:3000/api/message?sessionId=$SID" \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"curl","version":"0.0"}}}'
curl -X POST "http://localhost:3000/api/message?sessionId=$SID" \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","method":"notifications/initialized"}'
curl -X POST "http://localhost:3000/api/message?sessionId=$SID" \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"ping","arguments":{"message":"hi"}}}'
```

Responses arrive as `event: message` frames on the SSE stream.

### MCP client configuration

Any client that supports the SSE transport can connect to `https://<your-deployment>/api/sse`. For `mcp-remote`-style bridges or Claude Desktop:

```json
{
  "mcpServers": {
    "scraper": {
      "url": "https://<your-deployment>.vercel.app/api/sse",
      "headers": { "Authorization": "Bearer <MCP_AUTH_TOKEN>" }
    }
  }
}
```

## Deployment (Vercel)

```bash
npm i -g vercel
vercel          # preview
vercel --prod   # production
```

`vercel.json` already configures **1024 MB function memory** and a 60 s `maxDuration` for both API routes — required for the bundled Chromium binary. Set environment variables in the Vercel dashboard (or `vercel env add`).

## Environment variables

| Variable | Purpose |
|---|---|
| `MCP_AUTH_TOKEN` | Optional bearer token required on `/api/sse` + `/api/message`. **Set this for any public deployment** — unset means open access. |
| `CDP_ENDPOINT` | Remote Chrome DevTools endpoint (`ws(s)://` → `browserWSEndpoint`, `http(s)://` → `browserURL`). Highest-priority browser path — e.g. Browserless, Steel, self-hosted `chrome --remote-debugging-port=9222`. |
| `PUPPETEER_EXECUTABLE_PATH` | Local Chrome/Chromium binary for development (ignored on Vercel). |
| `SCRAPER_PROXY_URL` | Default upstream proxy for `fetch_url` / `take_screenshot` when the caller passes no `proxy`. |
| `HTTP_PROXY` / `HTTPS_PROXY` | Standard fallback proxy env vars for `fetch_url`. |
| `TMDB_API_KEY` | TMDB v3 key — primary `movie_metadata` provider. |
| `OMDB_API_KEY` | OMDb key — secondary `movie_metadata` provider. |
| `RATE_LIMIT_MAX` | Per-IP tool-call limit per window (0 disables; default 60). |
| `RATE_LIMIT_WINDOW_MS` | Rate-limit window (default 60000). |
| `FETCH_MAX_BYTES` | Response body cap in bytes (default 5 MiB). |
| `FETCH_DEFAULT_TIMEOUT_MS` | Per-request timeout (default 20000). |
| `SESSION_TTL_MS` | Idle-session eviction (default 600000). |

## Proxy configuration

`fetch_url` and `take_screenshot` accept a `proxy` argument and honour the env vars above. Supported schemes:

- `http://` / `https://` — via undici `ProxyAgent` (CONNECT tunnelling, optional auth in the URL).
- `socks5://`, `socks5h://`, `socks4://`, `socks4a://` — via `socks` + a custom undici connector; HTTPS origins get TLS inside the tunnel. Credentials may be embedded (`socks5://user:pass@host:1080`).
- For `take_screenshot`, the proxy is passed to Chromium as `--proxy-server` and embedded credentials are applied with `page.authenticate()`.

Proxy credentials are redacted from all error messages.

## Security & privacy

- **Auth:** optional `MCP_AUTH_TOKEN` bearer (header or `?token=`); no auth is otherwise enforced — treat an unauthenticated deployment as public tooling.
- **Rate limiting:** fixed-window per-IP limiter on tool calls (instance-local, best-effort).
- **Allowlisting:** none — the tools fetch arbitrary http(s) URLs. If you expose this publicly, set `MCP_AUTH_TOKEN` and consider fronting it with your own allowlist; see limitations for SSRF context.
- **No credential leakage:** proxy userinfo is stripped from URLs used in errors, logs, and browser flags.
- **Data handling:** no persistence — request bodies/screenshots live only for the duration of a call; sessions live in instance memory.

## Responsible use

`fetch_url` makes requests look like ordinary browser traffic to avoid *incidental* breakage — it is **not** a bypass for authentication, authorization, paywalls, CAPTCHAs, or site rate-limit policy, and must not be used as one. Honour `robots.txt`, the target site's terms of service, and applicable law. The MCP_AUTH_TOKEN gate and rate limiter are abuse dampers, not access control for the sites you scrape.

## Known limitations

- **Session affinity:** the in-memory session map lives inside one function instance. `POST /api/message` must reach the **same warm instance** as `GET /api/sse`; a cold start or scale-out returns `404 unknown_session`. For multi-instance deployments, switch to the MCP **Streamable HTTP** transport (`StreamableHTTPServerTransport`) with an external session store (e.g. Redis), or keep traffic single-instance.
- **Function lifetime:** SSE connections die at `maxDuration` (60 s default); MCP clients should reconnect and re-`initialize`.
- **Cold starts:** the first `take_screenshot` on a cold instance extracts ~50 MB of brotli-packed Chromium — expect a few seconds; warm calls are sub-second.
- **Binary ceiling:** `@sparticuz/chromium` ships **chrome-headless-shell** — no GPU rendering, no PDF printing; `setGraphicsMode` is disabled.
- **Rate limiter** is per-instance and memory-resident (not distributed).
- **Node ≥ 20.9** required (Vercel `nodejs20.x`+ runtime).
