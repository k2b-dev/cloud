import { afterAll, beforeAll, describe, expect, setDefaultTimeout, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { transformAsync } from "@babel/core";
import typescript from "@babel/preset-typescript";
import { createConfig } from "@k2b/ssr";
import tailwind from "bun-plugin-tailwind";
import type { Browser, BrowserContextOptions, Page } from "playwright";
import { hoverInPlace, launchBrowser, pageErrors } from "../../../ui/test/browser";

const root = mkdtempSync(resolve(tmpdir(), "cloud-privacy-screen-browser-"));
const { plugin } = createConfig({ dev: true, rootDir: root });
Bun.plugin(plugin());
process.once("exit", () => rmSync(root, { recursive: true, force: true }));
setDefaultTimeout(30_000);
const railSnapshot = await import("../services/rail-snapshot");
const screenService = await import("../services/screen-preferences");
const settingsMiddleware = await import("./../server/middleware/settings");
const help = await import("./help");
const { defaultRailPreferences } = await import("../contracts/rail-preferences");
const { server } = await import("./privacy-screen.browser-harness");

/** The person's saved timer for the next page load. */
let timer: 0 | 30 | 60 | 120 | 300 = 120;
const START = new Date("2026-11-10T09:00:00Z");

const measure = () => {
  const box = (selector: string) => {
    const rect = document.querySelector(selector)?.getBoundingClientRect();
    return rect ? [rect.x, rect.y, rect.width, rect.height].map((value) => Math.round(value * 100) / 100) : null;
  };
  return {
    rail: box(".layout-rail"),
    app: box(".layout-rail [data-cloud-rail-apps] .rail-item"),
    avatar: box(".layout-rail .layout-profile-preferences"),
    countdown: box(".layout-rail .cloud-privacy-countdown"),
    area: box(".layout-shell-content"),
    subject: box("#subject"),
    reply: box("#reply"),
    scroll: [document.scrollingElement?.scrollTop ?? 0],
  };
};

let browser: Browser;
let origin: string;
let stop: () => void;
const spies: { mockRestore(): void }[] = [];
beforeAll(async () => {
  spies.push(
    spyOn(railSnapshot, "readRailSnapshot").mockResolvedValue(defaultRailPreferences()),
    spyOn(screenService.screenPreferences, "get").mockImplementation(async () => ({ privacyTimerSeconds: timer })),
    spyOn(settingsMiddleware, "preloadLayoutAnnouncements").mockResolvedValue(undefined),
    spyOn(help, "preloadLayoutHelp").mockResolvedValue(null),
  );
  const build = await Bun.build({ entrypoints: [resolve(import.meta.dir, "../../../../styles.css")], plugins: [tailwind] });
  if (!build.success) throw new AggregateError(build.logs, "Could not compile the global stylesheet");
  const css = await build.outputs[0]!.text();
  const solid = (await import(Bun.resolveSync("babel-preset-solid", import.meta.dir))).default;
  const entry = resolve(import.meta.dir, "privacy-screen.runtime-fixture.ts");
  const bundle = await Bun.build({
    entrypoints: [entry],
    files: {
      [entry]: `
import { createComponent } from "solid-js";
import { render } from "solid-js/web";
import ShellRuntime from "./ShellRuntime.island";
import { readShellData } from "./shell-data";
// The real runtime with the timer the server rendered; the harness hydrates no island. "?popout" runs it as a page
// without the command menu, as a pop-out editor does.
const timerSeconds = readShellData()?.privacyTimerSeconds ?? 0;
const popout = new URLSearchParams(location.search).has("popout");
render(
  () =>
    createComponent(ShellRuntime, {
      ...(popout ? {} : { focus: true, commands: { searchResources: false } }),
      privacy: { timerSeconds, name: "Cloud" },
    }),
  document.createElement("div"),
);
`,
    },
    target: "browser",
    conditions: ["browser"],
    format: "iife",
    plugins: [
      {
        name: "solid-privacy-screen-test",
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
  if (!bundle.success) throw new AggregateError(bundle.logs, "Could not bundle the privacy screen runtime");
  const runtime = await bundle.outputs[0]!.text();
  const served = Bun.serve({
    port: 0,
    fetch: async (request) => {
      if (new URL(request.url).pathname === "/privacy-runtime.js")
        return new Response(runtime, { headers: { "content-type": "text/javascript" } });
      const response = await server.fetch(request);
      if (!response.headers.get("content-type")?.includes("text/html")) return response;
      const markup = (await response.text())
        .replace(/<script type="module"[^>]*>[^<]*solid-island[^<]*<\/script>/g, "")
        .replace(
          "</head>",
          `<style>${css}</style><style>*,*::before,*::after{transition:none!important;animation:none!important}</style></head>`,
        )
        .replace("</body>", `<script src="/privacy-runtime.js"></script></body>`);
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

const open = async (options: BrowserContextOptions & { cookies?: { name: string; value: string }[]; search?: string } = {}) => {
  const { cookies, search, ...contextOptions } = options;
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    locale: "de-DE",
    timezoneId: "UTC",
    ...contextOptions,
  });
  await context.addCookies([
    { name: "cloud.timezone", value: "UTC", url: origin },
    ...(cookies ?? []).map((cookie) => ({ ...cookie, url: origin })),
  ]);
  const page = await context.newPage();
  const errors = pageErrors(page);
  // playwright clock: the idle timer, the countdown and the cross-tab deadline are the subject; fake timers drive them.
  await page.clock.install({ time: START });
  await page.goto(`${origin}/app/privacy${search ?? ""}`);
  return { context, page, errors };
};
/** Waits for the runtime: it appends its live region on install. */
const ready = (page: Page) =>
  page.waitForFunction(() => document.querySelector('body > .sr-only[aria-live="polite"][data-cloud-privacy="keep"]'));
const covered = (page: Page) => page.evaluate(() => document.documentElement.dataset.cloudPrivacy === "on");
const counting = (page: Page) => page.evaluate(() => document.documentElement.hasAttribute("data-cloud-privacy-countdown"));
const shortcut = async (page: Page) => page.keyboard.press(process.platform === "darwin" ? "Meta+Period" : "Control+Period");
const live = (page: Page) => page.evaluate(() => document.querySelector('body > .sr-only[aria-live="polite"]')?.textContent ?? "");
const countClicks = (page: Page) =>
  page.evaluate(() => {
    const button = document.getElementById("counter")!;
    button.dataset.count = "0";
    button.addEventListener("click", () => (button.dataset.count = String(Number(button.dataset.count) + 1)));
  });

describe("privacy screen", () => {
  test("the default timer covers after two idle minutes, with a ten-second countdown and no layout shift", async () => {
    timer = 120;
    const { context, page, errors } = await open();
    try {
      await ready(page);
      const before = await page.evaluate(measure);
      expect(before.countdown).not.toBeNull();
      await page.clock.runFor(109_000);
      expect(await counting(page)).toBe(false);
      await page.clock.runFor(1_500);
      expect(await counting(page)).toBe(true);
      expect(await page.locator(".cloud-privacy-countdown").evaluate((element) => getComputedStyle(element).opacity)).toBe("1");
      await page.clock.runFor(100);
      expect(await live(page)).toBe("Sichtschutz in 10 Sekunden. Eine Taste oder Mausbewegung hält ihn auf.");
      expect(await page.evaluate(measure)).toEqual(before);
      await page.clock.runFor(10_000);
      expect(await covered(page)).toBe(true);
      expect(await counting(page)).toBe(false);
      expect(await page.title()).toBe("Cloud");
      expect(await page.locator("#subject").evaluate((element) => Boolean(element.closest("[inert][data-cloud-privacy-covered]")))).toBe(
        true,
      );
      expect(await page.locator("#reply").evaluate((element) => Boolean(element.closest("[inert]")))).toBe(true);
      expect(await page.locator(".layout-rail").getAttribute("data-cloud-privacy-covered")).toBe("rail");
      expect(await page.evaluate(() => document.activeElement?.textContent)).toBe("Weiterarbeiten");
      expect(await page.locator(".cloud-privacy-hint").getAttribute("role")).toBe("dialog");
      expect(await page.locator(".cloud-privacy-hint").getAttribute("aria-modal")).toBeNull();
      // Blur and inert move nothing: the rail, the content and the scroll stay where they were.
      expect(await page.evaluate(measure)).toEqual(before);
      await page.clock.runFor(100);
      expect(await live(page)).toBe("Sichtschutz an, weil du Cloud eine Weile nicht benutzt hast.");
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  });

  test("any input cancels the countdown; a mouse movement, a scroll or a right click never lifts", async () => {
    timer = 30;
    const { context, page } = await open();
    try {
      await ready(page);
      await page.mouse.move(700, 400);
      await page.clock.runFor(21_000);
      expect(await counting(page)).toBe(true);
      await page.mouse.move(720, 420);
      expect(await counting(page)).toBe(false);
      await page.clock.runFor(25_000);
      expect(await covered(page)).toBe(false);
      await page.clock.runFor(6_000);
      expect(await covered(page)).toBe(true);
      await page.mouse.move(760, 440);
      await page.mouse.wheel(0, 200);
      await page.mouse.click(760, 440, { button: "right" });
      expect(await covered(page)).toBe(true);
      expect(await page.locator(".cloud-privacy-hint").getAttribute("data-wake")).toBe("true");
    } finally {
      await context.close();
    }
  });

  test("a click lifts without reaching the page, and focus and input stay", async () => {
    timer = 0;
    const { context, page } = await open();
    try {
      await ready(page);
      await countClicks(page);
      await page.locator("#reply").click();
      await page.keyboard.type("Hallo");
      await shortcut(page);
      expect(await covered(page)).toBe(true);
      // settled: transitions are off and the fake clock holds animation frames; covering never moves the button.
      const target = await page.locator("#counter").boundingBox();
      await page.mouse.click(target!.x + target!.width / 2, target!.y + target!.height / 2);
      expect(await covered(page)).toBe(false);
      expect(await page.locator("#counter").getAttribute("data-count")).toBe("0");
      expect(await page.evaluate(() => document.activeElement?.id)).toBe("reply");
      expect(await page.locator("#reply").inputValue()).toBe("Hallo");
      expect(await page.title()).not.toBe("Cloud");
      await page.mouse.click(target!.x + target!.width / 2, target!.y + target!.height / 2);
      expect(await page.locator("#counter").getAttribute("data-count")).toBe("1");
    } finally {
      await context.close();
    }
  });

  test("a key lifts and is used up until it is released; modifiers alone do not lift", async () => {
    timer = 0;
    const { context, page } = await open();
    try {
      await ready(page);
      await page.locator("#reply").click();
      await page.keyboard.type("Hallo");
      await shortcut(page);
      expect(await covered(page)).toBe(true);
      await page.keyboard.press("Shift");
      expect(await covered(page)).toBe(true);
      await page.keyboard.down("a");
      expect(await covered(page)).toBe(false);
      // Held keys repeat; the lifting key stays used up until its release.
      await page.keyboard.down("a");
      await page.keyboard.up("a");
      expect(await page.locator("#reply").inputValue()).toBe("Hallo");
      await page.keyboard.type("!");
      expect(await page.locator("#reply").inputValue()).toBe("Hallo!");
      // The shortcut also lifts, and is used up like any other key.
      await shortcut(page);
      await shortcut(page);
      expect(await covered(page)).toBe(false);
    } finally {
      await context.close();
    }
  });

  test("the shortcut works over a dialog, which blurs with the page", async () => {
    timer = 0;
    const { context, page } = await open();
    try {
      await ready(page);
      await page.evaluate(() => {
        const dialog = document.createElement("dialog");
        dialog.innerHTML = '<p id="secret">Gehalt 2026</p><button type="button">OK</button>';
        document.body.append(dialog);
        dialog.showModal();
      });
      await shortcut(page);
      expect(await covered(page)).toBe(true);
      expect(await page.evaluate(() => document.querySelector(".cloud-privacy-hint")?.parentElement?.tagName)).toBe("DIALOG");
      expect(await page.locator("#secret").getAttribute("data-cloud-privacy-covered")).toBe("");
      await page.keyboard.press("x");
      expect(await covered(page)).toBe(false);
      expect(await page.evaluate(() => document.querySelector("dialog")?.open)).toBe(true);
    } finally {
      await context.close();
    }
  });

  test("the shared workstation's sign-out warning comes first and its Continue lifts the screen too", async () => {
    timer = 30;
    const { context, page } = await open();
    try {
      await ready(page);
      const warn = () =>
        page.evaluate(() => {
          const dialog = document.createElement("dialog");
          dialog.id = "warning";
          dialog.setAttribute("role", "alertdialog");
          dialog.innerHTML = '<p>Du wirst gleich abgemeldet.</p><button type="button" data-cloud-idle-continue="">Weiterarbeiten</button>';
          dialog.querySelector("button")!.addEventListener("click", () => dialog.close());
          document.body.append(dialog);
          dialog.showModal();
        });
      await warn();
      await shortcut(page);
      expect(await covered(page)).toBe(false);
      // The timer waits while the warning is open.
      await page.clock.runFor(60_000);
      expect(await covered(page)).toBe(false);
      await page.locator("#warning button").click();
      await page.evaluate(() => document.getElementById("warning")?.remove());
      await shortcut(page);
      expect(await covered(page)).toBe(true);
      await warn();
      expect(await page.locator("#warning").getAttribute("data-cloud-privacy-covered")).toBeNull();
      // While the warning is open, keys belong to it and lift nothing.
      await page.keyboard.press("x");
      expect(await covered(page)).toBe(true);
      await page.locator("#warning button").click();
      expect(await covered(page)).toBe(false);
    } finally {
      await context.close();
    }
  });

  test("islands stay sharp and usable; a live island pauses the timer", async () => {
    timer = 30;
    const { context, page } = await open();
    try {
      await ready(page);
      await page.evaluate(() => {
        const cancel = document.getElementById("upload-cancel")!;
        cancel.addEventListener("click", () => (cancel.dataset.clicked = "true"));
      });
      await shortcut(page);
      expect(await page.locator("#upload").getAttribute("data-cloud-privacy-covered")).toBeNull();
      expect(await page.locator("#upload").evaluate((element) => element.closest("[inert]"))).toBeNull();
      expect(await page.locator("#upload-names").getAttribute("data-cloud-privacy-covered")).toBe("part");
      const filter = (element: Element) => getComputedStyle(element.closest("[data-cloud-privacy-covered]")!).filter;
      // settled: transitions are off and the fake clock holds animation frames; the filter applies with the attribute.
      expect(await page.locator("#subject").evaluate(filter)).toContain("blur");
      await page.locator("#upload-cancel").click();
      expect(await page.locator("#upload-cancel").getAttribute("data-clicked")).toBe("true");
      expect(await covered(page)).toBe(true);
      // Enter and Space on an island's button stay with the island; any other key shows the content again.
      await page.keyboard.press("Enter");
      expect(await covered(page)).toBe(true);
      await page.keyboard.press("x");
      expect(await covered(page)).toBe(false);
      await page.evaluate(() => {
        const dictation = document.createElement("div");
        dictation.id = "dictation";
        dictation.dataset.cloudPrivacy = "live";
        dictation.textContent = "Diktat läuft";
        document.querySelector(".k2b-app-workspace__main")!.append(dictation);
      });
      await page.clock.runFor(90_000);
      expect(await covered(page)).toBe(false);
      await page.evaluate(() => document.getElementById("dictation")?.remove());
      await page.clock.runFor(31_000);
      expect(await covered(page)).toBe(true);
    } finally {
      await context.close();
    }
  });

  test("with the timer off the app bar keeps no place and nothing covers on its own", async () => {
    timer = 0;
    const { context, page } = await open();
    try {
      await ready(page);
      expect(await page.locator(".cloud-privacy-countdown").count()).toBe(0);
      await page.clock.runFor(600_000);
      expect(await covered(page)).toBe(false);
      await shortcut(page);
      expect(await covered(page)).toBe(true);
    } finally {
      await context.close();
    }
  });

  test("reduced motion shows the seconds instead of the ring", async () => {
    timer = 30;
    const { context, page } = await open({ reducedMotion: "reduce" });
    try {
      await ready(page);
      await page.clock.runFor(25_000);
      expect(await counting(page)).toBe(true);
      expect(await page.locator(".cloud-privacy-countdown__seconds").textContent()).toBe("5");
      expect(await page.locator(".cloud-privacy-countdown__seconds").isVisible()).toBe(true);
      expect(await page.locator(".cloud-privacy-countdown__ring").isVisible()).toBe(false);
    } finally {
      await context.close();
    }
  });

  test("the wide app bar names the countdown; a hidden app bar shows it as a pill above the avatar", async () => {
    timer = 30;
    const wide = await open({ viewport: { width: 1720, height: 900 } });
    try {
      await ready(wide.page);
      await wide.page.clock.runFor(22_000);
      expect(await wide.page.locator(".cloud-privacy-countdown__label").isVisible()).toBe(true);
      expect(await wide.page.locator(".cloud-privacy-countdown__label").textContent()).toBe("Sichtschutz gleich");
    } finally {
      await wide.context.close();
    }
    const hidden = await open({ cookies: [{ name: "cloud_shell_focus", value: "1" }] });
    try {
      await ready(hidden.page);
      await hidden.page.clock.runFor(22_000);
      const pill = await hidden.page.locator(".cloud-privacy-countdown").boundingBox();
      const avatar = await hidden.page.locator(".layout-rail .layout-profile-preferences").boundingBox();
      expect(pill).not.toBeNull();
      expect(await hidden.page.locator(".cloud-privacy-countdown__label").isVisible()).toBe(true);
      expect(pill!.y + pill!.height).toBeLessThanOrEqual(avatar!.y);
      expect(Math.round(pill!.x)).toBe(Math.round(avatar!.x));
    } finally {
      await hidden.context.close();
    }
  });

  test("all tabs of the browser cover and show together", async () => {
    timer = 0;
    const first = await open();
    try {
      await ready(first.page);
      const second = await first.context.newPage();
      await second.clock.install({ time: START });
      await second.goto(`${origin}/app/privacy`);
      await ready(second);
      await shortcut(first.page);
      await second.waitForFunction(() => document.documentElement.dataset.cloudPrivacy === "on");
      await second.bringToFront();
      await second.keyboard.press("k");
      await first.page.waitForFunction(() => document.documentElement.dataset.cloudPrivacy !== "on");
    } finally {
      await first.context.close();
    }
  });

  test("Enter on the hint's button lifts and is used up; a click on the hint lifts too", async () => {
    timer = 0;
    const { context, page } = await open();
    try {
      await ready(page);
      await page.locator("#reply").click();
      await shortcut(page);
      expect(await page.evaluate(() => document.activeElement?.textContent)).toBe("Weiterarbeiten");
      await page.keyboard.down("Enter");
      expect(await covered(page)).toBe(false);
      await page.keyboard.down("Enter");
      await page.keyboard.up("Enter");
      expect(await page.locator("#reply").inputValue()).toBe("");
      await shortcut(page);
      // settled: transitions are off and the fake clock holds animation frames; the hint shows with the attribute.
      const title = await page.locator(".cloud-privacy-hint__title").boundingBox();
      await page.mouse.click(title!.x + 4, title!.y + 4);
      expect(await covered(page)).toBe(false);
    } finally {
      await context.close();
    }
  });

  test("the hint stays in the middle of the view over a transformed, clipping dialog, and open popovers blur", async () => {
    timer = 0;
    const { context, page } = await open();
    try {
      await ready(page);
      await page.evaluate(() => {
        const dialog = document.createElement("dialog");
        dialog.style.cssText =
          "position:fixed;inset:auto;top:50%;left:50%;width:240px;height:120px;overflow:hidden;transform:translate(-50%,-50%)";
        dialog.innerHTML = "<p>Gehalt 2026</p>";
        document.body.append(dialog);
        dialog.showModal();
        const popover = document.createElement("div");
        popover.id = "menu-popover";
        popover.popover = "manual";
        popover.textContent = "Vertrag Lindner";
        document.querySelector("#subject")!.append(popover);
      });
      await shortcut(page);
      // settled: transitions are off and the fake clock holds animation frames; the hint shows with the attribute.
      const box = await page.locator(".cloud-privacy-hint").boundingBox();
      // settled: the app area never moves while covered.
      const area = await page.locator(".layout-shell-content").boundingBox();
      expect(Math.abs(box!.x + box!.width / 2 - (area!.x + area!.width / 2))).toBeLessThanOrEqual(1);
      expect(box!.width).toBeGreaterThan(240);
      await page.keyboard.press("x");
      await page.evaluate(() => {
        document.querySelector("dialog")?.close();
        (document.getElementById("menu-popover") as HTMLElement).showPopover();
      });
      await shortcut(page);
      expect(await page.locator("#menu-popover").getAttribute("data-cloud-privacy-covered")).toBe("");
      // A popover that opens while covered, inside covered content, covers on its own: opening changes no attribute.
      await page.evaluate(() => {
        const late = document.createElement("div");
        late.id = "late-popover";
        late.popover = "manual";
        late.textContent = "Gehaltsübersicht";
        document.querySelector("#subject")!.append(late);
      });
      await page.evaluate(() => (document.getElementById("late-popover") as HTMLElement).showPopover());
      await page.waitForFunction(() => document.getElementById("late-popover")?.hasAttribute("data-cloud-privacy-covered"));
    } finally {
      await context.close();
    }
  });

  test("text beside an island covers its container, island included; a new island inside covered content stays covered", async () => {
    timer = 0;
    const { context, page } = await open();
    try {
      await ready(page);
      await page.evaluate(() => {
        const mixed = document.createElement("div");
        mixed.id = "mixed";
        mixed.innerHTML = 'Gehalt 120.000 € <span data-cloud-privacy="keep">42 %</span>';
        document.querySelector(".k2b-app-workspace__main")!.append(mixed);
      });
      await shortcut(page);
      expect(await page.locator("#mixed").getAttribute("data-cloud-privacy-covered")).toBe("");
      await page.evaluate(() => {
        const late = document.createElement("div");
        late.id = "late";
        late.dataset.cloudPrivacy = "live";
        late.textContent = "Diktat läuft";
        document.getElementById("subject")!.append(late);
      });
      // The subject holds text of its own, so the dictation inside it stays covered rather than showing the subject.
      await page.waitForFunction(() => document.getElementById("late")?.closest("[data-cloud-privacy-covered]"));
      expect(await page.locator("#upload").getAttribute("data-cloud-privacy-covered")).toBeNull();
      // Text that arrives beside an island later covers its container too.
      await page.evaluate(() => {
        const upload = document.getElementById("upload")!;
        upload.parentElement!.insertBefore(document.createTextNode("Kündigung Mietvertrag"), upload);
      });
      await page.waitForFunction(() => document.getElementById("upload")?.closest("[data-cloud-privacy-covered]"));
    } finally {
      await context.close();
    }
  });

  test("a tab that opens while the others are covered is covered at once", async () => {
    timer = 0;
    const first = await open();
    try {
      await ready(first.page);
      await shortcut(first.page);
      const second = await first.context.newPage();
      await second.clock.install({ time: START });
      await second.goto(`${origin}/app/privacy`);
      await second.waitForFunction(() => document.documentElement.dataset.cloudPrivacy === "on");
    } finally {
      await first.context.close();
    }
  });

  test("after a dictation ends the idle time starts again with its countdown; the first mouse movement counts", async () => {
    timer = 30;
    const { context, page } = await open();
    try {
      await ready(page);
      await page.evaluate(() => {
        const dictation = document.createElement("div");
        dictation.id = "dictation";
        dictation.dataset.cloudPrivacy = "live";
        document.querySelector(".k2b-app-workspace__main")!.append(dictation);
      });
      await page.clock.runFor(90_000);
      await page.evaluate(() => document.getElementById("dictation")?.remove());
      await page.clock.runFor(2_000);
      expect(await covered(page)).toBe(false);
      expect(await counting(page)).toBe(false);
      await page.clock.runFor(20_000);
      expect(await counting(page)).toBe(true);
      // This page has had no pointer movement yet: the first one stops the countdown.
      await page.mouse.move(600, 300);
      expect(await counting(page)).toBe(false);
    } finally {
      await context.close();
    }
  });

  test("a pop-out editor shows the countdown as a pill and covers with the shortcut", async () => {
    timer = 30;
    // The fixture runs the runtime without the command menu, as the pop-out's own Layout does.
    const { context, page } = await open({ search: "/popout?popout" });
    try {
      await ready(page);
      await page.clock.runFor(22_000);
      expect(await counting(page)).toBe(true);
      expect(await page.locator(".cloud-privacy-float .cloud-privacy-countdown__label").isVisible()).toBe(true);
      await page.locator("#draft").click();
      expect(await counting(page)).toBe(false);
      await shortcut(page);
      expect(await covered(page)).toBe(true);
      await page.keyboard.press("x");
      expect(await covered(page)).toBe(false);
    } finally {
      await context.close();
    }
  });

  test("the profile menu is 18 rem and every entry stays on one line, also with a longer translation", async () => {
    timer = 120;
    for (const locale of ["de-DE", "en-US"]) {
      const { context, page } = await open({ locale });
      try {
        await ready(page);
        await hoverInPlace(page.locator(".layout-profile-preferences__link"));
        const rows = () =>
          page.evaluate(() => {
            const panel = document.querySelector<HTMLElement>(".layout-profile-preferences__panel")!;
            return {
              width: Math.round(panel.getBoundingClientRect().width),
              rows: [...panel.querySelectorAll<HTMLElement>(".menu-item")]
                .filter((row) => row.checkVisibility())
                .map((row) => {
                  const label = row.querySelector<HTMLElement>(":scope > span:last-of-type")!;
                  const line = Number.parseFloat(getComputedStyle(label).lineHeight);
                  return {
                    text: label.textContent,
                    oneLine: label.getBoundingClientRect().height <= line + 1,
                    clipped: label.scrollWidth > label.clientWidth + 0.5,
                  };
                }),
            };
          });
        // settled: transitions are off and the fake clock holds animation frames; the panel shows on hover.
        const shown = await rows();
        // 18 rem: the smallest width where "Gemeinsam genutzter Arbeitsplatz" fits beside its check box.
        expect(shown.width).toBe(288);
        expect(shown.rows.every((row) => row.oneLine)).toBe(true);
        // The labels the menu ships fit without an ellipsis.
        expect(shown.rows.filter((row) => row.clipped)).toEqual([]);
        // A longer translation ends in an ellipsis instead of wrapping.
        await page.evaluate(() => {
          const label = document.querySelector('.layout-profile-preferences__panel [role="switch"] > span:last-of-type')!;
          label.textContent = "Gemeinsam genutzter Arbeitsplatz für mehrere Personen am Empfang";
        });
        // settled: a text change animates nothing; layout follows synchronously in the read.
        const long = await rows();
        expect(long.rows.every((row) => row.oneLine)).toBe(true);
        expect(long.rows.filter((row) => row.clipped).map((row) => row.text)).toEqual([
          "Gemeinsam genutzter Arbeitsplatz für mehrere Personen am Empfang",
        ]);
      } finally {
        await context.close();
      }
    }
  });

  test("the command to set the timer leads to the section on /me", async () => {
    timer = 120;
    const { context, page } = await open();
    try {
      await ready(page);
      await page.evaluate(async () => {
        const detail: { commands: { id: string; action: unknown }[] } = { commands: [] };
        window.dispatchEvent(new CustomEvent("cloud.command.collect", { detail }));
        const command = detail.commands.find((entry) => entry.id === "cloud.privacy.timer");
        if (typeof command?.action === "function") await command.action();
      });
      await page.waitForURL((url) => url.pathname === "/me" && url.hash === "#screen");
    } finally {
      await context.close();
    }
  });

  test("touch-only devices have no privacy screen", async () => {
    timer = 120;
    const { context, page } = await open({ viewport: { width: 1024, height: 1366 }, hasTouch: true, isMobile: true });
    try {
      await page.waitForFunction(() => document.querySelector(".layout-rail"));
      expect(await page.locator(".cloud-privacy-countdown").isVisible()).toBe(false);
      await page.clock.runFor(200_000);
      await shortcut(page);
      expect(await covered(page)).toBe(false);
      expect(await page.locator(".cloud-privacy-hint").count()).toBe(0);
    } finally {
      await context.close();
    }
  });
});
