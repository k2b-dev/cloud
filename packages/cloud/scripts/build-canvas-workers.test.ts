import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";
import { readImageRecords } from "../src/services/pdf/image-protocol";
import { CLOUD_LOGO_SVG } from "../src/shared/branding";
import { buildCanvasWorkers, reachedBundleInputs } from "./build-canvas-workers";

const dirs: string[] = [];
const dist = () => {
  const dir = mkdtempSync(join(tmpdir(), "cloud-canvas-workers-"));
  dirs.push(dir);
  return dir;
};
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

const glibc = z.object({ header: z.object({ glibcVersionRuntime: z.string().optional() }) }).parse(process.report.getReport())
  .header.glibcVersionRuntime;
const platform = `${process.platform}${process.platform === "linux" && !glibc ? "musl" : ""}-${process.arch}`;
const canvasPlatform = `${process.platform}-${process.arch}${process.platform === "linux" ? (glibc ? "-gnu" : "-musl") : ""}`;
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
    expect(readdirSync(join(canvas, "node_modules", "@napi-rs")).sort()).toEqual(["canvas", `canvas-${canvasPlatform}`]);
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
    const timer = setTimeout(() => child.kill("SIGKILL"), 30_000);
    try {
      const output = z
        .object({ icons: z.record(z.string(), z.string()), fallback: z.boolean() })
        .parse(JSON.parse(await new Response(child.stdout).text()));
      expect(await child.exited).toBe(0);
      expect(output.fallback).toBe(false);
      expect(Buffer.from(output.icons["apple-touch-icon"]!, "base64").subarray(1, 4).toString()).toBe("PNG");
    } finally {
      clearTimeout(timer);
      child.kill("SIGKILL");
      await child.exited;
    }
  }, 60_000);

  test("reaches only code that survives a real Bun server bundle", async () => {
    const out = dist();
    const pdf = resolve(import.meta.dir, "../src/services/pdf/index.ts");
    for (const name of ["renderHtmlToPdf", "preparePdfImage"]) {
      const entry = join(out, `${name}.ts`);
      const input =
        name === "preparePdfImage"
          ? "{ data: new Uint8Array(), boxes: [{ width: 1, height: 1 }], maxBytes: 1024 }"
          : '{ html: "<p>Hello</p>" }';
      await Bun.write(entry, `import { ${name} } from ${JSON.stringify(pdf)}; console.log(${name}(${input}));`);
      const build = await Bun.build({ entrypoints: [entry], target: "bun", metafile: true });
      expect(build.success).toBe(true);
      expect(build.metafile).toBeDefined();
      expect(Object.keys(build.metafile!.inputs).some((path) => path.endsWith("/services/pdf/image.ts"))).toBe(true);
      const reached = reachedBundleInputs(build.metafile);
      expect(reached.some((path) => path.endsWith("/services/pdf/image.ts"))).toBe(name === "preparePdfImage");
      expect(reached.some((path) => path.endsWith("/image-variants.ts") || path.includes("/sharp/"))).toBe(false);
    }
  }, 60_000);

  test("packages only sharp's host closure, and the isolated image worker converts a PNG", async () => {
    const out = dist();
    await buildCanvasWorkers(out, ["/x/packages/cloud/src/services/pdf/image.ts"]);
    const canvas = join(out, "canvas");
    expect(readdirSync(canvas).sort()).toEqual(["image-worker.js", "node_modules"]);
    expect(readdirSync(join(canvas, "node_modules")).sort()).toEqual(["@img", "detect-libc", "semver", "sharp"]);
    expect(readdirSync(join(canvas, "node_modules", "@img")).sort()).toEqual(
      ["colour", `sharp-${platform}`, `sharp-libvips-${platform}`].sort(),
    );
    const sharpDirectory = dirname(Bun.resolveSync("sharp/package.json", resolve(import.meta.dir, "..")));
    const Version = z.object({ version: z.string() });
    const expectedSemver = Version.parse(await Bun.file(Bun.resolveSync("semver/package.json", sharpDirectory)).json());
    expect(Version.parse(await Bun.file(join(canvas, "node_modules", "semver", "package.json")).json())).toEqual(expectedSemver);
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAEUlEQVR4nGP4z8DQAMIMMAYAOOgF/REzMMkAAAAASUVORK5CYII=",
      "base64",
    );
    const child = Bun.spawn([process.execPath, "--no-env-file", join(canvas, "image-worker.js")], {
      stdin: new Blob([`${JSON.stringify({ boxes: [{ width: 2, height: 2 }], maxBytes: 4096, timeoutMs: 10_000 })}\n`, png]),
      stdout: "pipe",
      stderr: "pipe",
      env: { PATH: process.env.PATH },
    });
    const timer = setTimeout(() => child.kill("SIGKILL"), 15_000);
    try {
      const result = await readImageRecords(child.stdout, { boxes: [{ width: 2, height: 2 }], maxBytes: 4096 });
      expect(await child.exited).toBe(0);
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error(result.code);
      expect(result.variants).toHaveLength(1);
      expect(result.variants[0]).toMatchObject({ type: "image/png", width: 2, height: 2 });
      expect(
        Buffer.from(await result.variants[0]!.data.arrayBuffer())
          .subarray(1, 4)
          .toString(),
      ).toBe("PNG");
    } finally {
      clearTimeout(timer);
      child.kill("SIGKILL");
      await child.exited;
    }
  }, 60_000);
});
