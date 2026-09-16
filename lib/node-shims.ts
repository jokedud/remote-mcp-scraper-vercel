/**
 * Node ↔ Web API shims.
 *
 * The MCP SDK's SSEServerTransport was written for Express-style
 * (IncomingMessage/ServerResponse) objects. These adapters present the same
 * surface on top of Web Streams so the transport works inside Next.js
 * App Router route handlers unchanged.
 */

import type { IncomingMessage, ServerResponse } from "node:http";

/* ── SSE response adapter (ReadableStream ⇐ ServerResponse) ─────────────── */

export class SseResponseAdapter {
  statusCode = 200;
  headersSent = false;

  private readonly headers = new Map<string, string>();
  private readonly closeHandlers: Array<() => void> = [];
  private closed = false;

  constructor(
    private readonly enqueueChunk: (chunk: string) => void,
    private readonly finish: () => void,
  ) {}

  writeHead(status: number, headers?: Record<string, string>): this {
    this.statusCode = status;
    this.headersSent = true;
    for (const [k, v] of Object.entries(headers ?? {})) this.headers.set(k, v);
    return this;
  }

  setHeader(name: string, value: string): this {
    this.headers.set(name, value);
    return this;
  }

  getHeader(name: string): string | undefined {
    return this.headers.get(name);
  }

  write(chunk: string | Uint8Array): boolean {
    if (this.closed) return false;
    this.enqueueChunk(
      typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"),
    );
    return true;
  }

  end(chunk?: string | Uint8Array): this {
    if (chunk !== undefined) this.write(chunk);
    this.close();
    return this;
  }

  on(event: string, cb: () => void): this {
    if (event === "close") this.closeHandlers.push(cb);
    return this;
  }

  once(event: string, cb: () => void): this {
    return this.on(event, cb);
  }

  removeListener(event: string, cb: () => void): this {
    if (event === "close") {
      const i = this.closeHandlers.indexOf(cb);
      if (i >= 0) this.closeHandlers.splice(i, 1);
    }
    return this;
  }

  /** Idempotent teardown — fires 'close' exactly once. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.finish();
    } finally {
      const handlers = this.closeHandlers.splice(0);
      for (const h of handlers) h();
    }
  }

  get isClosed(): boolean {
    return this.closed;
  }
}

export function asServerResponse(adapter: SseResponseAdapter): ServerResponse {
  return adapter as unknown as ServerResponse;
}

/* ── POST /api/message shims (Request ⇒ IncomingMessage/ServerResponse) ──── */

export function makePostRequestShim(request: Request): IncomingMessage {
  const url = new URL(request.url);
  const headers: Record<string, string> = {};
  request.headers.forEach((v, k) => {
    headers[k] = v;
  });
  if (!headers["content-type"]) headers["content-type"] = "application/json";
  return {
    headers,
    url: url.pathname + url.search,
    method: "POST",
    httpVersion: "1.1",
    socket: {},
  } as unknown as IncomingMessage;
}

export function makePostResponseShim(): {
  res: ServerResponse;
  done: Promise<Response>;
} {
  let resolveDone!: (r: Response) => void;
  const done = new Promise<Response>((r) => (resolveDone = r));
  const captured = { status: 200, body: "" };

  const res = {
    writeHead(status: number) {
      captured.status = status;
      return this;
    },
    write(chunk: unknown) {
      if (chunk !== undefined) captured.body += String(chunk);
      return true;
    },
    end(body?: unknown) {
      if (body !== undefined) captured.body += String(body);
      resolveDone(
        new Response(captured.body || "Accepted", { status: captured.status }),
      );
      return this;
    },
    on() {
      return this;
    },
    once() {
      return this;
    },
    removeListener() {
      return this;
    },
  } as unknown as ServerResponse;

  return { res, done };
}
