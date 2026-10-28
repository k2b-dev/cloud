import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import type { Browser, Page } from "playwright";
import { launchBrowser, settled } from "../../../../ui/test/browser";
import type { KioskSnapshot } from "../src/model";
import { fixtureSnapshot } from "./fixtures";

let browser: Browser;
let server: ReturnType<typeof Bun.serve>;
let bundle: string;
const entry = resolve(import.meta.dir, "Kiosk.browser-harness.tsx");
beforeAll(async () => {
  const ui = resolve(import.meta.dir, "../../../../ui");
  const { transformAsync } = await import(Bun.resolveSync("@babel/core", ui));
  const typescript = (await import(Bun.resolveSync("@babel/preset-typescript", ui))).default;
  const solid = (await import(Bun.resolveSync("babel-preset-solid", ui))).default;
  const build = await Bun.build({
    entrypoints: [entry],
    target: "browser",
    format: "esm",
    conditions: ["browser"],
    plugins: [
      {
        name: "app-pwa-example-browser",
        setup(builder) {
          // Synthetic decode callback; no actual barcode/camera hardware claim.
          builder.onResolve({ filter: /^qr-scanner$/ }, () => ({ path: resolve(import.meta.dir, "scanner-engine.fixture.ts") }));
          builder.onLoad({ filter: /\.tsx$/ }, async ({ path }) => {
            const result = await transformAsync(await Bun.file(path).text(), {
              filename: path,
              babelrc: false,
              configFile: false,
              presets: [typescript, [solid, { generate: "dom", hydratable: false }]],
            });
            if (!result?.code) throw new Error("Empty browser build");
            return { contents: result.code, loader: "js" };
          });
        },
      },
    ],
  });
  if (!build.success || !build.outputs[0]) throw new AggregateError(build.logs, "Example build failed");
  bundle = await build.outputs[0].text();
  // Cloud pages link the app stylesheet before Core's global stylesheet, which carries the Tailwind reset and @k2b/ui.
  const tailwind = (await import(Bun.resolveSync("bun-plugin-tailwind", resolve(ui, "../cloud")))).default;
  const global = await Bun.build({ entrypoints: [resolve(ui, "../../styles.css")], plugins: [tailwind] });
  if (!global.success || !global.outputs[0]) throw new AggregateError(global.logs, "Global stylesheet build failed");
  const globalCss = await global.outputs[0].text();
  const fonts = await Bun.file(resolve(ui, "dist/plex.css")).text();
  const icons = await Bun.file(resolve(ui, "dist/tabler.css")).text();
  const style = await Bun.file(resolve(import.meta.dir, "../src/style.css")).text();
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/away")
        return new Response("<!doctype html><title>Andere Seite</title><p>Andere Seite</p>", {
          headers: { "Content-Type": "text/html" },
        });
      if (url.pathname === "/bundle.js") return new Response(bundle, { headers: { "Content-Type": "text/javascript" } });
      if (url.pathname === "/style.css")
        return new Response(fonts + icons + style + globalCss, { headers: { "Content-Type": "text/css" } });
      if (/^\/(fonts\/[a-z0-9-]+|tabler-icons-[a-z0-9]+)\.woff2$/.test(url.pathname))
        return new Response(Bun.file(resolve(ui, "dist", url.pathname.slice(1))));
      const initial = fixtureSnapshot();
      if (url.searchParams.has("neutral")) initial.visit = null;
      if (url.searchParams.has("unpaired")) {
        initial.visit = null;
        initial.device = null;
      }
      if (url.searchParams.has("empty") && initial.visit) initial.visit.documents = [];
      return new Response(
        `<!doctype html><html lang="de" ${url.searchParams.has("dark") ? 'class="dark"' : ""}><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/style.css"></head><body class="k2b-ui"><div id="root"></div><script id="fixture" type="application/json">${JSON.stringify(initial)}</script><script type="module" src="/bundle.js"></script></body></html>`,
        { headers: { "Content-Type": "text/html" } },
      );
    },
  });
  browser = await launchBrowser();
}, 30_000);
afterAll(async () => {
  await browser?.close();
  await server?.stop(true);
});

const seedPage = async (page: Page) =>
  page.addInitScript(() => {
    let sequence = 1;
    Object.defineProperty(crypto, "randomUUID", { value: () => `20000000-0000-4000-8000-${String(sequence++).padStart(12, "0")}` });
  });
