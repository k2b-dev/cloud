import { afterAll, beforeAll, beforeEach, expect, setDefaultTimeout, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { transformAsync } from "@babel/core";
import typescript from "@babel/preset-typescript";
import { createConfig } from "@k2b/ssr";
import tailwind from "bun-plugin-tailwind";
import type { Browser, BrowserContext, Page } from "playwright";
import { launchBrowser, settled } from "../../../ui/test/browser";

// The shared workstation's browser half in a real engine: only trusted input reaches the server, the warning keeps
// the person working, and every tab of the browser leaves together. The clock is Playwright's and never real.
const root = mkdtempSync(resolve(tmpdir(), "cloud-shared-workstation-browser-"));
const { plugin } = createConfig({ dev: true, rootDir: root });
Bun.plugin(plugin());
process.once("exit", () => rmSync(root, { recursive: true, force: true }));
setDefaultTimeout(30_000);
const railSnapshot = await import("../services/rail-snapshot");
const settingsMiddleware = await import("../server/middleware/settings");
const help = await import("./help");
const { defaultRailPreferences } = await import("../contracts/rail-preferences");
const { person } = await import("../_internal/define-app.test-fixture");
const { sharedWorkstationCookieName } = await import("../services/session/shared-workstation");
const { server, serverState, TIMEOUT_SECONDS } = await import("./shared-workstation.browser-harness");

const START = Date.UTC(2026, 10, 10, 9, 0, 0);
const SID = "22222222-2222-4222-8222-222222222222";
let fakeNow = START;

let browser: Browser;
let origin: string;
let stop: () => void;
const spies: { mockRestore(): void }[] = [];
beforeAll(async () => {
  spies.push(
    spyOn(railSnapshot, "readRailSnapshot").mockResolvedValue(defaultRailPreferences()),
    spyOn(settingsMiddleware, "preloadLayoutAnnouncements").mockResolvedValue(undefined),
    spyOn(help, "preloadLayoutHelp").mockResolvedValue(null),
  );
  const build = await Bun.build({ entrypoints: [resolve(import.meta.dir, "../../../../styles.css")], plugins: [tailwind] });
  if (!build.success) throw new AggregateError(build.logs, "Could not compile the global stylesheet");
  const css = await build.outputs[0]!.text();
  const solid = (await import(Bun.resolveSync("babel-preset-solid", import.meta.dir))).default;
  const entry = resolve(import.meta.dir, "shared-workstation.runtime-fixture.ts");
  const bundle = await Bun.build({
    entrypoints: [entry],
    files: {
      [entry]: `
import { createComponent } from "solid-js";
import { render } from "solid-js/web";
import ShellRuntime from "./ShellRuntime.island";
render(() => createComponent(ShellRuntime, { browserSession: window.__browserSession }), document.createElement("div"));
`,
    },
    target: "browser",
    conditions: ["browser"],
    format: "iife",
    plugins: [
      {
        name: "solid-shared-workstation-test",
        setup(builder) {
          builder.onLoad({ filter: /\.tsx$/ }, async ({ path }) => {
            const result = await transformAsync(await Bun.file(path).text(), {
              filename: path,
              babelrc: false,
              configFile: false,
              presets: [typescript, [solid, { generate: "dom", hydratable: false }]],
            });
            if (!result?.code) throw new Error(`Could not compile ${path}`);
            return { contents: result.code, loader: "js" };
          });
        },
      },
    ],
  });
  if (!bundle.success) throw new AggregateError(bundle.logs, "Could not bundle the shell runtime");
  const runtime = await bundle.outputs[0]!.text();
  const served = Bun.serve({
    port: 0,
    fetch: async (request) => {
      if (new URL(request.url).pathname === "/shell-runtime.js")
        return new Response(runtime, { headers: { "content-type": "text/javascript" } });
      // Over plain http a browser refuses `__Host-` cookies; the fixture passes the mark on under the production name.
      const headers = new Headers(request.headers);
      if (/(?:^|;\s*)cloud_shared_workstation=1/.test(headers.get("Cookie") ?? ""))
        headers.set("Cookie", `${headers.get("Cookie")}; ${sharedWorkstationCookieName(false)}=1; ${sharedWorkstationCookieName(true)}=1`);
      const response = await server.fetch(new Request(request.url, { method: request.method, headers, body: request.body }));
      if (!response.headers.get("content-type")?.includes("text/html")) return response;
      const markup = (await response.text())
        .replace(/<script type="module"[^>]*>[^<]*solid-island[^<]*<\/script>/g, "")
        .replace(
          "</head>",
          `<style>${css}</style><style>*,*::before,*::after{transition:none!important;animation:none!important}</style></head>`,
        )
        .replace("</body>", `<script src="/shell-runtime.js"></script></body>`);
      return new Response(markup, { headers: { "content-type": "text/html; charset=utf-8" } });
    },
  });
  origin = `http://localhost:${served.port}`;
  stop = () => served.stop(true);
  browser = await launchBrowser();
}, 60_000);
afterAll(async () => {
  for (const spy of spies) spy.mockRestore();
  await browser?.close();
  stop?.();
});
beforeEach(() => {
  fakeNow = START;
  serverState.now = () => fakeNow;
  serverState.reports = 0;
  serverState.reads = 0;
});

/** Opens the counter page with `remaining` seconds left. The clock belongs to the context: every tab shares it. */
const openTab = async (context: BrowserContext, remaining: number, beside?: Page): Promise<Page> => {
  if (beside) await sync(beside);
  serverState.lastInput = fakeNow - (TIMEOUT_SECONDS - remaining) * 1_000;
  // The shell reloads a first visit once to store the browser's time zone; the contexts run in UTC, so it is set up front.
  if (!beside) await context.addCookies([{ name: "cloud.timezone", value: "UTC", url: origin }]);
  const page = await context.newPage();
  if (!beside) await context.clock.install({ time: fakeNow });
  await page.addInitScript((session) => Object.assign(window, { __browserSession: session }), {
    userId: person.id,
    sid: SID,
    idle: { remainingSeconds: remaining, timeoutSeconds: TIMEOUT_SECONDS },
  });
  // Opening the page is one navigation: a reload meanwhile would run the watcher twice and race the test's reads.
  let navigations = 0;
  page.on("framenavigated", (frame) => {
    if (frame === page.mainFrame()) navigations++;
  });
  await page.goto(`${origin}/app/desk`);
  await settled(page);
  expect(navigations).toBe(1);
  return page;
};
/** The installed clock keeps running in real time, so the fixture server follows the page's clock. */
const sync = async (page: Page) => {
  // real clock: reads the page's installed Playwright clock, which started at the fixed START
  fakeNow = await page.evaluate(() => Date.now());
};
/** Moves the browser's clock; the server's clock is there first, for the requests the due timers send. */
const forward = async (ms: number, page: Page) => {
  // real clock: reads the page's installed Playwright clock, which started at the fixed START
  fakeNow = (await page.evaluate(() => Date.now())) + ms;
  await page.clock.fastForward(ms);
  await sync(page);
};
const warning = (page: Page) => page.getByRole("alertdialog", { name: "You will be signed out soon" });
/** The next message the tabs exchange, heard in `page`; a tab announces a new deadline once it has applied it. */
const nextMessage = (page: Page) =>
  page.evaluate(
    () =>
      new Promise<string>((resolve) => {
        const channel = new BroadcastChannel("cloud.shared-workstation");
        channel.onmessage = (event) => {
          channel.close();
          resolve(String(event.data?.type));
        };
      }),
  );

test("background work never extends the session; the warning's Keep working does", async () => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "en", timezoneId: "UTC" });
  try {
    const page = await openTab(context, 75);
    // Requests, untrusted events and scrolling by script are no sign of a person.
    await page.evaluate(async () => {
      for (const type of ["keydown", "pointerdown", "wheel", "touchstart"]) window.dispatchEvent(new Event(type));
      document.querySelector("textarea")?.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true }));
      window.scrollTo(0, 100);
      await fetch("/api/background", { method: "POST" });
    });
    await forward(5_000, page);
    expect(await warning(page).isVisible()).toBe(false);
    await forward(11_000, page);
    await warning(page).waitFor();
    expect(serverState.reports).toBe(0);
    // Before warning the tab asked the server, without extending.
    expect(serverState.reads).toBe(1);
    expect(await warning(page).textContent()).toMatch(/you will be signed out in \d+ seconds/);
    // A script pressing Keep working is no person.
    await page.evaluate(() =>
      Array.from(document.querySelectorAll("button"))
        .find((button) => button.textContent?.trim() === "Keep working")
        ?.click(),
    );
    expect(serverState.reports).toBe(0);
    await warning(page).waitFor();
    // Two clear ways and nothing else: the focus is on Keep working, there is no close button, and Escape,
    // real or by script, neither closes the question nor keeps the session.
    const keepWorking = warning(page).getByRole("button", { name: "Keep working" });
    expect(await keepWorking.evaluate((button) => button === document.activeElement)).toBe(true);
    expect((await warning(page).getByRole("button").allTextContents()).map((text) => text.trim())).toEqual(["Sign out", "Keep working"]);
    await page.keyboard.press("Escape");
    await page.evaluate(() => document.activeElement?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    await forward(1_000, page);
    expect(await warning(page).isVisible()).toBe(true);
    expect(serverState.reports).toBe(0);

    // A second tab of the same browser hears the new deadline once this tab has applied it.
    const listener = await page.context().newPage();
    await listener.goto(`${origin}/auth/login`);
    const heard = nextMessage(listener);
    await page.getByRole("button", { name: "Keep working" }).click();
    expect(await heard).toBe("deadline");
    await warning(page).waitFor({ state: "hidden" });
    expect(serverState.reports).toBe(1);
    await forward((TIMEOUT_SECONDS - 90) * 1_000, page);
    expect(await warning(page).isVisible()).toBe(false);
    expect(page.url()).toBe(`${origin}/app/desk`);
  } finally {
    await context.close();
  }
});

