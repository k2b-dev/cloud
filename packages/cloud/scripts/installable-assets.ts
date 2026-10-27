import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod";
import { spawnCanvasWorker } from "../src/_internal/canvas-worker";
import { INSTALLABLE_ICON_VARIANTS } from "../src/_internal/installable-assets";
import type { AppInstallable } from "../src/contracts/installable";
import { readTablerIcon, renderAppFavicon } from "./app-favicon";

/** Reuse Tabler vectors and the bounded native subprocess; the build never loads canvas in process. */
export async function writeInstallableIcons(publicDir: string, appId: string, app: AppInstallable): Promise<void> {
  const vector = renderAppFavicon(await readTablerIcon(app.icon));
  const out = resolve(publicDir, appId, "installable");
  await mkdir(out, { recursive: true });
  for (const theme of ["light", "dark"] as const) {
    // Native SVG rendering does not evaluate prefers-color-scheme. Resolve it before drawing.
    const source = vector.replace(
      /<style>[\s\S]*?<\/style>/,
      `<style>.start{stop-color:${theme === "dark" ? "#f0f6ff" : "#3b82f6"}}.end{stop-color:${theme === "dark" ? "#1f8bff" : "#1d4ed8"}}</style>`,
    );
    const variants = Object.entries(INSTALLABLE_ICON_VARIANTS).map(([id, variant]) => ({
      id,
      ...variant,
      background: app.themeColor[theme],
    }));
    const child = spawnCanvasWorker(
      new URL("../src/services/branding/icon-render-worker.ts", import.meta.url),
      "installable-icons",
      JSON.stringify({
        source: Buffer.from(source).toString("base64"),
        mime: "image/svg+xml",
        fallback: source,
        variants,
      }),
    );
    const timer = setTimeout(() => child.kill("SIGKILL"), 10_000);
    try {
      let bytes = 0;
      const stdout = child.stdout.pipeThrough(
        new TransformStream<Uint8Array, Uint8Array>({
          transform(chunk, controller) {
            bytes += chunk.byteLength;
            if (bytes > 8 * 1024 * 1024) throw new Error("Installable icons exceed their output budget");
            controller.enqueue(chunk);
          },
        }),
      );
      const output = await new Response(stdout).text();
      if ((await child.exited) !== 0) throw new Error("Installable icon worker failed");
      const result = z.object({ icons: z.record(z.string(), z.string()), fallback: z.literal(false) }).parse(JSON.parse(output));
      for (const { id } of variants) {
        const png = result.icons[id];
        if (!png) throw new Error(`Missing installable icon: ${id}`);
        await writeFile(resolve(out, `${id}-${theme}.png`), Buffer.from(png, "base64"));
      }
    } finally {
      clearTimeout(timer);
      child.kill("SIGKILL");
      await child.exited;
    }
  }
}
