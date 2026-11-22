import { expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { islandIdFromFile } from "../../src/island-id";
import { makeTempRoot } from "../temp-root";

const core = resolve(import.meta.dir, "../../src");
const variants = `{ names: ["en", "de"], select: (options) => options.lang, transform: (source, path, variant) => source.replaceAll("__VARIANT__", variant) }`;

const run = async (script: string) => {
  const child = Bun.spawn([process.execPath, script], { stdout: "pipe", stderr: "pipe" });
  const [status, stderr] = await Promise.all([child.exited, new Response(child.stderr).text(), new Response(child.stdout).text()]);
  expect({ status, stderr }).toEqual({ status: 0, stderr: "" });
};

test("production builds each island variant once, and pages load the variant they select", async () => {
  const root = makeTempRoot(".ssr-variants-test-");
  try {
    const source = join(root, "Greeting.island.tsx");
    writeFileSync(
      source,
      'import { engine, label, logo, note } from "./label"; export default function Greeting() { return <b title="__VARIANT__" data-assets={[engine, logo, note].join()}>{label}</b>; }',
    );
    // A rewritten module that imports assets: they keep their loader in every variant build instead of becoming JavaScript.
    writeFileSync(
      join(root, "label.ts"),
      `import engine from "./engine.js" with { type: "file" };
      import logo from "./logo.svg" with { type: "file" };
      import note from "./note.txt" with { type: "text" };
      export { engine, logo, note };
      export const label: string = "label-__VARIANT__";`,
    );
    const engineSource = 'export const engine = "prebuilt engine";\n';
    writeFileSync(join(root, "engine.js"), engineSource);
    writeFileSync(join(root, "logo.svg"), '<svg xmlns="http://www.w3.org/2000/svg"/>');
    writeFileSync(join(root, "note.txt"), "plain note text");
    const build = join(root, "build-test.ts");
    writeFileSync(
      build,
      `import { buildIslands } from ${JSON.stringify(join(core, "build.ts"))};
      const dev = Bun.argv.includes("--dev");
      await buildIslands({ pattern: "**/*.{island,client}.tsx", cwd: import.meta.dir, outdir: import.meta.dir + "/_ssr", dev, verbose: false, variants: ${variants} });`,
    );
    const id = islandIdFromFile(source, root);
    const ssr = join(root, "_ssr");

    await run(build);
    const manifest = JSON.parse(readFileSync(join(ssr, "manifest.json"), "utf8"));
    expect(Object.keys(manifest).sort()).toEqual(["entries", "variants", "version"]);
    expect(Object.keys(manifest.variants)).toEqual(["de"]);
    expect(manifest.variants.de.version).toMatch(/^[a-f0-9]{16}$/);
    expect(manifest.variants.de.version).not.toBe(manifest.version);
    expect(manifest.variants.de.entries[id][0]).toBe(`${id}.js`);
    expect(existsSync(join(ssr, "de", "manifest.json"))).toBe(false);
    const bundle = (directory: string) =>
      [...new Bun.Glob("*.js").scanSync(directory)].map((file) => readFileSync(join(directory, file), "utf8")).join("\n");
    // The default build sits in _ssr/ as without variants; plain modules and islands both pass through the transform.
    expect(bundle(ssr)).toContain('"label-en"');
    expect(bundle(ssr)).toMatch(/title=\\?"?en\b/);
    expect(bundle(ssr)).not.toContain("__VARIANT__");
    expect(bundle(ssr)).not.toContain("label-de");
    expect(bundle(join(ssr, "de"))).toContain('"label-de"');
    expect(bundle(join(ssr, "de"))).not.toContain("label-en");
    for (const directory of [ssr, join(ssr, "de")]) {
      const files = [...new Bun.Glob("*").scanSync(directory)];
      const asset = (pattern: RegExp) => readFileSync(join(directory, files.find((file) => pattern.test(file)) ?? "missing"), "utf8");
      expect(asset(/^engine-[a-z0-9]+\.js$/)).toBe(engineSource);
      expect(asset(/^logo-[a-z0-9]+\.svg$/)).toBe('<svg xmlns="http://www.w3.org/2000/svg"/>');
      expect(bundle(directory)).toContain("plain note text");
      expect(bundle(directory)).toMatch(/engine-[a-z0-9]+\.js/);
    }

    const server = join(root, "server-test.ts");
    writeFileSync(
      server,
      `import { strict as assert } from "node:assert";
      import { Hono } from "hono";
      import { ssr } from "@solidjs/web";
      import { createConfig } from ${JSON.stringify(join(core, "index.ts"))};
      import { routes as honoRoutes } from ${JSON.stringify(join(core, "adapter/hono.ts"))};
      import { routes as bunRoutes } from ${JSON.stringify(join(core, "adapter/bun.ts"))};
      import { routes as elysiaRoutes } from ${JSON.stringify(join(core, "adapter/elysia.ts"))};
      const manifest = ${JSON.stringify(manifest)};
      const id = ${JSON.stringify(id)};
      const { config, html } = createConfig({ variants: ${variants} });
      const page = async (options) => (await (await html(() => ssr('<solid-island data-id="' + id + '" data-props="{}"></solid-island>'), options)).text()).match(/const p="([^"]+)"/)[1];
      assert.equal(await page({ lang: "de" }), "/_ssr/" + manifest.variants.de.version);
      // The default name, an unknown name, and no choice all load the default build.
      for (const options of [{ lang: "en" }, { lang: "fr" }, { lang: "constructor" }, { lang: "toString" }, { lang: "__proto__" }, {}])
        assert.equal(await page(options), "/_ssr/" + manifest.version);
      for (const adapter of ["hono", "bun", "elysia"]) {
        const hono = adapter === "hono" ? new Hono().route(config.ssrPath, honoRoutes(config)) : undefined;
        const elysia = adapter === "elysia" ? elysiaRoutes(config) : undefined;
        const server = adapter === "bun"
          ? Bun.serve({ port: 0, routes: bunRoutes(config), fetch: () => new Response(null, { status: 404 }) })
          : Bun.serve({ port: 0, fetch: (request) => hono ? hono.fetch(request) : elysia.fetch(request) });
        try {
          const get = (path) => fetch(new URL(path, server.url), { signal: AbortSignal.timeout(3000) });
          for (const [version, label] of [[manifest.version, "label-en"], [manifest.variants.de.version, "label-de"]]) {
            const response = await get("/_ssr/" + version + "/" + id + ".js");
            assert.equal(response.status, 200, adapter);
            assert.equal(response.headers.get("Cache-Control"), "public, max-age=31536000, immutable");
            assert.ok((await response.text()).includes(label), adapter + ": " + label);
          }
          for (const path of ["/_ssr/" + manifest.variants.de.version + "/manifest.json", "/_ssr/" + manifest.version + "/de/" + id + ".js", "/_ssr/de/" + id + ".js", "/_ssr/0123456789abcdef/" + id + ".js"])
            assert.equal((await get(path)).status, 404, adapter + ": " + path);
        } finally {
          await server.stop(true);
        }
      }
      process.exit(0);`,
    );
    await run(server);

    // Development builds the plain modules once: no transform, no variant directory, no manifest.
    rmSync(ssr, { recursive: true });
    const devBuild = join(root, "build-dev-test.ts");
    writeFileSync(devBuild, readFileSync(build, "utf8").replace('Bun.argv.includes("--dev")', "true"));
    await run(devBuild);
    expect(bundle(ssr)).toContain("label-__VARIANT__");
    expect(existsSync(join(ssr, "de"))).toBe(false);
    expect(existsSync(join(ssr, "manifest.json"))).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);

test("invalid variant names fail the production build before bundling", async () => {
  const { buildIslands } = await import("../../src/build");
  const options = { pattern: "**/*.island.tsx", cwd: import.meta.dir, outdir: join(import.meta.dir, "_unused"), verbose: false };
  const transform = (source: string) => source;
  for (const names of [[], ["en", "en"], ["EN"], ["de/ch"], ["-de"]])
    await expect(buildIslands({ ...options, variants: { names, transform } })).rejects.toThrow("[ssr] ");
  expect(existsSync(join(import.meta.dir, "_unused"))).toBe(false);
});
