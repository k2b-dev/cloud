import { expect, test } from "bun:test";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

test("a production bundle reads deployed glyph assets without an installed UI package", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "geo-glyph-bundle-"));
  try {
    const entry = resolve(root, "entry.ts");
    await Bun.write(
      entry,
      `import { geoGlyphFile } from ${JSON.stringify(resolve(import.meta.dir, "geo-glyphs.ts"))};\nconsole.log((await geoGlyphFile("IBM Plex Sans Medium", "0-255.pbf").arrayBuffer()).byteLength);`,
    );
    const built = await Bun.build({
      entrypoints: [entry],
      outdir: root,
      naming: "server.js",
      target: "bun",
      minify: true,
      define: { __CLOUD_APP_ASSETS__: JSON.stringify("./assets/") },
    });
    expect(built.success, built.logs.join("\n")).toBe(true);
    await cp(new URL("./map-glyphs/", import.meta.resolve("@k2b/ui/package.json")), resolve(root, "assets/map-glyphs"), {
      recursive: true,
    });
    const run = Bun.spawn([process.execPath, resolve(root, "server.js")], { cwd: tmpdir(), stdout: "pipe", stderr: "pipe" });
    const [exit, stdout, stderr] = await Promise.all([run.exited, new Response(run.stdout).text(), new Response(run.stderr).text()]);
    expect(exit, stderr).toBe(0);
    expect(Number(stdout)).toBeGreaterThan(0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
