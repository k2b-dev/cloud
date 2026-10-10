import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import type { Browser, BrowserContextOptions, Page } from "playwright";
import { launchBrowser } from "../../../ui/test/browser";
import type { MailFocusPage } from "../contracts";
import type { MailOverviewHarnessOptions } from "./MailOverview.browser-harness";

// Whether switching views ever shows an empty state or moves the list needs real layout, paint
// timing, and CSS animations, so the real overview runs in a browser against a held Focus API.
const buildHarness = async (): Promise<string> => {
  const ui = new URL("../../../ui/", import.meta.url).pathname;
  const { transformAsync } = await import(Bun.resolveSync("@babel/core", ui));
  const typescript = (await import(Bun.resolveSync("@babel/preset-typescript", ui))).default;
  const solid = (await import(Bun.resolveSync("babel-preset-solid", ui))).default;
  const build = await Bun.build({
    entrypoints: [new URL("./MailOverview.browser-harness.tsx", import.meta.url).pathname],
    target: "browser",
    format: "iife",
    conditions: ["browser"],
    plugins: [
      {
        name: "solid-mail-overview-test",
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
  if (!build.success) throw new AggregateError(build.logs, "Mail overview harness build failed");
  return build.outputs[0]!.text();
};

const buildCss = async (entry: string): Promise<string> => {
  // The production stylesheets compile through Cloud's Tailwind plugin.
  const tailwind = (await import(Bun.resolveSync("bun-plugin-tailwind", new URL("../../../cloud/", import.meta.url).pathname))).default;
  const build = await Bun.build({ entrypoints: [entry], plugins: [tailwind] });
  if (!build.success) throw new AggregateError(build.logs, `Could not compile ${entry}`);
  return build.outputs[0]!.text();
};

const item = (index: number): MailFocusPage["items"][number] => ({
  id: `Conv${String(index).padStart(2, "0")}`,
  mailboxId: "Mail01",
  mailboxName: "Support",
  subject: `Refund request ${index} with a subject long enough to be cut off on a phone`,
  participantSummary: `Person ${index}`,
  latestMessageAt: "2026-08-19T10:00:00.000Z",
  workStatus: "needs_action",
  assigneeUserIds: [],
  unread: index % 2 === 0,
  flagged: index % 3 === 0,
  hasAttachments: index % 4 === 0,
  preview: `Hello, could you look at order ${index} again? The preview is long enough to need the whole line and more.`,
});
const plain = (index: number) => ({ ...item(index), flagged: false, hasAttachments: false });
const counts = { mine: 2, unassigned: 4, waiting: 0, all: 6 };

const harness = await buildHarness();
const css =
  (await buildCss(resolve(import.meta.dir, "../../../../styles.css"))) + (await buildCss(resolve(import.meta.dir, "../styles/app.css")));

/** Focus requests wait here until the test answers them. */
const held: { view: string; respond: (page: Omit<MailFocusPage, "mailboxCounts">) => void }[] = [];
const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/harness.js") return new Response(harness, { headers: { "Content-Type": "text/javascript; charset=utf-8" } });
    if (url.pathname === "/styles.css") return new Response(css, { headers: { "Content-Type": "text/css; charset=utf-8" } });
    if (url.pathname === "/api/mail/overview/conversations") {
      return new Promise<Response>((answer) =>
        held.push({
          view: url.searchParams.get("view") ?? "",
          respond: (page) => answer(Response.json({ ...page, mailboxCounts: [] })),
        }),
      );
    }
    if (url.pathname.startsWith("/api/")) return Response.json({ message: "Not part of this test" }, { status: 404 });
    return new Response(
      '<!doctype html><html class="light" style="--app-accent:#0f766e"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">' +
        '<link rel="stylesheet" href="/styles.css"></head><body class="k2b-ui" style="margin:0">' +
        '<div id="root" style="position:fixed;inset:0;display:flex;flex-direction:column"></div>' +
        '<script src="/harness.js"></script></body></html>',
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

const viewports: [string, BrowserContextOptions][] = [
  ["desktop", { viewport: { width: 1280, height: 900 } }],
  ["phone", { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true }],
];

const load = async (context: BrowserContextOptions, options: MailOverviewHarnessOptions) => {
  held.length = 0;
  const page = await (await browser.newContext(context)).newPage();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(server.url.href);
  await page.evaluate((harnessOptions) => window.mountMailOverview(harnessOptions), options);
  await page.waitForSelector(".mail-overview-list");
  await page.evaluate(() => window.watchFocus());
  await fontsLoaded(page);
  return Object.assign(page, { errors });
};
const close = (page: Page) => page.context().close();
/** The icon font changes the height of a row's facts once it loads, so measure only after it did. */
const fontsLoaded = (page: Page) => page.evaluate(() => document.fonts.ready.then(() => undefined));

/**
 * The box of the list and of each row in it, rounded to tenths of a pixel, as the next frame paints
 * them. Rows skip their layout until they are on screen (`content-visibility: auto`), and a new row
 * has its placeholder height until the next rendering update decides that it is.
 */
const listLayout = (page: Page, rowSelector: string) =>
  page.evaluate(async (rowSelector) => {
    await new Promise((painted) => requestAnimationFrame(() => requestAnimationFrame(painted)));
    const round = (value: number) => Math.round(value * 10) / 10;
    const rect = (element: Element) => {
      const { top, left, width, height } = element.getBoundingClientRect();
      return [round(top), round(left), round(width), round(height)];
    };
    const list = document.querySelector(".mail-overview-list")!;
    return { list: rect(list), rows: [...list.querySelectorAll(rowSelector)].map(rect) };
  }, rowSelector);
const answered = async (page: Page, count: number) => {
  for (let attempt = 0; attempt < 200 && held.length < count; attempt += 1) await Bun.sleep(10);
  expect(held).toHaveLength(count);
};
const idle = async (page: Page) => {
  await page.waitForFunction(() => document.querySelector(".mail-focus-main")?.getAttribute("aria-busy") === "false");
  await fontsLoaded(page);
};
const choose = (page: Page, label: string) => page.locator('[role="radio"]', { hasText: label }).click();

describe("Mail overview views", () => {
  for (const [name, context] of viewports) {
    test(`switches to a view the server rendered without an empty state or a moving list on a ${name}`, async () => {
      const page = await load(context, {
        initialView: "mine",
        initialFocusError: null,
        initialFocus: {
          pages: {
            mine: { items: [item(1), item(2)], nextCursor: null },
            unassigned: { items: [item(3), item(4), item(5), item(6)], nextCursor: null },
            waiting: { items: [], nextCursor: null },
            all: { items: [1, 2, 3, 4, 5, 6].map(item), nextCursor: null },
          },
          counts,
          mailboxCounts: [],
        },
      });
      try {
        await choose(page, "Unassigned");
        const before = await listLayout(page, "a.mail-focus-row");
        expect(before.rows).toHaveLength(4);
        await answered(page, 1);
        expect(held[0]!.view).toBe("unassigned");
        held[0]!.respond({ items: [item(3), item(4), item(5), item(6)], counts, nextCursor: null });
        await idle(page);
        expect(await listLayout(page, "a.mail-focus-row")).toEqual(before);
        expect(await page.evaluate(() => window.focusSeen)).toEqual({ empty: [], skeleton: 0 });
        expect(page.errors).toEqual([]);
      } finally {
        await close(page);
      }
    }, 30_000);

    test(`switches to an empty view whose count grew since without its empty state on a ${name}`, async () => {
      const page = await load(context, {
        initialView: "unassigned",
        initialFocusError: null,
        initialFocus: {
          pages: {
            mine: { items: [], nextCursor: null },
            unassigned: { items: [item(1), item(2)], nextCursor: null },
            waiting: { items: [], nextCursor: null },
            all: { items: [item(1), item(2)], nextCursor: null },
          },
          counts: { mine: 0, unassigned: 2, waiting: 0, all: 2 },
          mailboxCounts: [],
        },
      });
      try {
        // Another view's read brings the newer counts: one conversation is now assigned to the person.
        await choose(page, "Waiting");
        await answered(page, 1);
        const grown = { mine: 1, unassigned: 1, waiting: 0, all: 2 };
        held[0]!.respond({ items: [], counts: grown, nextCursor: null });
        await idle(page);
        await page.evaluate(() => window.watchFocus());

        // For me still holds the server's empty page; its count says one row is coming.
        await choose(page, "For me");
        await page.waitForSelector(".mail-focus-skeleton");
        const skeleton = await listLayout(page, ".mail-focus-skeleton > .mail-focus-row");
        expect(skeleton.rows).toHaveLength(1);
        await answered(page, 2);
        expect(held[1]!.view).toBe("mine");
        held[1]!.respond({ items: [plain(1)], counts: grown, nextCursor: null });
        await idle(page);
        expect(await listLayout(page, "a.mail-focus-row")).toEqual(skeleton);
        expect((await page.evaluate(() => window.focusSeen)).empty).toEqual([]);
        expect(page.errors).toEqual([]);
      } finally {
        await close(page);
      }
    }, 30_000);

    test(`shows loading rows of the final size, never the empty state, while a view loads on a ${name}`, async () => {
      const page = await load(context, { initialView: "mine", initialFocusError: "Mail is restarting", initialFocus: null });
      try {
        await choose(page, "Unassigned");
        await page.waitForSelector(".mail-focus-skeleton");
        // A read that answers at once never shows the loading rows: they stay transparent for a moment.
        const appear = await page.evaluate(() => {
          const style = getComputedStyle(document.querySelector(".mail-focus-skeleton > .mail-focus-row")!);
          return { delay: style.animationDelay, fill: style.animationFillMode };
        });
        expect(appear).toEqual({ delay: "0.3s", fill: "both" });
        await page.waitForFunction(
          () => getComputedStyle(document.querySelector(".mail-focus-skeleton > .mail-focus-row")!).opacity === "1",
        );
        expect(await page.locator(".mail-focus-skeleton").getAttribute("aria-busy")).toBe("true");
        // Nothing is known about the view yet: one loading row in a box of the empty state's height.
        const unknown = await listLayout(page, ".mail-focus-skeleton > .mail-focus-row");
        expect(unknown.rows).toHaveLength(1);
        await answered(page, 1);
        const known = { mine: 0, unassigned: 0, waiting: 0, all: 2 };
        held[0]!.respond({ items: [], counts: known, nextCursor: null });
        await page.waitForSelector('.mail-overview-list .k2b-placeholder[data-state="empty"]');
        await fontsLoaded(page);
        expect((await listLayout(page, ".k2b-placeholder")).list).toEqual(unknown.list);

        // With the count from that read, the next view loads in as many rows as it will show.
        await choose(page, "All active");
        await page.waitForSelector(".mail-focus-skeleton");
        const skeleton = await listLayout(page, ".mail-focus-skeleton > .mail-focus-row");
        expect(skeleton.rows).toHaveLength(2);
        await answered(page, 2);
        // Rows with only their mailbox and state, the usual case. On a phone a row whose further facts
        // (flagged, attachment) wrap to a second line is one line taller than its loading row.
        held[1]!.respond({ items: [plain(3), plain(4)], counts: known, nextCursor: null });
        await idle(page);
        // The rows take exactly the place of the loading rows.
        expect(await listLayout(page, "a.mail-focus-row")).toEqual(skeleton);

        const seen = await page.evaluate(() => window.focusSeen);
        // Only the view that answered without rows showed its empty state, and only after it answered.
        expect(new Set(seen.empty)).toEqual(new Set(["No unassigned conversationsThere are no matching active conversations."]));
        expect(page.errors).toEqual([]);
      } finally {
        await close(page);
      }
    }, 30_000);
  }
});