const setup = async (width: number, query = "") => {
  const page = await browser.newPage({ viewport: { width, height: 1024 }, hasTouch: true, reducedMotion: "reduce" });
  await page.clock.install({ time: new Date("2026-10-23T10:00:00Z") });
  await seedPage(page);
  const state: {
    snapshot: KioskSnapshot;
    failure: number;
    lost: boolean;
    endFailed: boolean;
    signs: number;
    scans: number;
    completed: boolean;
    attempts: Set<string>;
  } = {
    snapshot: fixtureSnapshot(),
    failure: 0,
    lost: false,
    endFailed: false,
    signs: 0,
    scans: 0,
    completed: false,
    attempts: new Set(),
  };
  if (query.includes("neutral") || query.includes("unpaired")) state.snapshot.visit = null;
  if (query.includes("unpaired")) state.snapshot.device = null;
  await page.route("**/fixture/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("/scan")) {
      state.scans++;
      state.snapshot = fixtureSnapshot();
      return route.fulfill({ json: { ok: true } });
    }
    if (path.endsWith("/snapshot")) return route.fulfill({ status: state.failure || 200, json: state.snapshot });
    if (path.endsWith("/sign")) {
      state.signs++;
      if (state.failure) return route.fulfill({ status: state.failure });
      const input = JSON.parse(route.request().postData() ?? "{}");
      state.attempts.add(input.attempt);
      const document = state.snapshot.visit?.documents.find((item) => item.id === input.input.documentId);
      if (document) document.signed = true;
      if (query.includes("atomic") && input.input.documentId === "receipt") {
        state.completed = true;
        state.snapshot.visit = null;
      }
      if (state.lost) return route.abort("failed");
      return route.fulfill({ json: query.includes("atomic") ? { completed: state.completed } : { ok: true } });
    }
    if (path.includes("/attempt/"))
      return route.fulfill({
        body: state.attempts.has(path.split("/").at(-1) ?? "") ? (state.completed ? "completed" : "committed") : "absent",
      });
    if (path.endsWith("/end")) {
      state.snapshot.visit = null;
      if (state.endFailed) return route.abort("failed");
      return route.fulfill({ json: { ok: true } });
    }
    return route.fulfill({ json: { ok: true } });
  });
  await page.goto(`${server.url}?${query}`);
  await page.locator(".kiosk").waitFor();
  return { page, state };
};
const sign = async (page: Page, receipt = false) => {
  await page.getByRole("radio", { name: "Tippen", exact: true }).click();
  await page.getByRole("textbox").fill("Lea Muster");
  await page.getByRole("checkbox").check();
  await page.getByRole("button", { name: receipt ? "Empfang unterschreiben" : "Vertrag unterschreiben", exact: true }).click();
};
const heading = (page: Page, name: string) => page.getByRole("heading", { name, exact: true }).waitFor();

