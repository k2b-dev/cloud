import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { appAccentStyle } from "@k2b/cloud/ssr/app-appearance";
import { appColors } from "@k2b/cloud/ssr/app-color";
import type { Browser, BrowserContextOptions, Page } from "playwright";
import { launchBrowser, settled } from "../../../../ui/test/browser";
import type { MailConversationPreview } from "../../contracts";
import type { MailFolderView } from "../../service/messages";
import type { MailListHarnessOptions } from "./MailConversationList.browser-harness";
import type { MailListItem } from "./mail-navigation";

// Pointer types, the top layer, real layout, and timers decide when and where
// the quick look opens, so the real list runs in a browser beside a reader.
const buildHarness = async (): Promise<string> => {
  const ui = new URL("../../../../ui/", import.meta.url).pathname;
  const { transformAsync } = await import(Bun.resolveSync("@babel/core", ui));
  const typescript = (await import(Bun.resolveSync("@babel/preset-typescript", ui))).default;
  const solid = (await import(Bun.resolveSync("babel-preset-solid", ui))).default;
  const build = await Bun.build({
    entrypoints: [new URL("./MailConversationList.browser-harness.tsx", import.meta.url).pathname],
    target: "browser",
    format: "iife",
    conditions: ["browser"],
    plugins: [
      {
        name: "solid-mail-list-test",
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
  if (!build.success) throw new AggregateError(build.logs, "Mail list harness build failed");
  return build.outputs[0]!.text();
};

const buildCss = async (entry: string): Promise<string> => {
  // The production stylesheets compile through Cloud's Tailwind plugin.
  const tailwind = (await import(Bun.resolveSync("bun-plugin-tailwind", new URL("../../../../cloud/", import.meta.url).pathname))).default;
  const build = await Bun.build({ entrypoints: [entry], plugins: [tailwind] });
  if (!build.success) throw new AggregateError(build.logs, `Could not compile ${entry}`);
  return build.outputs[0]!.text();
};

/** The page's fake clock starts here, so day labels such as "Today" do not depend on when the suite runs. */
const NOW = Date.UTC(2026, 9, 1, 10, 30);
const at = (minutesAgo: number) => new Date(Date.UTC(2026, 9, 1, 10, 0) - minutesAgo * 60_000).toISOString();
const item = (index: number, overrides: Partial<MailListItem> = {}): MailListItem => ({
  id: `Cv${String(index).padStart(4, "0")}`,
  conversationId: `Cv${String(index).padStart(4, "0")}`,
  selectionKind: "conversation",
  primaryReference: null,
  subject: `Room booking ${index}`,
  participantSummary: `Person ${index}`,
  participantLabels: [`Person ${index}`],
  latestMessageAt: at(index * 90),
  preview: `Short preview ${index}`,
  attachmentMatch: null,
  unread: index % 3 === 0,
  activeFolderIds: [],
  flagged: false,
  hasAttachments: false,
  messageCount: 1,
  workStatus: "needs_action",
  assigneeUserIds: [],
  snoozedUntil: null,
  sourceFolderId: null,
  unreadFolderIds: [],
  localTags: [],
  revision: 1,
  kept: false,
  ...overrides,
});
const tag = (name: string, color: string) => ({ id: name, name, color }) as unknown as MailListItem["localTags"][number];
const items: MailListItem[] = [
  item(0, {
    subject: "Stage technology offer for the 2027 summer festival with a deliberately long subject line",
    participantLabels: ["Mara Example", "Jonas Sample"],
    assigneeUserIds: ["user-jonas"],
    messageCount: 5,
    hasAttachments: true,
    localTags: [tag("Event", "#8b5cf6"), tag("Offer", "#f59e0b"), tag("Accounting", "#0ea5e9"), tag("Members", "#10b981")],
  }),
  item(1, { subject: "Question about invoice 2026-0418", participantLabels: ["Paul Probe"], workStatus: "waiting" }),
  ...Array.from({ length: 28 }, (_, index) => item(index + 2)),
];
const previews: Record<string, MailConversationPreview> = {
  Cv0000: {
    conversationId: "Cv0000",
    summary: "Mara sends version 3 of the offer for stage, light and sound. Power supply and the Friday setup are still open.",
    latestMessage: {
      from: { name: "Mara Example", address: "mara@example.test" },
      excerpt: Array.from({ length: 30 }, (_, line) => `Line ${line} of the newest message.`).join("\n"),
      body: "synced",
    },
    attachments: { count: 3, firstName: "Offer_stage_technology_v3.pdf" },
    earlierMessageCount: 4,
    assigneeName: "Jonas Sample",
  },
  Cv0007: {
    conversationId: "Cv0007",
    summary: null,
    latestMessage: { from: { name: "Person 7", address: "person@example.test" }, excerpt: null, body: "syncing" },
    attachments: { count: 0, firstName: null },
    earlierMessageCount: 0,
    assigneeName: null,
  },
};
const previewFor = (id: string): MailConversationPreview =>
  previews[id] ?? {
    conversationId: id,
    summary: null,
    latestMessage: {
      from: { name: `Person ${Number(id.slice(2))}`, address: "person@example.test" },
      excerpt: "Good morning,\n\nthanks.",
      body: "synced",
    },
    attachments: { count: 0, firstName: null },
    earlierMessageCount: 0,
    assigneeName: null,
  };

const harness = await buildHarness();
const css =
  (await buildCss(resolve(import.meta.dir, "../../../../../styles.css"))) +
  (await buildCss(resolve(import.meta.dir, "../../styles/app.css")));
/** Milliseconds the preview endpoint waits before it answers. */
let previewDelay = 0;
const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  async fetch(request) {
    const { pathname } = new URL(request.url);
    if (pathname === "/harness.js") return new Response(harness, { headers: { "Content-Type": "text/javascript; charset=utf-8" } });
    if (pathname === "/styles.css") return new Response(css, { headers: { "Content-Type": "text/css; charset=utf-8" } });
    const match = /^\/api\/mail\/mailboxes\/Box001\/conversations\/([^/]+)\/preview$/u.exec(pathname);
    if (match?.[1]) {
      if (previewDelay) await Bun.sleep(previewDelay);
      return Response.json(previewFor(match[1]));
    }
    return new Response(
      // Mail's accent, which Cloud's layout sets for the app.
      '<!doctype html><html class="light" style="--app-accent:#0f766e"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">' +
        '<link rel="stylesheet" href="/styles.css"></head><body class="k2b-ui" style="margin:0">' +
        '<div id="root" style="position:fixed;inset:56px 8px 8px 56px;display:flex;flex-direction:column;container-type:inline-size;container-name:k2b-app-area"></div>' +
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

const desktop: BrowserContextOptions = { viewport: { width: 1440, height: 900 } };

const load = async (
  options: {
    context?: BrowserContextOptions;
    theme?: "light" | "dark";
    selectedConversationId?: string | null;
    locale?: "en" | "de";
    selectionMode?: boolean;
    sidebarCollapsed?: boolean;
    listSize?: number;
    folderOnlyHints?: MailFolderView[];
    reader?: boolean;
    requestUrl?: string;
    items?: MailListItem[];
    toolbarActions?: MailListHarnessOptions["toolbarActions"];
    deletedOnServer?: boolean;
    plainText?: string;
    /** Serves this stylesheet in place of the compiled one. */
    css?: string;
  } = {},
) => {
  const page = await (await browser.newContext(options.context ?? desktop)).newPage();
  const stylesheet = options.css;
  if (stylesheet) await page.route("**/styles.css", (route) => route.fulfill({ contentType: "text/css; charset=utf-8", body: stylesheet }));
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  // Every API request of the page, and whether the page aborted it. The page looks up once, while idle, which apps
  // store files for "Save to Files"; that lookup is not one of the list's requests.
  const requests: { path: string; aborted: boolean }[] = [];
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    if (path.startsWith("/api/") && path !== "/api/capabilities/v1/catalog") requests.push({ path, aborted: false });
  });
  page.on("requestfailed", (request) => {
    const path = new URL(request.url()).pathname;
    const entry = requests.findLast((candidate) => candidate.path === path && !candidate.aborted);
    // Chromium reports net::ERR_ABORTED, WebKit "Load request cancelled", Firefox NS_BINDING_ABORTED.
    if (entry && /aborted|cancel/iu.test(request.failure()?.errorText ?? "")) entry.aborted = true;
  });
  await page.clock.install({ time: NOW });
  await page.goto(server.url.href);
  if (options.theme === "dark") await page.evaluate(() => document.documentElement.classList.replace("light", "dark"));
  await page.evaluate((harnessOptions: MailListHarnessOptions) => window.mountMailList(harnessOptions), {
    locale: options.locale ?? "en",
    items: options.items ?? items,
    selectedConversationId: options.selectedConversationId ?? null,
    selectionMode: options.selectionMode,
    sidebarCollapsed: options.sidebarCollapsed,
    listSize: options.listSize,
    folderOnlyHints: options.folderOnlyHints,
    reader: options.reader,
    requestUrl: options.requestUrl,
    toolbarActions: options.toolbarActions,
    deletedOnServer: options.deletedOnServer,
    plainText: options.plainText,
  } satisfies MailListHarnessOptions);
  await page.clock.pauseAt(NOW + 60_000);
  return Object.assign(page, { errors, requests });
};
const close = (page: Page) => page.context().close();

type Box = { top: number; left: number; width: number; height: number };
const box = (page: Page, selector: string) =>
  page.evaluate((selector) => {
    const element = document.querySelector(selector);
    if (!element) return null;
    const { top, left, width, height } = element.getBoundingClientRect();
    return { top, left, width, height };
  }, selector) as Promise<Box | null>;
const row = (id: string) => `.mail-list-entry[data-conversation-id="${id}"]`;
const card = ".mail-quick-look-card";
const shown = (page: Page) =>
  page.evaluate(() => {
    const surface = document.querySelector(".mail-quick-look-card");
    return surface?.matches(":popover-open") ? (surface.querySelector(".mail-quick-look__subject")?.textContent ?? "") : null;
  });
/**
 * Chromium may deliver a mouse move after Playwright's call returned, so wait
 * until the target is hovered before the fake clock runs the delays.
 */
const hovered = (page: Page, selector: string) =>
  page.waitForFunction((selector) => document.querySelector(selector)?.matches(":hover") === true, selector);
const pointAt = async (page: Page, selector: string) => {
  const target = (await box(page, selector))!;
  await page.mouse.move(target.left + target.width * 0.4, target.top + target.height / 2);
  await hovered(page, selector);
};
/** The boxes of everything around the card: frame, list, rows, and reader. */
const layout = (page: Page) =>
  page.evaluate(() =>
    [...document.querySelectorAll(".mail-workspace, .mail-workspace-navigation, .mail-list-entry, .mail-list-entry *, #reader")].map(
      (element) => {
        const { top, left, width, height } = element.getBoundingClientRect();
        return [top, left, width, height];
      },
    ),
  );
/** Lets the preview request answer and the card render it. */
const settle = async (page: Page) => {
  await page.waitForFunction(() => !document.querySelector(".mail-quick-look[aria-busy='true']"));
  await page.evaluate(() => new Promise((done) => queueMicrotask(() => done(null))));
};

type Tracked = Page & { requests: { path: string; aborted: boolean }[] };
const requests = async (page: Tracked) => page.requests.map((request) => ({ ...request }));
/** The browser reports an abort after the page made it, so wait for that report. */
const abortReported = async (page: Tracked, path: string) => {
  for (let attempt = 0; attempt < 100 && !page.requests.some((request) => request.path === path && request.aborted); attempt += 1) {
    await Bun.sleep(20);
  }
};
/** Requests reach the test after the page made them, so wait for the expected count. */
const requested = async (page: Tracked, path: string, count: number) => {
  for (let attempt = 0; attempt < 100 && page.requests.filter((request) => request.path === path).length < count; attempt += 1) {
    await Bun.sleep(20);
  }
};
/** The list's scroll container. */
const listScroller = '[data-scroll-preserve="mail-list-Box001"]';
const previewPath = (id: string) => `/api/mail/mailboxes/Box001/conversations/${id}/preview`;
const linkOf = (id: string) => `${row(id)} a.mail-list-row`;
const expanded = (page: Page, id: string) =>
  page.evaluate((selector) => document.querySelector(selector)?.getAttribute("aria-expanded"), linkOf(id));
const navigations = (page: Page) =>
  page.evaluate(() => window.mailNavigations.map((href) => new URL(href, location.href)).map((url) => `${url.pathname}${url.search}`));
/** A point in the reader, far from the list and the card. */
const away = async (page: Page) => {
  await page.mouse.move(1300, 850);
  await hovered(page, "#reader");
};

describe("Mail quick look", () => {
  test("opens after 200 ms beside the list, top-aligned with the row, at a fixed size, without moving anything", async () => {
    const page = await load();
    try {
      const before = await layout(page);
      await pointAt(page, row("Cv0001"));
      await page.clock.runFor(199);
      expect(await shown(page)).toBeNull();
      await page.clock.runFor(2);
      expect(await shown(page)).toBe("Question about invoice 2026-0418");
      expect(await expanded(page, "Cv0001")).toBe("true");
      await settle(page);
      expect(await page.locator(`${card} .mail-quick-look__facts`).innerText()).toContain("Today, 10:30");

      const surface = (await box(page, card))!;
      const list = (await box(page, "[data-mail-conversation-list]"))!;
      const anchor = (await box(page, row("Cv0001")))!;
      expect(surface.width).toBe(22 * 16);
      expect(surface.height).toBe(20 * 16);
      expect(Math.round(surface.top)).toBe(Math.round(anchor.top));
      expect(Math.round(surface.left - (list.left + list.width))).toBe(8);
      // Neither opening nor the answer moves the list, its rows, or the reader.
      expect(await layout(page)).toEqual(before);
      // Hovering only reads the preview; nothing else is requested, so nothing is marked as read.
      expect(await requests(page)).toEqual([{ path: previewPath("Cv0001"), aborted: false }]);
      expect(page.errors).toEqual([]);
    } finally {
      await close(page);
    }
  }, 30_000);

  test("starts the request once the mouse rests on a row and aborts it when the row is left before the answer", async () => {
    previewDelay = 2_000;
    const page = await load();
    try {
      await pointAt(page, row("Cv0003"));
      await page.clock.runFor(79);
      expect(await requests(page)).toEqual([]);
      await page.clock.runFor(2);
      await requested(page, previewPath("Cv0003"), 1);
      expect(await requests(page)).toEqual([{ path: previewPath("Cv0003"), aborted: false }]);
      await away(page);
      await abortReported(page, previewPath("Cv0003"));
      expect(await requests(page)).toEqual([{ path: previewPath("Cv0003"), aborted: true }]);
      await page.clock.runFor(500);
      expect(await shown(page)).toBeNull();

      // A card that opened keeps its request when the pointer moves into it.
      await pointAt(page, row("Cv0004"));
      await page.clock.runFor(201);
      expect(await shown(page)).toBe("Room booking 4");
      expect(await page.locator(`${card} .mail-quick-look[aria-busy='true']`).count()).toBe(1);
      const loadingBox = await box(page, card);
      await pointAt(page, card);
      await page.clock.runFor(400);
      expect(await shown(page)).toBe("Room booking 4");
      expect((await requests(page)).at(-1)).toEqual({ path: previewPath("Cv0004"), aborted: false });
      await settle(page);
      expect(await box(page, card)).toEqual(loadingBox);
      expect(await page.locator(`${card} .mail-quick-look__text`).innerText()).toContain("thanks.");
    } finally {
      previewDelay = 0;
      await close(page);
    }
  }, 30_000);

  test("focus retries an aborted prefetch while another card is pinned open", async () => {
    const page = await load();
    let releaseResponse = () => {};
    const heldResponse = new Promise<void>((resolve) => {
      releaseResponse = resolve;
    });
    let attempts = 0;
    try {
      await page.route(`**${previewPath("Cv0003")}`, async (route) => {
        attempts += 1;
        if (attempts === 1) await heldResponse;
        await route.fulfill({ json: previewFor("Cv0003") });
      });
      await page.focus(linkOf("Cv0002"));
      await page.keyboard.press("Space");
      await settle(page);
      expect(await shown(page)).toBe("Room booking 2");
      await pointAt(page, row("Cv0003"));
      await page.clock.runFor(81);
      await requested(page, previewPath("Cv0003"), 1);
      expect(await shown(page)).toBe("Room booking 2");
      await away(page);
      await abortReported(page, previewPath("Cv0003"));
      expect((await requests(page)).filter((request) => request.path === previewPath("Cv0003"))).toEqual([
        { path: previewPath("Cv0003"), aborted: true },
      ]);
      releaseResponse();
      // No new pointer stay or Space: the shared controller follows focus.
      await page.focus(linkOf("Cv0003"));
      await page.clock.runFor(91);
      expect(await shown(page)).toBe("Room booking 3");
      await requested(page, previewPath("Cv0003"), 2);
      expect((await requests(page)).filter((request) => request.path === previewPath("Cv0003"))).toHaveLength(2);
      await settle(page);
      expect(await page.locator(`${card} .mail-quick-look__text`).innerText()).toContain("thanks.");
      expect(page.errors).toEqual([]);
    } finally {
      releaseResponse();
      await close(page);
    }
  }, 30_000);

  test("swaps rows after 90 ms at the same size and serves a row again from the cache", async () => {
    const page = await load();
    try {
      await pointAt(page, row("Cv0002"));
      await page.clock.runFor(201);
      await settle(page);
      const first = (await box(page, card))!;
      // A row with room below it for the whole card, so the card starts at the row (rows are three or four lines).
      await pointAt(page, row("Cv0004"));
      await page.clock.runFor(89);
      expect(await shown(page)).toBe("Room booking 2");
      await page.clock.runFor(2);
      expect(await shown(page)).toBe("Room booking 4");
      await settle(page);
      const second = (await box(page, card))!;
      expect([second.width, second.height]).toEqual([first.width, first.height]);
      expect(Math.round(second.top)).toBe(Math.round((await box(page, row("Cv0004")))!.top));

      await pointAt(page, row("Cv0002"));
      await page.clock.runFor(91);
      expect(await shown(page)).toBe("Room booking 2");
      expect((await requests(page)).filter((request) => request.path === previewPath("Cv0002"))).toHaveLength(1);
    } finally {
      await close(page);
    }
  }, 30_000);

  test("closes 180 ms after the pointer leaves, on Escape, and when the list scrolls", async () => {
    const page = await load();
    try {
      await pointAt(page, row("Cv0002"));
      await page.clock.runFor(201);
      await away(page);
      await page.clock.runFor(179);
      expect(await shown(page)).toBe("Room booking 2");
      await page.clock.runFor(2);
      expect(await shown(page)).toBeNull();

      await pointAt(page, row("Cv0003"));
      await page.clock.runFor(201);
      await page.keyboard.press("Escape");
      expect(await shown(page)).toBeNull();
      // Escape holds until the pointer leaves the row.
      await page.clock.runFor(500);
      expect(await shown(page)).toBeNull();

      await pointAt(page, row("Cv0004"));
      await page.clock.runFor(201);
      expect(await shown(page)).toBe("Room booking 4");
      await page.mouse.wheel(0, 200);
      await page.waitForFunction(() => !document.querySelector(".mail-quick-look-card")?.matches(":popover-open"));
    } finally {
      await close(page);
    }
  }, 30_000);

  test("Space on the focused row toggles the card and keeps focus; Enter and a click on the card open the conversation", async () => {
    const page = await load();
    try {
      await page.focus(linkOf("Cv0002"));
      await page.keyboard.press("Space");
      expect(await shown(page)).toBe("Room booking 2");
      expect(await page.evaluate(() => document.activeElement?.closest(".mail-list-entry")?.getAttribute("data-conversation-id"))).toBe(
        "Cv0002",
      );
      await page.keyboard.press("Space");
      expect(await shown(page)).toBeNull();
      expect(await expanded(page, "Cv0002")).toBe("false");

      await page.keyboard.press("Enter");
      expect(await navigations(page)).toEqual(["/app/mail/Box001?conversation=Cv0002"]);

      await page.keyboard.press("Space");
      await settle(page);
      await page.click(`${card} .mail-quick-look__text`);
      expect((await navigations(page)).at(-1)).toBe("/app/mail/Box001?conversation=Cv0002");
      expect(await shown(page)).toBeNull();
    } finally {
      await close(page);
    }
  }, 30_000);

  test("shows no card and starts no request for the conversation open in the reader", async () => {
    const page = await load({ selectedConversationId: "Cv0001" });
    try {
      await pointAt(page, row("Cv0001"));
      await page.clock.runFor(500);
      expect(await shown(page)).toBeNull();
      await page.focus(linkOf("Cv0001"));
      await page.keyboard.press("Space");
      expect(await shown(page)).toBeNull();
      expect(await requests(page)).toEqual([]);
    } finally {
      await close(page);
    }
  }, 30_000);

  test("shows no card on touch devices and phones", async () => {
    const phone = await load({ context: { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true } });
    try {
      const before = await layout(phone);
      await phone.tap(linkOf("Cv0002"));
      await phone.clock.runFor(500);
      expect(await shown(phone)).toBeNull();
      expect(await requests(phone)).toEqual([]);
      expect(await layout(phone)).toEqual(before);
    } finally {
      await close(phone);
    }
    // A mouse on a phone-sized window has no room beside the full-width list either.
    const narrow = await load({ context: { viewport: { width: 390, height: 844 } } });
    try {
      await pointAt(narrow, row("Cv0002"));
      await narrow.clock.runFor(500);
      expect(await shown(narrow)).toBeNull();
      expect(await requests(narrow)).toEqual([]);
    } finally {
      await close(narrow);
    }
  }, 30_000);

  test("never covers the list: no card without room beside it, but one beside a collapsed sidebar", async () => {
    // The host is 64px narrower than the viewport. At 1120px it passes the
    // shared 1024px sidebar breakpoint. A wider resizable list leaves too little
    // room for a card until the sidebar collapses.
    const context = { viewport: { width: 1120, height: 768 } };
    const page = await load({ context, listSize: 520 });
    try {
      await settle(page);
      const list = (await box(page, "[data-mail-conversation-list]"))!;
      const frame = (await box(page, ".mail-workspace"))!;
      const sidebar = (await box(page, ".mail-workspace-navigation"))!;
      expect(sidebar.left).toBeGreaterThanOrEqual(frame.left);
      expect(frame.left + frame.width - (list.left + list.width)).toBeLessThan(22 * 16 + 16);
      await pointAt(page, row("Cv0002"));
      await page.clock.runFor(500);
      expect(await shown(page)).toBeNull();
      await page.focus(linkOf("Cv0002"));
      await page.keyboard.press("Space");
      expect(await shown(page)).toBeNull();
      expect(await requests(page)).toEqual([]);
    } finally {
      await close(page);
    }
    const collapsed = await load({ context, sidebarCollapsed: true, listSize: 520 });
    try {
      await settle(collapsed);
      const list = (await box(collapsed, "[data-mail-conversation-list]"))!;
      const frame = (await box(collapsed, ".mail-workspace"))!;
      expect(frame.left + frame.width - (list.left + list.width)).toBeGreaterThanOrEqual(22 * 16 + 16);
      await pointAt(collapsed, row("Cv0002"));
      await collapsed.clock.runFor(500);
      expect(await shown(collapsed)).toBe("Room booking 2");
      await settle(collapsed);
      const surface = (await box(collapsed, card))!;
      expect(surface.left).toBeGreaterThan(list.left + list.width);
      expect(surface.left + surface.width).toBeLessThanOrEqual(frame.left + frame.width);
    } finally {
      await close(collapsed);
    }
  }, 30_000);

  test("starts no request for rows a sweeping mouse or a scrolling list passes", async () => {
    const page = await load();
    try {
      // A sweep from the second to the eighth row, with a frame between moves.
      const from = (await box(page, row("Cv0002")))!;
      const to = (await box(page, row("Cv0008")))!;
      for (let step = 0; step <= 20; step += 1) {
        await page.mouse.move(from.left + 120, from.top + 10 + ((to.top - from.top) * step) / 20);
        await page.clock.runFor(16);
      }
      await hovered(page, row("Cv0008"));
      expect(await requests(page)).toEqual([]);
      // Only the row where the mouse comes to rest loads.
      await page.clock.runFor(81);
      await requested(page, previewPath("Cv0008"), 1);
      expect(await requests(page)).toEqual([{ path: previewPath("Cv0008"), aborted: false }]);

      // Rows that pass under a still mouse while the list scrolls load nothing.
      for (let tick = 0; tick < 20; tick += 1) {
        await page.mouse.wheel(0, 120);
        await Bun.sleep(30);
        await page.clock.runFor(30);
      }
      // The wheel scrolls past the end; WebKit may still be scrolling and update `:hover` and pointer events later.
      await page.waitForFunction((selector) => {
        const list = document.querySelector(selector)!;
        return list.scrollTop + list.clientHeight >= list.scrollHeight - 1;
      }, listScroller);
      await page.clock.runFor(500);
      // The row under the resting mouse, from the layout rather than from `:hover`, which WebKit updates late.
      const under = await page.evaluate(
        ([x, y]) => document.elementFromPoint(x!, y!)?.closest(".mail-list-entry")?.getAttribute("data-conversation-id"),
        [from.left + 120, to.top + 10],
      );
      // The list really moved rows under the mouse.
      expect(under).toBeDefined();
      expect(under).not.toBe("Cv0008");
      const loaded = (await requests(page)).slice(1).map((request) => request.path);
      // At most the row the mouse rests on once the list stands still, which the card opens for anyway.
      expect(loaded.length).toBeLessThanOrEqual(1);
      if (loaded.length === 1) expect(loaded[0]).toBe(previewPath(under!));
    } finally {
      await close(page);
    }
  }, 30_000);

  test("starts no request and shows no card for a row the list moved away before the browser reported the mouse", async () => {
    const page = await load();
    try {
      await page.evaluate(() => {
        const body = document.body.dataset;
        document
          .querySelector('.mail-list-entry[data-conversation-id="Cv0003"]')!
          .addEventListener("pointerenter", () => (body.entered = "true"));
        // WebKit reports pointer events for rows that a list scrolls under a still mouse several scroll steps
        // late, and the list's scroll event may arrive only after the delays ended.
        for (const type of ["pointerover", "pointerenter", "pointermove", "pointerout", "pointerleave", "scroll"]) {
          window.addEventListener(type, (event) => body.held && event.stopImmediatePropagation(), true);
        }
      });
      const target = (await box(page, row("Cv0003")))!;
      await page.mouse.move(target.left + target.width * 0.4, target.top + target.height / 2);
      // The browser may deliver the move after Playwright's call returned, in WebKit even after `:hover` matches.
      await page.waitForFunction(() => document.body.dataset.entered);
      await page.clock.runFor(50);
      // The list scrolls three rows.
      await page.evaluate(
        ([selector, by]) => {
          document.body.dataset.held = "true";
          document.querySelector(selector)!.scrollTop = by!;
        },
        [listScroller, 3 * target.height] as const,
      );
      await page.clock.runFor(1_000);
      expect(await requests(page)).toEqual([]);
      expect(await shown(page)).toBeNull();
    } finally {
      await close(page);
    }
  }, 30_000);

  test("tag chips that shorten long names keep every full name in their tooltip", async () => {
    const page = await load();
    try {
      // The quick look's clock is paused, so wait for the row itself rather than for settled animations.
      await page.locator(`${row("Cv0000")} .mail-row-tags`).waitFor();
      await pointAt(page, `${row("Cv0000")} .mail-row-tags`);
      await page.clock.runFor(1000);
      // The hovered group's tooltip shows; the "+1" tooltip with the same names stays hidden.
      const tip = page.locator('[role="tooltip"]:visible').filter({ hasText: "Event, Offer, Accounting, Members" });
      await tip.waitFor({ state: "visible" });
      expect(await tip.count()).toBe(1);
    } finally {
      await close(page);
    }
  }, 30_000);

  test("shows no card and starts no request in selection mode, where a click selects", async () => {
    const page = await load({ selectionMode: true });
    try {
      await pointAt(page, row("Cv0002"));
      await page.clock.runFor(500);
      expect(await shown(page)).toBeNull();
      expect(await requests(page)).toEqual([]);
    } finally {
      await close(page);
    }
  }, 30_000);

  test("says when the newest message's body is still synchronizing", async () => {
    const page = await load({ locale: "de" });
    try {
      // Complete the prefetch before the 200 ms opening callback. A slow response
      // would hide a second load behind the loader's in-flight deduplication.
      await page.evaluate(() => {
        const fetch = window.fetch.bind(window);
        window.fetch = Object.assign(async (...args: Parameters<typeof fetch>) => {
          const response = await fetch(...args);
          if (response.url.endsWith("/Cv0007/preview")) {
            const json = response.json.bind(response);
            response.json = async () => {
              const data = await json();
              document.body.dataset.previewParsed = "true";
              return data;
            };
          }
          return response;
        }, fetch);
      });
      await pointAt(page, row("Cv0007"));
      await page.clock.runFor(81);
      await page.waitForFunction(() => document.body.dataset.previewParsed === "true");
      await page.clock.runFor(120);
      await settle(page);
      expect(await page.locator(`${card} .mail-quick-look__text`).innerText()).toBe("Der Nachrichteninhalt wird noch synchronisiert");
      expect((await requests(page)).filter((request) => request.path === previewPath("Cv0007"))).toHaveLength(1);
      const target = (await box(page, row("Cv0007")))!;
      await page.mouse.move(target.left + target.width * 0.6, target.top + target.height / 2);
      await hovered(page, row("Cv0007"));
      await page.clock.runFor(81);
      expect((await requests(page)).filter((request) => request.path === previewPath("Cv0007"))).toHaveLength(1);
      // A body that was still synchronizing is asked for again on the next rest instead of staying cached.
      await away(page);
      await page.clock.runFor(400);
      await pointAt(page, row("Cv0007"));
      await page.clock.runFor(81);
      await requested(page, previewPath("Cv0007"), 2);
      await page.clock.runFor(120);
      await settle(page);
      expect((await requests(page)).filter((request) => request.path === previewPath("Cv0007"))).toHaveLength(2);
    } finally {
      await close(page);
    }
  }, 30_000);

  test("keeps the loaded content while a live update of the conversation loads", async () => {
    const page = await load();
    try {
      await pointAt(page, row("Cv0002"));
      await page.clock.runFor(201);
      await settle(page);
      const before = await page.locator(`${card} .mail-quick-look__text`).innerText();
      previewDelay = 2_000;
      await page.evaluate(
        (next) => window.setMailItems(next),
        items.map((entry) => (entry.conversationId === "Cv0002" ? { ...entry, revision: entry.revision + 1 } : entry)),
      );
      await requested(page, previewPath("Cv0002"), 2);
      expect(await page.locator(`${card} .mail-quick-look[aria-busy='true']`).count()).toBe(0);
      expect(await page.locator(`${card} .mail-quick-look__text`).innerText()).toBe(before);
      expect((await requests(page)).filter((request) => request.path === previewPath("Cv0002"))).toHaveLength(2);
    } finally {
      previewDelay = 0;
      await close(page);
    }
  }, 30_000);

  test("an explicit keyboard reopening retries a syncing preview while the pointer stays on the row", async () => {
    const page = await load();
    try {
      await page.locator(row("Cv0007")).waitFor({ state: "visible" });
      await pointAt(page, row("Cv0007"));
      await page.clock.runFor(201);
      await settle(page);
      expect((await requests(page)).filter((request) => request.path === previewPath("Cv0007"))).toHaveLength(1);
      await page.locator(linkOf("Cv0007")).focus();
      await page.keyboard.press("Space");
      expect(await shown(page)).toBeNull();
      await page.keyboard.press("Space");
      await settle(page);
      await requested(page, previewPath("Cv0007"), 2);
      expect((await requests(page)).filter((request) => request.path === previewPath("Cv0007"))).toHaveLength(2);
      expect(await shown(page)).toBe("Room booking 7");
      expect(page.errors).toEqual([]);
    } finally {
      await close(page);
    }
  }, 30_000);

  test("returning from the still-open card starts one new attempt for a syncing preview", async () => {
    const page = await load();
    try {
      await page.locator(row("Cv0007")).waitFor({ state: "visible" });
      await pointAt(page, row("Cv0007"));
      await page.clock.runFor(201);
      await settle(page);
      expect((await requests(page)).filter((request) => request.path === previewPath("Cv0007"))).toHaveLength(1);
      await pointAt(page, card);
      await page.clock.runFor(400);
      expect(await shown(page)).toBe("Room booking 7");
      await pointAt(page, row("Cv0007"));
      await page.clock.runFor(81);
      await requested(page, previewPath("Cv0007"), 2);
      await settle(page);
      expect((await requests(page)).filter((request) => request.path === previewPath("Cv0007"))).toHaveLength(2);
      await page.clock.runFor(200);
      expect((await requests(page)).filter((request) => request.path === previewPath("Cv0007"))).toHaveLength(2);
      expect(page.errors).toEqual([]);
    } finally {
      await close(page);
    }
  }, 30_000);

  test("a denied preview stays unavailable for the current stay and can retry on a new stay", async () => {
    const page = await load();
    let attempts = 0;
    try {
      await page.route(`**${previewPath("Cv0007")}`, (route) => {
        attempts += 1;
        return attempts === 1
          ? route.fulfill({ status: 403, contentType: "application/json", body: JSON.stringify({ error: "Forbidden" }) })
          : route.fulfill({ json: previewFor("Cv0007") });
      });
      const denied = page.waitForResponse((response) => response.url().endsWith(previewPath("Cv0007")));
      await page.locator(row("Cv0007")).waitFor({ state: "visible" });
      await pointAt(page, row("Cv0007"));
      await page.clock.runFor(81);
      await (await denied).finished();
      await page.clock.runFor(120);
      await settle(page);
      expect(await page.locator(`${card} .mail-quick-look__text`).innerText()).toBe(
        "Preview unavailable. Open the conversation to read it.",
      );
      expect(attempts).toBe(1);
      await away(page);
      await page.clock.runFor(400);
      await pointAt(page, row("Cv0007"));
      await page.clock.runFor(201);
      await settle(page);
      expect(attempts).toBe(2);
      expect(await page.locator(`${card} .mail-quick-look__text`).innerText()).toBe("Body is still synchronizing");
      expect(page.errors).toEqual([]);
    } finally {
      await close(page);
    }
  }, 30_000);

  test("keeps the facts on one line: tags collapse into +n while status and assignee stay", async () => {
    const page = await load({ locale: "de" });
    try {
      await pointAt(page, row("Cv0000"));
      await page.clock.runFor(201);
      await settle(page);
      const facts = await page.evaluate(() => {
        const line = document.querySelector<HTMLElement>(".mail-quick-look__facts")!;
        return { overflow: line.scrollWidth - line.clientWidth, text: line.innerText.replace(/\s+/gu, " ") };
      });
      expect(facts.overflow).toBeLessThanOrEqual(0);
      expect(facts.text).toContain("Handlungsbedarf");
      expect(facts.text).toContain("Jonas Sample");
      expect(facts.text).toMatch(/\+\d/u);
      expect(facts.text).not.toContain("Members");
      const subjectLines = await page.evaluate(() => {
        const subject = document.querySelector<HTMLElement>(".mail-quick-look__subject")!;
        return Math.round(subject.getBoundingClientRect().height / Number.parseFloat(getComputedStyle(subject).lineHeight));
      });
      expect(subjectLines).toBe(2);
      expect(await page.locator(`${card} .mail-quick-look__foot`).innerText()).toContain("4 frühere Nachrichten");
      // Unassigned conversations say so instead of leaving the assignee out.
      await pointAt(page, row("Cv0002"));
      await page.clock.runFor(91);
      await settle(page);
      expect(await page.locator(`${card} .mail-quick-look__facts`).innerText()).toContain("Nicht zugewiesen");
    } finally {
      await close(page);
    }
  }, 30_000);

  test("moves up into the frame for a row near the bottom and keeps clear of the list", async () => {
    const page = await load();
    try {
      await page.evaluate(() => {
        const scroller = document
          .querySelector(".mail-list-entry")!
          .closest("[data-scroll-preserve], .k2b-scroll-area__viewport") as HTMLElement | null;
        (scroller ?? document.querySelector(".mail-list-entry")!.parentElement!.parentElement!).scrollTop = 100_000;
      });
      await page.clock.runFor(10);
      const last = row(items.at(-1)!.conversationId!);
      await pointAt(page, last);
      await page.clock.runFor(201);
      expect(await shown(page)).toBe(items.at(-1)!.subject);
      const surface = (await box(page, card))!;
      const frame = (await box(page, ".mail-workspace"))!;
      const list = (await box(page, "[data-mail-conversation-list]"))!;
      expect(Math.round(surface.top + surface.height)).toBeLessThanOrEqual(Math.round(frame.top + frame.height - 8));
      expect(surface.top).toBeLessThanOrEqual((await box(page, last))!.top);
      expect(surface.left).toBeGreaterThan(list.left + list.width);
    } finally {
      await close(page);
    }
  }, 30_000);

  for (const theme of ["light", "dark"] as const) {
    test(`uses the plain surface with inner depth only in the ${theme} theme`, async () => {
      const page = await load({ theme });
      try {
        await pointAt(page, row("Cv0000"));
        await page.clock.runFor(201);
        await settle(page);
        const style = await page.evaluate(() => {
          const surface = getComputedStyle(document.querySelector(".mail-quick-look-card")!);
          return { background: surface.backgroundColor, shadow: surface.boxShadow };
        });
        expect(style.background).toBe(theme === "light" ? "rgb(255, 255, 255)" : "rgb(17, 21, 27)");
        for (const shadow of style.shadow.split(/,(?![^(]*\))/u)) expect(shadow).toContain("inset");
        expect(page.errors).toEqual([]);
      } finally {
        await close(page);
      }
    }, 30_000);
  }
});

describe("Mail hint for a folder whose mail stays inside it", () => {
  const shared: MailFolderView = {
    id: "Fold02",
    parentId: null,
    name: "Shared",
    role: "other",
    providerRole: "other",
    configuredRole: null,
    selectable: true,
    display: "folder_only",
    effectiveDisplay: "folder_only",
    displayInheritedFromFolderId: null,
    displayNeutral: false,
    namespaceKinds: ["shared"],
    discoveryState: "active",
    missingSince: null,
    syncStatus: "current",
    total: 12,
    unread: 3,
  };
  const hint = "[data-mail-folder-only-hint]";

  for (const [name, context] of [
    ["desktop", desktop],
    ["phone", { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true }],
  ] as const) {
    test(`stays inside the list column on ${name} and leaves without a trace when dismissed`, async () => {
      const page = await load({ context, folderOnlyHints: [shared], locale: name === "phone" ? "de" : "en" });
      try {
        const list = (await box(page, "[data-mail-conversation-list]"))!;
        const notice = (await box(page, hint))!;
        expect(notice.left).toBeGreaterThanOrEqual(list.left);
        expect(notice.left + notice.width).toBeLessThanOrEqual(list.left + list.width);
        // Every line and control stays inside the notice; touch targets may reach beyond a control, not its box.
        expect(
          await page.$eval(hint, (element) => {
            const outer = element.getBoundingClientRect();
            return [...element.querySelectorAll("*")].filter((child) => {
              const inner = child.getBoundingClientRect();
              return inner.width > 0 && (inner.left < outer.left - 0.5 || inner.right > outer.right + 0.5);
            }).length;
          }),
        ).toBe(0);
        expect(await page.locator(`${hint} a`).getAttribute("href")).toBe("/app/mail/Box001?folder=Fold02");
        expect(await page.locator(hint).innerText()).toContain(
          name === "phone" ? "E-Mails aus „Shared“ erscheinen nur noch im Ordner." : "Mail from “Shared” now appears only in its folder.",
        );

        // On wide lists the actions sit beside the text; on narrow ones they move below it rather than squeeze it.
        const text = (await box(page, `${hint} p`))!;
        const actions = (await box(page, `${hint} a`))!;
        if (name === "phone") expect(actions.top).toBeGreaterThanOrEqual(text.top + text.height);
        else expect(actions.top).toBeLessThan(text.top + text.height);

        await page.locator(`${hint} button`).click();
        expect(await page.locator(hint).count()).toBe(0);
        expect(await page.evaluate(() => window.folderHintDismissed)).toBe(true);
        expect(page.errors).toEqual([]);
      } finally {
        await close(page);
      }
    }, 30_000);
  }

  test("keeps keyboard focus in the list column when a hint is dismissed", async () => {
    const page = await load({ folderOnlyHints: [shared, { ...shared, id: "Fold03", name: "Projects" }] });
    try {
      await page.locator(`${hint} button`).focus();
      await page.keyboard.press("Enter");
      // The next hint takes the place of the first, and its close button keeps the focus.
      expect(await page.locator(hint).innerText()).toContain("Mail from “Projects” now appears only in its folder.");
      expect(await page.evaluate(() => document.activeElement?.getAttribute("aria-label"))).toBe("Dismiss hint");
      // Without another hint, focus moves to the list's heading rather than out of the page.
      await page.keyboard.press("Enter");
      expect(await page.locator(hint).count()).toBe(0);
      expect(await page.evaluate(() => `${document.activeElement?.tagName} ${document.activeElement?.textContent?.trim()}`)).toBe(
        "H1 Inbox",
      );
      expect(page.errors).toEqual([]);
    } finally {
      await close(page);
    }
  }, 30_000);
});

describe("Mail conversation switching", () => {
  const subjectOf = (id: string) => items.find((candidate) => candidate.conversationId === id)!.subject;
  /** What the page shows: the URL, the current row, the reader's heading, and the open message with its body. */
  const opened = (page: Page) =>
    page.evaluate(() => {
      const card = document.querySelector<HTMLElement>("#reader [data-mail-message-id]");
      const body = card?.querySelector(".mail-message-body");
      const frame = body?.querySelector("iframe");
      // An HTML body renders in its frame; its document text without the frame's own script and styles.
      const framed = frame ? new DOMParser().parseFromString(frame.srcdoc, "text/html") : null;
      for (const element of framed?.querySelectorAll("script, style") ?? []) element.remove();
      return {
        url: `${location.pathname}${location.search}`,
        current: document.querySelector('.mail-list-entry:has([aria-current="page"])')?.getAttribute("data-conversation-id") ?? null,
        heading: document.querySelector("#reader [data-mail-reader-heading]")?.textContent?.trim() ?? null,
        cards: document.querySelectorAll("#reader [data-mail-message-id]").length,
        message: card?.dataset.mailMessageId ?? null,
        body: (framed ? framed.body.textContent : body?.textContent)?.trim() ?? null,
      };
    });
  const expected = (id: string) => ({
    url: `/app/mail/Box001?conversation=${id}`,
    current: id,
    heading: subjectOf(id),
    cards: 1,
    message: `Msg${id.slice(2)}`,
    body: `Body of ${subjectOf(id)}`,
  });
  /** Waits until the page shows the conversation, then compares everything at once. */
  const shows = async (page: Page, id: string) => {
    await page
      .waitForFunction((url) => `${location.pathname}${location.search}` === url, expected(id).url, { timeout: 2_000 })
      .catch(() => undefined);
    expect(await opened(page)).toEqual(expected(id));
  };
  const open = (page: Page, id: string) => page.click(linkOf(id));

  test("every click opens the clicked conversation, fast clicks end on the last one, and back and forward follow", async () => {
    const page = await load({ reader: true });
    try {
      // An HTML body (even rows) and a plain body (odd rows) unmount on every switch; back to an earlier one too.
      for (const id of ["Cv0001", "Cv0002", "Cv0003", "Cv0001", "Cv0004"]) {
        await open(page, id);
        await shows(page, id);
      }
      for (const id of ["Cv0005", "Cv0006", "Cv0007"]) await open(page, id);
      await shows(page, "Cv0007");

      await page.focus(linkOf("Cv0008"));
      await page.keyboard.press("Enter");
      await shows(page, "Cv0008");

      await page.goBack();
      await shows(page, "Cv0007");
      await page.goBack();
      await shows(page, "Cv0006");
      await page.goForward();
      await shows(page, "Cv0007");
      await open(page, "Cv0002");
      await shows(page, "Cv0002");
      expect(page.errors).toEqual([]);
    } finally {
      await close(page);
    }
  }, 30_000);

  test("after switching, the quick look opens for every other row, closes again, and never for the open one", async () => {
    const page = await load({ reader: true });
    try {
      await open(page, "Cv0001");
      await open(page, "Cv0002");
      await shows(page, "Cv0002");

      await pointAt(page, row("Cv0001"));
      await page.clock.runFor(201);
      expect(await shown(page)).toBe(subjectOf("Cv0001"));
      await settle(page);
      expect(await page.locator(`${card} .mail-quick-look__subject`).innerText()).toBe(subjectOf("Cv0001"));
      await away(page);
      await page.clock.runFor(181);
      expect(await shown(page)).toBeNull();

      await pointAt(page, row("Cv0002"));
      await page.clock.runFor(500);
      expect(await shown(page)).toBeNull();

      await pointAt(page, row("Cv0003"));
      await page.clock.runFor(201);
      expect(await shown(page)).toBe(subjectOf("Cv0003"));
      // Opening the previewed row closes its card; the row is now the open one.
      await open(page, "Cv0003");
      await shows(page, "Cv0003");
      await page.clock.runFor(500);
      expect(await shown(page)).toBeNull();

      await pointAt(page, row("Cv0002"));
      await page.clock.runFor(201);
      expect(await shown(page)).toBe(subjectOf("Cv0002"));
      // Only now, no longer open, did Cv0002 request its preview.
      expect((await requests(page)).filter((request) => request.path === previewPath("Cv0002"))).toHaveLength(1);
      expect(page.errors).toEqual([]);
    } finally {
      await close(page);
    }
  }, 30_000);
});

describe("Mail kept conversations", () => {
  const keptItems = (id: string) => items.map((entry) => (entry.conversationId === id ? { ...entry, kept: true } : entry));
  /** The reader's header and toolbar, and the open row: what keeping must not move. */
  const keepLayout = (page: Page, id: string) =>
    page.evaluate(
      (selector) =>
        [
          ...document.querySelectorAll(
            `#reader header, #reader [data-mail-reader-heading], #reader [data-mail-toolbar-action], ${selector}`,
          ),
        ].map((element) => {
          const { top, left, width, height } = element.getBoundingClientRect();
          return [top, left, width, height];
        }),
      row(id),
    );

  test("keeping the open conversation shows the lock without moving the header, toolbar, or row", async () => {
    const page = await load({
      reader: true,
      selectedConversationId: "Cv0001",
      toolbarActions: ["reply", "archive", "spam", "trash", "keep"],
    });
    try {
      await page.waitForSelector("#reader [data-mail-reader-heading]");
      const before = await keepLayout(page, "Cv0001");
      await page.evaluate((next) => window.setMailItems(next), keptItems("Cv0001"));
      await page.waitForSelector("#reader [data-mail-kept-indicator]");
      expect(await keepLayout(page, "Cv0001")).toEqual(before);
      // The harness loads no icon font, so the lock has no size here; the row carries it.
      expect(await page.locator(`${row("Cv0001")} [data-mail-kept-indicator]`).count()).toBe(1);
      // Cloud refuses Trash and Junk for a kept conversation, and only managers lift the keep.
      expect(await page.isDisabled('#reader [data-mail-toolbar-action="trash"]')).toBe(true);
      expect(await page.isDisabled('#reader [data-mail-toolbar-action="spam"]')).toBe(true);
      expect(await page.getAttribute('#reader [data-mail-toolbar-action="keep"]', "aria-label")).toBe("Kept");
      expect(page.errors).toEqual([]);
    } finally {
      await close(page);
    }
  });

  test("fits a phone and names a message the server deleted", async () => {
    for (const theme of ["light", "dark"] as const) {
      const page = await load({
        context: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true },
        theme,
        reader: true,
        items: keptItems("Cv0001"),
        selectedConversationId: "Cv0001",
        deletedOnServer: true,
      });
      try {
        await page.waitForSelector("#reader [data-mail-kept-indicator]");
        expect(await page.isVisible("text=Deleted on the server, kept in Cloud")).toBe(true);
        const overflow = await page.evaluate(() => {
          const header = document.querySelector("#reader header");
          return {
            page: document.documentElement.scrollWidth - window.innerWidth,
            header: header ? header.scrollWidth - header.clientWidth : 0,
          };
        });
        expect(overflow).toEqual({ page: 0, header: 0 });
        expect(page.errors).toEqual([]);
      } finally {
        await close(page);
      }
    }
  });
});

describe("Mail row actions", () => {
  const environments = [
    { name: "desktop mouse", hover: "hover", "any-hover": "hover", pointer: "fine", "any-pointer": ["fine"] },
    { name: "tablet with mouse", hover: "none", "any-hover": "hover", pointer: "coarse", "any-pointer": ["coarse", "fine"] },
    { name: "touch-only phone", hover: "none", "any-hover": "none", pointer: "coarse", "any-pointer": ["coarse"] },
  ] as const;
  // Neither engine emulates a touch primary pointer with a hovering secondary one, so the pointer media are rewritten.
  const pointerCss = (environment: (typeof environments)[number]) =>
    css.replace(/\((hover|any-hover|pointer|any-pointer)\s*:\s*(hover|none|fine|coarse)\)/g, (_, feature: string, value: string) => {
      const matches =
        feature === "any-pointer"
          ? environment["any-pointer"].some((pointer) => pointer === value)
          : environment[feature as "hover" | "any-hover" | "pointer"] === value;
      return matches ? "(min-width:0)" : "(max-width:0)";
    }) + "*,*::before,*::after{transition:none!important}";
  const matched = item(1, {
    subject: "Question about invoice 2026-0418",
    attachmentMatch: {
      attachmentId: "At0001",
      messageId: "Ms0001",
      filename: "invoice.pdf",
      snippet: "Invoice total",
      reason: "attachment_content",
    },
  });
  const rowItems = items.map((entry) => (entry.id === matched.id ? matched : entry));
  /** Per row: the opacity of its time and of each of its actions, and the boxes of everything in it. */
  const state = (page: Page) =>
    page.evaluate(() =>
      ["Cv0001", "Cv0002"].map((id) => {
        const entry = document.querySelector(`.mail-list-entry[data-conversation-id="${id}"]`)!;
        const opacity = (element: Element | null) => (element ? Number(getComputedStyle(element).opacity) : null);
        return {
          id,
          time: opacity(entry.querySelector(".mail-list-time")),
          actions: [...entry.querySelectorAll(".k2b-progressive-action")].map(opacity),
          // The open menu is a popover in the top layer, not part of the row's layout.
          boxes: [entry, ...entry.querySelectorAll(":not([popover], [popover] *)")].map((element) => {
            const { top, left, width, height } = element.getBoundingClientRect();
            return [top, left, width, height];
          }),
        };
      }),
    );
  const blur = (page: Page) => page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());

  for (const environment of environments) {
    describe(environment.name, () => {
      const hides = environment["any-hover"] === "hover";
      let page: Awaited<ReturnType<typeof load>>;
      let rest: Awaited<ReturnType<typeof state>>;
      /** Cv0001 has the matched attachment's download link besides its menu; Cv0002 only its menu. */
      const expectRows = (visible: string | null, hidesAtRest = hides) =>
        state(page).then((rows) => {
          for (const [index, row] of rows.entries()) {
            const actions = !hidesAtRest || row.id === visible ? 1 : 0;
            expect(row.time, row.id).toBe(1 - actions);
            expect(row.actions, row.id).toEqual(Array(row.id === "Cv0001" ? 2 : 1).fill(actions));
            // Only opacity changes; nothing in the rows moves.
            expect(row.boxes, row.id).toEqual(rest[index]!.boxes);
          }
        });

      // One page per environment: WebKit takes about a second per step on this page.
      beforeAll(async () => {
        page = await load({ items: rowItems, css: pointerCss(environment) });
        await away(page);
        rest = await state(page);
      }, 30_000);
      afterAll(async () => {
        await close(page);
      });

      test(hides ? "hides every row's actions at rest and shows the time" : "shows every row's actions in place of the time", async () => {
        await expectRows(null);
      });

      test("shows the hovered row's actions", async () => {
        await pointAt(page, row("Cv0001"));
        await expectRows("Cv0001");
        await away(page);
        await expectRows(null);
      }, 30_000);

      test("shows the focused row's actions", async () => {
        await page.focus(linkOf("Cv0002"));
        await expectRows("Cv0002");
        await blur(page);
        await expectRows(null);
      }, 30_000);

      test("keeps a row's actions while its menu is open", async () => {
        const trigger = `${row("Cv0002")} .k2b-progressive-action button[aria-haspopup]`;
        await page.click(trigger);
        await away(page);
        await blur(page);
        await expectRows("Cv0002");
        await page.keyboard.press("Escape");
        // With focus on the body, the browser closes the popover and reports it in a later toggle event.
        await page.waitForFunction((selector) => document.querySelector(selector)?.getAttribute("aria-expanded") !== "true", trigger);
        await blur(page);
        await expectRows(null);
        expect(page.errors).toEqual([]);
      }, 30_000);

      test("follows the recorded input mode: touch shows the actions in place of the time, trackpad on hover", async () => {
        const mode = (value: string | null) =>
          page.evaluate((value) => {
            if (value) document.documentElement.setAttribute("data-k2b-input", value);
            else document.documentElement.removeAttribute("data-k2b-input");
          }, value);
        try {
          await mode("touch");
          await expectRows(null, false);
          await mode("trackpad");
          await expectRows(null, true);
          await pointAt(page, row("Cv0001"));
          await expectRows("Cv0001", true);
          await away(page);
        } finally {
          await mode(null);
        }
        await expectRows(null);
      }, 30_000);
    });
  }
});

describe("Mail rows that an action takes out of the list", () => {
  /** The top of every row, by conversation. */
  const positions = (page: Page): Promise<Record<string, number>> =>
    page.evaluate(() =>
      Object.fromEntries(
        [...document.querySelectorAll<HTMLElement>(".mail-list-entry")].map((entry) => [
          entry.dataset.conversationId ?? "",
          Math.round(entry.getBoundingClientRect().top * 10) / 10,
        ]),
      ),
    );
  /** Holds the collapse at a fraction of its run, so the test reads its frames instead of racing them. */
  const collapseAt = (page: Page, fraction: number) =>
    page.evaluate((fraction) => {
      const animations = document.querySelector(".mail-list-entry[data-leaving]")?.getAnimations() ?? [];
      for (const animation of animations) {
        animation.pause();
        animation.currentTime = Number(animation.effect?.getComputedTiming().duration ?? 0) * fraction;
      }
      return animations.length;
    }, fraction);

  for (const viewport of [
    { name: "desktop", context: { viewport: { width: 1366, height: 900 } } },
    { name: "phone", context: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } },
  ] satisfies { name: string; context: BrowserContextOptions }[]) {
    test(`${viewport.name}: collapses in place, the rows below close the gap, and dropping the row moves nothing`, async () => {
      const page = await load({ context: viewport.context });
      try {
        const before = await positions(page);
        const left = (await box(page, row("Cv0002")))!;
        const next = before.Cv0003!;
        const step = next - before.Cv0002!;

        await page.evaluate(() => window.setMailLeaving(["Cv0002"]));
        expect(await collapseAt(page, 0)).toBe(1);
        const leaving = page.locator(row("Cv0002"));
        expect(await leaving.getAttribute("inert")).not.toBeNull();
        expect(await leaving.getAttribute("aria-hidden")).toBe("true");
        // The first frame keeps every row where it was; nothing jumps when the collapse starts.
        expect(await positions(page)).toEqual(before);
        expect((await box(page, row("Cv0002")))!.height).toBeCloseTo(left.height, 0);

        await collapseAt(page, 0.5);
        const halfway = await positions(page);
        expect(halfway.Cv0001).toBe(before.Cv0001!);
        expect(halfway.Cv0003!).toBeLessThan(next);
        expect(halfway.Cv0003!).toBeGreaterThan(next - step);

        // At its end the row takes its gap along: the next row stands where the leaving one stood.
        await collapseAt(page, 1);
        const collapsed = await positions(page);
        expect(collapsed.Cv0003).toBeCloseTo(before.Cv0002!, 0);

        await page.evaluate(() => {
          window.setMailItems(window.mailItems().filter((item) => item.id !== "Cv0002"));
          window.setMailLeaving([]);
        });
        const after = await positions(page);
        expect(Object.keys(after)).not.toContain("Cv0002");
        // Rows below the fold are placeholders of an estimated height until they come near the viewport, so only the
        // rows in view have a position the reader can see move.
        const inView = Object.entries(after).filter(([id]) => collapsed[id]! < viewport.context.viewport.height);
        expect(inView.length).toBeGreaterThan(3);
        for (const [id, top] of inView) expect(top).toBeCloseTo(collapsed[id]!, 0);
        expect(page.errors).toEqual([]);
      } finally {
        await close(page);
      }
    }, 30_000);
  }

  test("goes at once without an animation when the reader asks for reduced motion", async () => {
    const page = await load({ context: { ...desktop, reducedMotion: "reduce" } });
    try {
      await page.evaluate(() => window.setMailLeaving(["Cv0002"]));
      expect(await collapseAt(page, 0)).toBe(0);
    } finally {
      await close(page);
    }
  }, 30_000);
});

describe("Mail search returns to the view it started from", () => {
  for (const [device, context] of [
    ["desktop", { viewport: { width: 1366, height: 900 } }],
    ["phone", { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true }],
  ] satisfies [string, BrowserContextOptions][]) {
    for (const method of ["button", "Backspace", "Escape"]) {
      test(`${device}: clear with ${method} restores the view without moving the search field`, async () => {
        const origin = "/app/mail/Box001?view=needs_action";
        const page = await load({ context, requestUrl: origin });
        try {
          // The field's frame: the input inside it makes room for the clear button, the frame must not move.
          await page.getByRole("button", { name: "Search (/)", exact: true }).click();
          const selector = 'form[role="search"] .k2b-input-shell';
          const field = page.locator('input[name="q"]');
          await field.waitFor({ state: "visible" });
          const before = await box(page, selector);
          expect(
            await field.evaluate((element) => {
              const rect = element.getBoundingClientRect();
              const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
              return { inputReceivesPointer: hit === element, hit: hit?.tagName, width: rect.width };
            }),
          ).toMatchObject({ inputReceivesPointer: true, hit: "INPUT" });
          await field.click();
          await page.keyboard.type("invoice");
          await page.clock.runFor(350);
          expect(await page.evaluate(() => location.search)).toBe("?searchFrom=view%3Dneeds_action&q=invoice");
          expect(await box(page, selector)).toEqual(before);
          if (method === "button") await page.locator('form[role="search"] button[aria-label="Clear"]').click();
          else if (method === "Backspace") {
            await field.press("ControlOrMeta+a");
            await page.keyboard.press("Backspace");
          } else await page.keyboard.press("Escape");
          await page.clock.runFor(350);
          expect(await page.evaluate(() => location.pathname + location.search)).toBe(origin);
          if (method === "Escape") {
            expect(await field.count()).toBe(0);
            expect(
              await page.getByRole("button", { name: "Search (/)", exact: true }).evaluate((element) => element === document.activeElement),
            ).toBe(true);
          } else {
            expect(await field.inputValue()).toBe("");
            expect(await box(page, selector)).toEqual(before);
          }
          expect(page.errors).toEqual([]);
        } finally {
          await close(page);
        }
      }, 30_000);
    }
  }
});

describe("Mail conversation printing", () => {
  /** The newest message replies with quoted text to an earlier one, whose header keeps a tinted surface. */
  const plainText = "Thanks, see below.\n\n> Earlier question about the invoice\n> with a second line";
  /** What the reader prints: the subject, every message header, and every plain text body. */
  const printed = {
    subject: "[data-mail-print-root] h1",
    sender: "[data-mail-print-root] [data-mail-message-header] .font-semibold",
    date: "[data-mail-print-root] [data-mail-message-header] time",
    body: "[data-mail-print-root] [data-mail-message-id] pre:not(details pre)",
    quote: "[data-mail-print-root] [data-mail-message-id] details pre",
  };
  type Ink = { shown: boolean; ink: number[]; paper: number[] };
  /**
   * Every printed part: whether it takes part in the rendering, its text color, and the surface behind it, both as
   * red, green, and blue. The surface counts as printed, as with the browser's "Background graphics" option.
   */
  const inks = (page: Page) =>
    page.evaluate((selectors) => {
      const canvas = document.createElement("canvas").getContext("2d", { willReadFrequently: true })!;
      // The canvas resolves every CSS color syntax, oklch() included, to sRGB, and lays it over white paper.
      const onPaper = (...colors: string[]) => {
        canvas.fillStyle = "white";
        canvas.fillRect(0, 0, 1, 1);
        for (const color of colors) {
          canvas.fillStyle = color;
          canvas.fillRect(0, 0, 1, 1);
        }
        return [...canvas.getImageData(0, 0, 1, 1).data.slice(0, 3)];
      };
      const surfaces = (element: Element) => {
        const colors: string[] = [];
        for (let current: Element | null = element; current; current = current.parentElement) {
          colors.unshift(getComputedStyle(current).backgroundColor);
        }
        return colors;
      };
      return Object.fromEntries(
        Object.entries(selectors).map(([part, selector]) => [
          part,
          [...document.querySelectorAll(selector)].map((element) => ({
            shown: element.checkVisibility({ visibilityProperty: true }),
            ink: onPaper(getComputedStyle(element).color),
            paper: onPaper(...surfaces(element)),
          })),
        ]),
      ) as Record<keyof typeof printed, Ink[]>;
    }, printed);
  const luminance = (color: number[]) => {
    const [red, green, blue] = color.map((channel) => {
      const value = channel / 255;
      return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
    }) as [number, number, number];
    return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
  };
  /** WCAG contrast of the text against the surface it prints on. */
  const contrast = ({ ink, paper }: Ink) => {
    const [light, dark] = [luminance(ink), luminance(paper)].sort((a, b) => b - a) as [number, number];
    return (light + 0.05) / (dark + 0.05);
  };
  /** The labels of the quoted-text toggle that a reader of the paper would see. */
  const quoteLabels = (page: Page) =>
    page.evaluate(() =>
      [...document.querySelectorAll("[data-mail-print-root] details summary .inline-grid > span")]
        .filter((label) => label.checkVisibility({ visibilityProperty: true }))
        .map((label) => label.textContent),
    );
  const open = async (theme: "light" | "dark") => {
    const page = await load({ reader: true, theme, selectedConversationId: "Cv0001", plainText });
    await page.waitForSelector(printed.body);
    return page;
  };
  /** Prints through the conversation's Print action, as a person does, up to the browser's print dialog. */
  const print = async (page: Page) => {
    await page.evaluate(() => {
      window.print = () => document.body.setAttribute("data-printed", "");
    });
    await page.getByRole("button", { name: "More conversation actions" }).click();
    await page.getByRole("menuitem", { name: "Print conversation" }).click();
    // The reader opens every message, then asks for the dialog two frames later.
    await page.clock.runFor(100);
    await page.waitForSelector("body.mail-printing-conversation[data-printed]", { state: "attached" });
    await page.emulateMedia({ media: "print" });
  };

  test("prints a dark conversation as dark text on white paper, with its sender rows and one quote label", async () => {
    const page = await open("dark");
    try {
      // The print rules change nothing on screen.
      const screen = await inks(page);
      await page.evaluate(() => document.body.classList.add("mail-printing-conversation"));
      expect(await inks(page)).toEqual(screen);
      await page.evaluate(() => document.body.classList.remove("mail-printing-conversation"));

      await print(page);
      const paper = await inks(page);
      expect(paper.sender).toHaveLength(2);
      expect(paper.body).toHaveLength(2);
      for (const part of ["subject", "sender", "date", "body"] as const) {
        for (const [index, printedPart] of paper[part].entries()) {
          expect({ part, index, shown: printedPart.shown }).toEqual({ part, index, shown: true });
          expect(contrast(printedPart)).toBeGreaterThanOrEqual(7);
          // Dark text on light paper, never light text on a dark surface.
          expect(luminance(printedPart.paper)).toBeGreaterThan(luminance(printedPart.ink));
        }
      }
      expect(await quoteLabels(page)).toEqual(["Show quoted text"]);

      // Quoted text the person opened prints too, under its one current label.
      await page.evaluate(() => {
        document.querySelector<HTMLDetailsElement>("[data-mail-print-root] details")!.open = true;
      });
      expect(await quoteLabels(page)).toEqual(["Hide quoted text"]);
      const [quote] = (await inks(page)).quote;
      expect(quote?.shown).toBe(true);
      expect(contrast(quote!)).toBeGreaterThanOrEqual(7);
      expect(page.errors).toEqual([]);
    } finally {
      await close(page);
    }
  }, 30_000);

  test("prints a light conversation in the colors it shows", async () => {
    const page = await open("light");
    try {
      await print(page);
      const paper = await inks(page);
      await page.emulateMedia({ media: "screen" });
      // The same open conversation on screen: the print rules only add the message headers to the paper.
      const screen = await inks(page);
      expect(paper).toEqual({
        ...screen,
        sender: screen.sender.map((sender) => ({ ...sender, shown: true })),
        date: screen.date.map((date) => ({ ...date, shown: true })),
      });
      expect(paper.sender).toHaveLength(2);
      // The secondary date stays lighter than the sender's name.
      expect(paper.date[0]!.ink).not.toEqual(paper.sender[0]!.ink);
      expect(await quoteLabels(page)).toEqual(["Show quoted text"]);
    } finally {
      await close(page);
    }
  }, 30_000);
});

const rgb = (hex: string) => `rgb(${[1, 3, 5].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16)).join(", ")})`;
for (const viewport of [
  { width: 1440, height: 900 },
  { width: 390, height: 844 },
]) {
  test(`Mail open and checked rows use the app fill without moving at ${viewport.width}px`, async () => {
    const page = await load({ context: { viewport, reducedMotion: "reduce" }, selectionMode: true });
    try {
      // Keep dates fixed while letting settled() observe real animation frames.
      await page.clock.resume();
      await page.clock.setFixedTime(NOW + 60_000);
      await page.evaluate((style) => {
        const root = document.querySelector<HTMLElement>("#root")!;
        root.classList.add("app-accent-scope");
        root.style.cssText += `;${style}`;
      }, appAccentStyle("#0f766e")!);
      for (const theme of ["light", "dark"] as const) {
        await page.evaluate((theme) => {
          document.documentElement.className = theme;
          window.setMailActive(null);
          window.setMailChecked([]);
        }, theme);
        await settled(page);
        const before = [await box(page, row("Cv0000")), await box(page, row("Cv0001"))];
        await page.evaluate(() => {
          window.setMailActive("Cv0000");
          window.setMailChecked(["Cv0001"]);
          const scope = document.querySelector("#root")!;
          for (const percent of [11, 16]) {
            const old = document.createElement("span");
            old.id = `old-${percent}`;
            old.setAttribute("style", `background:color-mix(in srgb,var(--app-accent) ${percent}%,var(--ui-surface))`);
            scope.append(old);
          }
        });
        await settled(page);
        const fills = await page.evaluate(() => ({
          active: getComputedStyle(document.querySelector(".mail-list-entry-active")!).backgroundColor,
          checked: getComputedStyle(document.querySelector(".mail-list-entry-selected")!).backgroundColor,
          old: [11, 16].map((percent) => getComputedStyle(document.getElementById(`old-${percent}`)!).backgroundColor),
        }));
        for (const [index, fill] of [fills.active, fills.checked].entries()) {
          expect(fill, `${theme} ${index}`).toBe(rgb(appColors("#0f766e")[theme].selected));
          expect(fill).not.toBe(fills.old[index]);
        }
        await settled(page);
        expect([await box(page, row("Cv0000")), await box(page, row("Cv0001"))]).toEqual(before);
      }
    } finally {
      await close(page);
    }
  }, 30_000);

  test(`Mail quick-look summary stays flat with unchanged padding and card height at ${viewport.width}px`, async () => {
    const page = await load({ context: { viewport, reducedMotion: "reduce" } });
    try {
      await page.clock.resume();
      await page.clock.setFixedTime(NOW + 60_000);
      await page.evaluate(
        ({ style, item, preview }) => {
          const root = document.querySelector<HTMLElement>("#root")!;
          root.classList.add("app-accent-scope");
          root.style.cssText += `;${style}`;
          window.mountMailQuickLook(item, preview);
        },
        { style: appAccentStyle("#0f766e")!, item: items[0]!, preview: previews.Cv0000! },
      );
      for (const theme of ["light", "dark"] as const) {
        await page.evaluate((theme) => {
          document.documentElement.className = theme;
        }, theme);
        await settled(page);
        const summary = await page.locator("#summary-card .mail-quick-look__summary").evaluate((element) => {
          const style = getComputedStyle(element);
          return {
            background: style.backgroundColor,
            shadow: style.boxShadow,
            padding: [style.paddingTop, style.paddingRight, style.paddingBottom, style.paddingLeft],
          };
        });
        expect(summary).toEqual({ background: "rgba(0, 0, 0, 0)", shadow: "none", padding: ["7px", "10px", "7px", "10px"] });
        await settled(page);
        expect((await box(page, "#summary-card"))!.height).toBe(20 * 16);
      }
    } finally {
      await close(page);
    }
  }, 30_000);
}

describe("scoped flag search builder", () => {
  for (const type of ["unread", "flagged"] as const) {
    for (const step of ["edit", "clear", "save", "sequence"] as const) {
      // Cold WebKit setup plus opening, editing and reopening the lazy builder exceeds five seconds.
      // Use the shell browser suite's bounded budget; keep every transition and payload assertion.
      test(`${type}: ${step} retains folder scope and negation`, async () => {
        // Each starting state is the preceding step's asserted persisted output.
        const expression =
          step === "edit" || step === "sequence"
            ? { type, folderId: "Fold01" }
            : { type: "and", expressions: [{ type: "not", expression: { type, folderId: step === "clear" ? "Fold02" : null } }] };
        const initial = { expression, sort: "newest" };
        const currentPage = await load({ requestUrl: `/app/mail/Box001?${new URLSearchParams({ search: JSON.stringify(initial) })}` });
        try {
          await currentPage.clock.resume();
          let saved: unknown;
          await currentPage.route("**/api/mail/mailboxes/Box001/folders", (route) =>
            route.fulfill({
              json: [
                { id: "Fold01", name: "Inbox", parentId: null, selectable: true, role: "inbox" },
                { id: "Fold02", name: "Archive", parentId: null, selectable: true, role: "archive" },
              ],
            }),
          );
          await currentPage.route("**/api/mail/mailboxes/Box001/saved-views", async (route) => {
            saved = route.request().postDataJSON();
            await route.fulfill({ json: { ...route.request().postDataJSON(), id: "View01", revision: 1 } });
          });
          const openBuilder = async (currentPage: Awaited<ReturnType<typeof load>>) => {
            const trigger = currentPage.getByRole("button", { name: "Search (/)", exact: true });
            if (await trigger.count()) {
              await trigger.focus();
              await trigger.press("Enter");
              await currentPage.locator('input[name="q"]').waitFor({ state: "visible" });
            }
            await currentPage.getByRole("button", { name: "Search filters", exact: true }).click();
            await currentPage.getByRole("dialog").waitFor({ state: "visible" });
          };
          await openBuilder(currentPage);
          const state = () => JSON.parse(new URL(currentPage.url()).searchParams.get("search")!);
          const folder = currentPage.getByRole("combobox", { name: "Folder", exact: true });
          if (step === "edit" || step === "sequence") {
            await folder.click();
            await currentPage.getByRole("option", { name: "Archive", exact: true }).click();
            await currentPage.getByRole("button", { name: "Exclude this condition", exact: true }).click();
            await currentPage.getByRole("button", { name: "Search", exact: true }).click();
            await currentPage.getByRole("dialog").waitFor({ state: "hidden" });
            expect(state()).toEqual({
              expression: { type: "and", expressions: [{ type: "not", expression: { type, folderId: "Fold02" } }] },
              sort: "newest",
            });
            await openBuilder(currentPage);
            await folder.filter({ hasText: "Archive" }).waitFor({ state: "visible" });
            expect(await folder.textContent()).toContain("Archive");
          }
          if (step === "clear" || step === "sequence") {
            await folder.filter({ hasText: "Archive" }).waitFor({ state: "visible" });
            await currentPage.getByRole("button", { name: "Clear selection", exact: true }).click();
            await currentPage.getByRole("button", { name: "Search", exact: true }).click();
            await currentPage.getByRole("dialog").waitFor({ state: "hidden" });
            expect(state()).toEqual({
              expression: { type: "and", expressions: [{ type: "not", expression: { type, folderId: null } }] },
              sort: "newest",
            });
            await openBuilder(currentPage);
            await folder.waitFor({ state: "visible" });
            expect(await folder.textContent()).toContain("Any included folder");
          }
          if (step === "save" || step === "sequence") {
            await folder.waitFor({ state: "visible" });
            expect(await folder.textContent()).toContain("Any included folder");
            await folder.click();
            await currentPage.getByRole("option", { name: "Inbox", exact: true }).click();
            await currentPage.getByRole("button", { name: "Save as view", exact: true }).click();
            await currentPage.getByRole("textbox", { name: "Name", exact: true }).fill("Flagged in folder");
            await currentPage.getByRole("button", { name: "Save view", exact: true }).click();
            await currentPage.waitForURL((url) => url.searchParams.get("savedView") === "View01");
            expect(saved).toMatchObject({
              filter: {
                expression: { type: "and", expressions: [{ type: "not", expression: { type, folderId: "Fold01" } }] },
                sort: "newest",
              },
            });
          }
          expect(currentPage.errors).toEqual([]);
        } finally {
          await close(currentPage);
        }
      }, 20_000);
    }
  }
});

test("scoped flag folder lookup recovers without losing the filter", async () => {
  const initial = { expression: { type: "unread", folderId: "Fold01" }, sort: "newest" };
  const page = await load({ requestUrl: `/app/mail/Box001?${new URLSearchParams({ search: JSON.stringify(initial) })}` });
  try {
    await page.clock.resume();
    let fail = true;
    await page.route("**/api/mail/mailboxes/Box001/folders", (route) =>
      fail
        ? route.fulfill({ status: 503, json: { error: "Folder lookup temporarily unavailable" } })
        : route.fulfill({ json: [{ id: "Fold01", name: "Inbox", parentId: null, selectable: true, role: "inbox" }] }),
    );
    if (await page.getByRole("button", { name: "Search (/)", exact: true }).count())
      await page.getByRole("button", { name: "Search (/)", exact: true }).click();
    await page.getByRole("button", { name: "Search filters", exact: true }).click();
    await page.getByRole("alert").waitFor({ state: "visible" });
    expect(await page.getByRole("combobox", { name: "Folder", exact: true }).isDisabled()).toBe(true);
    fail = false;
    await page.getByRole("button", { name: "Retry", exact: true }).click();
    const folder = page.getByRole("combobox", { name: "Folder", exact: true });
    await folder.filter({ hasText: "Inbox" }).waitFor({ state: "visible" });
    expect(await folder.isEnabled()).toBe(true);
    await page.getByRole("button", { name: "Search", exact: true }).click();
    await page.getByRole("dialog").waitFor({ state: "hidden" });
    expect(JSON.parse(new URL(page.url()).searchParams.get("search")!)).toEqual({
      expression: { type: "and", expressions: [initial.expression] },
      sort: "newest",
    });
    expect(page.errors).toEqual([]);
  } finally {
    await close(page);
  }
});
