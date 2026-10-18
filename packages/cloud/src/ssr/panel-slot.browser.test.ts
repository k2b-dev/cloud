import { afterAll, beforeAll, expect, setDefaultTimeout, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { transformAsync } from "@babel/core";
import typescript from "@babel/preset-typescript";
import { createConfig } from "@k2b/ssr";
import tailwind from "bun-plugin-tailwind";
import type { Browser, BrowserContext, Page } from "playwright";
import { launchBrowser } from "../../../ui/test/browser";

const root = mkdtempSync(resolve(tmpdir(), "cloud-panel-browser-"));
const { plugin } = createConfig({ dev: true, rootDir: root });
Bun.plugin(plugin());
process.once("exit", () => rmSync(root, { recursive: true, force: true }));
setDefaultTimeout(30_000);
const rail = await import("../services/rail-snapshot");
const settings = await import("../server/middleware/settings");
const help = await import("./help");
const { panelContextConsent } = await import("../services/panel-context-consent");
const { defaultRailPreferences } = await import("../contracts/rail-preferences");
const { server, panelGeometry, consentGeometry, consentAnswers, fixtureConsent } = await import("./panel-slot.browser-harness");
let browser: Browser;
let providerRequests = 0;
let origin: string;
let stop: () => void;
const spies: { mockRestore(): void }[] = [];

beforeAll(async () => {
  spies.push(
    spyOn(panelContextConsent, "get").mockImplementation(fixtureConsent.get),
    spyOn(rail, "readRailSnapshot").mockResolvedValue(defaultRailPreferences()),
    spyOn(settings, "preloadLayoutAnnouncements").mockResolvedValue(undefined),
    spyOn(help, "preloadLayoutHelp").mockResolvedValue(null),
  );
  const styles = await Bun.build({ entrypoints: [resolve(import.meta.dir, "../../../../styles.css")], plugins: [tailwind] });
  if (!styles.success) throw new AggregateError(styles.logs, "Could not compile panel styles");
  const css = await styles.outputs[0]!.text();
  const solid = (await import(Bun.resolveSync("babel-preset-solid", import.meta.dir))).default;
  const bundle = async (name: string, contents: string) => {
    const entry = resolve(import.meta.dir, `panel-slot.${name}-fixture.ts`);
    const result = await Bun.build({
      entrypoints: [entry],
      files: { [entry]: contents },
      target: "browser",
      conditions: ["browser"],
      format: "iife",
      plugins: [
        {
          name: "solid-panel-fixture",
          setup(builder) {
            builder.onLoad({ filter: /\.tsx$/ }, async ({ path }) => {
              const transformed = await transformAsync(await Bun.file(path).text(), {
                filename: path,
                babelrc: false,
                configFile: false,
                presets: [typescript, [solid, { generate: "dom", hydratable: false }]],
              });
              if (!transformed?.code) throw new Error(`Could not compile ${path}`);
              return { contents: transformed.code, loader: "js" };
            });
          },
        },
      ],
    });
    if (!result.success) throw new AggregateError(result.logs, `Could not bundle panel ${name}`);
    return result.outputs[0]!.text();
  };
  const host = await bundle(
    "host",
    `
import { createComponent } from "solid-js";
import { render } from "solid-js/web";
import ShellRuntime from "./ShellRuntime.island";
import { openPanel, publishPageContext } from "../browser/panel";
render(() => createComponent(ShellRuntime, { panel: true, workspace: { appId: "fixture" }, commands: { searchResources: false } }), document.createElement("div"));
for (const button of document.querySelectorAll("[data-cloud-panel-toggle]")) button.addEventListener("click", () => window.dispatchEvent(new CustomEvent("cloud.panel.request", { detail: { action: "toggle" } })));
document.getElementById("open-panel").addEventListener("click", () => openPanel("fixture"));
document.getElementById("open-silent-panel").addEventListener("click", () => openPanel("fixture", { search: "mode=silent" }));
let disposeContext = () => {};
document.getElementById("change-context")?.addEventListener("click", () => {
  const previous = disposeContext;
  disposeContext = publishPageContext({ scope: { type: "fixture.place", id: "place2" } });
  previous();
});
document.documentElement.dataset.consentFirstFrame = JSON.stringify((${consentGeometry.toString()})());
document.documentElement.dataset.panelFirstFrame = JSON.stringify((${panelGeometry.toString()})());
document.documentElement.dataset.panelHostMounted = "true";
`,
  );
  const provider = await bundle(
    "provider",
    `
import { createComponent } from "solid-js";
import { render } from "solid-js/web";
import PanelRuntime from "./PanelRuntime.island";
import { getContext, onContextChange } from "../browser/panel";
const showContext = () => document.getElementById("panel-context-probe").textContent = JSON.stringify(getContext());
showContext();
onContextChange(showContext);
document.getElementById("prevent-escape").addEventListener("keydown", event => { if (event.key === "Escape") event.preventDefault(); });
if (new URL(location.href).searchParams.get("mode") !== "silent" || document.cookie.includes("fixture_ready=1")) {
  render(() => createComponent(PanelRuntime, { provider: document.querySelector("[data-cloud-panel-page]").dataset.panelProvider }), document.createElement("div"));
}
document.documentElement.dataset.panelProviderMounted = "true";
`,
  );
  const served = Bun.serve({
    port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname;
      if (path.endsWith("/panel")) providerRequests++;
      if (path === "/panel-host.js" || path === "/panel-provider.js")
        return new Response(path === "/panel-host.js" ? host : provider, { headers: { "content-type": "text/javascript" } });
      const response = await server.fetch(request);
      if (!response.headers.get("content-type")?.includes("text/html")) return response;
      const embedded = path.endsWith("/panel");
      const markup = (await response.text())
        .replace(/<script type="module">[^<]*solid-island[^<]*<\/script>/g, "")
        .replace(
          "</head>",
          `<style>${css}</style><style>*,*::before,*::after{transition:none!important;animation:none!important}</style></head>`,
        )
        .replace(
          "</body>",
          embedded
            ? '<script src="/panel-provider.js"></script></body>'
            : `<script>document.documentElement.dataset.consentServerFrame=JSON.stringify((${consentGeometry.toString()})());document.documentElement.dataset.panelServerFrame=JSON.stringify((${panelGeometry.toString()})());</script><script src="/panel-host.js"></script></body>`,
        );
      return new Response(markup, { headers: { "content-type": "text/html; charset=utf-8" } });
    },
  });
  origin = `http://localhost:${served.port}`;
  stop = () => served.stop(true);
  browser = await launchBrowser();
}, 60_000);