for (const width of [390, 768])
  describe(`Laden-iPad at ${width}px`, () => {
    test("signs both offered revisions and ends without resurrecting customer data", async () => {
      const { page, state } = await setup(width);
      try {
        await sign(page);
        await heading(page, "Auszahlung bestätigen");
        await sign(page, true);
        await heading(page, "Alles unterschrieben.");
        expect(state.signs).toBe(2);
        await page.getByRole("button", { name: "Sitzung beenden", exact: true }).click();
        await heading(page, "Die Sitzung ist beendet.");
        expect(await page.locator("body").innerText()).not.toContain("Lea Muster");
        await page.getByRole("button", { name: "Zum Scanner", exact: true }).click();
        await page.getByRole("heading", { name: /Ihr Vorgang/ }).waitFor();
        expect(await page.getByRole("textbox").count()).toBe(0);
      } finally {
        await page.close();
      }
    });
    test("reconciles a committed response loss without signing again", async () => {
      const { page, state } = await setup(width);
      try {
        state.lost = true;
        await sign(page);
        await heading(page, "Ist die Unterschrift angekommen?");
        expect(await page.locator("body").innerText()).not.toContain("Lea Muster");
        await page.getByRole("button", { name: "Speicherstatus prüfen", exact: true }).click();
        await heading(page, "Auszahlung bestätigen");
        expect(state.signs).toBe(1);
      } finally {
        await page.close();
      }
    });
    test("resets ink on revision conflict and does not carry it into a new revision", async () => {
      const { page, state } = await setup(width);
      try {
        state.failure = 409;
        await sign(page);
        await heading(page, "Das Dokument wurde geändert.");
        state.failure = 0;
        if (state.snapshot.visit?.documents[0]) state.snapshot.visit.documents[0].revision = 2;
        await page.getByRole("button", { name: "Neue Fassung lesen", exact: true }).click();
        await heading(page, "Ankaufsvertrag lesen");
        expect(await page.getByRole("button", { name: "Vertrag unterschreiben", exact: true }).isDisabled()).toBe(true);
        expect(await page.locator("body").innerText()).toContain("Fassung 2");
      } finally {
        await page.close();
      }
    });
    test("conceals offline and pagehide, then revalidates on return", async () => {
      const { page, state } = await setup(width);
      try {
        await page.evaluate(() => window.dispatchEvent(new Event("offline")));
        await heading(page, "Verbindung unterbrochen.");
        expect(await page.locator("body").innerText()).not.toContain("Lea Muster");
        await page.getByRole("button", { name: "Verbindung erneut prüfen", exact: true }).click();
        await heading(page, "Ankaufsvertrag lesen");
        await page.evaluate(() => window.dispatchEvent(new Event("pagehide")));
        expect(await page.locator("body").innerText()).not.toContain("Lea Muster");
        state.failure = 410;
        await page.evaluate(() => window.dispatchEvent(new Event("pageshow")));
        await heading(page, "Die Sitzung ist abgelaufen.");
        expect(await page.locator("body").innerText()).not.toContain("Lea Muster");
      } finally {
        await page.close();
      }
    });
    test("does not confirm a failed end and supports authoritative retry", async () => {
      const { page, state } = await setup(width);
      try {
        state.endFailed = true;
        await page.getByRole("button", { name: "Sitzung beenden", exact: true }).click();
        await heading(page, "Beenden wird geprüft.");
        expect(await page.locator("body").innerText()).not.toContain("Lea Muster");
        state.endFailed = false;
        await page.getByRole("button", { name: "Status erneut prüfen", exact: true }).click();
        await heading(page, "Die Sitzung ist beendet.");
      } finally {
        await page.close();
      }
    });
    test("fits light and dark without horizontal overflow", async () => {
      for (const dark of [false, true]) {
        const { page } = await setup(width, dark ? "dark=1" : "");
        try {
          const size = await page.evaluate(() => ({
            viewport: innerWidth,
            content: document.documentElement.scrollWidth,
            button: document.querySelector(".kiosk-full")?.getBoundingClientRect().height,
          }));
          expect(size.content).toBeLessThanOrEqual(size.viewport);
          expect(size.button).toBeGreaterThanOrEqual(44);
        } finally {
          await page.close();
        }
      }
    });
  });

