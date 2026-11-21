import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import type { Browser, Page } from "playwright";
import { launchBrowser, pageErrors } from "../../ui/test/browser";
import { type MaintenancePageModel, renderMaintenancePage } from "./maintenance-page";
import { contentSecurityPolicy } from "./unavailable-answer";

// The waiting game on the gateway's maintenance page, in a real engine under the page's own CSP. Frames advance only
// when the test steps them, and chance is seeded, so every round plays the same way on every run.
setDefaultTimeout(30_000);

const NOW = Date.parse("2026-11-16T13:58:00+01:00");
const model: MaintenancePageModel = {
  locale: "de",
  cloud: { name: "Musterverein Cloud" },
  timeZone: "Europe/Berlin",
  statusPath: "/_cloud/gateway/status",
  kind: "cloud",
  message: "Wir spielen Version 2.4 ein. Danach ist alles wie vorher.",
  until: Date.parse("2026-11-16T14:30:00+01:00"),
};

let status: unknown = { maintenance: { active: true, until: "2026-11-16T13:30:00.000Z" } };
let loads = 0;
const server = Bun.serve({
  port: 0,
  fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/_cloud/gateway/status") return Response.json(status);
    loads++;
    const nonce = crypto.randomUUID().replaceAll("-", "");
    const page: MaintenancePageModel =
      url.pathname === "/app" ? { ...model, kind: "app", app: { id: "mail", name: "Mail" }, reason: "unavailable" } : model;
    return new Response(renderMaintenancePage(page, { nonce }), {
      status: 503,
      headers: { "Content-Type": "text/html; charset=utf-8", "Content-Security-Policy": contentSecurityPolicy(nonce) },
    });
  },
});

/** Runs before the page: a pinned clock, seeded chance, and animation frames that run only when the test steps them. */
const deterministic = (at: number) => {
  const realNow = Date.now.bind(Date);
  const offset = at - realNow(); // real clock: the page's distance to the pinned instant
  Date.now = () => realNow() + offset; // real clock: flows from the pinned instant
  let seed = 7;
  Math.random = () => {
    seed = (seed * 16_807) % 2_147_483_647;
    return (seed - 1) / 2_147_483_646;
  };
  const frames = new Map<number, FrameRequestCallback>();
  let id = 0;
  let time = 1_000;
  window.requestAnimationFrame = (callback) => {
    frames.set(++id, callback);
    return id;
  };
  window.cancelAnimationFrame = (handle) => {
    frames.delete(handle);
  };
  // The app page's „takes longer than usual“ timer (two minutes) waits for the test instead.
  const realSetTimeout = window.setTimeout.bind(window);
  window.setTimeout = ((handler: TimerHandler, ms?: number, ...rest: unknown[]) => {
    if (ms !== 120_000) return realSetTimeout(handler, ms, ...rest);
    Reflect.set(window, "takeLonger", handler);
    return 0;
  }) as typeof window.setTimeout;
  Reflect.set(window, "stepFrames", (count: number) => {
    for (let i = 0; i < count; i++) {
      time += 1000 / 60;
      const due = [...frames.values()];
      frames.clear();
      for (const callback of due) callback(time);
    }
  });
};

const step = (page: Page, count: number) => page.evaluate((n) => Reflect.get(window, "stepFrames")(n), count);
const said = (page: Page) => page.locator(".lauf-sr").textContent();
const mode = (page: Page) => page.evaluate(() => document.documentElement.dataset.lauf ?? "closed");
/** Steps frame by frame until the round is over and returns how many frames that took. */
const playUntilOver = async (page: Page, limit = 1_200) => {
  for (let frames = 1; frames <= limit; frames++) {
    await step(page, 1);
    if ((await said(page))?.startsWith("Runde vorbei")) return frames;
  }
  throw new Error("The round did not end without input.");
};
/** How opaque the canvas is in its corner: the road fades out there and lets the page show, unless the screen is dimmed. */
const corner = (page: Page) =>
  page.evaluate(() => {
    const canvas = document.querySelector<HTMLCanvasElement>(".lauf canvas");
    const pixel = canvas?.getContext("2d")?.getImageData(2, 2, 1, 1).data;
    return pixel ? pixel[3]! : -1;
  });

let browser: Browser;
beforeAll(async () => {
  browser = await launchBrowser();
}, 30_000);
afterAll(async () => {
  await browser?.close();
  server.stop(true);
});

const open = async (reducedMotion: "reduce" | "no-preference" = "no-preference", path = "/") => {
  status = { maintenance: { active: true, until: "2026-11-16T13:30:00.000Z" } };
  loads = 0;
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion });
  await context.addInitScript(deterministic, NOW);
  const page = await context.newPage();
  const errors = pageErrors(page);
  await page.goto(new URL(path, server.url).href);
  return { page, errors, close: () => context.close() };
};

const exitShown = (page: Page) => page.getByRole("button", { name: "Spiel beenden" }).isVisible();

