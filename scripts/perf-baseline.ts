#!/usr/bin/env bun
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { cpus, loadavg } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { TIMEZONE_COOKIE } from "../packages/cloud/src/shared/time";
import { runUnderHeavyLock } from "./heavy-lock";
import { measureStatic } from "./perf-baseline/assets";
import { Browsers, measuredLocale, measuredTimeZone } from "./perf-baseline/browser";
import { pageApps, parseArgs, type Result, renderSummary, resultSchema, sortedJson, validatePage } from "./perf-baseline/model";
import { buildRoot, command, freeLoopbackPort, localTls, Runtime, repository, runtimeImage, worktreePath } from "./perf-baseline/runtime";
import { Api, defaultPaths, seed, waitForRoutes } from "./perf-baseline/seed";

export const help = `Usage: bun --no-env-file scripts/perf-baseline.ts [flags]

Measure production bundles through an isolated local Docker gateway and
Caddy TLS terminator (HTTPS + HTTP/2; gateway compression passes through).
Prerequisites: installed workspace dependencies and Docker access.
Both browsers use one run-owned Playwright noble container matching the root
catalog version, sharing Caddy's network namespace. Docker may pull missing
images, including the Playwright image (about 3.5 GB); the container may
download its matching Playwright package.
The machine-wide heavy lock waits for other check/test runs and blocks them
while this harness builds and measures. Unless --skip-build is used, it
rebuilds @k2b/ui before building the selected apps.
Allow roughly 5–15 minutes for builds/startup plus cold page loads; slower
hosts or downloads take longer. Each browser load is capped at 45 seconds.
The script starts and removes only its uniquely named containers/network/
volumes. It publishes HTTPS and the browser server on free loopback ports,
never 3000; all apps use APP_URL=https://localhost:<port>. Bun fetches skip
certificate verification only for this origin; browser contexts ignore
certificate errors.
It does not use or change the development stack or application runtime code.
After login it accepts the fresh installation's legal terms for the throwaway
administrator through Core's public consent flow and verifies the session
before checking authenticated routes or seeding fixtures. Every page is
measured with that administrator session.

  --help             Show this help; no build, Docker or browser launch.
  --pages a,b        Restrict pages (default: all seven):
                     document,faq,mail-mailbox,assistant-chat,
                     notebooks-editor,files,accounts
  --runs N           Cold runs per browser/profile (default: 3).
  --skip-build       Reuse .local/perf-baseline/build/<app>/dist;
                     does not verify that these builds match current source.
  --out <dir>        Write result.json and summary.md here, within this
                     worktree (default: .local/perf-baseline/<UTC timestamp>).
                     Existing result files are never overwritten.
  --compare <file>   Read an earlier schemaVersion 1 result.json and add
                     median TTI deltas to the Markdown table.
  --keep             Keep this run's containers, network, volumes and private
                     fixture files; print exact commands to remove them.

Both Chromium and WebKit run desktop (1440x900) and phone (390x844 @3x).
Chromium phone uses 4x CPU slowdown, 150 ms request latency, 1.6 Mbit/s
download and 750 kbit/s upload. WebKit is unthrottled and may skip with a
recorded connect error; a browser server that does not start fails the run.
These are local emulations, not real-phone measurements.
TTI is the latest of FCP, the end of each initial island mount, the last
script response end and, in Chromium, the last long-task end. Observation
stops once all initial islands mounted and scripts were quiet for 500 ms;
that window is not part of TTI, but transfers and performance entries count
until the stop. Timeouts and render/fixture failures fail the run; partial
metrics and errors are still written to both output files.

Mail measures the real mailbox view of a seeded mailbox without a provider
connection: empty list, smaller props, same eager JS. This limitation is
recorded in page notes; no real mailboxes or provider credentials are used.
`;

const oneMinuteLoad = () => Number(loadavg()[0]?.toFixed(2) ?? 0);

