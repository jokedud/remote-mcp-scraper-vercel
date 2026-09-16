/**
 * Stealth-oriented fetch client.
 *
 * - Rotating, realistic browser User-Agent + client-hint / Sec-Fetch headers.
 * - HTTP(S) and SOCKS4/5 upstream proxies (per-call or via env).
 * - Bounded retries with exponential backoff + jitter and Retry-After support.
 * - Header/body timeouts and a hard cap on response size (serverless memory).
 *
 * Responsible use: this client makes requests look like ordinary browser
 * traffic. It does NOT and MUST NOT be used to bypass authentication,
 * authorization, paywalls, or rate-limit policy. Honour robots.txt and target
 * site terms of service; see README "Responsible use".
 */

import { Agent, ProxyAgent, request } from "undici";
import type { Dispatcher, buildConnector } from "undici";
import { SocksClient } from "socks";
import tls from "node:tls";
import net from "node:net";
import zlib from "node:zlib";
import { STATUS_CODES } from "node:http";
import type { Readable } from "node:stream";
import {
  buildBrowserHeaders,
  pickProfile,
  profileForUserAgent,
} from "./user-agents";

export interface FetchRequest {
  url: string;
  method?: "GET" | "HEAD" | "POST" | "PUT" | "DELETE" | "PATCH";
  headers?: Record<string, string>;
  body?: string;
  /** Per-request timeout in ms (applies to headers and body phases). */
  timeoutMs?: number;
  /** Retries after the first attempt. */
  maxRetries?: number;
  /** Hard cap on response body bytes. */
  maxBytes?: number;
  /** Proxy URL: http(s):// or socks4:// socks5:// socks5h:// */
  proxy?: string;
  /** Explicit UA override; otherwise a profile is rotated in. */
  userAgent?: string;
  /** Follow 3xx redirects (default true, max 10 hops). */
  followRedirects?: boolean;
  /** Rotation seed hook — tests can inject determinism. */
  random?: () => number;
}

export interface FetchResult {
  requestedUrl: string;
  finalUrl: string;
  status: number;
  statusText: string;
  headers: Record<string, string>;
  contentType: string;
  /** UTF-8 text body when content-type is textual. */
  bodyText?: string;
  /** base64 body when content-type is binary. */
  bodyBase64?: string;
  encoding: "utf-8" | "base64" | "none";
  bytesRead: number;
  truncated: boolean;
  attempts: number;
  redirects: string[];
  durationMs: number;
}

export class FetcherError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly status?: number,
    public readonly attempts: number = 0,
  ) {
    super(message);
    this.name = "FetcherError";
  }
}

const DEFAULT_TIMEOUT_MS = numEnv("FETCH_DEFAULT_TIMEOUT_MS", 20_000);
const DEFAULT_MAX_BYTES = numEnv("FETCH_MAX_BYTES", 5 * 1024 * 1024);
const MAX_REDIRECTS = 10;
const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);
const BASE_BACKOFF_MS = 500;
const MAX_BACKOFF_MS = 8_000;

function numEnv(name: string, fallback: number): number {
  const v = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

/* ── Proxy dispatchers ────────────────────────────────────────────────────── */

type ProxySpec =
  | { kind: "http"; url: URL }
  | { kind: "socks"; url: URL; type: 4 | 5 };

const dispatcherCache = new Map<string, Dispatcher>();

/** Strip credentials so they never leak into logs/errors. */
function redactUrl(raw: string): string {
  try {
    const u = new URL(raw);
    u.username = "";
    u.password = "";
    return u.toString();
  } catch {
    return "<invalid-url>";
  }
}

export function parseProxyUrl(raw: string): ProxySpec {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new FetcherError(`Invalid proxy URL: ${redactUrl(raw)}`, "E_PROXY_URL");
  }
  const scheme = url.protocol.replace(":", "").toLowerCase();
  if (scheme === "http" || scheme === "https") return { kind: "http", url };
  if (scheme === "socks5" || scheme === "socks5h")
    return { kind: "socks", url, type: 5 };
  if (scheme === "socks4" || scheme === "socks4a")
    return { kind: "socks", url, type: 4 };
  throw new FetcherError(
    `Unsupported proxy scheme "${scheme}" in ${redactUrl(raw)}`,
    "E_PROXY_SCHEME",
  );
}

