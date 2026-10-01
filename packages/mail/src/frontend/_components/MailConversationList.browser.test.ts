import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { type Browser, type BrowserContextOptions, chromium, type Page } from "playwright";
import type { MailConversationPreview } from "../../contracts";
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
  assigneeUserId: null,
  snoozedUntil: null,
  sourceFolderId: null,
  unreadFolderIds: [],
  localTags: [],
  revision: 1,
  ...overrides,
});
const tag = (name: string, color: string) => ({ id: name, name, color }) as unknown as MailListItem["localTags"][number];
const items: MailListItem[] = [
  item(0, {
    subject: "Stage technology offer for the 2027 summer festival with a deliberately long subject line",
    participantLabels: ["Mara Example", "Jonas Sample"],
    assigneeUserId: "user-jonas",
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
    },
    attachments: { count: 3, firstName: "Offer_stage_technology_v3.pdf" },
    earlierMessageCount: 4,
    assigneeName: "Jonas Sample",
  },
};
const previewFor = (id: string): MailConversationPreview =>
  previews[id] ?? {
    conversationId: id,
    summary: null,
    latestMessage: { from: { name: `Person ${Number(id.slice(2))}`, address: "person@example.test" }, excerpt: "Good morning,\n\nthanks." },
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
      '<!doctype html><html class="light"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">' +
        '<link rel="stylesheet" href="/styles.css"></head><body class="k2b-ui" style="margin:0">' +
        '<div id="root" style="position:fixed;inset:56px 8px 8px 56px;display:flex;flex-direction:column"></div>' +
        '<script src="/harness.js"></script></body></html>',
      { headers: { "Content-Type": "text/html" } },
    );
  },
});

let browser: Browser;
beforeAll(async () => {
  browser = await chromium.launch();
}, 30_000);
afterAll(async () => {
  await browser?.close();
  server.stop(true);
});

const desktop: BrowserContextOptions = { viewport: { width: 1440, height: 900 } };

const load = async (
  options: { context?: BrowserContextOptions; theme?: "light" | "dark"; selectedConversationId?: string | null; locale?: "en" | "de" } = {},
) => {
  const page = await (await browser.newContext(options.context ?? desktop)).newPage();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  // Every API request of the page, and whether the page aborted it.
  const requests: { path: string; aborted: boolean }[] = [];
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    if (path.startsWith("/api/")) requests.push({ path, aborted: false });
  });
  page.on("requestfailed", (request) => {
    const path = new URL(request.url()).pathname;
    const entry = requests.findLast((candidate) => candidate.path === path && !candidate.aborted);
    if (entry && request.failure()?.errorText.includes("ABORTED")) entry.aborted = true;
  });
  await page.clock.install();
  await page.goto(server.url.href);
  if (options.theme === "dark") await page.evaluate(() => document.documentElement.classList.replace("light", "dark"));
  await page.evaluate((harnessOptions: MailListHarnessOptions) => window.mountMailList(harnessOptions), {
    locale: options.locale ?? "en",
    items,
    selectedConversationId: options.selectedConversationId ?? null,
  } satisfies MailListHarnessOptions);
  await page.clock.pauseAt(Date.now() + 60_000);
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

  test("starts the request on pointer enter and aborts it when the row is left before the answer", async () => {
    previewDelay = 2_000;
    const page = await load();
    try {
      await pointAt(page, row("Cv0003"));
      await page.clock.runFor(50);
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

  test("never covers the list: no card without room beside it at 1024 px", async () => {
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
