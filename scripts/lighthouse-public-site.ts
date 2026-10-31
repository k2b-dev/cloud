/**
 * Lighthouse check of the public-site example through the gateway's app-domain path.
 *
 *   bun scripts/lighthouse-public-site.ts [--port <n>] [--out <dir>]
 *
 * Uses the integration test infrastructure (CLOUD_TEST_DATABASE_URL, CLOUD_TEST_VALKEY_URL, CLOUD_TEST_NATS_SERVERS
 * and CLOUD_TEST_NATS_CREDS_FILE when needed): the gateway path starts like the gateway process, and its telemetry
 * publishes through Sync in its own test namespace, deleted afterwards.
 * Fails below SEO 100 or mobile performance 95 for any page.
 */
import { mkdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { deleteTestNamespace, testNamespacePrefix } from "./fixtures/test-sync";

const LIGHTHOUSE = "lighthouse@13.6.0";
const TARGETS = { seo: 100, performance: 95 } as const;
const PAGES = ["/", "/de/"] as const;

const args = Bun.argv.slice(2);
if (args.includes("--help") || args.includes("-h")) {
  console.log(`usage: bun scripts/lighthouse-public-site.ts [--port <n>] [--out <dir>]

Builds packages/cloud/examples/public-site in production mode, serves it through the gateway
request handler as http://public-site.localhost:<port>/, and runs ${LIGHTHOUSE} (mobile, simulated
throttling, Playwright Chromium) on ${PAGES.join(" and ")}. Prints SEO and performance scores and
exits 1 below SEO ${TARGETS.seo} or performance ${TARGETS.performance}.

  --port <n>   gateway port for the measurement server (default 3180)
  --out <dir>  directory for the bundle and Lighthouse JSON reports (default .local/lighthouse-public-site)

Requires CLOUD_TEST_DATABASE_URL, CLOUD_TEST_VALKEY_URL, CLOUD_TEST_NATS_SERVERS and, if needed,
CLOUD_TEST_NATS_CREDS_FILE (see docs-site/docs/en/contributing/testing.md).`);
  process.exit(0);
}
const option = (name: string, fallback: string) => {
  const index = args.indexOf(name);
  return index === -1 ? fallback : (args[index + 1] ?? fallback);
};
const root = resolve(import.meta.dir, "..");
const port = option("--port", "3180");
const out = resolve(option("--out", join(root, ".local/lighthouse-public-site")));
const { CLOUD_TEST_DATABASE_URL: database, CLOUD_TEST_VALKEY_URL: valkey, CLOUD_TEST_NATS_SERVERS: servers } = Bun.env;
if (!database || !valkey || !servers)
  throw new Error(
    "Set CLOUD_TEST_DATABASE_URL, CLOUD_TEST_VALKEY_URL and CLOUD_TEST_NATS_SERVERS; see docs-site/docs/en/contributing/testing.md",
  );

const run = async (cmd: string[], env: Record<string, string | undefined> = {}, cwd = root) => {
  const child = Bun.spawn(cmd, { cwd, env: { ...Bun.env, ...env }, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  if (code !== 0) throw new Error(`${cmd.join(" ")} exited ${code}\n${stderr || stdout}`);
  return stdout;
};

await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });
// The app's SSR plugin discovers islands from the app directory, as in its own production build.
await run(
  [process.execPath, "--no-env-file", join(root, "scripts/fixtures/lighthouse-public-site.build.ts"), out],
  { NODE_ENV: "production" },
  join(root, "packages/cloud/examples/public-site"),
);

// The browser tests' pinned Playwright Chromium, resolved from the package that depends on Playwright.
const chrome = (
  await run(
    [process.execPath, "--no-env-file", "-e", 'console.log((await import("playwright")).chromium.executablePath())'],
    {},
    join(root, "packages/cloud"),
  )
).trim();
const namespace = `${testNamespacePrefix}lighthouse-${crypto.randomUUID().slice(0, 8)}`;
const server = Bun.spawn([process.execPath, "--no-env-file", join(out, "server.js")], {
  cwd: out,
  env: {
    ...Bun.env,
    NODE_ENV: "production",
    // The gateway path starts like the gateway process; the clients connect only when used.
    DATABASE_URL: database,
    REDIS_URL: valkey,
    APP_SECRET: crypto.randomUUID().replaceAll("-", "").repeat(2),
    NATS_SERVERS: servers,
    NATS_CREDS_FILE: Bun.env.CLOUD_TEST_NATS_CREDS_FILE,
    SYNC_NAMESPACE: namespace,
    PUBLIC_SITE_PORT: port,
  },
  stdout: "pipe",
  stderr: "inherit",
});

type Report = {
  categories: Record<"seo" | "performance", { score: number | null; auditRefs: { id: string; weight: number }[] }>;
  audits: Record<string, { score: number | null; title: string; displayValue?: string }>;
};
let failed = false;
try {
  const reader = server.stdout.getReader();
  let output = "";
  while (!output.includes("ready ")) {
    const { value, done } = await reader.read();
    if (done) throw new Error(`measurement server exited before it was ready:\n${output}`);
    output += new TextDecoder().decode(value);
  }
  reader.releaseLock();
  const origin = output.match(/ready (http:\/\/\S+?)\/\s/)?.[1];
  if (!origin) throw new Error(`unexpected server output: ${output}`);

  for (const page of PAGES) {
    const file = join(out, `lighthouse-${page === "/" ? "en" : page.replaceAll("/", "")}.json`);
    await run(
      [
        process.execPath,
        "x",
        LIGHTHOUSE,
        `${origin}${page}`,
        "--only-categories=seo,performance",
        "--form-factor=mobile",
        "--output=json",
        `--output-path=${file}`,
        "--quiet",
        "--chrome-flags=--headless=new",
      ],
      { CHROME_PATH: chrome },
    );
    const report = (await Bun.file(file).json()) as Report;
    const seo = Math.round((report.categories.seo.score ?? 0) * 100);
    const performance = Math.round((report.categories.performance.score ?? 0) * 100);
    const metrics = ["first-contentful-paint", "largest-contentful-paint", "total-blocking-time", "cumulative-layout-shift", "speed-index"]
      .map((id) => `${report.audits[id]?.title}: ${report.audits[id]?.displayValue ?? "n/a"}`)
      .join(", ");
    console.log(`${page}  SEO ${seo}  performance ${performance}  (${metrics})`);
    for (const { id } of report.categories.seo.auditRefs) {
      const audit = report.audits[id];
      if (audit && audit.score !== null && audit.score < 1) console.log(`  SEO audit not passed: ${id} (${audit.title})`);
    }
    if (seo < TARGETS.seo || performance < TARGETS.performance) failed = true;
  }
} finally {
  server.kill("SIGTERM");
  await server.exited;
  await deleteTestNamespace(namespace);
}
if (failed) {
  console.error(`Below target: SEO ${TARGETS.seo} and mobile performance ${TARGETS.performance} are required.`);
  process.exit(1);
}