function socksDispatcher(spec: Extract<ProxySpec, { kind: "socks" }>): Dispatcher {
  const { url, type } = spec;
  const proxyHost = url.hostname;
  const proxyPort = Number.parseInt(url.port || "1080", 10);
  const userId = decodeURIComponent(url.username || "") || undefined;
  const password = decodeURIComponent(url.password || "") || undefined;

  // Custom undici connector: open TCP to the SOCKS proxy, run the handshake,
  // then (for https origins) wrap the tunnelled socket in TLS ourselves.
  const connect: buildConnector.connector = (opts, cb) => {
    SocksClient.createConnection({
      proxy: {
        host: proxyHost,
        port: proxyPort,
        type,
        userId,
        password,
      },
      command: "connect",
      destination: {
        host: opts.hostname,
        port: Number(opts.port),
      },
      timeout: 15_000,
    })
      .then(({ socket }) => {
        if (opts.protocol === "https:") {
          const tlsSocket: net.Socket = tls.connect({
            socket,
            servername: opts.servername || opts.hostname,
          });
          cb(null, tlsSocket);
        } else {
          cb(null, socket);
        }
      })
      .catch((err: unknown) => {
        cb(err instanceof Error ? err : new Error(String(err)), null);
      });
  };

  return new Agent({ connect });
}

export function dispatcherForProxy(raw: string): Dispatcher {
  const cached = dispatcherCache.get(raw);
  if (cached) return cached;
  const spec = parseProxyUrl(raw);
  const dispatcher =
    spec.kind === "http"
      ? new ProxyAgent({ uri: spec.url.toString() })
      : socksDispatcher(spec);
  dispatcherCache.set(raw, dispatcher);
  return dispatcher;
}

/** Resolve the effective proxy: explicit arg > SCRAPER_PROXY_URL > HTTPS_PROXY/HTTP_PROXY. */
export function resolveProxy(explicit: string | undefined, url: URL): string | undefined {
  if (explicit) return explicit;
  if (process.env.SCRAPER_PROXY_URL) return process.env.SCRAPER_PROXY_URL;
  return url.protocol === "https:"
    ? process.env.HTTPS_PROXY || process.env.https_proxy
    : process.env.HTTP_PROXY || process.env.http_proxy;
}

/* ── Body handling ─────────────────────────────────────────────────────────── */

const TEXTUAL = /^text\/|application\/(json|ld\+json|xml|xhtml\+xml|javascript|ecmascript|x-www-form-urlencoded|rss\+xml|atom\+xml|svg\+xml)|\+json$|\+xml$/i;

async function readBodyCapped(
  body: AsyncIterable<Buffer>,
  maxBytes: number,
): Promise<{ data: Buffer; truncated: boolean }> {
  const chunks: Buffer[] = [];
  let size = 0;
  let truncated = false;
  for await (const chunk of body) {
    size += chunk.length;
    if (size > maxBytes) {
      chunks.push(chunk.subarray(0, Math.max(0, chunk.length - (size - maxBytes))));
      truncated = true;
      break;
    }
    chunks.push(chunk);
  }
  return { data: Buffer.concat(chunks), truncated };
}

function flattenHeaders(
  headers: Record<string, string | string[] | undefined>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (v === undefined) continue;
    out[k] = Array.isArray(v) ? v.join(", ") : v;
  }
  return out;
}

/* ── Backoff ───────────────────────────────────────────────────────────────── */