test("typing reaches the server at most every 20 seconds and keeps the tab open", async () => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "en", timezoneId: "UTC" });
  try {
    const page = await openTab(context, TIMEOUT_SECONDS);
    const note = page.getByRole("textbox", { name: "Note" });
    await note.click();
    for (let second = 0; second < 10; second++) {
      await note.press("a");
      await forward(1_000, page);
    }
    expect(serverState.reports).toBe(1);
    const trailing = page.waitForResponse((response) => response.url().endsWith("/api/me/browser/activity"));
    await forward(20_000, page);
    await trailing;
    expect(serverState.reports).toBe(2);
  } finally {
    await context.close();
  }
});

test("input in one tab keeps the other awake, and the sign-out takes every tab along", async () => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "en", timezoneId: "UTC" });
  try {
    const first = await openTab(context, 90);
    const second = await openTab(context, 90, first);
    await forward(20_000, first);
    // The tab's own channel, made before this one, hears each message first.
    const heard = nextMessage(first);
    await second.getByRole("textbox", { name: "Note" }).click();
    expect(await heard).toBe("deadline");
    expect(serverState.reports).toBe(1);
    // The first tab heard of the new deadline: its old warning time passes quietly, without even asking the server.
    await forward(40_000, first);
    expect(await warning(first).isVisible()).toBe(false);
    expect(serverState.reads).toBe(0);

    // Nobody works any more: both tabs warn; signing out in one takes the other along at once.
    await forward((TIMEOUT_SECONDS - 40 - 20) * 1_000, first);
    await warning(second).waitFor();
    // A background tab draws nothing; brought to the front it shows its warning too.
    await first.bringToFront();
    await warning(first).waitFor();
    await Promise.all([
      first.waitForURL(`${origin}/auth/login?signedOut=idle`),
      second.waitForURL(`${origin}/auth/login?signedOut=idle`),
      first.getByRole("button", { name: "Sign out" }).click(),
    ]);
    expect(serverState.reports).toBe(1);
    // The sign-in page ends exactly this session and clears this account's data.
    expect(JSON.parse((await first.evaluate(() => sessionStorage.getItem("cloud.idle-sign-out"))) ?? "null")).toEqual({
      userId: person.id,
      sid: SID,
    });
  } finally {
    await context.close();
  }
});