async function run() {
  const options = parseArgs(Bun.argv.slice(2));
  if (options.help) {
    console.log(help);
    return;
  }
  runUnderHeavyLock();
  const timestamp = new Date().toISOString();
  const out = await worktreePath(options.out ?? `.local/perf-baseline/${timestamp.replaceAll(":", "-")}`);
  const previous = options.compare ? resultSchema.parse(JSON.parse(await readFile(options.compare, "utf8"))) : undefined;
  const image = runtimeImage(await readFile(join(repository, "Dockerfile"), "utf8"));
  const playwright = z
    .object({ version: z.string() })
    .parse(JSON.parse(await readFile(join(repository, "packages/ui/node_modules/playwright/package.json"), "utf8")));
  const catalog = z
    .object({ workspaces: z.object({ catalog: z.object({ playwright: z.string() }) }) })
    .parse(JSON.parse(await readFile(join(repository, "package.json"), "utf8"))).workspaces.catalog;
  if (playwright.version !== catalog.playwright)
    throw new Error("Installed Playwright differs from the root catalog; run bun install --frozen-lockfile");
  const [commit, status] = await Promise.all([command(["git", "rev-parse", "HEAD"]), command(["git", "status", "--porcelain"])]);
  const result: Result = {
    schemaVersion: 1,
    metadata: {
      commit,
      dirty: status.length > 0,
      timestamp,
      bunVersion: Bun.version,
      playwrightVersion: playwright.version,
      browserVersions: {},
      cpuCount: cpus().length,
      loadAverage: { start: oneMinuteLoad(), end: null },
      runs: options.runs,
      origin: "not started",
      transport: "https-h2-caddy",
      runtimeImage: image,
      seedVersion: 1,
    },
    pages: options.pages.map((id) => ({
      id,
      path: defaultPaths[id],
      status: "failed",
      errors: ["Not measured: installation setup did not complete"],
      notes: [],
      static: null,
      browsers: [],
    })),
    errors: [],
  };
  // Reserve both files before doing expensive work, without overwriting a previous baseline.
  if (existsSync(join(out, "result.json")) || existsSync(join(out, "summary.md")))
    throw new Error("Output already contains result.json or summary.md; choose a fresh --out directory");
  await mkdir(out, { recursive: true });
  await writeFile(join(out, "result.json"), sortedJson(result), { flag: "wx" });
  await writeFile(join(out, "summary.md"), renderSummary(result, previous), { flag: "wx" });
  const controller = new AbortController();
  const interrupted = () => controller.abort(new Error("Interrupted; cleaning up this run"));
  process.on("SIGINT", interrupted);
  process.on("SIGTERM", interrupted);
  let runtime: Runtime | undefined;
  let browsers: Browsers | undefined;
  try {
    console.log("Checking Docker access…");
    await command(["docker", "info", "--format", "{{.ServerVersion}}"], { timeoutMs: 15_000, signal: controller.signal });
    runtime = new Runtime(await freeLoopbackPort(), image, controller.signal);
    const origin = runtime.origin;
    result.metadata.origin = origin;
    await mkdir(join(runtime.directory, "tmp"), { recursive: true });
    const apps = ["core", ...new Set(options.pages.map((id) => pageApps[id]).filter((id) => id !== "core")), "gateway"];
    await runtime.build(apps, options.skipBuild);
    await runtime.start(apps);
    browsers = new Browsers(controller.signal);
    await browsers.launch(await runtime.startBrowsers(catalog.playwright));
    result.metadata.browserVersions = browsers.versions();
    const api = new Api(origin, controller.signal);
    const userId = await api.login(runtime.adminToken);
    await waitForRoutes(api, apps, runtime);
    result.pages = await seed(api, runtime, options.pages, userId);
    for (const page of result.pages) {
      controller.signal.throwIfAborted();
      if (page.status === "failed") continue;
      console.log(`Measuring ${page.id}: ${page.path}`);
      const url = `${origin}${page.path}`;
      try {
        const response = await fetch(url, {
          ...localTls(url, origin),
          headers: {
            cookie: `session_token=${api.cookie}; ${TIMEZONE_COOKIE}=${encodeURIComponent(measuredTimeZone)}`,
            "accept-language": measuredLocale,
          },
          redirect: "manual",
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(30_000)]),
        });
        const html = await response.text();
        validatePage(response.status, url, response.url, html);
        page.static = await measureStatic(html, url, buildRoot, apps);
        page.browsers = [];
        await browsers.measure(url, api.cookie, options.runs, page.browsers);
        if (page.browsers.some((profile) => profile.status === "failed")) {
          page.status = "failed";
          page.errors.push("One or more browser profiles failed; see the recorded reasons");
        }
      } catch (error) {
        page.status = "failed";
        page.errors.push(error instanceof Error ? error.message : String(error));
        controller.signal.throwIfAborted();
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    result.errors.push(message);
    await runtime?.logs();
  } finally {
    try {
      await browsers?.close();
    } catch (error) {
      result.errors.push(`Browser cleanup: ${String(error)}`);
    }
    try {
      await runtime?.cleanup(options.keep);
    } catch (error) {
      result.errors.push(String(error));
    }
    process.off("SIGINT", interrupted);
    process.off("SIGTERM", interrupted);
    for (const page of result.pages)
      if (page.status === "ok" && (page.static === null || page.browsers.length === 0)) {
        page.status = "failed";
        page.errors.push("Not measured: run stopped before this page completed");
      }
    result.metadata.loadAverage.end = oneMinuteLoad();
    resultSchema.parse(result);
    await writeFile(join(out, "result.json"), sortedJson(result));
    await writeFile(join(out, "summary.md"), renderSummary(result, previous));
    console.log(`Result: ${join(out, "result.json")}\nSummary: ${join(out, "summary.md")}`);
  }
  if (controller.signal.aborted || result.errors.length || result.pages.some((page) => page.status === "failed"))
    process.exitCode = controller.signal.aborted ? 130 : 1;
}

if (import.meta.main) {
  try {
    await run();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
