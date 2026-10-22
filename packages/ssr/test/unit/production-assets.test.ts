import { expect, test } from "bun:test";
import { readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { islandIdFromFile } from "../../src/island-id";
import { makeTempRoot } from "../temp-root";

test("production adapters preserve one module URL through lazy imports", async () => {
  const root = makeTempRoot(".ssr-production-test-");
  try {
    const source = join(root, "Counter.island.tsx");
    writeFileSync(
      source,
      `
      import { state } from "./state";
      export default function Counter() {
        return <button onClick={async () => { const lazy = await import("./lazy"); state.same = lazy.state === state; lazy.load(); }}>Load</button>;
      }
    `,
    );
    writeFileSync(join(root, "state.ts"), "export const state = { same: false };");
    writeFileSync(join(root, "lazy.ts"), 'export { state } from "./state"; export const load = () => console.log("Lazy-only code");');
    writeFileSync(join(root, "Other.client.tsx"), "export default () => <b>Client</b>;");
    // Real rebuilds use fresh build processes; Bun caches watched text imports within one process.
    const build = async () => {
      const script = `import { buildIslands } from ${JSON.stringify(resolve(import.meta.dir, "../../src/build.ts"))}; await buildIslands(${JSON.stringify({ pattern: "**/*.{island,client}.tsx", cwd: root, outdir: join(root, "_ssr"), dev: false, verbose: false })});`;
      const child = Bun.spawn([process.execPath, "-e", script], { stdout: "pipe", stderr: "pipe" });
      const [status, stderr] = await Promise.all([child.exited, new Response(child.stderr).text(), new Response(child.stdout).text()]);
      expect({ status, stderr }).toEqual({ status: 0, stderr: "" });
    };
    await build();
    const id = islandIdFromFile(source, root);
    const clientId = islandIdFromFile(join(root, "Other.client.tsx"), root);
    // A separate process puts Bun.main next to the production _ssr directory.
    const runner = join(root, "server-test.ts");
    const core = resolve(import.meta.dir, "../../src");
    writeFileSync(
      runner,
      `
      import { strict as assert } from "node:assert";
      import { Hono } from "hono";
      import { ssr } from "solid-js/web";
      import { createConfig } from ${JSON.stringify(join(core, "index.ts"))};
      import { routes as honoRoutes } from ${JSON.stringify(join(core, "adapter/hono.ts"))};
      import { routes as bunRoutes } from ${JSON.stringify(join(core, "adapter/bun.ts"))};
      import { routes as elysiaRoutes } from ${JSON.stringify(join(core, "adapter/elysia.ts"))};
      const id = ${JSON.stringify(id)};
      const clientId = ${JSON.stringify(clientId)};
      const onlyPrefix = Bun.argv.includes("--prefix-only");
      const prefix = (await (await createConfig().html(() => "")).text()).match(/const p="([^"]+)"/)[1];
      if (onlyPrefix) { console.log(prefix); process.exit(0); }
      const scanner = new Bun.Transpiler({ loader: "js" });
      const runLoader = async (output, ids) => {
        assert.ok(!output.includes('<link rel="modulepreload"'));
        const loader = output.match(/<script type="module"[^>]*>([^<]+)<\\/script>/)[1];
        assert.ok(loader.startsWith("const p="));
        const links = [];
        const entries = [];
        new Function("document", "capture", loader.replaceAll("import(", "capture("))({
          createElement: tag => { assert.equal(tag, "link"); return {}; },
          head: { append: link => {
            assert.equal(link.rel, "modulepreload");
            assert.equal(entries.length, 0, "preloads precede entry imports");
            links.push({ rel: link.rel, href: link.href });
          } },
          querySelectorAll: selector => {
            assert.equal(selector, "solid-island,solid-client");
            return ids.map(id => ({ dataset: { id } }));
          },
        }, url => { entries.push(url); });
        let assets;
        let preload;
        let loaders = 0;
        await new HTMLRewriter().on('script[type="module"][data-ssr-assets]', {
          element(element) {
            loaders++;
            assets = element.getAttribute("data-ssr-assets");
            preload = element.getAttribute("data-ssr-preload");
          },
        }).transform(new Response(output)).text();
        assert.equal(loaders, 1);
        assert.ok(loader.startsWith("const p=" + JSON.stringify(assets) + ";"));
        assert.deepEqual(preload === null ? [] : preload.split(" "), links.map(link => {
          assert.ok(link.href.startsWith(assets + "/"));
          return link.href.slice(assets.length + 1);
        }));
        if (links.length === 0) assert.equal(preload, null);
        return { loader, hrefs: links.map(link => link.href), entries };
      };
      for (const basePath of ["", "/docs"]) {
        const { config, html } = createConfig({ basePath });
        const empty = await (await html(() => "")).text();
        assert.ok(!empty.includes("modulepreload"));
        const assetPath = config.ssrPath + "/" + prefix.split("/").pop();
        assert.equal((await runLoader(empty, [])).loader, 'const p=' + JSON.stringify(assetPath) + ";document.querySelectorAll('solid-island,solid-client').forEach(e=>import(p+'/'+e.dataset.id+'.js'));");
        const output = await (await html(() => ssr('<solid-island data-id="' + id + '" data-props="{}"></solid-island>'))).text();
        const { hrefs, entries } = await runLoader(output, [id]);
        assert.equal(entries.length, 1);
        const [entry] = entries;
        assert.match(entry, new RegExp("^" + config.ssrPath + "/[a-f0-9]{16}/" + id + "\\\\.js$"));
        for (const adapter of ["hono", "bun", "elysia"]) {
          const hono = adapter === "hono" ? new Hono().route(config.ssrPath, honoRoutes(config)) : undefined;
          const elysia = adapter === "elysia" ? elysiaRoutes(config) : undefined;
          const server = adapter === "bun"
            ? Bun.serve({ port: 0, routes: bunRoutes(config), fetch: () => new Response(null, { status: 404 }) })
            : Bun.serve({ port: 0, fetch: (request) => hono ? hono.fetch(request) : elysia.fetch(request) });
          const origin = server.url;
          const request = fetch;
          try {
            const start = new URL(entry, origin).href;
            const pending = [start];
            const visited = new Set();
            const files = new Map();
            const imports = new Map();
            let dynamicImports = 0;
            while (pending.length) {
              const url = pending.pop();
              if (visited.has(url)) continue;
              visited.add(url);
              const filename = new URL(url).pathname.split("/").pop();
              assert.equal(files.get(filename) ?? url, url, adapter + ": duplicate module identity");
              files.set(filename, url);
              const response = await request(url, { signal: AbortSignal.timeout(3000) });
              assert.equal(response.status, 200, adapter + ": " + url);
              assert.equal(response.headers.get("Cache-Control"), "public, max-age=31536000, immutable");
              const code = await response.text();
              imports.set(url, scanner.scanImports(code));
              for (const item of imports.get(url)) {
                if (item.kind === "dynamic-import") dynamicImports++;
                if (item.path.startsWith(".")) pending.push(new URL(item.path, url).href);
              }
            }
            assert.ok(dynamicImports > 0, "fixture must exercise lazy loading");
            assert.ok(visited.size > 1, "fixture must exercise splitting");
            const staticClosure = new Set([start]);
            for (const url of staticClosure) {
              for (const item of imports.get(url)) {
                if (item.kind === "import-statement" && item.path.startsWith(".")) staticClosure.add(new URL(item.path, url).href);
              }
            }
            const staticPaths = [...staticClosure].map(url => new URL(url).pathname);
            assert.deepEqual([...hrefs, entry].sort(), [...staticPaths].sort(), adapter + ": static preloads and entry");
            assert.ok(!hrefs.includes(entry));
            for (const href of hrefs) {
              assert.equal(href, new URL(href, origin).pathname, "canonical preload URL");
              assert.ok(staticClosure.has(new URL(href, origin).href), adapter + ": preload module identity");
            }
            assert.ok(hrefs.some(path => path.includes("/chunk-")));
            assert.ok(visited.size > staticClosure.size, "fixture must emit a lazy-only chunk");
            for (const url of visited) if (!staticClosure.has(url)) assert.ok(!hrefs.includes(new URL(url).pathname));
            const clientEntry = entry.replace(id + ".js", clientId + ".js");
            const clientPaths = new Set([clientEntry]);
            const clientQueue = [new URL(clientEntry, origin).href];
            const clientVisited = new Set();
            for (const url of clientQueue) {
              if (clientVisited.has(url)) continue;
              clientVisited.add(url);
              const response = await request(url);
              assert.equal(response.status, 200);
              for (const item of scanner.scanImports(await response.text())) {
                if (item.kind === "import-statement" && item.path.startsWith(".")) {
                  const target = new URL(item.path, url);
                  clientPaths.add(target.pathname);
                  clientQueue.push(target.href);
                }
              }
            }
            const unionBody = '<solid-client data-id="' + clientId + '"></solid-client><solid-island data-id="' + id + '"></solid-island><solid-island data-id="' + id + '"></solid-island><solid-client data-id="000000000000"></solid-client>';
            const unionOutput = await (await html(() => ssr(unionBody))).text();
            const { hrefs: unionHrefs, entries: unionEntries } = await runLoader(unionOutput, [clientId, id, id, "000000000000"]);
            assert.deepEqual(unionEntries, [clientEntry, entry, entry, assetPath + "/000000000000.js"]);
            // Each manifest closure lists its entry first, then its shared files in filename order.
            const sharedPaths = paths => [...paths].filter(path => path !== entry && path !== clientEntry).sort();
            const expectedUnion = [...new Set([...sharedPaths(clientPaths), ...sharedPaths(staticPaths)])];
            assert.deepEqual(unionHrefs, expectedUnion, adapter + ": ordered shared union");
            assert.ok(!unionHrefs.includes(entry));
            assert.ok(!unionHrefs.includes(clientEntry));
            assert.equal(new Set(unionHrefs).size, unionHrefs.length);
            for (const path of [config.ssrPath + "/" + id + ".js", config.ssrPath + "/old/" + id + ".js", config.ssrPath + "/0/" + id + ".js", config.ssrPath + "/1234567890000/" + id + ".js", entry.replace(id + ".js", "manifest.json"), config.ssrPath + "/manifest.json", entry.replace(id + ".js", "extra/" + id + ".js")]) {
              assert.equal((await request(new URL(path, origin), { signal: AbortSignal.timeout(3000) })).status, 404, adapter + ": unexpected alias " + path);
            }
            const head = await request(new URL(entry, origin), { method: "HEAD", signal: AbortSignal.timeout(3000) });
            assert.equal(head.status, 200);
            assert.equal(await head.text(), "");
          } finally {
            await server.stop(true);
          }
        }
      }
      // Elysia schedules a delayed compiler-cache GC timer; all servers are already stopped.
      console.log(prefix);
      process.exit(0);
    `,
    );
    const run = async (prefixOnly = false) => {
      const child = Bun.spawn([process.execPath, runner, ...(prefixOnly ? ["--prefix-only"] : [])], {
        stdout: "pipe",
        stderr: "pipe",
      });
      const [status, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      expect({ status, stderr }).toEqual({ status: 0, stderr: "" });
      expect(stdout.trim()).toMatch(/^\/_ssr\/[a-f0-9]{16}$/);
      return stdout.trim();
    };
    const first = await run(true);
    await build();
    utimesSync(runner, new Date("2001-01-01"), new Date("2001-01-01"));
    expect(await run(true)).toBe(first);
    writeFileSync(source, readFileSync(source, "utf8").replace(">Load</button>", ">Changed</button>"));
    await build();
    expect(await run(true)).not.toBe(first);
    await run();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 20_000);

test("production manifests are required, validated, and memoized only after a successful read", async () => {
  const root = makeTempRoot(".ssr-manifest-test-");
  try {
    const runner = join(root, "server-test.ts");
    const core = resolve(import.meta.dir, "../../src");
    writeFileSync(
      runner,
      `
      import { strict as assert } from "node:assert";
      import { mkdirSync, rmSync, writeFileSync } from "node:fs";
      import { join } from "node:path";
      import { Hono } from "hono";
      import { ssr } from "solid-js/web";
      import { createConfig } from ${JSON.stringify(join(core, "index.ts"))};
      import { readAssetManifest, getAssetPrefix } from ${JSON.stringify(join(core, "adapter/utils.ts"))};
      import { routes as honoRoutes } from ${JSON.stringify(join(core, "adapter/hono.ts"))};
      import { routes as bunRoutes } from ${JSON.stringify(join(core, "adapter/bun.ts"))};
      import { routes as elysiaRoutes } from ${JSON.stringify(join(core, "adapter/elysia.ts"))};
      const { config, html } = createConfig();
      const directory = join(import.meta.dir, "_ssr");
      const path = join(directory, "manifest.json");
      const hono = new Hono().route(config.ssrPath, honoRoutes(config)).onError(error => {
        assert.ok(error.message.includes("manifest.json"));
        return new Response(null, { status: 500 });
      });
      const bun = bunRoutes(config);
      const elysia = elysiaRoutes(config);
      assert.equal(getAssetPrefix(config), "/0");
      mkdirSync(directory);
      writeFileSync(join(directory, "entry.js"), "export const answer = 42;");
      const missing = "[ssr] Missing " + path;
      await assert.rejects(html(() => ""), error => error.message.startsWith(missing));
      for (const handle of [request => hono.fetch(request), bun[config.ssrPath + "/:version/:filename"], request => elysia.fetch(request)]) {
        try {
          const response = await handle(new Request("http://localhost/_ssr/0123456789abcdef/entry.js"));
          assert.notEqual(response.status, 200);
        } catch (error) { assert.ok(error.message.startsWith(missing)); }
      }
      for (const invalid of ['{', 'null', '[]', '{}', '{"version":"0","entries":{}}', '{"version":"0123456789ABCDEf","entries":{}}', '{"version":"0123456789abcdef","entries":[]}', '{"version":"0123456789abcdef","entries":{"id":[1]}}', '{"version":"0123456789abcdef","entries":{"id":"entry.js"}}', ...["x</script>.js", "../x.js", "x.js.map", "x.js.MAP"].map(file => JSON.stringify({ version: "0123456789abcdef", entries: { id: [file] } }))]) {
        writeFileSync(path, invalid);
        assert.throws(() => readAssetManifest(config), error => error.message.startsWith("[ssr] Invalid " + path));
      }
      const dev = createConfig({ dev: true, rootDir: import.meta.dir });
      assert.equal(getAssetPrefix(dev.config), "");
      assert.ok(!(await (await dev.html(() => ssr('<solid-island data-id="0123456789ab"></solid-island>'))).text()).includes("modulepreload"));
      const valid = { version: "0123456789abcdef", entries: { id: ["entry.js"] } };
      writeFileSync(path, JSON.stringify(valid));
      assert.deepEqual(readAssetManifest(config), valid);
      rmSync(path);
      assert.deepEqual(readAssetManifest(config), valid);
      process.exit(0);
    `,
    );
    const child = Bun.spawn([process.execPath, runner], { stdout: "pipe", stderr: "pipe" });
    const [status, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    expect({ status, stderr }).toEqual({ status: 0, stderr: "" });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("loader data exposes escaped asset paths and the ordered shared module set without a server", async () => {
  const root = makeTempRoot(".ssr-loader-data-");
  try {
    const runner = join(root, "loader-data.ts");
    writeFileSync(
      runner,
      `
      import { strict as assert } from "node:assert";
      import { mkdirSync, writeFileSync } from "node:fs";
      import { ssr } from "solid-js/web";
      import { createConfig } from ${JSON.stringify(resolve(import.meta.dir, "../../src/index.ts"))};
      mkdirSync(import.meta.dir + "/_ssr");
      const version = "0123456789abcdef";
      writeFileSync(import.meta.dir + "/_ssr/manifest.json", JSON.stringify({
        version, entries: {
          "00000000000a": ["00000000000a.js", "chunk-a.js", "chunk-shared.js"],
          "00000000000b": ["00000000000b.js", "chunk-b.js", "chunk-shared.js"],
        },
      }));
      for (const dev of [false, true]) {
        const { config, html } = createConfig({ dev, basePath: '/docs&"quoted' });
        const assets = config.ssrPath + (dev ? "" : "/" + version);
        for (const empty of [false, true]) {
          const body = empty ? "" : '<solid-client data-id="00000000000b"></solid-client><solid-island data-id="00000000000a"></solid-island>';
          const output = await (await html(() => ssr(body))).text();
          const shared = dev || empty ? [] : ["chunk-b.js", "chunk-shared.js", "chunk-a.js"];
          let loaders = 0;
          await new HTMLRewriter().on('script[data-ssr-assets]', { element(element) {
            loaders++;
            assert.equal(element.getAttribute("type"), "module");
            // HTMLRewriter preserves attribute entities; the browser decodes them.
            assert.equal(element.getAttribute("data-ssr-assets"), Bun.escapeHTML(assets));
            assert.equal(element.getAttribute("data-ssr-preload"), shared.length ? shared.join(" ") : null);
          } }).transform(new Response(output)).text();
          assert.equal(loaders, 1);
          assert.ok(output.includes('data-ssr-assets="' + Bun.escapeHTML(assets) + '"'));
          assert.ok(!output.includes('<link rel="modulepreload"'));
        }
      }
    `,
    );
    const child = Bun.spawn([process.execPath, runner], { stdout: "pipe", stderr: "pipe" });
    const [status, stderr] = await Promise.all([child.exited, new Response(child.stderr).text(), new Response(child.stdout).text()]);
    expect({ status, stderr }).toEqual({ status: 0, stderr: "" });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
