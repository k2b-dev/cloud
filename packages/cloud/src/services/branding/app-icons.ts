import { z } from "zod";
import { spawnCanvasWorker } from "../../_internal/canvas-worker";
import { PWA_CANVAS_COLORS } from "../../contracts/pwa";
import { CLOUD_LOGO_SVG } from "../../shared/branding";
import { logger } from "../logging";
import { appIconVersion, readAppIconSource } from "./app-icon-source";

declare const __CLOUD_ICON_RENDER_WORKER__: string | undefined;

/**
 * The icons of the installable mobile app. `any` icons are transparent; the maskable and the Apple icon are opaque,
 * because launchers crop maskable icons to their own shape and iOS paints transparency black. The maskable logo stays
 * inside the safe circle (40 % radius), so its square is at most 56 % of the icon.
 */
export const APP_ICON_VARIANTS = {
  "pwa-icon-192": { size: 192, background: null, box: 0.84 },
  "pwa-icon-512": { size: 512, background: null, box: 0.84 },
  "pwa-icon-maskable-512": { size: 512, background: PWA_CANVAS_COLORS.light, box: 0.56 },
  "apple-touch-icon": { size: 180, background: PWA_CANVAS_COLORS.light, box: 0.7 },
} as const;
export type AppIconVariant = keyof typeof APP_ICON_VARIANTS;

const RENDER_TIMEOUT_MS = 10_000;
/** Four PNGs of at most 512 px, in base64, plus the JSON envelope. */
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const RenderResult = z.object({
  icons: z.record(z.string(), z.string()),
  fallback: z.boolean(),
});

const log = logger("branding");

const renderAll = async (source: Awaited<ReturnType<typeof readAppIconSource>>): Promise<Map<AppIconVariant, Uint8Array<ArrayBuffer>>> => {
  if (process.platform !== "linux") throw new Error("Icon rendering requires the Linux Cloud runtime with memory isolation.");
  const worker =
    typeof __CLOUD_ICON_RENDER_WORKER__ === "string"
      ? new URL(__CLOUD_ICON_RENDER_WORKER__, import.meta.url)
      : new URL("./icon-render-worker.ts", import.meta.url);
  const signal = AbortSignal.timeout(RENDER_TIMEOUT_MS);
  const child = spawnCanvasWorker(
    worker,
    "icon-renderer",
    JSON.stringify({
      source: Buffer.from(source.data).toString("base64"),
      mime: source.mime,
      fallback: CLOUD_LOGO_SVG,
      variants: Object.entries(APP_ICON_VARIANTS).map(([id, variant]) => ({ id, ...variant })),
    }),
  );
  const stop = () => child.kill("SIGKILL");
  signal.addEventListener("abort", stop, { once: true });
  try {
    let length = 0;
    const stdout = child.stdout.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          length += chunk.byteLength;
          if (length > MAX_OUTPUT_BYTES) throw new Error("Rendered icons exceed their budget.");
          controller.enqueue(chunk);
        },
      }),
    );
    const text = await new Response(stdout).text();
    signal.throwIfAborted();
    if ((await child.exited) !== 0 || !text.trim()) throw new Error("Icon rendering failed.");
    const output = RenderResult.parse(JSON.parse(text));
    // Never log the logo or its data, only that it could not be used.
    if (output.fallback) log.warn("The installation logo could not be decoded; the app icons use the Cloud logo");
    const icons = new Map<AppIconVariant, Uint8Array<ArrayBuffer>>();
    for (const variant of Object.keys(APP_ICON_VARIANTS) as AppIconVariant[]) {
      const png = output.icons[variant];
      if (!png) throw new Error("Icon rendering failed.");
      icons.set(variant, new Uint8Array(Buffer.from(png, "base64")));
    }
    return icons;
  } finally {
    signal.removeEventListener("abort", stop);
    stop();
    await child.exited;
  }
};

/**
 * Renders the mobile app's icons from the installation logo. One run draws all variants in an isolated process; the
 * result is kept for the current logo, concurrent requests share one run, and a new logo is drawn on its next read.
 */
export const createAppIcons = () => {
  let current: { version: string; icons: Promise<Map<AppIconVariant, Uint8Array<ArrayBuffer>>> } | undefined;
  return {
    version: appIconVersion,
    render: async (variant: AppIconVariant): Promise<{ png: Uint8Array<ArrayBuffer>; etag: string }> => {
      const source = await readAppIconSource();
      let entry = current;
      if (entry?.version !== source.version) {
        const created = { version: source.version, icons: renderAll(source) };
        // A failed run is not kept; the next request tries again.
        created.icons.catch(() => {
          if (current === created) current = undefined;
        });
        current = entry = created;
      }
      const icons = await entry.icons;
      return { png: icons.get(variant)!, etag: `"${source.version}"` };
    },
  };
};

export const appIcons = createAppIcons();