test("the profile menu's switch says on or off to the eye and to screen readers, and switching moves nothing", async () => {
  const rows: Array<{ checked: string | null; checks: number; row: unknown; label: unknown }> = [];
  for (const marked of [false, true]) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "en", timezoneId: "UTC" });
    try {
      if (marked) await context.addCookies([{ name: "cloud_shared_workstation", value: "1", url: origin }]);
      const page = await openTab(context, TIMEOUT_SECONDS);
      // The hover panel stays hidden until hovered, so the role is looked up in the markup, not the accessibility tree.
      const entry = page.locator('.layout-profile-preferences__panel [role="switch"]', { hasText: "Shared workstation" });
      rows.push(
        await entry.evaluate((element) => {
          const box = (node: Element | null) => {
            const rect = node?.getBoundingClientRect();
            return rect && { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
          };
          return {
            checked: element.getAttribute("aria-checked"),
            checks: element.querySelectorAll(".cloud-shared-workstation-check .ti-check").length,
            row: box(element),
            label: box(element.querySelector(".layout-profile-preferences__copy")),
          };
        }),
      );
    } finally {
      await context.close();
    }
  }
  expect(rows.map(({ checked, checks }) => [checked, checks])).toEqual([
    ["false", 0],
    ["true", 1],
  ]);
  expect(rows[1]?.row).toEqual(rows[0]?.row);
  expect(rows[1]?.label).toEqual(rows[0]?.label);
});
