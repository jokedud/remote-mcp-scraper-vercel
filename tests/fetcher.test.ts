import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  backoffMs,
  dispatcherForProxy,
  FetcherError,
  parseProxyUrl,
} from "@/lib/fetcher";
import {
  buildBrowserHeaders,
  pickProfile,
  profileForUserAgent,
  UA_PROFILES,
} from "@/lib/user-agents";
import {
  fetchUrlSchema,
  movieMetadataSchema,
  takeScreenshotSchema,
} from "@/lib/schemas";
import { checkRateLimit } from "@/lib/rate-limit";
import { SseResponseAdapter } from "@/lib/node-shims";

describe("parseProxyUrl", () => {
  it("accepts http/https proxies", () => {
    expect(parseProxyUrl("http://proxy.local:8080").kind).toBe("http");
    expect(parseProxyUrl("https://proxy.local:8443").kind).toBe("http");
  });

  it("accepts socks4/5 proxies", () => {
    const s5 = parseProxyUrl("socks5://127.0.0.1:1080");
    const s5h = parseProxyUrl("socks5h://127.0.0.1:1080");
    const s4 = parseProxyUrl("socks4://127.0.0.1:1080");
    expect(s5.kind).toBe("socks");
    if (s5.kind === "socks") expect(s5.type).toBe(5);
    if (s5h.kind === "socks") expect(s5h.type).toBe(5);
    if (s4.kind === "socks") expect(s4.type).toBe(4);
  });

  it("rejects bad schemes and malformed URLs", () => {
    expect(() => parseProxyUrl("ftp://x")).toThrow(FetcherError);
    expect(() => parseProxyUrl("not a url")).toThrow(FetcherError);
  });

  it("never leaks credentials in error messages", () => {
    try {
      parseProxyUrl("gopher://user:hunter2@host:1");
      expect.unreachable();
    } catch (err) {
      expect((err as Error).message).not.toContain("hunter2");
    }
  });

  it("builds a dispatcher for each supported scheme", () => {
    expect(dispatcherForProxy("http://127.0.0.1:8080")).toBeTruthy();
    expect(dispatcherForProxy("socks5://127.0.0.1:1080")).toBeTruthy();
  });
});

describe("backoffMs", () => {
  it("grows exponentially and stays bounded", () => {
    const rnd = () => 0.5;
    expect(backoffMs(0, rnd)).toBe(375);
    expect(backoffMs(3, rnd)).toBe(3000);
    expect(backoffMs(10, rnd)).toBe(6000); // capped
  });
});

describe("user-agents", () => {
  it("rotates through real-looking profiles", () => {
    const p = pickProfile(() => 0);
    expect(p).toBe(UA_PROFILES[0]);
    for (const profile of UA_PROFILES) {
      expect(profile.userAgent).toContain("Mozilla/5.0");
    }
  });

  it("derives chromium client hints for custom UAs", () => {
    const p = profileForUserAgent(
      "Mozilla/5.0 (Windows NT 10.0) Chrome/128.0.0.0 Safari/537.36",
    );
    expect(p.secChUa).toContain('v="128"');
    expect(p.platform).toBe("Windows");
  });

  it("emits a complete browser-like header set", () => {
    const h = buildBrowserHeaders(UA_PROFILES[0]!);
    expect(h["user-agent"]).toBeTruthy();
    expect(h["sec-ch-ua"]).toContain("Chromium");
    expect(h["sec-fetch-mode"]).toBe("navigate");
    expect(h["accept-language"]).toBeTruthy();
  });
});

describe("zod tool schemas", () => {
  it("validates take_screenshot input", () => {
    const s = z.object(takeScreenshotSchema);
    expect(() => s.parse({ url: "https://example.com" })).not.toThrow();
    expect(() => s.parse({ url: "ftp://x" })).toThrow();
    expect(() => s.parse({ url: "https://x", width: 10 })).toThrow();
  });

  it("validates fetch_url input", () => {
    const s = z.object(fetchUrlSchema);
    const parsed = s.parse({ url: "https://example.com" });
    expect(parsed.method).toBe("GET");
    expect(() => s.parse({ url: "javascript:alert(1)" })).toThrow();
    expect(() =>
      s.parse({ url: "https://x", proxy: "ftp://bad" }),
    ).toThrow();
  });

  it("validates movie_metadata input", () => {
    const s = z.object(movieMetadataSchema);
    expect(s.parse({ title: "Dune" }).provider).toBe("auto");
    expect(() => s.parse({ title: "" })).toThrow();
  });
});

describe("rate limiter", () => {
  it("blocks after the window max", () => {
    process.env.RATE_LIMIT_MAX = "2";
    const key = `t-${Math.random()}`;
    expect(checkRateLimit(key)).toBe(true);
    expect(checkRateLimit(key)).toBe(true);
    expect(checkRateLimit(key)).toBe(false);
    delete process.env.RATE_LIMIT_MAX;
  });
});

describe("SseResponseAdapter", () => {
  it("buffers writes and fires close exactly once", () => {
    const chunks: string[] = [];
    let closed = 0;
    const a = new SseResponseAdapter(
      (c) => chunks.push(c),
      () => closed++,
    );
    a.writeHead(200, { "Content-Type": "text/event-stream" });
    a.write("event: endpoint\n\n");
    let closes = 0;
    a.on("close", () => closes++);
    a.end();
    a.end();
    expect(chunks).toEqual(["event: endpoint\n\n"]);
    expect(closed).toBe(1);
    expect(closes).toBe(1);
    expect(a.write("late")).toBe(false);
  });
});
