import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Browser, BrowserContextOptions, Page } from "playwright";
import { launchBrowser, settled } from "../../../ui/test/browser";

// The shared Code page inside Mail: layout at real widths, the switch-on flow with Core's answers, and recovery.
const buildHarness = async (): Promise<string> => {
  const ui = new URL("../../../ui/", import.meta.url).pathname;
  const { transformAsync } = await import(Bun.resolveSync("@babel/core", ui));
  const typescript = (await import(Bun.resolveSync("@babel/preset-typescript", ui))).default;
  const solid = (await import(Bun.resolveSync("babel-preset-solid", ui))).default;
  const build = await Bun.build({
    entrypoints: [new URL("./MailboxCode.browser-harness.tsx", import.meta.url).pathname],
    target: "browser",
    format: "iife",
    conditions: ["browser"],
    plugins: [
      {
        name: "solid-mailbox-code-test",
        setup(builder) {
          builder.onLoad({ filter: /\.tsx$/ }, async ({ path }) => {
            const result = await transformAsync(await Bun.file(path).text(), {
              filename: path,
              babelrc: false,
              configFile: false,
              presets: [typescript, [solid, { generate: "dom", hydratable: false }]],
            });
            return { contents: result.code, loader: "js" };
          });
        },
      },
    ],
  });
  if (!build.success) throw new AggregateError(build.logs, "Mailbox Code harness build failed");
  return build.outputs[0]!.text();
};

const buildCss = async (entry: string): Promise<string> => {
  const tailwind = (await import(Bun.resolveSync("bun-plugin-tailwind", new URL("../../../cloud/", import.meta.url).pathname))).default;
  const build = await Bun.build({ entrypoints: [entry], plugins: [tailwind] });
  if (!build.success) throw new AggregateError(build.logs, `Could not compile ${entry}`);
  return build.outputs[0]!.text();
};

const harness = await buildHarness();
const css =
  (await buildCss(resolve(import.meta.dir, "../../../../styles.css"))) + (await buildCss(resolve(import.meta.dir, "../styles/app.css")));
// Screenshots show the real icons: the Tabler font is served beside the stylesheet.
const iconCss = fileURLToPath(import.meta.resolve("@k2b/ui/icons/tabler.css"));
const iconSource = await Bun.file(iconCss).text();
const iconFont = iconSource.match(/url\((\.\/[^)"']+\.woff2)[^)]*\)/)?.[1];
if (!iconFont) throw new Error("Missing Tabler WOFF2 file");
const icons = { css: iconSource.replace(iconFont, "/tabler.woff2"), font: resolve(dirname(iconCss), iconFont) };
/** What Core answers while the person switches on: the activation's final state. */
let activationEnd: "active" | "owner_refused" | "unavailable" | "lost-active" | "silent" = "active";
const activations: unknown[] = [];
const unexpectedRoutes: string[] = [];
const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/harness.js") return new Response(harness, { headers: { "Content-Type": "text/javascript; charset=utf-8" } });
    if (url.pathname === "/styles.css") return new Response(css + icons.css, { headers: { "Content-Type": "text/css; charset=utf-8" } });
    if (url.pathname === "/tabler.woff2") return new Response(Bun.file(icons.font), { headers: { "Content-Type": "font/woff2" } });
    if (url.pathname === "/api/code/activate") {
      const body = (await request.json()) as { activationId: string; versionId: string };
      activations.push(body);
      // Core's answer gets lost on the way back: it may or may not have accepted.
      if (activationEnd === "unavailable" || activationEnd === "lost-active" || activationEnd === "silent")
        return Response.json({ code: "INTERNAL", message: "Core nicht erreichbar" }, { status: 503 });
      return Response.json({ data: { id: body.activationId, versionId: body.versionId, state: "preflight", failure: null } });
    }
    if (url.pathname === "/api/code/activation/read") {
      const body = (await request.json()) as { activationId: string };
      // The refusal names the target the harness was told about, with its title and manager even where it should not.
      if (activationEnd === "owner_refused")
        return Response.json({
          data: {
            id: body.activationId,
            versionId: "00000000-0000-4000-8000-000000000005",
            state: "failed",
            failure: { target: null, code: "not_owner_manager", reason: "Nur Verwalter des Besitzers können Code einschalten." },
          },
        });
      if (activationEnd === "unavailable") return Response.json({ code: "NOT_FOUND", message: "Activation not found." }, { status: 404 });
      if (activationEnd === "silent") return Response.json({ code: "INTERNAL", message: "Core nicht erreichbar" }, { status: 503 });
      return Response.json({
        data: {
          id: body.activationId,
          versionId: "00000000-0000-4000-8000-000000000005",
          state: "active",
          failure: null,
        },
      });
    }
    if (url.pathname.startsWith("/api/")) unexpectedRoutes.push(url.pathname);
    return new Response(
      '<!doctype html><html class="light" style="--app-accent:#2563eb"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">' +
        '<link rel="stylesheet" href="/styles.css"><style>#root{position:fixed;inset:0;display:flex}</style></head>' +
        '<body class="k2b-ui" style="margin:0"><div id="root"></div><script src="/harness.js"></script></body></html>',
      { headers: { "Content-Type": "text/html" } },
    );
  },
});

