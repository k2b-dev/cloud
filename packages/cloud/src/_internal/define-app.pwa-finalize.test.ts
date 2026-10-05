import { expect, test } from "bun:test";

test("mobile app pages skip the web layout's announcements, Help, and rail reads; Core's pages below /pwa/_auth keep them", async () => {
  const module = (path: string) => JSON.stringify(new URL(path, import.meta.url).pathname);
  const script = `
    import { mock } from "bun:test";
    import { strict as assert } from "node:assert";
    import { mkdtempSync, rmSync } from "node:fs";
    import { tmpdir } from "node:os";
    import { resolve } from "node:path";
    import { createConfig } from "@k2b/ssr";
    import { Hono } from "hono";

    const reads = [];
    const settings = await import(${module("../server/middleware/settings.ts")});
    mock.module(${module("../server/middleware/settings.ts")}, () => ({
      ...settings,
      preloadLayoutAnnouncements: async (c) => { reads.push("announcements " + c.req.path); },
    }));
    const help = await import(${module("../ssr/help.ts")});
    mock.module(${module("../ssr/help.ts")}, () => ({
      ...help,
      preloadLayoutHelp: async (c) => { reads.push("help " + c.req.path); return null; },
    }));
    const rail = await import(${module("../services/rail-snapshot.ts")});
    mock.module(${module("../services/rail-snapshot.ts")}, () => ({
      ...rail,
      readRailSnapshot: async () => { reads.push("rail"); return undefined; },
    }));

    const root = mkdtempSync(resolve(tmpdir(), "cloud-pwa-finalize-"));
    const { plugin } = createConfig({ dev: true, rootDir: root });
    Bun.plugin(plugin());
    const { defineApp } = await import(${module("./define-app.ts")});
    const app = defineApp({
      id: "finalize-probe",
      name: "Finalize Probe",
      icon: "ti ti-stack",
      description: "Page finalization probe",
      baseUrl: "http://finalize-probe:3000",
      routes: ["/app/finalize-probe"],
      pwa: {},
    });
    const page = app.ssr(() => () => "body");
    const server = new Hono()
      .use("*", async (c, next) => { c.set("user", { id: "user-1" }); await next(); })
      .get("/app/finalize-probe", ...page)
      .get("/pwa/finalize-probe", ...page)
      .get("/pwa/_auth/missing", ...page);
    const read = async (path) => {
      reads.length = 0;
      assert.equal((await server.request(path)).status, 200);
      return reads.sort();
    };
    try {
      assert.deepEqual(await read("/pwa/finalize-probe"), []);
      assert.deepEqual(await read("/app/finalize-probe"), ["announcements /app/finalize-probe", "help /app/finalize-probe", "rail"]);
      // Core's not-found page there renders in the web layout.
      assert.deepEqual(await read("/pwa/_auth/missing"), ["announcements /pwa/_auth/missing", "help /pwa/_auth/missing", "rail"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  `;
  const child = Bun.spawn([process.execPath, "-e", script], {
    cwd: new URL("../..", import.meta.url).pathname,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  // The output is part of the comparison, so a failure shows the child's assertion.
  expect({ exitCode, output: exitCode === 0 ? "" : `${stdout}${stderr}` }).toEqual({ exitCode: 0, output: "" });
}, 30_000);