afterAll(async () => {
  await browser?.close();
  stop?.();
  for (const spy of spies) spy.mockRestore();
});
const slot = "#cloud-panel";
const separator = ".cloud-panel__resize";
const ready = (page: Page) => page.waitForFunction(() => document.getElementById("cloud-panel")?.dataset.state === "ready");
const closed = (page: Page) => page.waitForFunction(() => document.getElementById("cloud-panel")?.dataset.state === "closed");
const settle = (page: Page) => page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
const panelCookie = async (context: BrowserContext) => (await context.cookies()).find((cookie) => cookie.name === "cloud_panel")?.value;
const modJ = async (page: Page) =>
  (await page.evaluate(() => /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent))) ? "Meta+j" : "Control+j";
async function fixture(width = 1440, cookie?: string, height = 900, ask = false) {
  const context = await browser.newContext({ viewport: { width, height }, locale: "en", timezoneId: "UTC", reducedMotion: "reduce" });
  const personId = crypto.randomUUID();
  consentAnswers.set(
    personId,
    ask
      ? new Map()
      : new Map([
          ["fixture", true],
          ["second", true],
        ]),
  );
  context.on("close", () => consentAnswers.delete(personId));
  try {
    await context.addCookies([
      { name: "fixture_person", value: personId, url: origin },
      { name: "cloud.timezone", value: "UTC", url: origin },
      ...(cookie ? [{ name: "cloud_panel", value: cookie, url: origin }] : []),
    ]);
    const page = await context.newPage();
    await page.goto(`${origin}/app/fixture`);
    await page.waitForFunction(() => document.documentElement.dataset.panelHostMounted === "true");
    return { context, page };
  } catch (error) {
    await context.close();
    throw error;
  }
}
async function open(page: Page) {
  await page.locator("#open-panel").click();
  await ready(page);
}
async function startDrag(page: Page) {
  const rect = await page.locator(separator).boundingBox();
  if (!rect) throw new Error("Missing panel separator");
  const point = { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
  await page.mouse.move(point.x, point.y);
  await page.mouse.down();
  await page.waitForFunction(() => document.getElementById("cloud-panel")?.dataset.resizing === "true");
  return point;
}

// 1: CSS owns all three first-frame rectangles, including the narrowed workspace host.
for (const width of [1440, 1194])
  test(`${width}px: server, first runtime and settled frames agree over ten reloads`, async () => {
    const { context, page } = await fixture(width, "1:fixture:");
    try {
      for (let attempt = 0; attempt < 10; attempt++) {
        if (attempt) await page.reload();
        await page.waitForFunction(() => document.documentElement.dataset.panelFirstFrame !== undefined);
        await ready(page);
        await settle(page);
        const serverFrame = await page.evaluate(() => document.documentElement.dataset.panelServerFrame ?? "");
        expect(await page.evaluate(() => document.documentElement.dataset.panelFirstFrame)).toBe(serverFrame);
        expect(JSON.stringify(await page.evaluate(panelGeometry))).toBe(serverFrame);
        expect(await page.locator(slot).evaluate((el) => el.getBoundingClientRect().width)).toBe(width === 1440 ? 416 : 344);
      }
    } finally {
      await context.close();
    }
  });

// 2: Pointer commit, key steps and bounds share rem units and persistent width.
test("pointer and keyboard resize commit width and ARIA in rem", async () => {
  const { context, page } = await fixture();
  try {
    await open(page);
    // The default changes within column mode too, without committing a width.
    for (const [width, value] of [
      [1194, "21.5"],
      [1440, "26"],
    ] as const) {
      await page.setViewportSize({ width, height: 900 });
      await page.waitForFunction((value) => document.querySelector(".cloud-panel__resize")?.getAttribute("aria-valuenow") === value, value);
    }
    const point = await startDrag(page);
    await page.mouse.move(point.x - 32, point.y);
    await page.mouse.up();
    expect(await page.locator(separator).getAttribute("aria-valuenow")).toBe("28");
    expect((await page.locator(slot).boundingBox())?.width).toBe(448);
    expect(await panelCookie(context)).toBe("1:fixture:28");
    await page.locator(separator).focus();
    await page.keyboard.press("ArrowLeft");
    expect(await panelCookie(context)).toBe("1:fixture:29");
    await page.keyboard.press("Shift+ArrowRight");
    expect(await panelCookie(context)).toBe("1:fixture:25");
    await page.keyboard.press("Home");
    expect(await panelCookie(context)).toBe("1:fixture:20");
    await page.keyboard.press("End");
    expect(await panelCookie(context)).toBe("1:fixture:36");
  } finally {
    await context.close();
  }
});

// 3: The raw close threshold never overwrites the width committed before the drag.
test("close drag shows its hint and keeps the committed width", async () => {
  const { context, page } = await fixture(1440, "0:fixture:24");
  try {
    await open(page);
    const point = await startDrag(page);
    await page.mouse.move(point.x + 160, point.y);
    expect(await page.locator(".cloud-panel__closing").isVisible()).toBe(true);
    expect(await page.locator(".cloud-panel__closing").textContent()).toContain("Release to close the panel");
    expect((await page.locator(slot).boundingBox())?.width).toBe(320);
    await page.mouse.up();
    await closed(page);
    expect(await panelCookie(context)).toBe("0:fixture:24");
    await open(page);
    expect((await page.locator(slot).boundingBox())?.width).toBe(384);
  } finally {
    await context.close();
  }
});

// 4: A hit test proves the iframe cannot consume the resize pointer.
test("resize shield receives hits above the iframe", async () => {
  const { context, page } = await fixture();
  try {
    await open(page);
    await startDrag(page);
    expect(
      await page.locator(".cloud-panel__frame").evaluate((frame) => {
        const rect = frame.getBoundingClientRect();
        return document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)?.classList.contains("cloud-panel__shield");
      }),
    ).toBe(true);
    await page.mouse.up();
    expect(await page.locator(".cloud-panel__shield").isVisible()).toBe(false);
  } finally {
    await context.close();
  }
});

