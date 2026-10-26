import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import type { Browser, Page } from "playwright";
import { launchBrowser, pageErrors } from "../../../packages/ui/test/browser";

// A request to pair or remove a device opens like a sign-in: a bottom sheet on a phone, a centered dialog on a
// tablet. This runs the real build and stylesheet and pins that the sheet keeps its size from the first frame
// through going offline and the ending, in light and dark. CLOUD_LOGIN_SHOTS=<dir> also saves each state.

let root: string;
let server: ReturnType<typeof Bun.serve>;
let browser: Browser;
let fixture: string;
const shots = process.env.CLOUD_LOGIN_SHOTS;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "pwa-auth-change-sheet-"));
  // The sheet opens from a script added to the running app, with an invented Cloud and an answer the test releases.
  const entry = resolve(import.meta.dir, "change-sheet.fixture.ts");
  const source = `
    import { createComponent, createSignal } from "solid-js";
    import { bottomSheetAdaptiveOptions } from "@k2b/ui";
    import { ChangeSheet } from "./ChangeSheet";
    import { openDialog } from "./dialog";
    const [online, setOnline] = createSignal(true);
    const now = Date.parse("2026-10-16T12:01:00.000Z");
    const binding = { id: "fixture", label: "Kolb Cloud", name: "Kolb", issuer: "https://cloud.example.test",
      deviceId: "00000000-0000-4000-8000-000000000001", key: {} };
    let release = () => {};
    window.setOnline = setOnline;
    window.release = () => release();
    window.openChange = (kind, self) => {
      const change = {
        changeId: "00000000-0000-4000-8000-000000000101",
        kind,
        device: { id: self ? binding.deviceId : "00000000-0000-4000-8000-000000000102", name: kind === "pair" ? "Jonas' iPad Pro" : "Pixel 8" },
        endSessions: kind === "revoke",
        createdAt: "2026-10-16T12:00:00.000Z",
        expiresAt: "2026-10-16T12:05:00.000Z",
      };
      const auth = {
        bindings: () => [binding],
        states: () => ({ fixture: { requests: [], actions: [], moreChanges: 0, moreActions: 0, changes: [change] } }),
        now: () => now,
        online,
        decideChange: () => new Promise((resolve) => { release = resolve; }),
      };
      void openDialog(
        (close, { requestDismiss }) =>
          createComponent(ChangeSheet, { auth, binding, change, dismiss: requestDismiss, close: () => close() }),
        bottomSheetAdaptiveOptions,
      );
    };
  `;
  // In its own process: this suite resolves the browser condition, which gives Babel its browser build. The same
  // process compiles the fixture with the app's Solid transform.
  const script = resolve(import.meta.dir, "../scripts/build.ts");
  const output = join(root, "change-sheet-fixture.js");
  const built = Bun.spawnSync({
    cmd: [
      process.execPath,
      "--eval",
      `const { build, solid } = await import(${JSON.stringify(script)});
       await build({ development: true, outdir: ${JSON.stringify(root)} });
       const entry = ${JSON.stringify(entry)};
       const bundle = await Bun.build({ entrypoints: [entry], files: { [entry]: process.env.FIXTURE_SOURCE }, target: "browser",
         conditions: ["browser"], format: "iife", plugins: [solid] });
       if (!bundle.success) throw new AggregateError(bundle.logs, "Could not bundle the change sheet fixture.");
       await Bun.write(${JSON.stringify(output)}, await bundle.outputs[0].text());`,
    ],
    env: { ...process.env, FIXTURE_SOURCE: source },
    stdout: "ignore",
    stderr: "pipe",
  });
  if (built.exitCode !== 0) throw new Error(`Could not build Cloud Login:\n${built.stderr.toString()}`);
  fixture = await Bun.file(output).text();
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const pathname = new URL(request.url).pathname;
      const path = resolve(root, `.${pathname === "/" ? "/index.html" : pathname}`);
      const file = Bun.file(path);
      if (relative(root, path).startsWith("..") || !(await file.exists())) return new Response(null, { status: 404 });
      return new Response(file);
    },
  });
  if (shots) await mkdir(shots, { recursive: true });
  browser = await launchBrowser();
}, 120_000);