for (const width of [390, 768])
  describe(`Additional recovery at ${width}px`, () => {
    test("a lost final completion recovers neutrally without requesting private documents again", async () => {
      const { page, state } = await setup(width, "atomic=1");
      try {
        await sign(page);
        await heading(page, "Auszahlung bestätigen");
        state.lost = true;
        await sign(page, true);
        await heading(page, "Ist die Unterschrift angekommen?");
        await page.getByRole("button", { name: "Speicherstatus prüfen", exact: true }).click();
        await heading(page, "Alles unterschrieben.");
        expect(await page.locator("body").innerText()).not.toContain("Lea Muster");
        expect(state.signs).toBe(2);
        await page.getByRole("button", { name: "Sitzung beenden", exact: true }).click();
        await heading(page, "Die Sitzung ist beendet.");
      } finally {
        await page.close();
      }
    });
    test("camera denial stays neutral and offers a scanner retry", async () => {
      const { page } = await setup(width, "unpaired=1&dark=1");
      try {
        await page.evaluate(() =>
          Object.defineProperty(navigator, "mediaDevices", {
            configurable: true,
            value: {
              getUserMedia: async () => {
                throw new DOMException("Denied", "NotAllowedError");
              },
            },
          }),
        );
        await page.getByRole("button", { name: "QR scannen", exact: true }).click();
        await page.getByText("Der Kamerazugriff ist aus.", { exact: false }).waitFor();
        expect(await page.getByRole("button", { name: "Erneut versuchen", exact: true }).isVisible()).toBe(true);
        expect(await page.getByRole("textbox").count()).toBe(0);
      } finally {
        await page.close();
      }
    });
    test("shared scanner rejects foreign QR then accepts the target app through its decode callback", async () => {
      const { page, state } = await setup(width, "unpaired=1");
      try {
        await page.evaluate(() =>
          Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: { getUserMedia: async () => new MediaStream() } }),
        );
        await page.getByRole("button", { name: "QR scannen", exact: true }).click();
        await page.getByText("Scannen Sie den QR vom Mitarbeiterbildschirm.", { exact: true }).waitFor();
        await page.evaluate(() => window.dispatchEvent(new CustomEvent("fixture:decoded-qr", { detail: "https://evil.example/#token" })));
        expect(state.scans).toBe(0);
        expect(await page.locator(".k2b-qr-scanner").count()).toBe(1);
        await page.evaluate(() =>
          window.dispatchEvent(
            new CustomEvent("fixture:decoded-qr", {
              detail: `https://cloud.example.test/app/visit-demo/counter/#cloud-app-pwa:device:${"A".repeat(43)}`,
            }),
          ),
        );
        await heading(page, "Ankaufsvertrag lesen");
        expect(state.scans).toBe(1);
        expect(await page.locator(".k2b-qr-scanner").count()).toBe(0);
        expect(await page.getByRole("textbox").count()).toBe(0);
      } finally {
        await page.close();
      }
    });
    test("opening the scanner invalidates a pending passive poll", async () => {
      const { page } = await setup(width, "neutral=1");
      const held = Promise.withResolvers<void>();
      const entered = Promise.withResolvers<void>();
      const delivered = Promise.withResolvers<void>();
      try {
        await page.evaluate(() =>
          Object.defineProperty(navigator, "mediaDevices", {
            configurable: true,
            value: { getUserMedia: async () => new MediaStream() },
          }),
        );
        await page.route("**/fixture/snapshot", async (route) => {
          entered.resolve();
          await held.promise;
          await route.fulfill({ json: fixtureSnapshot() }).catch(() => {});
          delivered.resolve();
        });
        await page.clock.runFor(2_000);
        await entered.promise;
        await page.getByRole("button", { name: "QR scannen", exact: true }).click();
        await page.locator(".k2b-qr-scanner").waitFor();
        held.resolve();
        await delivered.promise;
        await settled(page);
        expect(await page.locator(".k2b-qr-scanner").count()).toBe(1);
        expect(await page.locator("body").innerText()).not.toContain("Lea Muster");
      } finally {
        held.resolve();
        await page.close();
      }
    });
    test("stale read after pagehide cannot reveal old customer data; simulated BFCache return reads a fresh customer", async () => {
      const { page, state } = await setup(width);
      let release: (() => void) | undefined;
      try {
        const pending = new Promise<void>((resolve) => {
          release = resolve;
        });
        let observed: (() => void) | undefined;
        const intercepted = new Promise<void>((resolve) => {
          observed = resolve;
        });
        await page.route("**/fixture/snapshot", async (route) => {
          observed?.();
          await pending;
          await route.fulfill({ json: fixtureSnapshot() }).catch(() => {});
        });
        await page.clock.runFor(2_000);
        await intercepted;
        await page.evaluate(() => window.dispatchEvent(new Event("pagehide")));
        release?.();
        expect(await page.locator("body").innerText()).not.toContain("Lea Muster");
        await page.unroute("**/fixture/snapshot");
        // The fresh customer's documents name only that customer.
        state.snapshot = fixtureSnapshot("Neuer Beispielkunde");
        if (state.snapshot.visit) state.snapshot.visit.id = "10000000-0000-4000-8000-000000000002";
        await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true })));
        await page.getByText("Neuer Beispielkunde", { exact: true }).waitFor();
        expect(await page.locator("body").innerText()).not.toContain("Lea Muster");
        expect(await page.getByRole("button", { name: "Vertrag unterschreiben", exact: true }).isDisabled()).toBe(true);
        await expectHeadingFocus(page);
      } finally {
        release?.();
        await page.close();
      }
    });
    for (const navigation of ["reload", "back"] as const)
      test(`real ${navigation} conceals the previous visit until revalidation and discards unfinished ink`, async () => {
        const { page, state } = await setup(width, "neutral=1");
        const held = Promise.withResolvers<void>();
        const observed = Promise.withResolvers<void>();
        try {
          await page.getByRole("heading", { name: /Ihr Vorgang/ }).waitFor();
          state.snapshot = fixtureSnapshot();
          await page.clock.runFor(2_000);
          await heading(page, "Ankaufsvertrag lesen");
          await page.getByRole("radio", { name: "Tippen", exact: true }).click();
          await page.getByRole("textbox").fill("Noch nicht gespeichert");
          await page.getByRole("checkbox").check();
          expect(await page.getByRole("button", { name: "Vertrag unterschreiben", exact: true }).isEnabled()).toBe(true);
          if (navigation === "back") await page.goto(new URL("away", server.url).href);
          if (!state.snapshot.visit) throw new Error("Missing fixture visit");
          state.snapshot.visit.customerName = "Neuer Beispielkunde";
          await page.route("**/fixture/snapshot", async (route) => {
            observed.resolve();
            await held.promise;
            await route.fulfill({ json: state.snapshot }).catch(() => {});
          });
          if (navigation === "reload") await page.reload();
          else await page.goBack();
          await observed.promise;
          expect(await page.locator("body").innerText()).not.toContain("Lea Muster");
          expect(await page.getByRole("textbox").count()).toBe(0);
          held.resolve();
          await page.getByText("Neuer Beispielkunde", { exact: true }).waitFor();
          await page.getByRole("radio", { name: "Tippen", exact: true }).click();
          expect(await page.getByRole("textbox").inputValue()).toBe("");
          expect(await page.getByRole("checkbox").isChecked()).toBe(false);
          expect(await page.getByRole("button", { name: "Vertrag unterschreiben", exact: true }).isDisabled()).toBe(true);
          expect(state.signs).toBe(0);
        } finally {
          held.resolve();
          await page.close();
        }
      });
  });
