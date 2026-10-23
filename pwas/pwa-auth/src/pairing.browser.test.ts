import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import type { Browser, BrowserContext, BrowserContextOptions, Page } from "playwright";
import { APP_APPROVAL_LIMITS, APP_APPROVAL_PROTOCOL } from "../../../packages/cloud/src/contracts/app-approval";
import { launchBrowser } from "../../../packages/ui/test/browser";
import { pairingPage } from "./pairing.browser-harness";

let browser: Browser;
const contexts = new Map<number, BrowserContext>();
const viewOptions = (width: number): BrowserContextOptions => ({
  viewport: { width, height: 900 },
  hasTouch: true,
  isMobile: width < 768,
  colorScheme: "light",
  // These assertions cover flow state, not entrance animations; use the supported reduced-motion presentation.
  reducedMotion: "reduce",
  userAgent:
    width < 768
      ? "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 Version/18.6 Mobile/15E148 Safari/604.1"
      : "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Gecko/20100101 Firefox/143.0",
});
const built = await pairingPage();
beforeAll(async () => {
  browser = await launchBrowser();
  // Reuse a context per viewport, but a fresh page and in-memory store per test. Warm the first
  // native dialog in each context here; WebKit's first mobile rendering is part of launch setup.
  for (const width of [390, 834, 1440]) {
    const context = await browser.newContext(viewOptions(width));
    contexts.set(width, context);
    const warm = await context.newPage();
    try {
      await warm.route("https://login.example.test/**", (route) => route.fulfill({ contentType: "text/html", body: built.html }));
      await warm.goto("https://login.example.test/");
      await warm.clock.install({ time: new Date("2026-10-23T13:00:00.000Z") });
      await warm.addScriptTag({ content: built.script });
      await open(warm);
      await warm.locator("dialog[open]").waitFor();
      await warm.waitForFunction(() => document.getAnimations().every((animation) => animation.playState !== "running"));
    } finally {
      await warm.close();
    }
  }
}, 30_000);
afterAll(async () => {
  await Promise.all([...contexts.values()].map((context) => context.close()));
  await browser?.close();
});
const open = (page: Page, options: { label?: string; empty?: boolean } = {}) =>
  page.evaluate((options) => {
    // The test bundle owns this fixture-only entry point.
    Reflect.get(window, "openPairing")(options);
  }, options);
async function fixture(
  width: number,
  run: (
    page: Page,
    state: { offline: boolean; failClaim: boolean; savedElsewhere: boolean; claims: number; confirmed: boolean },
  ) => Promise<void>,
) {
  const context = contexts.get(width)!;
  const page = await context.newPage();
  const state = { offline: false, failClaim: false, savedElsewhere: false, claims: 0, confirmed: false };
  let claimed = false;
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  try {
    await page.clock.install({ time: new Date("2026-10-23T13:00:00.000Z") });
    await page.route("https://login.example.test/**", (route) => route.fulfill({ contentType: "text/html", body: built.html }));
    await page.route("https://cloud.example.test/**", async (route) => {
      if (state.offline) return route.abort();
      const headers = { "access-control-allow-origin": "https://login.example.test", "access-control-allow-headers": "content-type" };
      if (route.request().method() === "OPTIONS") return route.fulfill({ headers });
      const path = new URL(route.request().url()).pathname;
      let body: unknown;
      if (path.endsWith("/info"))
        body = {
          protocol: APP_APPROVAL_PROTOCOL,
          issuer: "https://cloud.example.test",
          api: "https://cloud.example.test/api/auth/app-approval/v1",
          appOrigin: "https://login.example.test",
          algorithm: "ES256",
          limits: APP_APPROVAL_LIMITS,
        };
      else if (path.endsWith("/claim")) {
        state.claims++;
        if (state.savedElsewhere) {
          state.savedElsewhere = false;
          claimed = true;
          state.confirmed = true;
          await page.evaluate(() => Reflect.get(window, "storeClaimFromAnotherTab")());
          return route.abort();
        }
        if (state.failClaim) {
          state.failClaim = false;
          return route.abort();
        }
        claimed = true;
        body = { deviceId: "22222222-2222-4222-8222-222222222222", comparison: "123456", expiresAt: "2026-10-23T13:05:00.000Z" };
      } else
        body = {
          state: state.confirmed ? "confirmed" : claimed ? "claimed" : "pending",
          deviceId: claimed ? "22222222-2222-4222-8222-222222222222" : null,
          comparison: claimed && !state.confirmed ? "123456" : null,
        };
      await route.fulfill({ headers, contentType: "application/json", body: JSON.stringify(body) });
    });
    await page.goto("https://login.example.test/");
    await page.addScriptTag({ content: built.script });
    await run(page, state);
    expect(errors).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
  } finally {
    await page.close();
  }
}