// 5: Exercise the shell command delegation and the provider runtime shortcut.
test("mod+J toggles in the host and closes from a provider input", async () => {
  const { context, page } = await fixture();
  try {
    const shortcut = await modJ(page);
    await page.locator("#open-panel").focus();
    await page.keyboard.press(shortcut);
    await ready(page);
    await page.frameLocator(".cloud-panel__frame").getByRole("textbox", { name: "Panel input" }).focus();
    await page.keyboard.press(shortcut);
    await closed(page);
    await page.keyboard.press(shortcut);
    await ready(page);
    await page.locator("[data-cloud-panel-close]").focus();
    await page.keyboard.press(shortcut);
    await closed(page);
  } finally {
    await context.close();
  }
});

// 6: The provider decides Escape after its own controls have handled it.
test("provider Escape returns focus, while preventDefault keeps it open", async () => {
  const { context, page } = await fixture();
  try {
    await open(page);
    await page.frameLocator(".cloud-panel__frame").getByRole("button", { name: "Keep Escape" }).focus();
    await page.keyboard.press("Escape");
    // Cross the deferred provider task with an explicit round trip, without a sleep.
    await page
      .frameLocator(".cloud-panel__frame")
      .locator("html")
      .evaluate(() => new Promise((done) => setTimeout(done, 0)));
    expect(await page.locator(slot).getAttribute("data-state")).toBe("ready");
    await page.frameLocator(".cloud-panel__frame").getByRole("textbox", { name: "Panel input" }).focus();
    await page.keyboard.press("Escape");
    await closed(page);
    expect(await page.locator("#open-panel").evaluate((button) => button === document.activeElement)).toBe(true);
  } finally {
    await context.close();
  }
});

