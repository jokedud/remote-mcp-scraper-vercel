/**
 * Fixed-window, per-key rate limiter kept in instance memory.
 * Good enough for abuse damping on a serverless function; it is NOT a
 * distributed limiter — each warm instance counts independently.
 */

interface Bucket {
  count: number;
  resetAt: number;
}

const globalStore = globalThis as unknown as {
  __rateLimitBuckets?: Map<string, Bucket>;
};
const buckets = (globalStore.__rateLimitBuckets ??= new Map<string, Bucket>());

function intEnv(name: string, fallback: number): number {
  const v = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(v) && v >= 0 ? v : fallback;
}

export function rateLimitEnabled(): boolean {
  return intEnv("RATE_LIMIT_MAX", 60) > 0;
}

/** Returns true when the call is allowed, false when over limit. */
export function checkRateLimit(key: string, now = Date.now()): boolean {
  const max = intEnv("RATE_LIMIT_MAX", 60);
  if (max <= 0) return true;
  const windowMs = intEnv("RATE_LIMIT_WINDOW_MS", 60_000);
  const b = buckets.get(key);
  if (!b || now >= b.resetAt) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return true;
  }
  if (b.count >= max) return false;
  b.count++;
  return true;
}

/** Extract a best-effort client key (IP) from a Web Request. */
export function clientKey(request: Request): string {
  const h = request.headers;
  const fwd = h.get("x-forwarded-for") || h.get("x-real-ip") || "";
  return fwd.split(",")[0]?.trim() || "anonymous";
}
