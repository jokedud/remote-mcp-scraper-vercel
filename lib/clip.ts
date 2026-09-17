import type { Page } from "puppeteer-core";
import { launchBrowser, BrowserError } from "./browser";

export type ClipAction = "scroll" | "draw_canvas" | "none";

export interface CaptureClipOptions {
  url: string;
  action?: ClipAction;
  durationMs?: number;
  fps?: number;
  width?: number;
  height?: number;
  quality?: number;
  proxy?: string;
}

export interface CapturedClip {
  url: string;
  finalUrl: string;
  action: ClipAction;
  durationMs: number;
  fps: number;
  width: number;
  height: number;
  mimeType: "image/jpeg";
  frames: string[];
  frameCount: number;
  bytes: number;
  note: string;
}

const MAX_DURATION_MS = 6_000;
const MAX_FRAMES = 30;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function performAction(page: Page, action: ClipAction, elapsedMs: number, durationMs: number): Promise<void> {
  if (action === "scroll") {
    await page.evaluate(({ elapsed, duration }) => {
      const max = Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
      window.scrollTo({ top: max * Math.min(1, elapsed / duration), behavior: "auto" });
    }, { elapsed: elapsedMs, duration: durationMs });
  } else if (action === "draw_canvas") {
    await page.evaluate(({ elapsed, duration }) => {
      const canvas = document.querySelector("canvas") as HTMLCanvasElement | null;
      if (!canvas) return;
      const rect = canvas.getBoundingClientRect();
      const x = rect.left + rect.width * Math.min(1, elapsed / duration);
      const y = rect.top + rect.height * (0.5 + 0.2 * Math.sin(elapsed / 180));
      canvas.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, clientX: x, clientY: y, pointerId: 1, buttons: 1 }));
    }, { elapsed: elapsedMs, duration: durationMs });
  }
}

export async function captureActionFrames(opts: CaptureClipOptions): Promise<CapturedClip> {
  let parsed: URL;
  try { parsed = new URL(opts.url); } catch { throw new BrowserError(`Invalid URL: ${opts.url}`, "E_URL"); }
  if (!/^https?:$/.test(parsed.protocol)) throw new BrowserError("URL must use http or https", "E_URL_SCHEME");

  const durationMs = Math.min(Math.max(Math.round(opts.durationMs ?? 4_000), 250), MAX_DURATION_MS);
  const fps = Math.min(Math.max(Math.round(opts.fps ?? 3), 1), 5);
  const width = Math.min(Math.max(Math.round(opts.width ?? 960), 320), 1600);
  const height = Math.min(Math.max(Math.round(opts.height ?? 540), 240), 1200);
  const intervalMs = Math.max(200, Math.round(1000 / fps));
  const action = opts.action ?? "scroll";
  const browser = await launchBrowser({ proxy: opts.proxy });
  const frames: string[] = [];
  const started = Date.now();

  try {
    const page = await browser.newPage();
    await page.setViewport({ width, height, deviceScaleFactor: 1 });
    if (opts.proxy) {
      const proxyUrl = new URL(opts.proxy);
      if (proxyUrl.username) await page.authenticate({ username: decodeURIComponent(proxyUrl.username), password: decodeURIComponent(proxyUrl.password) });
    }
    await page.goto(parsed.toString(), { waitUntil: "domcontentloaded", timeout: 30_000 });
    const captureUntil = Date.now() + durationMs;
    while (Date.now() < captureUntil && frames.length < MAX_FRAMES) {
      const elapsed = Math.min(durationMs, Date.now() - started);
      await performAction(page, action, elapsed, durationMs);
      const image = await page.screenshot({ type: "jpeg", quality: Math.min(Math.max(opts.quality ?? 65, 30), 85), encoding: "binary" });
      frames.push(Buffer.from(image).toString("base64"));
      await sleep(Math.min(intervalMs, Math.max(0, captureUntil - Date.now())));
    }
    return {
      url: opts.url, finalUrl: page.url(), action, durationMs, fps, width, height,
      mimeType: "image/jpeg", frames, frameCount: frames.length,
      bytes: frames.reduce((sum, frame) => sum + Buffer.byteLength(frame, "base64"), 0),
      note: "Frames are ordered JPEG base64 images. Capture is capped at 6000ms and 30 frames for serverless safety; callers can stitch them into an animated WebP/GIF.",
    };
  } catch (err) {
    if (err instanceof BrowserError) throw err;
    throw new BrowserError(`Clip capture failed: ${err instanceof Error ? err.message : String(err)}`, "E_CLIP");
  } finally {
    await browser.close().catch(() => undefined);
  }
}
