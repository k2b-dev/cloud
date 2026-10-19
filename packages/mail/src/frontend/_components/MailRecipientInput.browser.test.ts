import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import type { Browser, BrowserContextOptions, Page } from "playwright";
import { launchBrowser } from "../../../../ui/test/browser";
import type { MailRecipientHarnessOptions } from "./MailRecipientInput.browser-harness";

// Whether the suggestion list opens at its final size without moving the field, and whether the details panel simply
// has no contacts block without a contact app, are layout questions that only a real engine answers.
const buildHarness = async (): Promise<string> => {
  const ui = new URL("../../../../ui/", import.meta.url).pathname;
  const { transformAsync } = await import(Bun.resolveSync("@babel/core", ui));
  const typescript = (await import(Bun.resolveSync("@babel/preset-typescript", ui))).default;
  const solid = (await import(Bun.resolveSync("babel-preset-solid", ui))).default;
  const build = await Bun.build({
    entrypoints: [new URL("./MailRecipientInput.browser-harness.tsx", import.meta.url).pathname],
    target: "browser",
    format: "iife",
    conditions: ["browser"],
    plugins: [
      {
        name: "solid-mail-recipient-test",
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
  if (!build.success) throw new AggregateError(build.logs, "Mail recipient harness build failed");
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
// The Tabler font, so screenshots show the icons that tell contacts and mailbox addresses apart.
const iconsCssPath = Bun.resolveSync("@k2b/ui/icons/tabler.css", import.meta.dir);
const iconsCss = await Bun.file(iconsCssPath).text();
const iconFont = /url\((\.\/[^)"']+\.woff2)(?:[?#][^)"']*)?\)/.exec(iconsCss)?.[1];
if (!iconFont) throw new Error("@k2b/ui Tabler preset does not reference a WOFF2 asset");
const lastSeenAt = "2026-10-18T09:30:00.000Z";
const mailboxItems = [
  { address: "ada.lovelace@example.test", displayName: "Ada Lovelace", writtenTo: true, lastSeenAt },
  { address: "adam.orders@example.test", displayName: "Adam Orders", writtenTo: false, lastSeenAt },
  { address: "admissions@example.test", displayName: null, writtenTo: false, lastSeenAt },
];
const contactSuggestions = [
  {
    contactId: "Contact01",
    bookId: "Book01",
    displayName: "Ada Lovelace",
    companyName: "Analytical Engines Ltd",
    jobTitle: "Mathematician",
    emails: [{ email: "ada.lovelace@example.test", label: null }],
    phones: [],
    contactPointsTruncated: false,
    updatedAt: lastSeenAt,
  },
];
/** Holds the mailbox answer until the test releases it, so the loading state is measured while it lasts. */
let mailboxGate: Promise<void> | undefined;
const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/harness.js") return new Response(harness, { headers: { "Content-Type": "text/javascript; charset=utf-8" } });
    if (url.pathname === "/styles.css") return new Response(css, { headers: { "Content-Type": "text/css; charset=utf-8" } });
    if (url.pathname === "/tabler-icons.css")
      return new Response(iconsCss.replaceAll(iconFont, "/tabler-icons.woff2"), { headers: { "Content-Type": "text/css; charset=utf-8" } });
    if (url.pathname === "/tabler-icons.woff2") return new Response(Bun.file(resolve(iconsCssPath, "..", iconFont)));
    if (url.pathname === "/api/mail/mailboxes/Box001/recipient-suggestions") {
      await mailboxGate;
      return Response.json({ items: mailboxItems });
    }
    if (url.pathname.startsWith("/api/capabilities")) return Response.json({ data: contactSuggestions });
    if (url.pathname === "/api/mail/mailboxes/Box001/conversations/Conv01/context")
      return Response.json({
        conversationId: "Conv01",
        participants: [{ email: "ada.lovelace@example.test", displayName: "Ada Lovelace" }],
        contacts: { status: "ready", items: [], matchedEmails: [], nextCursor: null },
        spaces: { status: "ready", items: [], truncated: false },
      });
    return new Response(
      '<!doctype html><html class="light" style="--app-accent:#0f766e"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">' +
        '<link rel="stylesheet" href="/tabler-icons.css"><link rel="stylesheet" href="/styles.css"><style>#root{position:fixed;inset:0;display:flex;overflow:auto}</style></head>' +
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

const desktop: BrowserContextOptions = { viewport: { width: 1280, height: 720 } };
const phone: BrowserContextOptions = { viewport: { width: 375, height: 740 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 };
/** `MAIL_RECIPIENT_SCREENSHOTS=<dir>` keeps light screenshots of each state for review. */
const screenshotDir = process.env.MAIL_RECIPIENT_SCREENSHOTS?.trim();
const capture = async (page: Page, name: string) => {
  if (!screenshotDir) return;
  mkdirSync(screenshotDir, { recursive: true });
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
  await page.screenshot({ path: resolve(screenshotDir, `${name}.png`) });
};

const load = async (options: MailRecipientHarnessOptions & { context?: BrowserContextOptions }) => {
  const page = await (await browser.newContext(options.context ?? desktop)).newPage();
  page.setDefaultTimeout(10_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(server.url.href);
  await page.evaluate((harnessOptions: MailRecipientHarnessOptions) => window.mountMailRecipients(harnessOptions), {
    locale: options.locale,
    contacts: options.contacts,
  });
  return Object.assign(page, { errors });
};
const layoutBox = (page: Page, selector: string) =>
  page
    .locator(selector)
    .first()
    .evaluate((element: HTMLElement) => {
      const rect = element.getBoundingClientRect();
      return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
    });

for (const [label, context] of [
  ["desktop", desktop],
  ["phone", phone],
] as const) {
  test(`${label}: mailbox addresses appear without Contacts; field and list keep their size`, async () => {
    let release = () => {};
    mailboxGate = new Promise((resolveGate) => {
      release = resolveGate;
    });
    const page = await load({ locale: "en", contacts: false, context });
    try {
      const field = page.getByRole("combobox", { name: "Recipients" });
      const control = ".mail-recipient-control";
      const input = await layoutBox(page, '[role="combobox"]');
      const before = await layoutBox(page, control);
      await field.fill("ad");
      // The lookup is pending: the spinner shows in its reserved slot and nothing in the flow moves.
      await page.locator(".mail-recipient-control .ti-loader-2.animate-spin").waitFor();
      expect(await layoutBox(page, control)).toEqual(before);
      expect(await layoutBox(page, '[role="combobox"]')).toEqual(input);
      expect(await page.locator('[role="listbox"]').count()).toBe(0);
      release();
      const listbox = page.getByRole("listbox");
      await listbox.waitFor();
      const opened = await layoutBox(page, '[role="listbox"]');
      await page.waitForTimeout(250);
      expect(await layoutBox(page, '[role="listbox"]')).toEqual(opened);
      expect(await layoutBox(page, control)).toEqual(before);
      expect(await page.getByRole("option").allTextContents()).toEqual([
        "From this mailboxAda Lovelaceada.lovelace@example.test",
        "From this mailboxAdam Ordersadam.orders@example.test",
        "From this mailboxadmissions@example.test",
      ]);
      expect(await page.locator('[role="option"] .ti-mail').count()).toBe(3);
      // The details panel has no contacts block and no error without a contact app; Spaces stays.
      await page.getByText("Spaces task").waitFor();
      expect(await page.getByRole("region", { name: "Contacts" }).count()).toBe(0);
      expect(await page.getByText("Contacts unavailable").count()).toBe(0);
      await field.press("ArrowDown");
      await capture(page, `${label}-suggestions-without-contacts`);
      await field.press("Enter");
      expect(await page.locator(".mail-recipient-pill").allTextContents()).toEqual(["Ada Lovelace <ada.lovelace@example.test>"]);
      expect(page.errors).toEqual([]);
    } finally {
      release();
      mailboxGate = undefined;
      await page.context().close();
    }
  });

  test(`${label}: contacts come first and a shared address appears once`, async () => {
    const page = await load({ locale: "de", contacts: true, context });
    try {
      const field = page.getByRole("combobox", { name: "Empfänger" });
      await field.fill("ad");
      await page.getByRole("listbox").waitFor();
      const options = await page.getByRole("option").allTextContents();
      expect(options).toEqual([
        "Ada Lovelaceada.lovelace@example.testAnalytical Engines Ltd · Mathematician",
        "Aus diesem PostfachAdam Ordersadam.orders@example.test",
        "Aus diesem Postfachadmissions@example.test",
      ]);
      expect(await page.locator('[role="option"]').first().locator(".ti-user").count()).toBe(1);
      await page.getByText("Neuer Kontakt").waitFor();
      await capture(page, `${label}-suggestions-with-contacts`);
      expect(page.errors).toEqual([]);
    } finally {
      await page.context().close();
    }
  });
}

test("details panel without Contacts shows only the Spaces block", async () => {
  const page = await load({ locale: "en", contacts: false });
  try {
    await page.getByText("Spaces task").waitFor();
    expect(await page.getByText("Contacts unavailable").count()).toBe(0);
    expect(await page.getByText("New contact").count()).toBe(0);
    await capture(page, "desktop-details-without-contacts");
  } finally {
    await page.context().close();
  }
});
