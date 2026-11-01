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
let activationEnd: "active" | "not_manager" | "unavailable" = "not_manager";
const activations: unknown[] = [];
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
      if (activationEnd === "unavailable") return Response.json({ code: "INTERNAL", message: "Core nicht erreichbar" }, { status: 503 });
      return Response.json({ data: { id: body.activationId, versionId: body.versionId, state: "preflight", failure: null } });
    }
    if (url.pathname === "/api/code/activation/read") {
      const body = (await request.json()) as { activationId: string };
      return Response.json({
        data: {
          id: body.activationId,
          versionId: "00000000-0000-4000-8000-000000000005",
          state: activationEnd === "active" ? "active" : "failed",
          failure:
            activationEnd === "active"
              ? null
              : { target: { type: "spaces.space", id: "sp_2lg8" }, code: "not_manager", reason: "Target manager authority required" },
        },
      });
    }
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
      for (const state of ["overview", "waiting", "removed", "runs", "run-failed", "versions", "empty", "error"]) {
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

  test("the sidebar marks Code under the open mailbox, after Sent", async () => {
    const page = await load("overview", 1440);
    try {
      const code = page.locator('.mail-sidebar a[href="/app/mail/Mb4kd2/code"]').first();
      await expect(code.getAttribute("aria-current")).resolves.toBe("page");
      const sent = await page.locator(".mail-sidebar").getByText("Gesendet", { exact: true }).first().boundingBox();
      const entry = await code.boundingBox();
      expect(entry!.y).toBeGreaterThan(sent!.y);
    } finally {
      await page.context().close();
    }
  });

  test("switching on lists every operation at its target, then names the target the person does not administer", async () => {
    activationEnd = "not_manager";
    activations.length = 0;
    const page = await load("waiting", 1440);
    try {
      await page.getByRole("button", { name: "Version 5 einschalten" }).first().click();
      const dialog = page.getByRole("dialog");
      await expect(dialog.getByText("Operation an Ziel").isVisible()).resolves.toBe(true);
      await expect(dialog.getByText("du verwaltest info@moebel-beispiel.de").isVisible()).resolves.toBe(true);
      await shoot(page, "einschalten-1440");
      await settled(page);
      const confirm = dialog.getByRole("button", { name: "Version 5 einschalten" });
      const before = await confirm.boundingBox();
      await confirm.click();
      await dialog.getByText("Du bist nicht Admin von Space Logistik.", { exact: false }).waitFor();
      expect(activations).toHaveLength(1);
      await expect(dialog.getByText("Es wurde nichts eingeschaltet, Version 4 läuft weiter.", { exact: false }).isVisible()).resolves.toBe(
        true,
      );
      await expect(dialog.getByText("du bist nicht Admin", { exact: true }).isVisible()).resolves.toBe(true);
      await expect(dialog.getByRole("button", { name: "Link kopieren" }).isVisible()).resolves.toBe(true);
      expect(await confirm.isDisabled()).toBe(true);
      // The confirm button keeps its place while the result appears above it only by growing the dialog downwards.
      expect((await confirm.boundingBox())!.x).toBeCloseTo(before!.x, 0);
      await shoot(page, "blockiert-1440");
      await dialog.getByRole("button", { name: "Schließen", exact: true }).click();
      await expect(page.getByRole("dialog").count()).resolves.toBe(0);
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
      await dialog.getByText("Core nicht erreichbar").waitFor();
      await expect(dialog.getByRole("button", { name: "Erneut versuchen" }).isEnabled()).resolves.toBe(true);
    } finally {
      await page.context().close();
    }
  }, 30_000);

  test("a phone session explains why it cannot switch on", async () => {
    const page = await load("waiting", 390, { phone: true });
    try {
      await page.getByRole("button", { name: "Version 5 einschalten" }).first().click();
      const dialog = page.getByRole("dialog");
      await expect(dialog.getByText("Am Telefon lässt sich Code nicht einschalten.", { exact: false }).isVisible()).resolves.toBe(true);
      expect(await dialog.getByRole("button", { name: "Version 5 einschalten" }).isDisabled()).toBe(true);
      expect(await overflow(page)).toBe(0);
      await shoot(page, "telefon-gesperrt-390");
    } finally {
      await page.context().close();
    }
  });

  test("dark theme keeps the page readable", async () => {
    const page = await load("removed", 1440, { dark: true });
    try {
      const color = await page.locator(".cloud-code__lead").evaluate((element) => getComputedStyle(element).color);
      expect(color).not.toBe("rgb(0, 0, 0)");
      await shoot(page, "removed-dark-1440");
    } finally {
      await page.context().close();
    }
  });
});
