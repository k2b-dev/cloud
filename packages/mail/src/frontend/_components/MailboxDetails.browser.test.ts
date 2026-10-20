import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import type { Browser, BrowserContextOptions, Page } from "playwright";
import { launchBrowser, settled } from "../../../../ui/test/browser";
import type { SenderIdentity } from "../../contracts";
import type { MailboxDetails } from "../../service/mailbox-details";
import type { MailboxDetailsHarnessOptions } from "./MailboxDetails.browser-harness";

// Menu loading, focus return, and phone dialog layout need a real browser.
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
const details: Omit<MailboxDetails, "permission"> = {
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
  hiddenAccessCount: 0,
  account: { email: "support@example.test", server: "imap.example.test" },
  lastSyncAt: "2026-10-14T09:55:00.000Z",
};

const harness = await buildHarness();
const css =
  (await buildCss(resolve(import.meta.dir, "../../../../../styles.css"))) +
  (await buildCss(resolve(import.meta.dir, "../../styles/app.css")));
/** The viewer's access the details request reports. */
let detailsPermission: MailboxDetails["permission"] = "write";
/** Holds the details response until the test releases it, so the loading state stays put while it is checked. */
let detailsGate: Promise<void> | undefined;
const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/harness.js") return new Response(harness, { headers: { "Content-Type": "text/javascript; charset=utf-8" } });
    if (url.pathname === "/styles.css") return new Response(css, { headers: { "Content-Type": "text/css; charset=utf-8" } });
    if (url.pathname === "/api/mail/mailboxes/Box001/details") {
      await detailsGate;
      return Response.json({ ...details, permission: detailsPermission } satisfies MailboxDetails);
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
  options: Partial<MailboxDetailsHarnessOptions> & { context?: BrowserContextOptions; theme?: "light" | "dark" } = {},
) => {
  detailsPermission = options.permission ?? "write";
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
  await page.addInitScript(() => {
    const RealDate = Date;
    const start = performance.now();
    const epoch = RealDate.parse("2026-10-14T10:00:00.000Z");
    class FixedDate extends RealDate {
      constructor(value?: string | number) {
        super(value ?? epoch + performance.now() - start);
      }
      static override now() {
        return epoch + performance.now() - start;
      }
    }
    window.Date = FixedDate as DateConstructor;
  });
  await page.goto(server.url.href);
  if (options.theme === "dark") await page.evaluate(() => document.documentElement.classList.replace("light", "dark"));
  await page.evaluate((harnessOptions: MailboxDetailsHarnessOptions) => window.mountMailboxDetails(harnessOptions), {
    locale: options.locale ?? "en",
    permission: options.permission ?? "write",
    identities,
    phoneMenu: options.phoneMenu,
  } satisfies MailboxDetailsHarnessOptions);
  await settled(page);
  return Object.assign(page, { errors });
};
const close = (page: Page) => page.context().close();
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
const head = (page: Page) => page.locator(".k2b-app-workspace__head");
const optionsTrigger = (page: Page) => head(page).getByRole("button", { name: /^(Options for|Optionen für) Support$/, exact: true });
const openDialog = async (page: Page, label = "Mailbox details") => {
  await optionsTrigger(page).click();
  await page.getByRole("menuitem", { name: label, exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.waitFor();
  return dialog;
};

describe("Mailbox details", () => {
  for (const context of [desktop, phone]) {
    test(`head Compose keeps its layout while preparing at ${context.viewport!.width}px`, async () => {
      const page = await load({ context });
      try {
        const primary = "[data-workspace-primary]";
        const before = await layoutBox(page, primary);
        await page.evaluate(() => window.setMailboxComposeStarting(true));
        await page.locator(`${primary} .ti-loader-2`).waitFor({ state: "attached" });
        await settled(page);
        expect(await layoutBox(page, primary)).toEqual(before);
        await page.evaluate(() => window.setMailboxComposeStarting(false));
        await page.locator(`${primary} .ti-pencil`).waitFor({ state: "attached" });
        await settled(page);
        expect(await layoutBox(page, primary)).toEqual(before);
        expect(page.errors).toEqual([]);
      } finally {
        await close(page);
      }
    }, 30_000);
  }
  for (const theme of ["light", "dark"] as const) {
    for (const permission of ["write", "read"] as const) {
      test(`${permission} opens details from head options and restores focus in ${theme}`, async () => {
        const page = await load({ theme, permission });
        const response = Promise.withResolvers<void>();
        detailsGate = response.promise;
        try {
          const trigger = optionsTrigger(page);
          const before = await trigger.boundingBox();
          await trigger.click();
          await page.getByRole("menuitem", { name: permission === "read" ? "About this mailbox" : "Mailbox details", exact: true }).click();
          await head(page).locator('[aria-busy="true"] .ti-loader-2').waitFor({ state: "attached" });
          await settled(page);
          expect(await trigger.boundingBox()).toEqual(before);
          expect(await trigger.evaluate((element) => document.activeElement === element)).toBe(true);
          expect(await page.locator("[data-workspace-primary]").count()).toBe(permission === "read" ? 0 : 1);
          response.resolve();
          const dialog = page.getByRole("dialog");
          await dialog.waitFor();
          expect(await dialog.evaluate((element) => element.contains(document.activeElement))).toBe(true);
          await page.keyboard.press("Escape");
          await dialog.waitFor({ state: "hidden" });
          await page.waitForFunction(() => document.activeElement?.getAttribute("aria-label") === "Options for Support");
          expect(page.errors).toEqual([]);
        } finally {
          response.resolve();
          detailsGate = undefined;
          await close(page);
        }
      }, 30_000);
    }
  }

  test("shows a reader the mailbox, its addresses, and who has which access, without a way to change it", async () => {
    const page = await load({ permission: "read" });
    try {
      const dialog = await openDialog(page, "About this mailbox");
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
      // The dialog resolves its result after it hides.
      await page.waitForFunction(() => window.detailsResults.length > 0);
      expect(await page.evaluate(() => window.detailsResults)).toEqual(["manage-access"]);
    } finally {
      await close(page);
    }
  }, 30_000);

  for (const permission of ["write", "read"] as const) {
    test(`opens ${permission} details from the phone head and fits the dialog`, async () => {
      const page = await load({ context: phone, permission, phoneMenu: true, locale: "de" });
      try {
        await page.waitForSelector(".mail-phone-menu .k2b-navigation__row");
        expect(
          await page
            .locator(".mail-phone-menu")
            .getByRole("button", { name: /Postfachdetails|Über dieses Postfach|Einstellungen/ })
            .count(),
        ).toBe(0);
        await optionsTrigger(page).click();
        await page
          .getByRole("menuitem", { name: permission === "write" ? "Postfachdetails" : "Über dieses Postfach", exact: true })
          .click();
        const dialog = page.getByRole("dialog");
        await dialog.waitFor();
        await settled(page);
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