// 7: Deliver real postMessages from three sources, then drain the task queue with a valid ready.
test("foreign sources, wrong origins and malformed provider messages are ignored", async () => {
  const { context, page } = await fixture();
  try {
    await open(page);
    const drained = page.evaluate(
      () =>
        new Promise<void>((resolve) => {
          const done = (event: MessageEvent<unknown>) => {
            if (event.data !== "fixture.probes.done") return;
            window.removeEventListener("message", done);
            resolve();
          };
          window.addEventListener("message", done);
        }),
    );
    await page.evaluate(() => {
      window.postMessage({ type: "cloud.panel.close" }, location.origin);
      const foreign = document.createElement("iframe");
      foreign.id = "foreign-frame";
      foreign.srcdoc =
        '<body><script>parent.postMessage({type:"cloud.panel.close"},"*");document.body.dataset.probeSent="true"</script></body>';
      document.body.append(foreign);
    });
    await page.frameLocator("#foreign-frame").locator("body[data-probe-sent=true]").waitFor({ state: "attached" });
    await page
      .frameLocator(".cloud-panel__frame")
      .locator("html")
      .evaluate(() => {
        parent.postMessage({ type: "cloud.panel.close", unexpected: true }, location.origin);
        parent.postMessage({ type: "cloud.panel.ready", v: 2, provider: "fixture" }, location.origin);
        const frame = window.frameElement;
        parent.dispatchEvent(
          new MessageEvent("message", { source: window, origin: "https://elsewhere.test", data: { type: "cloud.panel.close" } }),
        );
        frame?.setAttribute("data-probes-sent", "true");
        parent.postMessage({ type: "cloud.panel.ready", v: 1, provider: "fixture" }, location.origin);
        parent.postMessage("fixture.probes.done", location.origin);
      });
    await drained;
    await ready(page);
    expect(await page.locator(".cloud-panel__frame").count()).toBe(1);
  } finally {
    await context.close();
  }
});

