import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import type { Browser, BrowserContextOptions, Page } from "playwright";
import { launchBrowser } from "../../../../ui/test/browser";
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
        '<div id="root" style="position:fixed;inset:56px 8px 8px 56px;display:flex;flex-direction:column"></div>' +
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
    folderOnlyHints?: MailFolderView[];
    reader?: boolean;
    items?: MailListItem[];
    toolbarActions?: MailListHarnessOptions["toolbarActions"];
    deletedOnServer?: boolean;
  } = {},
) => {
  const page = await (await browser.newContext(options.context ?? desktop)).newPage();
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
    folderOnlyHints: options.folderOnlyHints,
    reader: options.reader,
    toolbarActions: options.toolbarActions,
    deletedOnServer: options.deletedOnServer,
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

  test("swaps rows after 90 ms at the same size and serves a row again from the cache", async () => {
    const page = await load();
    try {
      await pointAt(page, row("Cv0002"));
      await page.clock.runFor(201);
      await settle(page);
      const first = (await box(page, card))!;
      await pointAt(page, row("Cv0005"));
      await page.clock.runFor(89);
      expect(await shown(page)).toBe("Room booking 2");
      await page.clock.runFor(2);
      expect(await shown(page)).toBe("Room booking 5");
      await settle(page);
      const second = (await box(page, card))!;
      expect([second.width, second.height]).toEqual([first.width, first.height]);
      expect(Math.round(second.top)).toBe(Math.round((await box(page, row("Cv0005")))!.top));

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

  test("never covers the list: no card without room beside it at 1024 px, but one beside a collapsed sidebar", async () => {
    const page = await load({ context: { viewport: { width: 1024, height: 768 } } });
    try {
      const list = (await box(page, "[data-mail-conversation-list]"))!;
      const frame = (await box(page, ".mail-workspace"))!;
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
      const under = await page.evaluate(() => document.querySelector(".mail-list-entry:hover")?.getAttribute("data-conversation-id"));
      // The list really moved rows under the mouse.
      expect(under).toBeDefined();
      expect(under).not.toBe("Cv0008");
      await page.clock.runFor(500);
      const loaded = (await requests(page)).slice(1).map((request) => request.path);
      // At most the row the mouse rests on once the list stands still, which the card opens for anyway.
      expect(loaded.length).toBeLessThanOrEqual(1);
      if (loaded.length === 1) expect(loaded[0]).toBe(previewPath(under!));
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
      await pointAt(page, row("Cv0007"));
      await page.clock.runFor(201);
      await settle(page);
      expect(await page.locator(`${card} .mail-quick-look__text`).innerText()).toBe("Der Nachrichteninhalt wird noch synchronisiert");
      // A body that was still synchronizing is asked for again on the next rest instead of staying cached.
      await away(page);
      await page.clock.runFor(400);
      await pointAt(page, row("Cv0007"));
      await page.clock.runFor(81);
      await requested(page, previewPath("Cv0007"), 2);
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
