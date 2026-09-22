import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { appAssetPath } from "./app-assets";

const source = resolve(import.meta.dir, "app-assets.ts");
const temp = await realpath(await mkdtemp(resolve(tmpdir(), "cloud-app-assets-")));
afterAll(() => rm(temp, { recursive: true, force: true }));

describe("appAssetPath", () => {
  test("resolves inside src/assets from the source tree and rejects escapes", () => {
    expect(appAssetPath("templates", "empty.odt")).toBe(resolve(process.cwd(), "src/assets/templates/empty.odt"));
    expect(() => appAssetPath("..", "index.ts")).toThrow("escapes");
  });

  test("the production bundle resolves dist/assets next to server.js, wherever the process starts", async () => {
    // Same shape as the image: a minified bundle with the build's define, assets copied beside it.
    const image = resolve(temp, "app");
    const entry = resolve(temp, "entry.ts");
    await writeFile(
      entry,
      `import { appAssetPath } from ${JSON.stringify(source)};
const path = appAssetPath("templates", "empty.odt");
console.log(JSON.stringify({ path, exists: await Bun.file(path).exists() }));
`,
    );
    const build = await Bun.build({
      entrypoints: [entry],
      outdir: image,
      naming: "server.js",
      target: "bun",
      minify: true,
      define: { __CLOUD_APP_ASSETS__: JSON.stringify("./assets/") },
    });
    expect(build.success, build.logs.join("\n")).toBe(true);
    await Bun.write(resolve(image, "assets/templates/empty.odt"), "template");

    const run = Bun.spawn([process.execPath, resolve(image, "server.js")], { cwd: tmpdir(), stdout: "pipe", stderr: "pipe" });
    const [exit, out, err] = await Promise.all([run.exited, new Response(run.stdout).text(), new Response(run.stderr).text()]);
    expect(exit, err).toBe(0);
    expect(JSON.parse(out)).toEqual({ path: resolve(image, "assets/templates/empty.odt"), exists: true });
  }, 60_000);
});