// 8: Virtual time, with a per-context fixture cookie enabling the next ready signal.
test("10 s timeout shows failure and retry recovers with a fresh iframe", async () => {
  const { context, page } = await fixture();
  try {
    await page.clock.install({ time: new Date("2026-10-17T12:00:00Z") });
    await page.locator("#open-silent-panel").click();
    await page.frameLocator(".cloud-panel__frame").locator("html[data-panel-provider-mounted='true']").waitFor();
    await page.clock.fastForward(10_000);
    await page.waitForFunction(() => document.getElementById("cloud-panel")?.dataset.state === "failed");
    expect(await page.getByRole("button", { name: "Try again" }).isVisible()).toBe(true);
    await page.locator(".cloud-panel__frame").evaluate((frame) => frame.setAttribute("data-old-frame", "true"));
    await context.addCookies([{ name: "fixture_ready", value: "1", url: origin }]);
    await page.getByRole("button", { name: "Try again" }).click();
    await ready(page);
    expect(await page.locator("iframe[data-old-frame]").count()).toBe(0);
  } finally {
    await context.close();
  }
});

// 9: Drawer positioning never changes the host's layout width.
test("834px drawer overlays the app without narrowing it", async () => {
  const { context, page } = await fixture(834);
  try {
    const before = await page.evaluate(panelGeometry);
    await open(page);
    const after = await page.evaluate(panelGeometry);
    expect(after[0]).toEqual(before[0]);
    expect(after[2]).toEqual(before[2]);
    expect(await page.locator(slot).evaluate((el) => getComputedStyle(el).position)).toBe("absolute");
    expect(await page.locator(separator).isVisible()).toBe(false);
  } finally {
    await context.close();
  }
});

// 10: A persisted desktop state cannot reopen a phone sheet after navigation.
test("390px sheet grows and navigation, popstate and persisted pageshow close it without cookie writes", async () => {
  const before = providerRequests;
  const { context, page } = await fixture(390, "1:fixture:24");
  try {
    expect(await page.locator(slot).isVisible()).toBe(false);
    // The hidden server iframe does not load the provider.
    await settle(page);
    expect(providerRequests).toBe(before);
    await open(page);
    const sheet = await page.locator(slot).boundingBox();
    expect(sheet?.height).toBeCloseTo(900 * 0.58, 0);
    await page.locator("[data-cloud-panel-grow]").click();
    expect(await page.locator(slot).getAttribute("data-panel-size")).toBe("full");
    for (const event of ["popstate", "pageshow"]) {
      await page.evaluate(
        (type) => window.dispatchEvent(type === "pageshow" ? new PageTransitionEvent(type, { persisted: true }) : new PopStateEvent(type)),
        event,
      );
      await closed(page);
      await open(page);
    }
    expect(await panelCookie(context)).toBe("1:fixture:24");
    // The half-height sheet leaves the page's top in reach.
    await page.locator("[data-cloud-panel-grow]").click();
    await page.locator("#next-page").click();
    await page.waitForURL("**/app/fixture/next");
    await page.waitForFunction(() => document.documentElement.dataset.panelHostMounted === "true");
    expect(await page.locator(slot).isVisible()).toBe(false);
    expect(await panelCookie(context)).toBe("1:fixture:24");
  } finally {
    await context.close();
  }
});