test("the robot waits on its road from the first paint and never starts a round on its own", async () => {
  const { page, errors, close } = await open();
  try {
    expect(await mode(page)).toBe("wait");
    expect(await page.locator(".lauf canvas").count()).toBe(1);
    await step(page, 600);
    expect(await mode(page)).toBe("wait");
    expect(await said(page)).toBe("");
    // „Leave game“ belongs to a round, not to the waiting scene.
    expect(await exitShown(page)).toBe(false);
    expect(await page.getByText("Kurz spielen").count()).toBe(0);
    expect(errors).toEqual([]);
  } finally {
    await close();
  }
});

test("Space starts a round; it ends in a fall, starts again, and Escape or „Spiel beenden“ return to the waiting scene", async () => {
  const { page, errors, close } = await open();
  try {
    await page.keyboard.press(" ");
    expect(await mode(page)).toBe("run");
    expect(await said(page)).toContain("Escape beendet die Runde");
    expect(await exitShown(page)).toBe(true);
    await playUntilOver(page);
    expect(await said(page)).toMatch(/^Runde vorbei: \d+ Punkte\. Neuer Rekord\. Leertaste: nochmal$/);
    await step(page, 60);
    await page.keyboard.press(" ");
    expect(await said(page)).toContain("Runde läuft");
    await page.keyboard.press("Escape");
    expect(await mode(page)).toBe("wait");
    expect(await exitShown(page)).toBe(false);
    // The focus stays on the scene, so Space starts the next round at once.
    expect(await page.evaluate(() => document.activeElement?.classList.contains("lauf"))).toBe(true);
    expect(await said(page)).toBe("Runde verlassen. Leertaste startet eine neue.");
    await page.keyboard.press(" ");
    expect(await mode(page)).toBe("run");
    await page.getByRole("button", { name: "Spiel beenden" }).click();
    expect(await mode(page)).toBe("wait");
    expect(errors).toEqual([]);
  } finally {
    await close();
  }
});

test("the maintenance symbol starts a round at once", async () => {
  const { page, errors, close } = await open();
  try {
    await page.getByRole("button", { name: "Mini-Spiel starten" }).click();
    expect(await mode(page)).toBe("run");
    expect(errors).toEqual([]);
  } finally {
    await close();
  }
});

test("an app page shows the scene only once the restart takes longer than usual", async () => {
  const { page, errors, close } = await open("no-preference", "/app");
  try {
    expect(await mode(page)).toBe("closed");
    expect(await page.locator(".lauf").count()).toBe(0);
    await page.evaluate(() => Reflect.get(window, "takeLonger")());
    expect(await mode(page)).toBe("wait");
    expect(await page.locator(".lauf canvas").count()).toBe(1);
    expect(await page.locator("h1").textContent()).toBe("Mail ist gerade nicht erreichbar");
    expect(await page.locator(".when").textContent()).toContain("Dauert länger");
    expect(errors).toEqual([]);
  } finally {
    await close();
  }
});

test("an end during a round waits for the round or for „Weiter“ before the page reloads", async () => {
  const { page, errors, close } = await open();
  try {
    await page.keyboard.press(" ");
    await step(page, 30);
    status = { maintenance: null };
    await page.evaluate(() => dispatchEvent(new Event("online")));
    await page.getByRole("button", { name: "Weiter" }).waitFor();
    expect(await page.locator(".live b").textContent()).toBe("Wartung beendet");
    expect(await mode(page)).toBe("run");
    await playUntilOver(page);
    expect(await said(page)).toContain("Wartung beendet · weiter");
    expect(loads).toBe(1);
    status = { maintenance: { active: true, until: null } };
    await step(page, 60);
    let reloaded = page.waitForEvent("load");
    await page.keyboard.press(" ");
    await reloaded;
    expect(loads).toBe(2);

    // The same end, left with „Weiter“ in the middle of a round.
    await page.keyboard.press(" ");
    status = { maintenance: null };
    await page.evaluate(() => dispatchEvent(new Event("online")));
    reloaded = page.waitForEvent("load");
    await page.getByRole("button", { name: "Weiter" }).click();
    await reloaded;
    expect(loads).toBe(3);
    expect(errors).toEqual([]);
  } finally {
    await close();
  }
});

test("an end while nobody plays reloads as before", async () => {
  const { page, errors, close } = await open();
  try {
    status = { maintenance: null };
    const reloaded = page.waitForEvent("load");
    await page.evaluate(() => dispatchEvent(new Event("online")));
    await reloaded;
    expect(loads).toBe(2);
    expect(errors).toEqual([]);
  } finally {
    await close();
  }
});

test("reduced motion dims the screen for a fall instead of shaking it", async () => {
  const dimAtFall = async (reducedMotion: "reduce" | "no-preference") => {
    const { page, errors, close } = await open(reducedMotion);
    try {
      await page.keyboard.press(" ");
      await step(page, 2);
      const before = await corner(page);
      await playUntilOver(page);
      const after = await corner(page);
      expect(errors).toEqual([]);
      return { before, after };
    } finally {
      await close();
    }
  };
  const calm = await dimAtFall("reduce");
  expect(calm.before).toBe(0);
  expect(calm.after).toBeGreaterThan(20);
  const lively = await dimAtFall("no-preference");
  expect(lively.after).toBe(lively.before);
});
