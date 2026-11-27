import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, readdir, rmdir, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describeV2Page, measureV2Layout } from "@k2b/ui/v2/testing";
import { launchBrowser, pageErrors, settled } from "../../../ui/test/browser";

// The v2 measurement on the real public page (production build and server). Only the measurement's network is a
// fixture inside the page: sessions, pings, a download stream and an upload, so a run is the same in every engine and
// takes no real seconds (the page clock runs it).
const root = resolve(import.meta.dir, "../../../..");
let outdir = "";
let origin = "";
let server: Bun.Subprocess<"ignore", "pipe", "pipe"> | undefined;
let browser: Awaited<ReturnType<typeof launchBrowser>>;

const removeBuild = async (directory: string): Promise<void> => {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await removeBuild(path);
    else await unlink(path);
  }
  await rmdir(directory);
};

beforeAll(async () => {
  outdir = await mkdtemp(join(tmpdir(), "speedtest-pane-"));
  const build = Bun.spawn(["bun", "packages/speedtest/scripts/build.ts", "--outdir", outdir], {
    cwd: root,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, stderr] = await Promise.all([build.exited, new Response(build.stderr).text()]);
  if (code !== 0) throw new Error(`Production build failed: ${stderr}`);
  const reservation = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  const port = reservation.port!;
  await reservation.stop(true);
  origin = `http://127.0.0.1:${port}`;
  server = Bun.spawn(["bun", join(outdir, "server.js")], {
    cwd: outdir,
    env: { ...Bun.env, SPEEDTEST_HOST: "127.0.0.1", SPEEDTEST_PORT: String(port), SPEEDTEST_PUBLIC_URL: origin, SPEEDTEST_UDP_PORT: "" },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const reader = server.stdout.getReader();
  const ready = await reader.read();
  reader.releaseLock();
  if (!new TextDecoder().decode(ready.value).includes("Speedtest HTTP listening")) throw new Error("Speedtest server did not start");
  browser = await launchBrowser();
}, 90_000);

afterAll(async () => {
  await browser?.close();
  server?.kill();
  await server?.exited;
  if (outdir) await removeBuild(outdir);
});

/** The measurement's endpoints inside the page; `error` lets the first ping fail as an unreachable server does. */
const network = (scenario: "run" | "error") => {
  const chunk = new Uint8Array(256 * 1024);
  const aborted = () => new DOMException("Aborted", "AbortError");
  const nativeFetch = globalThis.fetch;
  const fixtureFetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input), location.href);
    if (url.origin !== location.origin || url.pathname === "/" || url.pathname.startsWith("/_") || url.pathname.startsWith("/assets"))
      return nativeFetch(input, init);
    if (url.pathname === "/session" && init?.method === "POST")
      return Response.json({ token: "00000000-0000-4000-8000-000000000001" }, { status: 201 });
    if (url.pathname === "/session") return Response.json({ limited: false });
    if (url.pathname === "/session/end") return new Response(null, { status: 204 });
    if (url.pathname.endsWith("/ping")) {
      if (scenario === "error") throw new TypeError("Fixture offline server");
      await new Promise((resolve) => setTimeout(resolve, 12));
      return new Response(null, { status: 204 });
    }
    let sent = 0;
    return new Response(
      new ReadableStream({
        async pull(controller) {
          await new Promise((resolve) => setTimeout(resolve, 25));
          if (init?.signal?.aborted) return controller.error(aborted());
          if (sent >= 25 * 1024 * 1024) return controller.close();
          controller.enqueue(chunk);
          sent += chunk.byteLength;
        },
      }),
    );
  };
  Object.defineProperty(globalThis, "fetch", { value: fixtureFetch });
  class FixtureXhr {
    upload: { onprogress: ((event: { loaded: number }) => void) | null } = { onprogress: null };
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    onabort: (() => void) | null = null;
    withCredentials = false;
    status = 200;
    timer: ReturnType<typeof setInterval> | undefined;
    open() {}
    setRequestHeader() {}
    getResponseHeader() {
      return null;
    }
    send() {
      let loaded = 0;
      this.timer = setInterval(() => {
        loaded += 128 * 1024;
        this.upload.onprogress?.({ loaded });
        if (loaded >= 16 * 1024 * 1024) {
          clearInterval(this.timer);
          this.onload?.();
        }
      }, 25);
    }
    abort() {
      clearInterval(this.timer);
      this.onabort?.();
    }
  }
  Object.defineProperty(globalThis, "XMLHttpRequest", { value: FixtureXhr });
};

const open = async (scenario: "run" | "error", width: number) => {
  const page = await browser.newPage({ viewport: { width, height: width < 600 ? 844 : 900 }, reducedMotion: "reduce" });
  await page.clock.install({ time: new Date("2026-11-27T12:00:00Z") });
  await page.addInitScript(network, scenario);
  await page.goto(`${origin}/de`);
  await page.locator('[data-k2-part="Workspace"]').waitFor();
  return page;
};

/** Where the parts of the measurement stand: none of them may move while a test runs or ends. */
const geometry = async (page: Awaited<ReturnType<typeof open>>) => {
  await settled(page);
  return page.evaluate(() =>
    ['[data-k2-part="Cells"]', '[data-k2-part="Progress"] .k2-progress-track', '[data-k2-part="Canvas"]', '[data-k2-part="Section"]'].map(
      (selector) => {
        const rect = document.querySelector(selector)!.getBoundingClientRect();
        return { selector, x: rect.x + scrollX, y: rect.y + scrollY, width: rect.width, height: rect.height };
      },
    ),
  );
};

for (const width of [1440, 390])
  test(`a run goes from start through the measurement to its result without moving a part at ${width}px`, async () => {
    const page = await open("run", width);
    try {
      const errors = pageErrors(page);
      const initial = await geometry(page);
      await page.getByRole("button", { name: "Test starten", exact: true }).click();
      await page.clock.runFor(1_000);
      await page.getByRole("button", { name: "Stoppen", exact: true }).waitFor();
      expect(await geometry(page)).toEqual(initial);
      await page.clock.runFor(15_000);
      await page.getByRole("button", { name: "Erneut testen", exact: true }).waitFor();
      expect(await geometry(page)).toEqual(initial);
      // the four results stand in the strip, each with its unit
      const values = await page.locator('[data-k2-part="Cells.Cell"]').allTextContents();
      expect(values.join(" | ")).toMatch(/Download.*\d.*Mbit\/s.*Upload.*\d.*Mbit\/s.*Ping.*\d.*ms/);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      const layout = await measureV2Layout(page);
      const outline = await describeV2Page(page);
      expect({ errors, layout: layout.problems, problems: outline.includes("Problems") ? outline : null }).toEqual({
        errors: [],
        layout: [],
        problems: null,
      });
    } finally {
      await page.close();
    }
  }, 60_000);

for (const width of [1440, 390])
  test(`an unreachable server ends the run with its reason and the way to try again at ${width}px`, async () => {
    const page = await open("error", width);
    try {
      const initial = await geometry(page);
      await page.getByRole("button", { name: "Test starten", exact: true }).click();
      await page.clock.runFor(2_000);
      await page.getByRole("button", { name: "Erneut testen", exact: true }).waitFor();
      // the failure stands as a notice in the tone of wrong at the top; the parts below keep their place
      await page.locator('[data-k2-part="Notice"][role="alert"]').waitFor();
      const after = await geometry(page);
      const shift = after[0]!.y - initial[0]!.y;
      expect(after.map((part) => ({ ...part, y: part.y - shift }))).toEqual(initial);
    } finally {
      await page.close();
    }
  }, 60_000);