// 10b: The page's last row scrolls up above the half-height sheet.
test("390px sheet leaves room to scroll the page's last row above it", async () => {
  const { context, page } = await fixture(390);
  try {
    await page.goto(`${origin}/app/fixture/long`);
    await page.waitForFunction(() => document.documentElement.dataset.panelHostMounted === "true");
    await open(page);
    // Scroll to the very end, whether the page or the app card scrolls.
    await page.evaluate(() => {
      const main = document.querySelector<HTMLElement>(".layout-content-main");
      if (main) main.scrollTop = main.scrollHeight;
      window.scrollTo(0, document.documentElement.scrollHeight);
    });
    await settle(page);
    const last = await page.locator("#last-row").boundingBox();
    const sheet = await page.locator(slot).boundingBox();
    expect(last && sheet && last.y + last.height <= sheet.y).toBe(true);
  } finally {
    await context.close();
  }
});

// 10c: A link that leaves the panel opens in the app, never a second shell in the iframe.
test("a provider link outside the panel navigates the top document", async () => {
  const { context, page } = await fixture(1440, "1:fixture:");
  try {
    await ready(page);
    await page.frameLocator("[data-cloud-panel-frame]").locator("#leave-panel").click();
    await page.waitForURL("**/app/fixture/next");
    await page.waitForFunction(() => document.documentElement.dataset.panelHostMounted === "true");
    await ready(page);
    const frame = page.frameLocator("[data-cloud-panel-frame]");
    expect(await frame.locator("[data-cloud-panel-page]").count()).toBe(1);
    expect(await frame.locator(".cloud-app-canvas").count()).toBe(0);
  } finally {
    await context.close();
  }
});

// 11: A detail waits beside the open column; opening a panel again parks its drawer.
test("opening the panel parks an open workspace detail drawer", async () => {
  const { context, page } = await fixture(1194, "1:fixture:");
  try {
    await ready(page);
    const details = page.locator("[data-app-workspace-detail-toggle]");
    await details.click();
    await page.waitForFunction(
      () => document.getElementById("k2b-workspace-detail-panel-fixture-detail")?.dataset.workspaceDetailDrawer === "open",
    );
    await page.locator('[data-cloud-panel-provider="second"]').click();
    await ready(page);
    expect(await page.locator("#k2b-workspace-detail-panel-fixture-detail").getAttribute("data-workspace-detail-drawer")).toBeNull();
    expect(await details.getAttribute("aria-expanded")).toBe("false");
    // Opening the detail again never closes the panel.
    await details.click();
    await page.waitForFunction(
      () => document.getElementById("k2b-workspace-detail-panel-fixture-detail")?.dataset.workspaceDetailDrawer === "open",
    );
    expect(await page.locator(slot).getAttribute("data-state")).toBe("ready");
  } finally {
    await context.close();
  }
});

// 12: The real workspace follows the host at its 808px threshold from the first paint.
for (const [width, stored, waiting] of [
  [1194, "", true],
  [1440, "", false],
  [1440, "36", true],
] as const)
  test(`${width}px with ${stored || "default"} rem panel: lg Detail waiting=${waiting}`, async () => {
    const { context, page } = await fixture(width, `1:fixture:${stored}`);
    try {
      await settle(page);
      expect(await page.locator("[data-app-workspace-detail-toggle]").isVisible()).toBe(waiting);
      expect(
        await page
          .locator("#k2b-workspace-detail-panel-fixture-detail")
          .evaluate((el) => getComputedStyle(el).getPropertyValue("--k2b-workspace-detail-waiting").trim()),
      ).toBe(waiting ? "1" : "0");
    } finally {
      await context.close();
    }
  });