afterAll(async () => {
  await browser?.close();
  await server?.stop(true);
  if (root) await rm(root, { recursive: true, force: true });
});

const views = [
  { name: "iphone-390", width: 390, height: 844, mobile: true },
  { name: "ipad-1194", width: 1194, height: 834, mobile: true },
  { name: "ipad-834", width: 834, height: 1194, mobile: true },
] as const;

/** The sheet's own box and whether its body has to scroll. */
const measure = (page: Page) =>
  page.evaluate(() => {
    const box = document.querySelector<HTMLElement>("dialog[open]")!.getBoundingClientRect();
    const body = document.querySelector<HTMLElement>("dialog[open] .k2b-panel-dialog__body")!;
    return { top: Math.round(box.top), height: Math.round(box.height), overflow: body.scrollHeight - body.clientHeight };
  });

describe("a device change request in Cloud Login", () => {
  for (const view of views)
    for (const colorScheme of ["light", "dark"] as const)
      test(`keeps its size through offline and its ending, ${view.name} ${colorScheme}`, async () => {
        const context = await browser.newContext({
          viewport: { width: view.width, height: view.height },
          deviceScaleFactor: 2,
          isMobile: view.mobile,
          hasTouch: true,
          colorScheme,
        });
        try {
          for (const [kind, self] of [
            ["pair", false],
            ["revoke", true],
          ] as const) {
            // Each request opens in a fresh app page, as a woken app does.
            const page = await context.newPage();
            const errors = pageErrors(page);
            await page.goto(server.url.href);
            await page.addScriptTag({ content: fixture });
            // Only the first launch in this browser opens the install introduction.
            const intro = page.getByRole("button", { name: "Continue in browser" });
            if (kind === "pair") await intro.click();
            await page.waitForFunction(() => !document.querySelector("dialog"));
            await page.evaluate(
              (input) => (window as unknown as { openChange: (k: string, s: boolean) => void }).openChange(input.kind, input.self),
              { kind, self },
            );
            await page.locator("dialog[open] .auth-change-device").waitFor();
            // Measure the settled sheet: its opening animation moves it, not the content.
            await page.evaluate(async () => {
              await document.fonts.ready;
              await Promise.all(
                document
                  .getAnimations()
                  .filter((animation) => animation.timeline === document.timeline)
                  .map((animation) => animation.finished.catch(() => {})),
              );
            });
            const shot = async (state: string) => {
              if (shots) await page.screenshot({ path: join(shots, `${kind}-${state}-${view.name}-${colorScheme}.png`) });
            };
            const first = await measure(page);
            expect(first.overflow, `${kind} request scrolls`).toBeLessThanOrEqual(0);
            await shot("request");
            await page.evaluate(() => (window as unknown as { setOnline: (value: boolean) => void }).setOnline(false));
            await page.locator("dialog[open] .auth-change-note[data-offline]").waitFor();
            expect(await measure(page), `${kind} offline`).toEqual(first);
            await shot("offline");
            await page.evaluate(() => (window as unknown as { setOnline: (value: boolean) => void }).setOnline(true));
            // Choices arm half a second after opening.
            await page.waitForTimeout(550);
            const approve = page.locator("dialog[open] .auth-decision-actions__choices button").last();
            const before = await approve.boundingBox();
            await approve.click();
            expect(await approve.boundingBox(), `${kind} sending keeps the button`).toEqual(before);
            expect(await measure(page), `${kind} sending`).toEqual(first);
            await shot("sending");
            await page.evaluate(() => (window as unknown as { release: () => void }).release());
            await page.locator("dialog[open] .auth-decision[data-ended]").waitFor();
            expect(await measure(page), `${kind} ending`).toEqual(first);
            await shot("approved");
            await page.locator("dialog[open] .auth-decision-actions__done button").click();
            await page.waitForFunction(() => !document.querySelector("dialog[open]"));
            expect(errors).toEqual([]);
            await page.close();
          }
        } finally {
          await context.close();
        }
      }, 90_000);
});
