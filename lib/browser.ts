/**
 * Dynamic headless-browser launcher for serverless.
 *
 * Resolution order:
 *   1. CDP_ENDPOINT set          → puppeteer.connect() to remote Chrome
 *      (Browserless, Steel, self-hosted --remote-debugging-port, ...).
 *      `ws(s)://` uses browserWSEndpoint, `http(s)://` uses browserURL.
 *   2. PUPPETEER_EXECUTABLE_PATH → puppeteer.launch() against a local binary
 *      (local development).
 *   3. Otherwise                 → puppeteer-core + @sparticuz/chromium, the
 *      compressed Chromium build sized for Vercel/AWS Lambda functions
 *      (~50 MB bundled binary, brotli-extracted at cold start).
 *
 * Proxy support: `--proxy-server` launch arg for CDP/launch paths plus
 * page.authenticate() when the proxy URL carries credentials.
 */

import chromium from "@sparticuz/chromium";
import puppeteer, { type Browser, type Page } from "puppeteer-core";

export class BrowserError extends Error {
  constructor(
    message: string,
    public readonly code: string,
  ) {
    super(message);
    this.name = "BrowserError";
  }
}

export interface LaunchOptions {
  /** Proxy URL passed to Chromium as --proxy-server (credentials stripped). */
  proxy?: string;
}

export interface ScreenshotOptions extends LaunchOptions {
  url: string;
  width?: number;
  height?: number;
  fullPage?: boolean;
  waitUntil?: "load" | "domcontentloaded" | "networkidle0" | "networkidle2";
  /** Extra settle time after navigation, ms. */
  delayMs?: number;
  format?: "png" | "jpeg";
  /** JPEG quality 1-100. */
  quality?: number;
  /** Navigation timeout, ms. */
  timeoutMs?: number;
  userAgent?: string;
}

export interface ScreenshotResult {
  image: Buffer;
  mimeType: "image/png" | "image/jpeg";
  finalUrl: string;
  status: number | null;
  width: number;
  height: number;
  bytes: number;
  durationMs: number;
}

const isServerless = Boolean(
  process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME,
);

/** Proxy URL without credentials, suitable for --proxy-server. */
function proxyServerArg(raw: string): string {
  const u = new URL(raw);
  u.username = "";
  u.password = "";
  return u.toString().replace(/\/$/, "");
}

function proxyCredentials(raw: string):
  | { username: string; password: string }
  | undefined {
  const u = new URL(raw);
  if (!u.username) return undefined;
  return {
    username: decodeURIComponent(u.username),
    password: decodeURIComponent(u.password),
  };
}

export async function launchBrowser(opts: LaunchOptions = {}): Promise<Browser> {
  const proxyArg = opts.proxy ? proxyServerArg(opts.proxy) : undefined;

  const cdp = process.env.CDP_ENDPOINT;
  if (cdp) {
    try {
      const connectOpts = /^wss?:\/\//.test(cdp)
        ? { browserWSEndpoint: cdp }
        : { browserURL: cdp };
      return await puppeteer.connect({
        ...connectOpts,
        acceptInsecureCerts: false,
      });
    } catch (err) {
      throw new BrowserError(
        `Failed to connect to CDP endpoint: ${err instanceof Error ? err.message : String(err)}`,
        "E_CDP_CONNECT",
      );
    }
  }

  if (proxyArg) {
    // puppeteer.launch arg is the same for all launch paths below.
  }

  const localBinary = process.env.PUPPETEER_EXECUTABLE_PATH;
  if (localBinary && !isServerless) {
    try {
      return await puppeteer.launch({
        executablePath: localBinary,
        headless: true,
        args: [
          "--no-sandbox",
          "--disable-setuid-sandbox",
          "--disable-dev-shm-usage",
          "--disable-gpu",
          "--hide-scrollbars",
          ...(proxyArg ? [`--proxy-server=${proxyArg}`] : []),
        ],
      });
    } catch (err) {
      throw new BrowserError(
        `Failed to launch local Chrome at PUPPETEER_EXECUTABLE_PATH: ${err instanceof Error ? err.message : String(err)}`,
        "E_LAUNCH_LOCAL",
      );
    }
  }

  // Serverless path — @sparticuz/chromium ships a brotli-packed binary that
  // fits Vercel's function size budget; extraction happens on cold start.
  try {
    chromium.setGraphicsMode = false;
    const executablePath = await chromium.executablePath();
    return await puppeteer.launch({
      args: [
        ...chromium.args,
        "--hide-scrollbars",
        ...(proxyArg ? [`--proxy-server=${proxyArg}`] : []),
      ],
      defaultViewport: { width: 1280, height: 720 },
      executablePath,
      // @sparticuz/chromium ships chrome-headless-shell exclusively.
      headless: "shell",
    });
  } catch (err) {
    throw new BrowserError(
      `Failed to launch bundled Chromium: ${err instanceof Error ? err.message : String(err)}`,
      "E_LAUNCH_CHROMIUM",
    );
  }
}

export async function captureScreenshot(
  opts: ScreenshotOptions,
): Promise<ScreenshotResult> {
  const started = Date.now();
  let url: URL;
  try {
    url = new URL(opts.url);
  } catch {
    throw new BrowserError(`Invalid URL: ${opts.url}`, "E_URL");
  }
  if (!/^https?:$/.test(url.protocol)) {
    throw new BrowserError(
      `Unsupported protocol "${url.protocol}" — http(s) only`,
      "E_URL_SCHEME",
    );
  }

  const width = opts.width ?? 1280;
  const height = opts.height ?? 720;
  const format = opts.format ?? "png";
  const creds = opts.proxy ? proxyCredentials(opts.proxy) : undefined;

  const browser = await launchBrowser({ proxy: opts.proxy });
  try {
    const page: Page = await browser.newPage();
    await page.setViewport({ width, height, deviceScaleFactor: 1 });
    if (opts.userAgent) await page.setUserAgent(opts.userAgent);
    if (creds) await page.authenticate(creds);

    const response = await page.goto(url.toString(), {
      waitUntil: opts.waitUntil ?? "load",
      timeout: opts.timeoutMs ?? 30_000,
    });
    if (opts.delayMs && opts.delayMs > 0) {
      await new Promise((r) => setTimeout(r, opts.delayMs));
    }

    const image = Buffer.from(
      await page.screenshot({
        type: format,
        fullPage: opts.fullPage ?? false,
        quality: format === "jpeg" ? (opts.quality ?? 80) : undefined,
        encoding: "binary",
      }),
    );

    return {
      image,
      mimeType: format === "jpeg" ? "image/jpeg" : "image/png",
      finalUrl: page.url(),
      status: response ? response.status() : null,
      width,
      height,
      bytes: image.length,
      durationMs: Date.now() - started,
    };
  } catch (err) {
    if (err instanceof BrowserError) throw err;
    throw new BrowserError(
      `Screenshot failed: ${err instanceof Error ? err.message : String(err)}`,
      "E_SCREENSHOT",
    );
  } finally {
    // Serverless: no warm browser pool — always release the process.
    await browser.close().catch(() => undefined);
  }
}
