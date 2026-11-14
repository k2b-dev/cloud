import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rmdir, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Browser } from "playwright";
import { browserName, launchBrowser } from "../../../ui/test/browser";

const partSize = 1024 * 1024;
let browser: Browser;
let temporary = "";
let httpUrl = "",
  httpsUrl = "";
let link: ReturnType<typeof Bun.spawn> | undefined;
beforeAll(async () => {
  if (browserName !== "chromium") return;
  const fixture = await Bun.build({
    entrypoints: [new URL("../../test/upload-link.ts", import.meta.url).pathname],
    target: "node",
    format: "esm",
  });
  if (!fixture.success) throw new AggregateError(fixture.logs, "Link fixture build");
  const built = await Bun.build({
    entrypoints: [new URL("./upload-pacing.browser-harness.ts", import.meta.url).pathname],
    target: "browser",
    format: "esm",
  });
  if (!built.success) throw new AggregateError(built.logs, "Pacing harness build");
  temporary = await mkdtemp(join(tmpdir(), "files-pacing-tls-"));
  const cert = join(temporary, "localhost.crt"),
    key = join(temporary, "localhost.key"),
    harness = join(temporary, "harness.js");
  await Bun.write(harness, await built.outputs[0]!.text());
  const linkScript = join(temporary, "link.mjs");
  await Bun.write(linkScript, await fixture.outputs[0]!.text());
  const generated = Bun.spawn(
    ["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", cert, "-days", "1", "-subj", "/CN=localhost"],
    { stdout: "ignore", stderr: "ignore" },
  );
  if ((await generated.exited) !== 0) throw new Error("Local test TLS certificate generation failed");
  const child = Bun.spawn(["node", linkScript, cert, key, harness], { stdout: "pipe", stderr: "inherit" });
  link = child;
  const reader = child.stdout.getReader();
  const decoder = new TextDecoder();
  let line = "";
  try {
    while (!line.includes("\n")) {
      const item = await reader.read();
      if (item.done) throw new Error("Shaping server exited before readiness");
      line += decoder.decode(item.value, { stream: true });
    }
  } finally {
    reader.releaseLock();
  }
  const urls = JSON.parse(line.split("\n")[0]!);
  httpUrl = urls.http;
  httpsUrl = urls.https;
  browser = await launchBrowser();
}, 30_000);
afterAll(async () => {
  await browser?.close();
  if (link) {
    link.kill("SIGTERM");
    await link.exited;
  }
  if (temporary) {
    await Promise.all(["localhost.key", "localhost.crt", "harness.js", "link.mjs"].map((name) => unlink(join(temporary, name))));
    await rmdir(temporary);
  }
});

// WebKit follows the nonstreaming path covered by the transport unit tests.
test.skipIf(browserName !== "chromium")(
  "paced PUTs preserve a 300 ms interactive p95 budget behind a deep shared FIFO",
  async () => {
    const page = await browser.newPage({ ignoreHTTPSErrors: true });
    try {
      await page.goto(httpsUrl);
      await page.waitForFunction(() => "createPacedUploadRequest" in window);
      const result = await page.evaluate(async () => {
        const factory = Reflect.get(window, "createPacedUploadRequest");
        const request: typeof fetch = factory();
        const body = new Blob([new Uint8Array(1024 * 1024)]);
        await request("/ping"); // Reuse existing control RTT, never add product probes.
        const samples: { baseline: boolean; ms: number }[] = [];
        let done = false,
          baseline = true;
        const probes = (async () => {
          while (!done) {
            const phase = baseline,
              start = performance.now();
            await fetch("/ping", { cache: "no-store" });
            samples.push({ baseline: phase, ms: performance.now() - start });
            await new Promise((resolve) => setTimeout(resolve, 100));
          }
        })();
        const durations: number[] = [];
        for (let part = 0; part < 3; part++) {
          baseline = part === 0;
          const start = performance.now();
          const response = await request("/upload", { method: "PUT", body });
          if (!response.ok || (await response.json()).bytes !== body.size) throw new Error("Incomplete upload");
          durations.push(performance.now() - start);
        }
        done = true;
        await probes;
        const percentile = (values: number[]) => values.sort((a, b) => a - b)[Math.ceil(values.length * 0.95) - 1]!;
        return {
          durations,
          baselineP95: percentile(samples.filter((s) => s.baseline).map((s) => s.ms)),
          pacedP95: percentile(samples.filter((s) => !s.baseline).map((s) => s.ms)),
        };
      });
      console.log("Shared FIFO pacing:", JSON.stringify(result));
      const metrics = await (await fetch(`${httpUrl}/metrics`)).json();
      expect(metrics.maximum).toBeGreaterThan(500_000 * 0.9);
      expect(result.baselineP95).toBeGreaterThan(1500);
      expect(result.pacedP95).toBeLessThan(300);
      expect(result.durations[1]).toBeLessThan(result.durations[0]! * 1.5);
      expect(result.durations[2]).toBeLessThan(result.durations[1]! * 1.15);
    } finally {
      await page.close();
    }
  },
  45_000,
);

test.skipIf(browserName !== "chromium")(
  "HTTP/1.1 falls back within SDK retries and acknowledged parts resume without replay",
  async () => {
    const page = await browser.newPage();
    await fetch(`${httpUrl}/reset`);
    try {
      await page.goto(httpUrl);
      await page.waitForFunction(() => "DirectSession" in window);
      const result = await page.evaluate(async () => {
        const factory = Reflect.get(window, "createPacedUploadRequest"),
          Session = Reflect.get(window, "DirectSession");
        const request: typeof fetch = factory();
        let attempts = 0;
        const counted = Object.assign(
          async (input: RequestInfo | URL, init?: RequestInit) => {
            if (init?.method === "PUT") attempts++;
            return request(input, init);
          },
          { preconnect: fetch.preconnect },
        );
        const session = new Session(new URL("/lease", location.href).href, counted);
        const file = new Blob([new Uint8Array(2 * 1024 * 1024)]);
        await session.upload(file);
        const after = attempts;
        await new Session(new URL("/lease", location.href).href, factory()).upload(file);
        return { attempts, after };
      });
      expect(result.attempts).toBe(3); // First Blob, rejected stream, existing SDK Blob retry.
      expect(result.after).toBe(3);
      const metrics = await (await fetch(`${httpUrl}/metrics`)).json();
      expect(metrics.puts).toEqual([0, 1]); // No second upload of either acknowledged receipt.
      expect(metrics.receipts.map((part: { size: number }) => part.size)).toEqual([partSize, partSize]);
    } finally {
      await page.close();
    }
  },
  30_000,
);