for (const width of [390, 834, 1440])
  test(`pairing at ${width}: suggestions remain editable, outside tap/Escape/drag cannot close, explicit X can`, async () => {
    await fixture(width, async (page) => {
      await open(page);
      const dialog = page.locator("dialog[open]");
      await dialog.waitFor();
      expect(await page.getByLabel("Bezeichnung", { exact: false }).first().inputValue()).toBe("Hoffmann Druck");
      const shots = process.env.CLOUD_PAIRING_SHOTS;
      if (shots && width !== 834) {
        await mkdir(shots, { recursive: true });
        await page.screenshot({ path: `${shots}/01-pairing-light-${width}.png` });
      }
      await page.getByLabel("Bezeichnung", { exact: false }).first().fill("Arbeit");
      await page.getByLabel("Gerätename", { exact: true }).fill("Mein Arbeitsgerät");
      await page.touchscreen.tap(2, 2);
      await page.keyboard.press("Escape");
      await page
        .locator(".k2b-panel-dialog__header")
        .dispatchEvent("pointerdown", { pointerId: 1, pointerType: "touch", clientY: 100, isPrimary: true, button: 0 });
      await page
        .locator(".k2b-panel-dialog__header")
        .dispatchEvent("pointerup", { pointerId: 1, pointerType: "touch", clientY: 260, isPrimary: true, button: 0 });
      expect(await dialog.count()).toBe(1);
      expect(await page.getByLabel("Gerätename", { exact: true }).inputValue()).toBe("Mein Arbeitsgerät");
      await page.getByRole("button", { name: "Schließen", exact: true }).first().click();
      await page.waitForFunction(() => !document.querySelector("dialog[open]"));
    });
  });

test("a claim lost before Cloud receives it resumes with its saved key", async () => {
  await fixture(390, async (page, state) => {
    state.failClaim = true;
    await open(page);
    await page.getByRole("button", { name: "Cloud vertrauen und koppeln" }).click();
    await page.locator(".auth-comparison").waitFor();
    expect(state.claims).toBe(2);
    expect(await page.locator(".auth-comparison").textContent()).toBe("123456");
  });
});

test("reopening reports an unfinished enrollment", async () => {
  await fixture(390, async (page) => {
    await open(page);
    await page.getByRole("button", { name: "Cloud vertrauen und koppeln" }).click();
    await page.locator(".auth-comparison").waitFor();
    await page.getByRole("button", { name: "Schließen", exact: true }).first().click();
    await open(page, { empty: true });
    await page.getByText("Auf diesem Gerät ist eine offene Kopplung gespeichert.", { exact: false }).waitFor();
  });
});

test("reopening the same link reuses the saved enrollment instead of claiming again", async () => {
  await fixture(390, async (page, state) => {
    await open(page);
    await page.getByLabel("Bezeichnung", { exact: false }).first().fill("Privat");
    await page.getByRole("button", { name: "Cloud vertrauen und koppeln" }).click();
    await page.locator(".auth-comparison").waitFor();
    await page.getByRole("button", { name: "Schließen", exact: true }).first().click();
    await open(page, { label: "Neuer Instanzname" });
    await page.getByRole("button", { name: "Cloud vertrauen und koppeln" }).click();
    await page.locator(".auth-comparison").waitFor();
    expect(state.claims).toBe(1);
  });
});