const expectHeadingFocus = async (page: Page) =>
  expect(await page.locator("h1").evaluate((element) => element === document.activeElement)).toBe(true);

for (const width of [390, 600, 768, 1440])
  describe(`Staff pairing at ${width}px`, () => {
    test("stable retry, claimed nullable QR, new pairing, pagination and visit QR renewal", async () => {
      // The 2-second device poll keeps fading the list buttons; the QR measurement needs a still page.
      const page = await browser.newPage({ viewport: { width, height: 1024 }, reducedMotion: "reduce" });
      await page.clock.install({ time: new Date("2026-10-23T10:00:00Z") });
      await seedPage(page);
      const id = "10000000-0000-4000-8000-000000000002";
      let firstLost = true;
      let active = false;
      const pairRequests: string[] = [];
      const visitRequests: string[] = [];
      const listRequests: unknown[] = [];
      await page.route("**/fixture/**", async (route) => {
        const path = new URL(route.request().url()).pathname;
        const input = JSON.parse(route.request().postData() ?? "{}");
        if (path.endsWith("devices/list")) {
          listRequests.push(input);
          return route.fulfill({
            json: {
              items: [
                {
                  id: input.after ? "10000000-0000-4000-8000-000000000003" : id,
                  name: input.after ? "Weiteres iPad" : "Laden-iPad",
                  state: active ? "active" : "pending",
                  expiresAt: null,
                },
              ],
              next: input.after ? null : id,
            },
          });
        }
        if (path.endsWith("devices/status"))
          return route.fulfill({ json: { id, name: "Laden-iPad", state: active ? "active" : "pending", expiresAt: null } });
        if (path.endsWith("devices/issue")) {
          pairRequests.push(input.requestId);
          active = true;
          if (firstLost) {
            firstLost = false;
            return route.abort("failed");
          }
          return route.fulfill({
            json: { id, name: "Laden-iPad", state: "active", expiresAt: null, qr: null, qrExpiresAt: "2026-10-23T10:02:00Z" },
          });
        }
        if (path.endsWith("visits/issue")) {
          visitRequests.push(input.requestId);
          return route.fulfill({
            json: {
              id,
              qr: `https://cloud.example.test/app/visit-demo/counter/#cloud-app-pwa:visit:${"A".repeat(43)}`,
              qrExpiresAt: "2026-10-23T10:02:00Z",
            },
          });
        }
        return route.fulfill({ json: { state: "revoked" } });
      });
      try {
        await page.goto(`${server.url}?staff=1&dark=1`);
        await page.getByRole("button", { name: "Laden-iPad koppeln", exact: true }).click();
        await page.getByRole("button", { name: "Dieselbe Anfrage wiederholen", exact: true }).click();
        await heading(page, "Laden-iPad gekoppelt");
        expect(pairRequests[0]).toBe(pairRequests[1]);
        // Pairing holds the form until the device list shows the new device.
        await page.waitForFunction(() => !document.querySelector<HTMLInputElement>(".kiosk-staff input")?.disabled);
        await page.getByRole("textbox", { name: "Gerätename" }).fill("Zweites Laden-iPad");
        await page.getByRole("button", { name: "Laden-iPad koppeln", exact: true }).click();
        await page.waitForFunction(() => !document.querySelector<HTMLInputElement>(".kiosk-staff input")?.disabled);
        expect(pairRequests[2]).not.toBe(pairRequests[1]);
        await page.getByRole("button", { name: "Weitere Geräte laden", exact: true }).click();
        await page.getByText("Weiteres iPad", { exact: true }).waitFor();
        await page.clock.runFor(2_000);
        expect(listRequests.some((request) => JSON.stringify(request) === JSON.stringify({ after: id }))).toBe(true);
        await page.getByRole("button", { name: "Besuchs-QR zeigen", exact: true }).first().click();
        await page.getByAltText("Besuchs-QR", { exact: true }).waitFor();
        await settled(page);
        const qrBox = await page.getByAltText("Besuchs-QR", { exact: true }).boundingBox();
        expect(qrBox?.width).toBe(224);
        expect(qrBox?.height).toBe(224);
        const shots = process.env.CLOUD_APP_PWA_SHOTS;
        if (shots) {
          await mkdir(shots, { recursive: true });
          await page.screenshot({ path: resolve(shots, `03-besuchsqr-dark-${width}.png`), fullPage: true });
        }
        await page.clock.runFor(120_000);
        await Promise.all([
          page.waitForResponse((response) => response.url().endsWith("/fixture/visits/issue")),
          page.getByRole("button", { name: "Neuen Besuchs-QR zeigen", exact: true }).click(),
        ]);
        expect(visitRequests).toHaveLength(2);
        expect(visitRequests[1]).not.toBe(visitRequests[0]);
        expect(pairRequests).toHaveLength(3);
        const size = await page.evaluate(() => ({ viewport: innerWidth, content: document.documentElement.scrollWidth }));
        expect(size.content).toBeLessThanOrEqual(size.viewport);
      } finally {
        await page.close();
      }
    });
  });

