import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { captureScreenshot } from "./browser";
import { stealthFetch, FetcherError } from "./fetcher";
import { getMovieMetadata, MovieError } from "./movie";
import { checkRateLimit } from "./rate-limit";
import {
  fetchUrlSchema,
  movieMetadataSchema,
  pingSchema,
  takeScreenshotSchema,
} from "./schemas";

export const SERVER_NAME = "remote-mcp-scraper-vercel";
export const SERVER_VERSION = "1.0.0";

const startedAt = Date.now();

function text(data: unknown): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
    structuredContent: data as Record<string, unknown>,
  };
}

function fail(err: unknown): CallToolResult {
  const message =
    err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  return {
    isError: true,
    content: [{ type: "text", text: message }],
  };
}

/** Best-effort client IP from requestInfo propagated by the transport. */
function rateKey(extra: { requestInfo?: { headers?: unknown } }): string {
  const h = extra.requestInfo?.headers;
  if (h && typeof h === "object") {
    const fwd = (h as Record<string, unknown>)["x-forwarded-for"];
    const v = Array.isArray(fwd) ? fwd[0] : fwd;
    if (typeof v === "string" && v) return v.split(",")[0]!.trim();
  }
  return "anonymous";
}

function limited(extra: { requestInfo?: { headers?: unknown } }): boolean {
  return !checkRateLimit(rateKey(extra));
}

const RATE_LIMITED: CallToolResult = {
  isError: true,
  content: [{ type: "text", text: "rate_limited: too many tool calls" }],
};

export function createMcpServer(): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { instructions: "Remote scraping MCP: screenshots, stealth fetch, movie metadata, ping." },
  );

  server.registerTool(
    "ping",
    {
      description: "Liveness probe — returns server identity and uptime.",
      inputSchema: pingSchema,
      outputSchema: {
        ok: z.literal(true),
        server: z.string(),
        version: z.string(),
        uptimeMs: z.number(),
        echo: z.string().optional(),
        timestamp: z.string(),
      },
    },
    async ({ message }) =>
      text({
        ok: true as const,
        server: SERVER_NAME,
        version: SERVER_VERSION,
        uptimeMs: Date.now() - startedAt,
        echo: message,
        timestamp: new Date().toISOString(),
      }),
  );

  server.registerTool(
    "fetch_url",
    {
      description:
        "Fetch an http(s) URL with browser-like headers, optional http/socks proxy, bounded retries with exponential backoff, timeouts and a body size cap. Returns status, headers and body (text or base64).",
      inputSchema: fetchUrlSchema,
    },
    async (args, extra) => {
      if (limited(extra)) return RATE_LIMITED;
      try {
        const res = await stealthFetch(args);
        if (res.bodyText && res.bodyText.length > 200_000) {
          res.bodyText = `${res.bodyText.slice(0, 200_000)}\n…[truncated for tool output]`;
        }
        if (res.bodyBase64 && res.bodyBase64.length > 200_000) {
          res.bodyBase64 = `${res.bodyBase64.slice(0, 200_000)}…`;
        }
        return text(res);
      } catch (err) {
        if (err instanceof FetcherError) return fail(err);
        return fail(err);
      }
    },
  );

  server.registerTool(
    "take_screenshot",
    {
      description:
        "Render a page in headless Chromium and return a PNG/JPEG screenshot plus navigation metadata. Uses CDP_ENDPOINT, a local binary, or the bundled serverless Chromium.",
      inputSchema: takeScreenshotSchema,
    },
    async (args, extra) => {
      if (limited(extra)) return RATE_LIMITED;
      try {
        const { image, ...meta } = await captureScreenshot(args);
        return {
          content: [
            {
              type: "image",
              data: image.toString("base64"),
              mimeType: meta.mimeType,
            },
            { type: "text", text: JSON.stringify(meta, null, 2) },
          ],
          structuredContent: { ...meta, bytes: meta.bytes },
        } satisfies CallToolResult;
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "movie_metadata",
    {
      description:
        "Look up movie metadata from legitimate public sources: TMDB (TMDB_API_KEY), OMDb (OMDB_API_KEY), or Wikipedia (no key). Provider 'auto' tries each in order.",
      inputSchema: movieMetadataSchema,
    },
    async ({ title, year, provider }, extra) => {
      if (limited(extra)) return RATE_LIMITED;
      try {
        const data = await getMovieMetadata(title, year, provider);
        return text(data);
      } catch (err) {
        if (err instanceof MovieError) return fail(err);
        return fail(err);
      }
    },
  );

  return server;
}