test("late Client Hints never replace a name the person edited; unlabeled links still work", async () => {
  await fixture(390, async (page) => {
    await page.evaluate(() => {
      Object.defineProperty(navigator, "userAgent", { configurable: true, value: "Android 10" });
      Object.defineProperty(navigator, "userAgentData", {
        configurable: true,
        value: {
          platform: "Android",
          getHighEntropyValues: () => new Promise((resolve) => Reflect.set(window, "finishHints", resolve)),
        },
      });
    });
    await open(page, { label: "" });
    expect(await page.getByLabel("Bezeichnung", { exact: false }).first().inputValue()).toBe("");
    await page.getByLabel("Gerätename", { exact: true }).fill("Mein Name");
    await page.evaluate(() => Reflect.get(window, "finishHints")({ model: "Pixel 8", platformVersion: "16" }));
    expect(await page.getByLabel("Gerätename", { exact: true }).inputValue()).toBe("Mein Name");
    await page.getByRole("button", { name: "Schließen", exact: true }).last().click();
    await page.waitForFunction(() => !document.querySelector("dialog[open]"));
  });
});

test("an app switch leaves a visible recoverable state without discarding edits", async () => {
  await fixture(390, async (page) => {
    await open(page);
    await page.getByLabel("Gerätename", { exact: true }).fill("Mein Name");
    await page.evaluate(() => {
      Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
      document.dispatchEvent(new Event("visibilitychange"));
      Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(await page.getByRole("alert").textContent()).toContain("unterbrochen");
    expect(await page.getByLabel("Gerätename", { exact: true }).inputValue()).toBe("Mein Name");
    await page.getByRole("button", { name: "Kopplung erneut versuchen", exact: true }).click();
    await page.locator(".auth-comparison").waitFor();
  });
});

test("network loss stays visible and retry resumes status checks", async () => {
  await fixture(390, async (page, state) => {
    await open(page);
    await page.getByRole("button", { name: "Cloud vertrauen und koppeln" }).click();
    await page.locator(".auth-comparison").waitFor();
    state.offline = true;
    await page.clock.fastForward(6000);
    await page.getByRole("alert").waitFor();
    const retry = page.getByRole("button", { name: "Kopplung erneut versuchen", exact: true });
    expect(await retry.isVisible()).toBe(true);
    const shots = process.env.CLOUD_PAIRING_SHOTS;
    if (shots) await page.screenshot({ path: `${shots}/02-recovery-light-390.png` });
    state.offline = false;
    await retry.click();
    await page.waitForFunction(() => !document.querySelector('[role="alert"]'));
    expect(state.claims).toBe(1);
  });
});

test("phone dark mode preserves the same editable fields and explicit close", async () => {
  await fixture(390, async (page) => {
    await page.evaluate(() => {
      document.body.dataset.theme = "dark";
    });
    await open(page);
    expect(await page.getByLabel("Gerätename", { exact: true }).isEditable()).toBe(true);
    expect(await page.getByRole("button", { name: "Cloud vertrauen und koppeln" }).isVisible()).toBe(true);
    await page.getByRole("button", { name: "Schließen", exact: true }).last().click();
    await page.waitForFunction(() => !document.querySelector("dialog[open]"));
  });
});

test("a saved comparison from another tab survives a terminal status without a code", async () => {
  await fixture(390, async (page, state) => {
    state.savedElsewhere = true;
    await open(page);
    await page.getByRole("button", { name: "Cloud vertrauen und koppeln" }).click();
    await page.getByRole("button", { name: "Beide Codes stimmen überein." }).click();
    await page.waitForFunction(() => !document.querySelector("dialog[open]"));
    expect(await page.evaluate(() => Reflect.get(window, "savedBindings").length)).toBe(1);
    expect(state.claims).toBe(1);
  });
});
