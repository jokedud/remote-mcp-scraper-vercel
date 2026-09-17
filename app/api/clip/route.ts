import { captureActionGif, type ClipAction } from "../../../lib/clip";
import { authorize } from "../../../lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const numberParam = (value: string | null, fallback: number) => {
  if (value === null || value.trim() === "") return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

export async function GET(request: Request) {
  const denied = authorize(request);
  if (denied) return denied;

  const params = new URL(request.url).searchParams;
  const url = params.get("url");
  if (!url) return new Response("Missing required url query parameter", { status: 400 });

  const actionValue = params.get("action") ?? "scroll";
  if (!["scroll", "draw_canvas", "none"].includes(actionValue)) {
    return new Response("Invalid action", { status: 400 });
  }

  try {
    const result = await captureActionGif({
      url,
      action: actionValue as ClipAction,
      durationMs: numberParam(params.get("durationMs"), 2500),
      fps: numberParam(params.get("fps"), 2),
      width: numberParam(params.get("width"), 640),
      height: numberParam(params.get("height"), 360),
    });
    const base64 = result.dataUri.slice(result.dataUri.indexOf(",") + 1);
    return new Response(Buffer.from(base64, "base64"), {
      headers: {
        "Content-Type": "image/gif",
        "Cache-Control": "public, max-age=60",
      },
    });
  } catch (error) {
    return new Response(error instanceof Error ? error.message : "GIF capture failed", { status: 500 });
  }
}