// 13: Manual tab focus does not switch; activation destroys the previous frame.
test("two provider tabs switch and unload, with one iframe in the DOM", async () => {
  const { context, page } = await fixture();
  try {
    await open(page);
    await page.locator(".cloud-panel__frame").evaluate((frame) => frame.setAttribute("data-old-frame", "true"));
    const first = page.locator('[data-cloud-panel-provider="fixture"]');
    const second = page.locator('[data-cloud-panel-provider="second"]');
    await first.focus();
    await page.keyboard.press("End");
    expect(await second.evaluate((el) => el === document.activeElement)).toBe(true);
    expect(await page.locator(slot).getAttribute("data-provider")).toBe("fixture");
    await page.keyboard.press("Enter");
    await ready(page);
    expect(await page.locator("iframe[data-old-frame]").count()).toBe(0);
    expect(await page.locator(".cloud-panel__frame").count()).toBe(1);
    expect(await second.getAttribute("aria-selected")).toBe("true");
    expect(await first.getAttribute("aria-selected")).toBe("false");
    expect(await panelCookie(context)).toBe("1:second:");
  } finally {
    await context.close();
  }
});

for (const [width, height] of [
  [1440, 900],
  [1194, 834],
] as const)
  test(`${width}x${height}: unanswered consent has identical server, first and settled rectangles`, async () => {
    const { context, page } = await fixture(width, "1:fixture:", height, true);
    try {
      await page.waitForFunction(() => document.documentElement.dataset.consentFirstFrame !== undefined);
      await settle(page);
      await expect(page.locator("[data-cloud-panel-consent]").isVisible()).resolves.toBe(true);
      const serverFrame = await page.evaluate(() => document.documentElement.dataset.consentServerFrame ?? "");
      expect(await page.evaluate(() => document.documentElement.dataset.consentFirstFrame)).toBe(serverFrame);
      expect(JSON.stringify(await page.evaluate(consentGeometry))).toBe(serverFrame);
      expect(await page.locator(slot).getAttribute("data-consent")).toBe("ask");
      expect(await page.locator("[data-cloud-panel-frame]").getAttribute("src")).not.toContain("cloud_panel_context");
    } finally {
      await context.close();
    }
  });

test("Allow delivers the place live; the menu checkbox withdraws it and stops subsequent updates", async () => {
  const { context, page } = await fixture(1440, "1:fixture:", 900, true);
  try {
    // A consent-covered iframe may still be lazy. Wait for its runtime before proving no reload on Allow.
    const frameElement = page.locator("[data-cloud-panel-frame]");
    await frameElement.evaluate((frame) => {
      if (frame instanceof HTMLIFrameElement) frame.loading = "eager";
    });
    await ready(page);
    const provider = page.frameLocator("[data-cloud-panel-frame]");
    expect(await provider.locator("#panel-context-probe").textContent()).toBe("null");
    const before = providerRequests;
    await page.getByRole("button", { name: "Allow", exact: true }).click();
    await page.waitForFunction(() => document.getElementById("cloud-panel")?.dataset.contextAllowed === "true");
    await provider.locator("#panel-context-probe").waitFor();
    await page.waitForFunction(() =>
      document
        .querySelector<HTMLIFrameElement>("[data-cloud-panel-frame]")
        ?.contentDocument?.getElementById("panel-context-probe")
        ?.textContent?.includes('"id":"place1"'),
    );
    expect(providerRequests).toBe(before);
    await page.getByRole("button", { name: "Panel menu", exact: true }).click();
    await page.getByRole("menuitemcheckbox", { name: "Share context", exact: true }).click();
    await page.waitForFunction(
      () =>
        document.getElementById("cloud-panel")?.dataset.contextAllowed === "false" &&
        document.getElementById("cloud-panel")?.dataset.consentSaving === "false",
    );
    await page.waitForFunction(
      () =>
        document.querySelector<HTMLIFrameElement>("[data-cloud-panel-frame]")?.contentDocument?.getElementById("panel-context-probe")
          ?.textContent === "null",
    );
    await page.locator("#change-context").click();
    await settle(page);
    expect(await provider.locator("#panel-context-probe").textContent()).toBe("null");
  } finally {
    await context.close();
  }
});
