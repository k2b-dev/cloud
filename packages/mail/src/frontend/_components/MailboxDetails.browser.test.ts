import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import type { Browser, BrowserContextOptions, Page } from "playwright";
import { launchBrowser } from "../../../../ui/test/browser";
import type { SenderIdentity } from "../../contracts";
import type { MailboxDetails } from "../../service/mailbox-details";
import type { MailboxDetailsHarnessOptions } from "./MailboxDetails.browser-harness";

// Whether the details button is square beside Compose, keeps its place while loading, and whether the dialog takes
// focus and fits a phone are layout and focus questions, which only a real engine answers.
const buildHarness = async (): Promise<string> => {
  const ui = new URL("../../../../ui/", import.meta.url).pathname;
  const { transformAsync } = await import(Bun.resolveSync("@babel/core", ui));
  const typescript = (await import(Bun.resolveSync("@babel/preset-typescript", ui))).default;
  const solid = (await import(Bun.resolveSync("babel-preset-solid", ui))).default;
  const build = await Bun.build({
    entrypoints: [new URL("./MailboxDetails.browser-harness.tsx", import.meta.url).pathname],
    target: "browser",
    format: "iife",
    conditions: ["browser"],
    plugins: [
      {
        name: "solid-mailbox-details-test",
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
  if (!build.success) throw new AggregateError(build.logs, "Mailbox details harness build failed");
  return build.outputs[0]!.text();
};

const buildCss = async (entry: string): Promise<string> => {
  // The production stylesheets compile through Cloud's Tailwind plugin.
  const tailwind = (await import(Bun.resolveSync("bun-plugin-tailwind", new URL("../../../../cloud/", import.meta.url).pathname))).default;
  const build = await Bun.build({ entrypoints: [entry], plugins: [tailwind] });
  if (!build.success) throw new AggregateError(build.logs, `Could not compile ${entry}`);
  return build.outputs[0]!.text();
};

const identity = (fromAddress: string, displayName: string, isDefault = false) =>
  ({ id: `Id${displayName.length}`, fromAddress, displayName, label: displayName, isDefault, status: "verified" }) as SenderIdentity;
const identities = [identity("support@example.test", "Support Team", true), identity("billing@example.test", "Billing")];

const user = (id: string, displayName: string) => ({ id, uid: displayName.toLowerCase(), displayName, mail: null, avatarHash: null });
const details: MailboxDetails = {
  access: [
    {
      id: "00000000-0000-4000-8000-000000000001",
      principal: { type: "user", userId: "00000000-0000-4000-8000-0000000000a1" },
      permission: "admin",
      createdAt: "2026-10-01T00:00:00.000Z",
      displayName: "Ada Admin",
    },
    {
      id: "00000000-0000-4000-8000-000000000002",
      principal: { type: "group", groupId: "00000000-0000-4000-8000-0000000000b1" },
      permission: "write",
      createdAt: "2026-10-01T00:00:00.000Z",
      // Long enough that the members toggle has to stay whole beside it on a phone.
      displayName: "Customer support and order handling team",
    },
    {
      id: "00000000-0000-4000-8000-000000000003",
      principal: { type: "service_account", serviceAccountId: "00000000-0000-4000-8000-0000000000c1" },
      permission: "read",
      createdAt: "2026-10-01T00:00:00.000Z",
      displayName: "Triage agent",
      serviceAccountKind: "agent",
    },
  ],
  account: { email: "support@example.test", server: "imap.example.test", status: "active", lastVerifiedAt: null },
  lastSyncAt: new Date(Date.now() - 5 * 60_000).toISOString(),
};

const harness = await buildHarness();
const css =
  (await buildCss(resolve(import.meta.dir, "../../../../../styles.css"))) +
  (await buildCss(resolve(import.meta.dir, "../../styles/app.css")));
/** How long the server takes to answer the details request. */
let detailsDelayMs = 0;
const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/harness.js") return new Response(harness, { headers: { "Content-Type": "text/javascript; charset=utf-8" } });
    if (url.pathname === "/styles.css") return new Response(css, { headers: { "Content-Type": "text/css; charset=utf-8" } });
    if (url.pathname === "/api/mail/mailboxes/Box001/details") {
      await Bun.sleep(detailsDelayMs);
      return Response.json(details);
    }
    if (url.pathname === "/api/accounts/entities") {
      if (url.searchParams.get("kinds") === "group") return Response.json({ items: [], pagination: { total: 0, has_next: false } });
      const members = [
        user("00000000-0000-4000-8000-0000000000d1", "Grace Hopper"),
        user("00000000-0000-4000-8000-0000000000d2", "Alan Turing"),
      ];
      return Response.json({
        items: members.map((member) => ({ kind: "user", user: member })),
        pagination: { total: members.length, has_next: false },
      });
    }
    return new Response(
      '<!doctype html><html class="light" style="--app-accent:#0f766e"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">' +
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

const desktop: BrowserContextOptions = { viewport: { width: 1440, height: 900 } };
const phone: BrowserContextOptions = { viewport: { width: 375, height: 740 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 };

const load = async (
  options: Partial<MailboxDetailsHarnessOptions> & { context?: BrowserContextOptions; theme?: "light" | "dark"; delayMs?: number } = {},
) => {
  detailsDelayMs = options.delayMs ?? 0;
  const page = await (await browser.newContext(options.context ?? desktop)).newPage();
  page.setDefaultTimeout(10_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  // The clipboard of a headless engine depends on its permissions; the copy action only has to hand over the address.
  await page.addInitScript(() => {
    const copied: string[] = [];
    Object.defineProperty(window, "copiedTexts", { value: copied });
    Object.defineProperty(navigator, "clipboard", { value: { writeText: async (text: string) => void copied.push(text) } });
  });
  await page.goto(server.url.href);
  if (options.theme === "dark") await page.evaluate(() => document.documentElement.classList.replace("light", "dark"));
  await page.evaluate((harnessOptions: MailboxDetailsHarnessOptions) => window.mountMailboxDetails(harnessOptions), {
    locale: options.locale ?? "en",
    permission: options.permission ?? "write",
    identities,
    phoneMenu: options.phoneMenu,
  } satisfies MailboxDetailsHarnessOptions);
  return Object.assign(page, { errors });
};
const close = (page: Page) => page.context().close();
const box = async (page: Page, selector: string) => {
  const rect = await page.locator(selector).first().boundingBox();
  if (!rect) throw new Error(`${selector} is not visible`);
  return rect;
};
/** The layout box, without the press feedback's brief scale. */
const layoutBox = (page: Page, selector: string) =>
  page
    .locator(selector)
    .first()
    .evaluate((element: HTMLElement) => ({
      x: element.offsetLeft,
      y: element.offsetTop,
      width: element.offsetWidth,
      height: element.offsetHeight,
    }));
const openDialog = async (page: Page, label = "Mailbox details") => {
  await page.getByRole("button", { name: label, exact: true }).first().click();
  const dialog = page.getByRole("dialog");
  await dialog.waitFor();
  return dialog;
};

describe("Mailbox details", () => {
  for (const theme of ["light", "dark"] as const) {
    test(`sits square beside Compose and keeps its place while loading in ${theme} mode`, async () => {
      const page = await load({ theme, locale: theme === "dark" ? "de" : "en", delayMs: 400 });
      try {
        const label = theme === "dark" ? "Postfachdetails" : "Mailbox details";
        await page.waitForSelector(".mail-details-action");
        const compose = await box(page, ".mail-compose-action");
        const details = await box(page, ".mail-details-action");
        // Same row and height; the details button is square and ends where the row ends.
        expect(details.y).toBe(compose.y);
        expect(details.height).toBe(compose.height);
        expect(details.width).toBe(details.height);
        expect(details.x).toBeGreaterThan(compose.x + compose.width);
        expect(compose.width).toBeGreaterThan(details.width * 4);

        const before = [await layoutBox(page, ".mail-compose-action"), await layoutBox(page, ".mail-details-action")];
        await page.getByRole("button", { name: label, exact: true }).click();
        await page.waitForSelector(".mail-details-action[aria-busy='true'] .ti-loader-2", { state: "attached" });
        expect([await layoutBox(page, ".mail-compose-action"), await layoutBox(page, ".mail-details-action")]).toEqual(before);
        // The button keeps focus while the details load, so focus can return to it.
        expect(await page.evaluate(() => document.activeElement?.classList.contains("mail-details-action"))).toBe(true);

        const dialog = page.getByRole("dialog");
        await dialog.waitFor();
        expect(await page.evaluate(() => document.activeElement?.closest("dialog") !== null)).toBe(true);
        await page.keyboard.press("Escape");
        await dialog.waitFor({ state: "hidden" });
        await page.waitForFunction(() => document.activeElement?.classList.contains("mail-details-action"));
        expect(page.errors).toEqual([]);
      } finally {
        await close(page);
      }
    }, 30_000);
  }

  test("shows a reader the mailbox, its addresses, and who has which access, without a way to change it", async () => {
    const page = await load({ permission: "read" });
    try {
      // Readers cannot compose; the details button keeps its place and size.
      expect(await page.locator(".mail-compose-action").count()).toBe(0);
      const details = await box(page, ".mail-details-action");
      expect(details.width).toBe(details.height);

      const dialog = await openDialog(page);
      expect(await dialog.getByRole("heading", { level: 2 }).innerText()).toBe("Support");
      const addresses = await dialog.locator("[data-mailbox-addresses] li").allInnerTexts();
      expect(addresses.map((text) => text.split("\n")[0])).toEqual(["support@example.test", "billing@example.test"]);
      await dialog.getByRole("button", { name: "Copy billing@example.test" }).click();
      expect(await page.evaluate(() => (window as unknown as { copiedTexts: string[] }).copiedTexts)).toEqual(["billing@example.test"]);

      for (const name of ["Ada Admin", "Customer support and order handling team", "Triage agent"]) {
        expect(await dialog.getByText(name, { exact: true }).isVisible()).toBe(true);
      }
      expect(await dialog.getByRole("button", { name: "Manage access" }).count()).toBe(0);
      expect(await dialog.getByRole("button", { name: /^Remove / }).count()).toBe(0);
      expect(await dialog.getByRole("combobox").count()).toBe(0);
      // Who a group grant reaches, with the reader's own directory visibility.
      await dialog.getByRole("button", { name: "Members of Customer support and order handling team" }).click();
      await dialog.getByText("Grace Hopper").waitFor();
      expect(page.errors).toEqual([]);
    } finally {
      await close(page);
    }
  }, 30_000);

  test("takes managers to the access settings", async () => {
    const page = await load({ permission: "admin" });
    try {
      const dialog = await openDialog(page);
      await dialog.getByRole("button", { name: "Manage access" }).click();
      await dialog.waitFor({ state: "hidden" });
      expect(await page.evaluate(() => window.detailsResults)).toEqual(["manage-access"]);
    } finally {
      await close(page);
    }
  }, 30_000);

  for (const permission of ["write", "read"] as const) {
    test(`puts the details in the phone menu ${permission === "write" ? "beside Compose" : "as their own row"} and fits the dialog to the phone`, async () => {
      const page = await load({ context: phone, permission, phoneMenu: true, locale: "de" });
      try {
        await page.waitForSelector(".mail-phone-menu .k2b-navigation__row");
        const first = page.locator(".mail-phone-menu .k2b-navigation__row").first();
        const row = (await first.boundingBox())!;
        if (permission === "write") {
          expect(await first.locator(".k2b-navigation__control").innerText()).toBe("Verfassen");
          const button = (await first.locator(".k2b-navigation__inline-action").boundingBox())!;
          expect(button.width).toBe(44);
          expect(button.height).toBe(44);
          // Inside the Compose row, at its end.
          expect(button.y).toBeGreaterThanOrEqual(row.y);
          expect(button.y + button.height).toBeLessThanOrEqual(row.y + row.height);
          expect(Math.round(button.x + button.width)).toBe(Math.round(row.x + row.width));
          await first.locator(".k2b-navigation__inline-action").click();
        } else {
          expect(await first.innerText()).toBe("Postfachdetails");
          await first.locator(".k2b-navigation__control").click();
        }
        const dialog = page.getByRole("dialog");
        await dialog.waitFor();
        const overflow = await page.evaluate(() => {
          const body = document.querySelector<HTMLElement>("dialog .k2b-panel-dialog__body")!;
          const frame = document.querySelector<HTMLElement>("dialog")!.getBoundingClientRect();
          return { horizontal: body.scrollWidth > body.clientWidth, frameRight: frame.right, viewport: window.innerWidth };
        });
        expect(overflow.horizontal).toBe(false);
        expect(overflow.frameRight).toBeLessThanOrEqual(overflow.viewport);
        expect(await dialog.getByRole("heading", { name: "Adressen" }).isVisible()).toBe(true);
        // The group's members toggle stays whole beside its long name.
        const toggle = dialog.getByRole("button", { name: "Mitglieder von Customer support and order handling team" });
        expect(await toggle.innerText()).toBe("Mitglieder");
        expect(page.errors).toEqual([]);
      } finally {
        await close(page);
      }
    }, 30_000);
  }
});
