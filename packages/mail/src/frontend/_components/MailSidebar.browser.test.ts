import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Browser, Page } from "playwright";
import { launchBrowser, settled } from "../../../../ui/test/browser";
import type { MailSidebarHarnessOptions } from "./MailSidebar.browser-harness";

// The mailbox list's quiet rows: Hidden, and the Mailboxes menu with New mailbox and Deleted mailboxes. Set
// MAIL_SIDEBAR_SCREENSHOTS to a directory for synthetic review screenshots with invented names.
const screenshots = process.env.MAIL_SIDEBAR_SCREENSHOTS;

const buildHarness = async (): Promise<string> => {
  const ui = new URL("../../../../ui/", import.meta.url).pathname;
  const { transformAsync } = await import(Bun.resolveSync("@babel/core", ui));
  const typescript = (await import(Bun.resolveSync("@babel/preset-typescript", ui))).default;
  const solid = (await import(Bun.resolveSync("babel-preset-solid", ui))).default;
  const build = await Bun.build({
    entrypoints: [new URL("./MailSidebar.browser-harness.tsx", import.meta.url).pathname],
    target: "browser",
    format: "iife",
    conditions: ["browser"],
    plugins: [
      {
        name: "solid-mail-sidebar-test",
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
  if (!build.success) throw new AggregateError(build.logs, "Mail sidebar harness build failed");
  return build.outputs[0]!.text();
};

const buildCss = async (entry: string): Promise<string> => {
  const tailwind = (await import(Bun.resolveSync("bun-plugin-tailwind", new URL("../../../../cloud/", import.meta.url).pathname))).default;
  const build = await Bun.build({ entrypoints: [entry], plugins: [tailwind] });
  if (!build.success) throw new AggregateError(build.logs, `Could not compile ${entry}`);
  return build.outputs[0]!.text();
};

const harness = await buildHarness();
const css =
  (await buildCss(resolve(import.meta.dir, "../../../../../styles.css"))) +
  (await buildCss(resolve(import.meta.dir, "../../styles/app.css")));
const ui = resolve(import.meta.dir, "../../../../ui/dist");

const visible = ["Studio", "Support", "Rechnungen", "Presse", "Vereinsvorstand", "Newsletter"];
const hidden = [
  "Agentur 2019",
  "Bewerbungen",
  "Domains",
  "Elternbeirat",
  "Fotoclub",
  "Hochzeit 2024",
  "Kita",
  "Lieferanten",
  "Mieterverein",
  "Projekt Nordlicht",
  "Reisen",
  "Sportverein",
  "Testpostfach",
  "Umzug",
  "Wohnungssuche",
];
const deletedNames = ["Altes Projekt", "Testpostfach 2"];
/** What the deleted-mailboxes request answers: invented names, or none. */
let deleted: string[] = deletedNames;

const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/harness.js") return new Response(harness, { headers: { "Content-Type": "text/javascript; charset=utf-8" } });
    if (url.pathname === "/styles.css") return new Response(css, { headers: { "Content-Type": "text/css; charset=utf-8" } });
    if (url.pathname.startsWith("/ui/")) return new Response(Bun.file(join(ui, url.pathname.slice(4))));
    if (url.pathname === "/api/mail/mailboxes/deleted")
      return Response.json({
        items: deleted.map((name, index) => ({
          id: `Del00${index + 1}`,
          name,
          deletedAt: `2026-10-0${index + 2}T09:00:00.000Z`,
          permission: "admin",
        })),
        nextCursor: null,
      });
    return new Response(
      '<!doctype html><html class="light" style="--app-accent:#0f766e"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">' +
        '<link rel="stylesheet" href="/ui/plex.css"><link rel="stylesheet" href="/ui/tabler.css">' +
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

const load = async (
  options: Partial<MailSidebarHarnessOptions> & { width?: number; theme?: "light" | "dark"; deleted?: string[] } = {},
) => {
  deleted = options.deleted ?? deletedNames;
  const page = await (await browser.newContext({ viewport: { width: options.width ?? 1440, height: 900 } })).newPage();
  page.setDefaultTimeout(10_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(server.url.href);
  if (options.theme === "dark") await page.evaluate(() => document.documentElement.classList.replace("light", "dark"));
  await page.evaluate((harnessOptions: MailSidebarHarnessOptions) => window.mountMailSidebar(harnessOptions), {
    locale: options.locale ?? "de",
    mailboxes: options.mailboxes ?? [...visible, ...hidden],
    hidden: options.hidden ?? hidden.map((_, index) => visible.length + index),
    canCreate: options.canCreate ?? true,
  } satisfies MailSidebarHarnessOptions);
  await page.evaluate(() => document.fonts.ready);
  await settled(page);
  return Object.assign(page, { errors });
};
const close = (page: Page) => page.context().close();

/** Saves the sidebar and the room a menu or dialog opens into, as `<name>-<theme>-<width>.png`. */
const shot = async (page: Page, name: string, theme: "light" | "dark" = "light") => {
  if (!screenshots) return;
  mkdirSync(screenshots, { recursive: true });
  const width = page.viewportSize()!.width;
  await page.screenshot({
    path: join(screenshots, `${name}-${theme}-${width}.png`),
    clip: { x: 0, y: 0, width: Math.min(width, 760), height: 900 },
  });
};

const menu = (page: Page) => page.getByRole("button", { name: "Aktionen für die Postfachliste" });
/** A pointer reaches the heading's menu as a person does: it shows on hover. */
const openMenu = async (page: Page) => {
  await page.locator(".k2b-app-workspace__sidebar-section-header").first().hover();
  await menu(page).click();
};

test("hidden mailboxes fold into one quiet row, and the Mailboxes menu holds New mailbox and Deleted mailboxes", async () => {
  const page = await load();
  try {
    // No footer entries any more: both actions live in the heading's menu.
    expect(await page.locator(".k2b-app-workspace__sidebar-footer").count()).toBe(0);
    const toggle = page.locator("button.mail-sidebar-hidden-toggle, .mail-sidebar-hidden-toggle button");
    expect((await toggle.innerText()).replace(/\s+/g, " ").trim()).toBe("Ausgeblendet 15");
    // The row is as quiet as the other mailboxes, not a bold heading.
    const label = toggle.locator(".k2b-app-workspace__sidebar-item-label");
    expect(await label.evaluate((el) => getComputedStyle(el).fontWeight)).toBe("400");
    expect(await page.getByRole("link", { name: /Agentur 2019/ }).count()).toBe(0);
    await toggle.click();
    await page.getByRole("link", { name: /Agentur 2019/ }).waitFor();
    await toggle.click();
    expect(await page.getByRole("link", { name: /Agentur 2019/ }).count()).toBe(0);

    await openMenu(page);
    expect(await page.getByRole("menuitem").allInnerTexts()).toEqual(["Neues Postfach", "Gelöschte Postfächer"]);
    await page.getByRole("menuitem", { name: "Gelöschte Postfächer" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByRole("button", { name: "Altes Projekt wiederherstellen" }).waitFor();
    expect(await dialog.getByRole("button", { name: "Testpostfach 2 wiederherstellen" }).count()).toBe(1);
    // Choosing one closes the list and asks before it restores, as before.
    await dialog.getByRole("button", { name: "Altes Projekt wiederherstellen" }).click();
    await page.getByRole("button", { name: "Postfach wiederherstellen" }).waitFor();
    expect(page.errors).toEqual([]);
  } finally {
    await close(page);
  }
}, 30_000);

test("without hidden mailboxes there is no Hidden row, and without creation rights the menu keeps Deleted mailboxes", async () => {
  const page = await load({ mailboxes: visible, hidden: [], canCreate: false });
  try {
    expect(await page.locator(".mail-sidebar-hidden-toggle").count()).toBe(0);
    await openMenu(page);
    expect(await page.getByRole("menuitem").allInnerTexts()).toEqual(["Gelöschte Postfächer"]);
    expect(page.errors).toEqual([]);
  } finally {
    await close(page);
  }
}, 30_000);

test.if(Boolean(screenshots))(
  "review screenshots of the sidebar states",
  async () => {
    for (const theme of ["light", "dark"] as const) {
      const page = await load({ theme });
      await shot(page, "01-sidebar-default", theme);
      await page.locator(".k2b-app-workspace__sidebar-section-header").first().hover();
      await shot(page, "02-sidebar-hover-heading", theme);
      await menu(page).click();
      await page.getByRole("menuitem", { name: "Gelöschte Postfächer" }).waitFor();
      await shot(page, "03-menu-open", theme);
      await page.getByRole("menuitem", { name: "Gelöschte Postfächer" }).click();
      await page.getByRole("button", { name: "Altes Projekt wiederherstellen" }).waitFor();
      await settled(page);
      await page.screenshot({ path: join(screenshots!, `05-deleted-dialog-${theme}-1440.png`) });
      await close(page);
    }
    {
      const page = await load();
      const toggle = page.locator("button.mail-sidebar-hidden-toggle, .mail-sidebar-hidden-toggle button");
      console.info(
        "hidden count color",
        await toggle.locator(".k2b-app-workspace__sidebar-item-meta").evaluate((el) => getComputedStyle(el).color),
      );
      await toggle.click();
      await settled(page);
      await shot(page, "04-hidden-open");
      await close(page);
    }
    {
      // Keyboard: Tab from the first mailbox back to the heading's menu shows it with the focus ring.
      const page = await load();
      await menu(page).focus();
      await page.keyboard.press("Enter");
      await page.getByRole("menuitem", { name: "Neues Postfach" }).waitFor();
      await shot(page, "06-keyboard-menu");
      await close(page);
    }
    {
      const page = await load({ deleted: [] });
      await openMenu(page);
      await page.getByRole("menuitem", { name: "Gelöschte Postfächer" }).click();
      await page.getByText("Keine gelöschten Postfächer").waitFor();
      await settled(page);
      await page.screenshot({ path: join(screenshots!, "07-deleted-empty-light-1440.png") });
      await close(page);
    }
    {
      const page = await load({ mailboxes: visible, hidden: [], canCreate: false });
      await openMenu(page);
      await page.getByRole("menuitem", { name: "Gelöschte Postfächer" }).waitFor();
      await shot(page, "08-no-hidden-no-create");
      await close(page);
    }
    {
      const page = await load({ width: 1024 });
      await shot(page, "09-narrow-sidebar");
      await close(page);
    }
  },
  120_000,
);