let browser: Browser;
beforeAll(async () => {
  browser = await launchBrowser();
}, 30_000);
afterAll(async () => {
  await browser?.close();
  server.stop(true);
});

const widths = { desktop: 1440, tablet: 1024, phone: 390 } as const;
const contextFor = (width: number): BrowserContextOptions =>
  width < 768
    ? { viewport: { width, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 }
    : { viewport: { width, height: 900 } };
/** Set CODE_PAGE_SHOTS to a directory to keep light screenshots of every state for review. */
const shots = process.env.CODE_PAGE_SHOTS;
if (shots) mkdirSync(shots, { recursive: true });

const load = async (state: string, width: number, options: { phone?: boolean; dark?: boolean } = {}): Promise<Page> => {
  const page = await (await browser.newContext(contextFor(width))).newPage();
  await page.goto(server.url.href);
  if (options.dark) await page.evaluate(() => document.documentElement.classList.replace("light", "dark"));
  await page.evaluate((params) => window.mountMailboxCode(params as Parameters<typeof window.mountMailboxCode>[0]), {
    state,
    locale: "de",
    phone: options.phone,
  });
  await settled(page);
  return page;
};
const shoot = async (page: Page, name: string) => {
  if (shots) await page.screenshot({ path: resolve(shots, `${name}.png`), fullPage: false });
};
const overflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

describe("Mailbox Code page in a browser", () => {
  for (const [name, width] of Object.entries(widths))
    test(`${name} ${width}px: every state fits without horizontal scrolling`, async () => {
      for (const state of [
        "overview",
        "waiting",
        "refused",
        "refused-nolink",
        "refused-reader",
        "refused-policy",
        "refused-approval",
        "internet",
        "runs",
        "run-failed",
        "versions",
        "empty",
        "error",
      ]) {
        const page = await load(state, width);
        try {
          expect({ state, overflow: await overflow(page) }).toEqual({ state, overflow: 0 });
          expect(await page.locator(".cloud-code").count()).toBe(1);
          await shoot(page, `${state}-${width}`);
        } finally {
          await page.context().close();
        }
      }
    }, 60_000);

  test("the page is titled Code and its row titles stay smaller than the section headings", async () => {
    for (const width of [1440, 390])
      for (const state of ["overview", "runs", "versions", "empty"]) {
        const page = await load(state, width);
        try {
          const measured = await page.evaluate(() => {
            const size = (element: Element) => Number.parseFloat(getComputedStyle(element).fontSize);
            const heading = document.querySelector(".cloud-code__h2");
            return {
              title: (document.querySelector(".cloud-code h1 [aria-hidden=true]") as HTMLElement | null)?.innerText,
              rowsAboveHeading: heading
                ? Array.from(document.querySelectorAll(".cloud-code__title")).filter((row) => size(row) > size(heading)).length
                : 0,
            };
          });
          expect({ state, width, ...measured }).toEqual({ state, width, title: "Code", rowsAboveHeading: 0 });
        } finally {
          await page.context().close();
        }
      }
  }, 60_000);

  test("the sidebar shows a warning dot, never a number, when the Code needs attention", async () => {
    for (const [state, dot] of [
      ["refused", true],
      ["overview", false],
    ] as const) {
      const page = await load(state, 1440);
      try {
        const entry = page.locator('.mail-sidebar a[href="/app/mail/Mb4kd2/code"]').first();
        const mark = entry.locator(".k2b-app-workspace__sidebar-status-attention");
        expect(await mark.count()).toBe(dot ? 1 : 0);
        if (dot) {
          expect(await mark.isVisible()).toBe(true);
          expect(await entry.getByText(", Code braucht Aufmerksamkeit").count()).toBe(1);
        }
        expect(/\d/.test((await entry.textContent()) ?? "")).toBe(false);
      } finally {
        await page.context().close();
      }
    }
  }, 30_000);

  test("the sidebar marks Code under the open mailbox, after Sent", async () => {
    const page = await load("overview", 1440);
    try {
      const code = page.locator('.mail-sidebar a[href="/app/mail/Mb4kd2/code"]').first();
      expect(await code.getAttribute("aria-current")).toBe("page");
      const sent = await page.locator(".mail-sidebar").getByText("Gesendet", { exact: true }).first().boundingBox();
      const entry = await code.boundingBox();
      expect(entry!.y).toBeGreaterThan(sent!.y);
    } finally {
      await page.context().close();
    }
  });

  test("switching on uses current account rights and makes no target preflight request", async () => {
    activationEnd = "active";
    activations.length = 0;
    unexpectedRoutes.length = 0;
    const page = await load("waiting", 1440);
    try {
      await page.getByRole("button", { name: "Version 5 einschalten" }).first().click();
      const dialog = page.getByRole("dialog");
      expect((await dialog.textContent()) ?? "").not.toContain("Operation an Ziel");
      expect((await dialog.textContent()) ?? "").not.toContain("du verwaltest");
      await dialog.getByRole("button", { name: "Version 5 einschalten" }).click();
      await page.waitForURL(/activated=5/);
      expect(activations).toHaveLength(1);
      expect(unexpectedRoutes).toEqual([]);
    } finally {
      await page.context().close();
    }
  }, 30_000);

  test("lost owner authority leaves the old version active and offers retry", async () => {
    activationEnd = "owner_refused";
    const page = await load("waiting", 1440);
    try {
      await page.getByRole("button", { name: "Version 5 einschalten" }).first().click();
      const dialog = page.getByRole("dialog");
      await dialog.getByRole("button", { name: "Version 5 einschalten" }).click();
      await dialog.getByText("Nur Verwalter des Besitzers können Code einschalten.", { exact: false }).waitFor();
      expect((await dialog.textContent()) ?? "").toContain("Version 4 läuft weiter");
      expect(await dialog.getByRole("button", { name: "Erneut versuchen" }).isEnabled()).toBe(true);
    } finally {
      await page.context().close();
    }
  }, 30_000);

  test("when Core cannot start switching on, nothing changed and the person can try again", async () => {
    activationEnd = "unavailable";
    const page = await load("waiting", 1024);
    try {
      await page.getByRole("button", { name: "Version 5 einschalten" }).first().click();
      const dialog = page.getByRole("dialog");
      await dialog.getByRole("button", { name: "Version 5 einschalten" }).click();
      // The answer was lost, and Core knows no such activation: nothing changed, and trying again is safe.
      await dialog.getByText("Cloud konnte das Einschalten nicht starten. Es hat sich nichts geändert.").waitFor();
      expect(await dialog.getByRole("button", { name: "Erneut versuchen" }).isEnabled()).toBe(true);
    } finally {
      await page.context().close();
    }
  }, 30_000);

  test("when Core's answer is lost but it switched on, the page shows the result instead of a false failure", async () => {
    activationEnd = "lost-active";
    activations.length = 0;
    const page = await load("waiting", 1440);
    try {
      await page.getByRole("button", { name: "Version 5 einschalten" }).first().click();
      await page.getByRole("dialog").getByRole("button", { name: "Version 5 einschalten" }).click();
      await page.waitForURL(/activated=5/);
      expect(activations).toHaveLength(1);
    } finally {
      await page.context().close();
    }
  }, 30_000);

  test("an unconfirmed attempt survives closing the dialog and is resumed by reading its status, never by starting another", async () => {
    activationEnd = "silent";
    activations.length = 0;
    const page = await load("waiting", 1440);
    try {
      await page.getByRole("button", { name: "Version 5 einschalten" }).first().click();
      const dialog = page.getByRole("dialog");
      await dialog.getByRole("button", { name: "Version 5 einschalten" }).click();
      await dialog.getByText("Cloud hat noch nicht bestätigt.", { exact: false }).waitFor();
      expect(await dialog.getByRole("button", { name: "Stand prüfen" }).isEnabled()).toBe(true);
      await dialog.getByRole("button", { name: "Schließen", exact: true }).click();
      // Core finished in the meantime; reopening asks for that attempt's status.
      activationEnd = "lost-active";
      await page.getByRole("button", { name: "Version 5 einschalten" }).first().click();
      await page.waitForURL(/activated=5/);
      expect(activations).toHaveLength(1);
    } finally {
      await page.context().close();
    }
  }, 30_000);

  test("a phone session explains why it cannot switch on", async () => {
    const page = await load("waiting", 390, { phone: true });
    try {
      await page.getByRole("button", { name: "Version 5 einschalten" }).first().click();
      const dialog = page.getByRole("dialog");
      expect(await dialog.getByText("Am Telefon lässt sich Code nicht einschalten.", { exact: false }).isVisible()).toBe(true);
      expect(await dialog.getByRole("button", { name: "Version 5 einschalten" }).isDisabled()).toBe(true);
      expect(await overflow(page)).toBe(0);
      await shoot(page, "telefon-gesperrt-390");
    } finally {
      await page.context().close();
    }
  });

  test("dark theme keeps the page readable", async () => {
    const page = await load("refused", 1440, { dark: true });
    try {
      const color = await page.locator(".cloud-code__lead").evaluate((element) => getComputedStyle(element).color);
      expect(color).not.toBe("rgb(0, 0, 0)");
      await shoot(page, "refused-dark-1440");
    } finally {
      await page.context().close();
    }
  });
});