// These measurements protect the approved shared phone/tablet/desktop geometry.
for (const width of [390, 600, 768, 1440])
  for (const theme of ["light", "dark"])
    test(`approved App-PWA geometry at ${width}px in ${theme}`, async () => {
      const { page, state } = await setup(width, `unpaired=1&${theme === "dark" ? "dark=1" : ""}`);
      try {
        await settled(page);
        const measure = await page.evaluate(() => {
          const box = (selector: string) => {
            const element = document.querySelector(selector);
            if (!element) throw new Error(`Missing ${selector}`);
            const rect = element.getBoundingClientRect();
            return { width: rect.width, height: rect.height, top: rect.top };
          };
          return {
            frame: box(".kiosk"),
            radius: getComputedStyle(document.querySelector(".kiosk")!).borderRadius,
            main: box(".kiosk-main"),
            welcome: box(".kiosk-welcome"),
            scan: box(".kiosk-scan-art"),
            overflow: document.documentElement.scrollWidth > innerWidth,
          };
        });
        expect(measure.overflow).toBe(false);
        const frameWidth = width === 390 ? 374 : width === 600 ? 576 : width === 768 ? 720 : 820;
        expect(measure.frame.width).toBe(frameWidth);
        expect(measure.frame.top).toBe(width === 390 ? 8 : width === 600 ? 12 : 24);
        expect(measure.radius).toBe(width === 390 ? "14px" : "18px");
        expect(measure.frame.height).toBeGreaterThanOrEqual(width === 390 ? 790 : width === 600 ? 780 : 760);
        expect(measure.main.width).toBe(Math.min(frameWidth - (width === 390 ? 40 : width === 600 ? 48 : 80), 650));
        expect(measure.welcome.width).toBe(Math.min(measure.main.width, 540));
        expect(measure.scan.height).toBe(190);
        const shots = process.env.CLOUD_APP_PWA_SHOTS;
        if (shots) {
          await mkdir(shots, { recursive: true });
          await page.screenshot({ path: resolve(shots, `01-start-${theme}-${width}.png`), fullPage: true });
        }
        state.snapshot = fixtureSnapshot();
        await page.goto(`${server.url}?${theme === "dark" ? "dark=1" : ""}`);
        await heading(page, "Ankaufsvertrag lesen");
        await settled(page);
        expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
        if (shots) await page.screenshot({ path: resolve(shots, `02-vertrag-${theme}-${width}.png`), fullPage: true });
      } finally {
        await page.close();
      }
    });