export function backoffMs(attempt: number, random: () => number = Math.random): number {
  const exp = Math.min(BASE_BACKOFF_MS * 2 ** attempt, MAX_BACKOFF_MS);
  return Math.floor(exp / 2 + random() * (exp / 2));
}

function retryAfterMs(headers: Record<string, string>): number | undefined {
  const raw = headers["retry-after"];
  if (!raw) return undefined;
  const secs = Number.parseInt(raw, 10);
  if (Number.isFinite(secs)) return Math.min(secs * 1000, 10_000);
  const date = Date.parse(raw);
  if (Number.isFinite(date)) {
    return Math.min(Math.max(date - Date.now(), 0), 10_000);
  }
  return undefined;
}

function isRetryableError(err: unknown): boolean {
  if (!(err instanceof Error)) return true;
  const code = (err as NodeJS.ErrnoException).code ?? "";
  // DNS/parse failures won't self-heal.
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") return false;
  if (err instanceof FetcherError && err.code === "E_PROXY_SCHEME") return false;
  return true;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/* ── Core request (single attempt, no redirect following) ─────────────────── */

interface RawResponse {
  statusCode: number;
  statusText: string;
  headers: Record<string, string>;
  body: AsyncIterable<Buffer>;
}

/** undici `request` does not auto-decompress — wrap the body per content-encoding. */
function decodeBody(
  body: Readable,
  contentEncoding: string | undefined,
): AsyncIterable<Buffer> {
  const enc = (contentEncoding ?? "").toLowerCase().trim();
  const asBufs = (s: NodeJS.ReadWriteStream) =>
    s as unknown as AsyncIterable<Buffer>;
  if (enc === "gzip" || enc === "x-gzip")
    return asBufs(body.pipe(zlib.createGunzip()));
  if (enc === "deflate") return asBufs(body.pipe(zlib.createInflate()));
  if (enc === "br") return asBufs(body.pipe(zlib.createBrotliDecompress()));
  // zstd is decoded only when the runtime supports it; it is not advertised
  // in accept-encoding, but some origins send it anyway.
  const zstd = (zlib as unknown as Record<string, unknown>).createZstdDecompress;
  if (enc === "zstd" && typeof zstd === "function") {
    return asBufs(
      body.pipe((zstd as () => NodeJS.ReadWriteStream).call(zlib)),
    );
  }
  return body as unknown as AsyncIterable<Buffer>;
}

async function rawRequest(
  target: URL,
  opts: FetchRequest,
  headers: Record<string, string>,
  timeoutMs: number,
  dispatcher?: Dispatcher,
): Promise<RawResponse> {
  const res = await request(target, {
    method: opts.method ?? "GET",
    headers,
    body: opts.body,
    headersTimeout: timeoutMs,
    bodyTimeout: timeoutMs,
    dispatcher,
  });
  const resHeaders = flattenHeaders(res.headers);
  return {
    statusCode: res.statusCode,
    statusText: STATUS_CODES[res.statusCode] ?? String(res.statusCode),
    headers: resHeaders,
    body: decodeBody(
      res.body as unknown as Readable,
      resHeaders["content-encoding"],
    ),
  };
}

/** Abortable drain so retryable responses don't leak sockets. */
async function drainBody(body: AsyncIterable<Buffer>): Promise<void> {
  try {
    for await (const _ of body) {
      void _;
    }
  } catch {
    /* ignore */
  }
}

/* ── Public API ────────────────────────────────────────────────────────────── */

export async function stealthFetch(req: FetchRequest): Promise<FetchResult> {
  const started = Date.now();
  let target: URL;
  try {
    target = new URL(req.url);
  } catch {
    throw new FetcherError(`Invalid URL: ${redactUrl(req.url)}`, "E_URL");
  }
  if (!/^https?:$/.test(target.protocol)) {
    throw new FetcherError(
      `Unsupported protocol "${target.protocol}" — http(s) only`,
      "E_URL_SCHEME",
    );
  }

  const timeoutMs = req.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = req.maxBytes ?? DEFAULT_MAX_BYTES;
  const maxRetries = req.maxRetries ?? 2;
  const followRedirects = req.followRedirects !== false;
  const random = req.random ?? Math.random;

  const profile = req.userAgent
    ? profileForUserAgent(req.userAgent)
    : pickProfile(random);
  const headers = buildBrowserHeaders(profile, req.headers);

  const proxyUrl = resolveProxy(req.proxy, target);
  const dispatcher = proxyUrl ? dispatcherForProxy(proxyUrl) : undefined;

  const redirects: string[] = [];
  let attempts = 0;
  let lastError: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    attempts = attempt + 1;
    try {
      let current = target;
      let method = req.method ?? "GET";
      let body = req.body;
      let hops = 0;

      // Redirect loop counts as a single attempt.
      for (;;) {
        const res = await rawRequest(current, { ...req, method, body }, headers, timeoutMs, dispatcher);

        const isRedirect =
          res.statusCode >= 300 &&
          res.statusCode < 400 &&
          Boolean(res.headers.location);

        if (!isRedirect || !followRedirects || hops >= MAX_REDIRECTS) {
          if (isRedirect && !followRedirects) {
            await drainBody(res.body);
            return {
              requestedUrl: req.url,
              finalUrl: current.toString(),
              status: res.statusCode,
              statusText: res.statusText,
              headers: res.headers,
              contentType: res.headers["content-type"] ?? "",
              encoding: "none",
              bytesRead: 0,
              truncated: false,
              attempts,
              redirects,
              durationMs: Date.now() - started,
            };
          }

          if (RETRYABLE_STATUS.has(res.statusCode)) {
            const retryAfter = retryAfterMs(res.headers);
            await drainBody(res.body);
            if (attempt < maxRetries) {
              await sleep(retryAfter ?? backoffMs(attempt, random));
              break; // retry outer loop
            }
            throw new FetcherError(
              `Upstream returned ${res.statusCode} after ${attempts} attempt(s)`,
              "E_UPSTREAM_STATUS",
              res.statusCode,
              attempts,
            );
          }

          const contentType = res.headers["content-type"] ?? "";
          const { data, truncated } = await readBodyCapped(res.body, maxBytes);
          const textual = TEXTUAL.test(contentType);
          return {
            requestedUrl: req.url,
            finalUrl: current.toString(),
            status: res.statusCode,
            statusText: res.statusText,
            headers: res.headers,
            contentType,
            bodyText: textual ? data.toString("utf-8") : undefined,
            bodyBase64:
              !textual && data.length > 0 ? data.toString("base64") : undefined,
            encoding:
              data.length === 0 ? "none" : textual ? "utf-8" : "base64",
            bytesRead: data.length,
            truncated,
            attempts,
            redirects,
            durationMs: Date.now() - started,
          };
        }

        // Redirect hop.
        await drainBody(res.body);
        const next = new URL(res.headers.location!, current);
        if (!/^https?:$/.test(next.protocol)) {
          throw new FetcherError(
            `Refusing to follow redirect to ${redactUrl(next.toString())}`,
            "E_REDIRECT_SCHEME",
          );
        }
        redirects.push(next.toString());
        hops++;
        if (res.statusCode === 303 || (res.statusCode < 307 && method !== "GET" && method !== "HEAD")) {
          method = "GET";
          body = undefined;
        }
        current = next;
      }
    } catch (err) {
      if (err instanceof FetcherError) throw err;
      lastError = err;
      if (attempt >= maxRetries || !isRetryableError(err)) break;
      await sleep(backoffMs(attempt, random));
    }
  }

  const msg =
    lastError instanceof Error ? lastError.message : String(lastError);
  throw new FetcherError(
    `Request to ${redactUrl(target.toString())} failed after ${attempts} attempt(s): ${msg}`,
    "E_REQUEST",
    undefined,
    attempts,
  );
}
