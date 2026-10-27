import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import type { Browser, BrowserContextOptions, Page } from "playwright";
import { launchBrowser } from "../../../../ui/test/browser";
import type { KeptAdminHarnessOptions } from "./MailAdminKept.browser-harness";
import type { KeptTableRow } from "./MailAdminKeptTable.island";

// Admin › Mail › Kept: selecting and downloading, stopping a keep with a reason, and the failure each step can end
// in, on a desktop table and a phone list.
const buildHarness = async (): Promise<string> => {
  const ui = new URL("../../../../ui/", import.meta.url).pathname;
  const { transformAsync } = await import(Bun.resolveSync("@babel/core", ui));
  const typescript = (await import(Bun.resolveSync("@babel/preset-typescript", ui))).default;
  const solid = (await import(Bun.resolveSync("babel-preset-solid", ui))).default;
  const build = await Bun.build({
    entrypoints: [new URL("./MailAdminKept.browser-harness.tsx", import.meta.url).pathname],
    target: "browser",
    format: "iife",
    conditions: ["browser"],
    plugins: [
      {
        name: "solid-kept-admin-test",
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
  if (!build.success) throw new AggregateError(build.logs, "Kept admin harness build failed");
  return build.outputs[0]!.text();
};

const buildCss = async (entry: string): Promise<string> => {
  const tailwind = (await import(Bun.resolveSync("bun-plugin-tailwind", new URL("../../../../cloud/", import.meta.url).pathname))).default;
  const build = await Bun.build({ entrypoints: [entry], plugins: [tailwind] });
  if (!build.success) throw new AggregateError(build.logs, `Could not compile ${entry}`);
  return build.outputs[0]!.text();
};

const row = (conversationId: string, subject: string, sender: string, mailboxName: string): KeptTableRow => ({
  mailboxId: "Box001",
  conversationId,
  href: `/admin/mail/kept/Box001/${conversationId}`,
  mailboxName,
  mailboxDeleted: false,
  subject,
  senderName: sender,
  senderAddress: `${sender.toLowerCase().replace(" ", ".")}@example.test`,
  date: "Oct 20, 2026",
  dateTitle: "Oct 20, 2026, 9:14 AM",
  dateTime: "2026-10-20T09:14:00.000Z",
  keptBy: "Jana Berger",
  keptSince: "Oct 21, 2026",
  keptSinceTitle: "Oct 21, 2026, 8:00 AM",
  keptSinceTime: "2026-10-21T08:00:00.000Z",
});
const rows = [
  row("Con001", "Termination notice for the Lindenstrasse lease", "Paul Weber", "Office"),
  row("Con002", "Delivery confirmation order 4711", "Mia Schulz", "Purchasing"),
  row("Con003", "Warranty claim for the cargo bike", "Lena Fischer", "Service"),
];

const detail: NonNullable<KeptAdminHarnessOptions["detail"]> = {
  conversation: {
    cloudId: "Box001/Con001",
    mailbox: { id: "Box001", name: "Office" },
    conversationId: "Con001",
    subject: "Termination notice for the Lindenstrasse lease",
    keep: { keptAt: "2026-10-21T08:00:00.000Z", keptBy: { kind: "user", displayName: "Jana Berger" } },
    messages: [
      {
        id: "Msg001",
        messageId: "<notice-4711@example.test>",
        delivery: null,
        date: "2026-10-20T09:14:00.000Z",
        from: [{ name: "Paul Weber", address: "paul.weber@example.test" }],
        replyTo: [],
        to: [{ name: "Office", address: "office@example.test" }],
        cc: [],
        bcc: [],
        subject: "Termination notice for the Lindenstrasse lease",
        inReplyTo: null,
        references: [],
        headers: {},
        text: "Dear team,\n\nwe hereby give notice to end the lease for Lindenstrasse 12 on December 31, 2026.\n\nKind regards\nPaul Weber",
        html: null,
        attachments: [
          { id: "Att001", filename: "notice-signed.pdf", contentType: "application/pdf", size: 182_400, inline: false, contentId: null },
        ],
      },
      {
        id: "Msg002",
        messageId: "<reply-4711@example.test>",
        delivery: { state: "cancelled" },
        date: "2026-10-20T11:02:00.000Z",
        from: [{ name: "Office", address: "office@example.test" }],
        replyTo: [],
        to: [{ name: "Paul Weber", address: "paul.weber@example.test" }],
        cc: [],
        bcc: [],
        subject: "Re: Termination notice for the Lindenstrasse lease",
        inReplyTo: "<notice-4711@example.test>",
        references: ["<notice-4711@example.test>"],
        headers: {},
        text: null,
        html: '<p>Thank you, we confirm receipt.</p><img src="https://tracker.example.test/pixel.gif" alt="">',
        attachments: [],
      },
    ],
  },
  history: [
    {
      action: "mail.conversation.keep.view",
      outcome: "allowed",
      at: "2026-10-27T09:30:00.000Z",
      actor: { label: "Admin Kim" },
      reason: null,
    },
    {
      action: "mail.conversation.keep.release",
      outcome: "denied",
      at: "2026-10-24T15:10:00.000Z",
      actor: { label: "Tom Krüger" },
      reason: null,
    },
    { action: "mail.conversation.keep", outcome: "allowed", at: "2026-10-21T08:00:00.000Z", actor: { label: "Jana Berger" }, reason: null },
  ],
  messageCount: 64,
};

type Recorded = { method: string; path: string; body: unknown };
const requests: Recorded[] = [];
let failNext = false;
const harness = await buildHarness();
const css =
  "@layer properties, theme, base, components, utilities;" +
  (await buildCss(resolve(import.meta.dir, "../../styles/app.css"))) +
  (await buildCss(resolve(import.meta.dir, "../../../../../styles.css")));
const uiDist = new URL("../../../../ui/dist/", import.meta.url).pathname;
const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/harness.js") return new Response(harness, { headers: { "Content-Type": "text/javascript; charset=utf-8" } });
    if (url.pathname === "/styles.css") return new Response(css, { headers: { "Content-Type": "text/css; charset=utf-8" } });
    if (url.pathname === "/tabler.css" || url.pathname.endsWith(".woff2")) return new Response(Bun.file(uiDist + url.pathname.slice(1)));
    if (url.pathname.startsWith("/api/mail/admin/kept")) {
      const text = await request.text();
      requests.push({ method: request.method, path: url.pathname, body: text ? JSON.parse(text) : null });
      if (failNext) {
        failNext = false;
        return Response.json({ code: "FORBIDDEN", message: "Only a Cloud administrator can stop keeping a conversation" }, { status: 403 });
      }
      if (request.method === "DELETE") return Response.json({ conversationId: "Con001", released: true });
      return new Response(JSON.stringify({ schema: "cloud.mail.kept-conversations/v1", conversations: [] }), {
        headers: { "Content-Type": "application/json", "Content-Disposition": 'attachment; filename="kept-conversations-2026-10-27.json"' },
      });
    }
    return new Response(
      '<!doctype html><html class="light" style="--app-accent:#0f766e"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">' +
        '<link rel="stylesheet" href="/tabler.css"><link rel="stylesheet" href="/styles.css"><style>#root{position:fixed;inset:0;display:flex}</style></head>' +
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

const desktop: BrowserContextOptions = { viewport: { width: 1280, height: 900 }, acceptDownloads: true };
const phone: BrowserContextOptions = { viewport: { width: 390, height: 780 }, isMobile: true, hasTouch: true, acceptDownloads: true };

const load = async (
  context: BrowserContextOptions,
  options: KeptAdminHarnessOptions,
  theme: "light" | "dark" = "light",
  before?: (page: Page) => Promise<unknown>,
) => {
  requests.length = 0;
  const page = await (await browser.newContext(context)).newPage();
  await before?.(page);
  page.setDefaultTimeout(10_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(server.url.href);
  if (theme === "dark") await page.evaluate(() => document.documentElement.classList.replace("light", "dark"));
  await page.evaluate((harnessOptions) => window.mountKeptAdmin(harnessOptions), options);
  return Object.assign(page, { errors });
};

describe("Admin › Mail › Kept", () => {
  test("downloads a selection as one JSON file and shows every column on a desktop", async () => {
    const page = await load(desktop, { locale: "en", rows });
    try {
      await page.getByRole("link", { name: /Kept/ }).waitFor();
      const table = page.locator(".k2b-data-table, table").first();
      for (const header of ["Mailbox", "Subject", "Sender", "Date", "Kept by", "Kept since"])
        expect(await table.getByRole("columnheader", { name: header }).count()).toBe(1);
      const download = page.getByRole("button", { name: "Download selection as JSON" });
      expect(await download.isDisabled()).toBe(true);

      await page.getByRole("checkbox", { name: "Select “Delivery confirmation order 4711”" }).first().check();
      await page.getByRole("checkbox", { name: "Select “Warranty claim for the cargo bike”" }).first().check();
      await page.getByText("2 selected").waitFor();
      const saved = page.waitForEvent("download");
      await download.click();
      expect((await saved).suggestedFilename()).toBe("kept-conversations-2026-10-27.json");
      expect(requests).toEqual([
        {
          method: "POST",
          path: "/api/mail/admin/kept/export",
          body: {
            items: [
              { mailboxId: "Box001", conversationId: "Con002" },
              { mailboxId: "Box001", conversationId: "Con003" },
            ],
          },
        },
      ]);

      // Select all on the page, then a failed download ends in a visible error with the server's reason.
      await page.getByRole("checkbox", { name: "Select all conversations on this page" }).check();
      await page.getByText("3 selected").waitFor();
      failNext = true;
      await download.click();
      await page.getByRole("dialog").getByText("Only a Cloud administrator can stop keeping a conversation").waitFor();
      expect(page.errors).toEqual([]);
    } finally {
      await page.context().close();
    }
  }, 30_000);

  test("shows a list without horizontal scrolling on a phone, in light and dark", async () => {
    for (const theme of ["light", "dark"] as const) {
      const page = await load(phone, { locale: "de", rows }, theme);
      try {
        const list = page.getByRole("list", { name: "Aufbewahrte Unterhaltungen" });
        await list.getByText("Termination notice for the Lindenstrasse lease").waitFor();
        expect(await page.locator("table").first().isVisible()).toBe(false);
        const overflow = await page.evaluate(
          () => document.querySelector("main")!.scrollWidth - document.querySelector("main")!.clientWidth,
        );
        expect(overflow).toBeLessThanOrEqual(0);
        // A tap on the visible box, as a finger does; the native input sits underneath it.
        await list.locator('label:has(input[aria-label="„Delivery confirmation order 4711“ auswählen"])').tap();
        await page.getByText("1 ausgewählt").waitFor();
        expect(page.errors).toEqual([]);
      } finally {
        await page.context().close();
      }
    }
  }, 30_000);

  test("shows the empty state with its explanation", async () => {
    const page = await load(desktop, { locale: "en", rows: [] });
    try {
      await page.getByText("No conversation is kept.").waitFor();
      await page.getByText("When someone keeps a conversation in Mail, it shows up here.").waitFor();
      expect(await page.getByRole("button", { name: "Download selection as JSON" }).count()).toBe(0);
    } finally {
      await page.context().close();
    }
  }, 30_000);

  test("shows the detail without loading remote content, and its history", async () => {
    const tracker: string[] = [];
    // Every request the page really sends to the sender's host; the frame's policy must stop it before the network.
    const page = await load(desktop, { locale: "en", rows, detail }, "light", (page) =>
      page.route("https://tracker.example.test/**", (route) => {
        tracker.push(route.request().url());
        return route.fulfill({ status: 204 });
      }),
    );
    try {
      await page.getByRole("heading", { name: "Termination notice for the Lindenstrasse lease" }).waitFor();
      await page.getByText("Kept since").waitFor();
      await page.getByText("Box001/Con001").waitFor();
      await page.getByText("notice-signed.pdf").waitFor();
      const frame = page.frameLocator("iframe").first();
      await frame.getByText("Thank you, we confirm receipt.").waitFor();
      await page.getByText("Tried to stop keeping the conversation (refused)").waitFor();
      // A cancelled outgoing copy never reads as sent, and a long conversation says that the download has the rest.
      await page.getByText("Not sent (cancelled)").waitFor();
      await page.getByText("Showing the newest 2 of 64 messages. Download as JSON to get all of them.").waitFor();
      expect(tracker).toEqual([]);
      expect(page.errors).toEqual([]);
    } finally {
      await page.context().close();
    }
  }, 30_000);

  test("stops keeping with a confirmation and a reason, and shows a refusal", async () => {
    const page = await load(desktop, { locale: "en", rows, detail });
    try {
      // A refusal ends in a visible error and keeps the person on the page.
      failNext = true;
      await page.getByRole("button", { name: "Stop keeping" }).click();
      let dialog = page.getByRole("dialog");
      await dialog.getByText("Stop keeping this conversation?").waitFor();
      await dialog.getByRole("button", { name: "Stop keeping" }).click();
      await page.getByRole("dialog").getByText("Only a Cloud administrator can stop keeping a conversation").waitFor();
      await page.keyboard.press("Escape");
      expect(requests.at(-1)).toEqual({ method: "DELETE", path: "/api/mail/admin/kept/Box001/Con001", body: {} });

      await page.getByRole("button", { name: "Stop keeping" }).click();
      dialog = page.getByRole("dialog");
      await dialog.getByLabel("Reason (optional)").fill("  Retention period ended  ");
      const navigated = page.waitForURL("**/admin/mail/kept");
      await dialog.getByRole("button", { name: "Stop keeping" }).click();
      await navigated;
      expect(requests.at(-1)).toEqual({
        method: "DELETE",
        path: "/api/mail/admin/kept/Box001/Con001",
        body: { reason: "Retention period ended" },
      });
    } finally {
      await page.context().close();
    }
  }, 30_000);
});
