import { CHART_SHARED_IMPORT, type ChartHashes } from "../html/chart-parts";
import type { ChartInteraction, RareChartRenderer } from "./chart-renderer-types";

let hashes: ChartHashes;
let request: (kind: string) => Promise<unknown>;
let track = (task: Promise<void>) => task;
const renderers = new Map<string, RareChartRenderer>();
const interactions = new Map<string, ChartInteraction>();
const loading = new Map<string, Promise<void>>();
let shared: Promise<string> | undefined;

/** Only the trusted host can deliver source; app code cannot choose an asset URL. */
export function configureChartModule(manifest: ChartHashes, source: typeof request, pending: typeof track) {
  hashes = manifest;
  request = source;
  track = pending;
}

export const deferChartDrawing = true;
export const rareChartSvg = (...args: Parameters<RareChartRenderer>): string | undefined => renderers.get(args[0].kind)?.(...args);
export const chartInteraction = (kind: string): ChartInteraction | undefined => interactions.get(kind);

async function source(kind: string): Promise<string> {
  const expected = kind === "shared" ? hashes.shared : hashes.kinds[kind];
  if (!expected) throw new Error("The chart module is missing. Reopen the app to reload its assets.");
  const part = await request(kind);
  if (
    !part ||
    typeof part !== "object" ||
    !("hash" in part) ||
    part.hash !== expected ||
    !("code" in part) ||
    typeof part.code !== "string"
  )
    throw new Error("The chart asset does not match this frame.");
  return part.code;
}

const blob = (code: string) => URL.createObjectURL(new Blob([code], { type: "text/javascript" }));
function sharedModule(): Promise<string> {
  shared ??= (async () => {
    const url = blob(await source("shared"));
    try {
      await import(/* @vite-ignore */ url);
      // Kind modules import this URL later; keep it alive for the frame's lifetime.
      addEventListener("pagehide", () => URL.revokeObjectURL(url), { once: true });
      return url;
    } catch (error) {
      URL.revokeObjectURL(url);
      throw error;
    }
  })().catch((error) => {
    shared = undefined;
    throw error;
  });
  return shared;
}

/** One import per drawn kind and one shared import per frame; failed loads remain retryable. */
export function loadChartRenderer(kind: string): Promise<void> {
  if (renderers.has(kind)) return Promise.resolve();
  let task = loading.get(kind);
  if (!task) {
    task = track(
      (async () => {
        const url = blob((await source(kind)).replaceAll(JSON.stringify(CHART_SHARED_IMPORT), JSON.stringify(await sharedModule())));
        try {
          const module = await import(/* @vite-ignore */ url);
          if (typeof module.render !== "function") throw new Error("The chart module did not provide its renderer.");
          if (kind === "balanceFlow") {
            const interactionUrl = blob(await source(`${kind}:interaction`));
            try {
              const interaction = await import(/* @vite-ignore */ interactionUrl);
              if (typeof interaction.mount !== "function") throw new Error("The chart module did not provide its interaction.");
              if (typeof interaction.map !== "function") throw new Error("The chart module did not provide its mapper.");
              interactions.set(kind, interaction.mount);
              renderers.set(kind, (mapped, common, locale) =>
                module.render(
                  common.balanceFlow
                    ? interaction.map(common.balanceFlow.input, locale ?? "en", {
                        width: common.width,
                        formats: common.balanceFlow.formats,
                      })
                    : mapped,
                  common,
                  locale,
                ),
              );
            } finally {
              URL.revokeObjectURL(interactionUrl);
            }
          }
          if (kind !== "balanceFlow") renderers.set(kind, module.render);
        } finally {
          URL.revokeObjectURL(url);
        }
      })(),
    ).catch((error) => {
      loading.delete(kind);
      throw error;
    });
    loading.set(kind, task);
  }
  return task;
}
