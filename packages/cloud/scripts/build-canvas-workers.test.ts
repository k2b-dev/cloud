import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CLOUD_LOGO_SVG } from "../src/shared/branding";
import { buildCanvasWorkers } from "./build-canvas-workers";

const dirs: string[] = [];
const dist = () => {
  const dir = mkdtempSync(join(tmpdir(), "cloud-canvas-workers-"));
  dirs.push(dir);
  return dir;
};
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

const runtime = process.platform === "linux" ? describe : describe.skip;

runtime("canvas worker packaging", () => {
  test("packages nothing for bundles that start no canvas worker", async () => {
    const out = dist();
    await buildCanvasWorkers(out, ["/app/src/index.ts"]);
    expect(existsSync(join(out, "canvas"))).toBe(false);
  });

  test("packages both workers with one copy of the native canvas", async () => {
    const out = dist();
    await buildCanvasWorkers(out, ["/x/packages/cloud/src/ai/pdf-render.ts", "/x/packages/cloud/src/services/branding/app-icons.ts"]);
    const canvas = join(out, "canvas");
    expect(readdirSync(canvas).sort()).toEqual(["icon-worker.js", "node_modules", "pdf-worker.js"]);
    const modules = readdirSync(join(canvas, "node_modules"));
    expect(modules.sort()).toEqual(["@napi-rs", "pdfjs-dist"]);
    expect(readdirSync(join(canvas, "node_modules", "@napi-rs")).filter((name) => name === "canvas")).toEqual(["canvas"]);
  }, 60_000);

  test("the packaged icon worker draws icons on its own", async () => {
    const out = dist();
    await buildCanvasWorkers(out, ["/x/packages/cloud/src/services/branding/app-icons.ts"]);
    expect(readdirSync(join(out, "canvas", "node_modules"))).toEqual(["@napi-rs"]);
    const child = Bun.spawn([process.execPath, "--no-env-file", join(out, "canvas", "icon-worker.js")], {
      stdin: new Blob([
        JSON.stringify({
          source: Buffer.from(CLOUD_LOGO_SVG).toString("base64"),
          mime: "image/svg+xml",
          fallback: CLOUD_LOGO_SVG,
          variants: [{ id: "apple-touch-icon", size: 180, background: "#fafafa", box: 0.7 }],
        }),
      ]),
      stdout: "pipe",
      stderr: "pipe",
      env: { PATH: process.env.PATH },
    });
    const output = JSON.parse(await new Response(child.stdout).text()) as { icons: Record<string, string>; fallback: boolean };
    expect(await child.exited).toBe(0);
    expect(output.fallback).toBe(false);
    expect(Buffer.from(output.icons["apple-touch-icon"]!, "base64").subarray(1, 4).toString()).toBe("PNG");
  }, 60_000);
});
