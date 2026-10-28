import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import type { Browser, BrowserContextOptions, Page } from "playwright";
import { launchBrowser, pageErrors, settled, viewTransitionEnded } from "../../../ui/test/browser";
import { chatTestNow, nora, startChatHarness, tobias, viewer } from "./ChatWorkspace.browser-fixture";
import type { DeviceNotice } from "./device-notice";

let harness: Awaited<ReturnType<typeof startChatHarness>>;
let browser: Browser;
beforeAll(async () => {
  harness = await startChatHarness();
  browser = await launchBrowser();
}, 60_000);
afterAll(async () => {
  await browser?.close();
  harness?.stop();
});
beforeEach(() => harness.reset());

const desktop: BrowserContextOptions = { viewport: { width: 1440, height: 900 } };
const phone: BrowserContextOptions = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true };
const minutesAgo = (minutes: number) => new Date(chatTestNow.getTime() - minutes * 60_000);
/** Set to a folder to keep light and dark pictures of each state, for the comparison with the approved mockup. */
const shots = process.env.CHAT_NOTIFY_SCREENSHOTS;
const shoot = async (page: Page, name: string) => {
  if (!shots) return;
  mkdirSync(shots, { recursive: true });
  await page.screenshot({ path: resolve(shots, `${name}.png`), animations: "disabled" });
};

const load = async (
  options: BrowserContextOptions,
  address: { chat?: string; thread?: string; panel?: "info" },
  extra: {
    deviceNotice?: DeviceNotice;
    theme?: "light" | "dark";
    /** What this device's browser answers: its notification permission, and Cloud's quiet state for the person. */
    device?: { permission?: NotificationPermission; userAgent?: string; quiet?: { reason: "doNotDisturb" | "quietHours"; until: string } };
  } = {},
) => {
  const context = await browser.newContext({
    ...options,
    colorScheme: extra.theme ?? "light",
    ...(extra.device?.userAgent ? { userAgent: extra.device.userAgent } : {}),
  });
  const page = await context.newPage();
  if (extra.device?.permission) {
    await page.addInitScript((permission) => {
      Object.defineProperty(Notification, "permission", { configurable: true, get: () => permission });
    }, extra.device.permission);
  }
  const quiet = extra.device?.quiet;
  await page.route("**/api/me/notifications/quiet", (route) =>
    route.fulfill({
      json: {
        state: quiet
          ? { active: true, reason: quiet.reason, until: quiet.until, nextStart: null }
          : { active: false, reason: null, until: null, nextStart: null },
      },
    }),
  );
  page.setDefaultTimeout(5_000);
  await page.addInitScript((timestamp) => {
    const RealDate = Date;
    class PinnedDate extends RealDate {
      constructor(...args: ConstructorParameters<DateConstructor> | []) {
        if (args.length === 0) super(timestamp);
        else super(...args);
      }
      static override now() {
        return timestamp;
      }
    }
    Object.defineProperty(globalThis, "Date", { value: PinnedDate, configurable: true, writable: true });
  }, chatTestNow.getTime());
  const errors = pageErrors(page);
  const path = address.chat ? `/app/chat/c/${address.chat}${address.thread ? `/t/${address.thread}` : ""}` : "/app/chat";
  const url = new URL(path, harness.url);
  if (address.panel) url.searchParams.set("panel", address.panel);
  if (extra.theme) url.searchParams.set("theme", extra.theme);
  await page.goto(url.href);
  await page.evaluate(
    ({ props, notice }) => {
      document.documentElement.lang = "de";
      window.mountChat(notice ? { ...props, deviceNotice: notice } : props, "de");
    },
    { props: harness.props(address), notice: extra.deviceNotice ?? null },
  );
  await page.locator(".chat-workspace").waitFor();
  await settled(page);
  return { page, errors };
};

/** "Projekt Lindenhof" with 8 members and the chat rule's default; a 34-member chat on mentions; a muted one. */
const seed = () => {
  const team = Array.from({ length: 6 }, (_, index) => ({
    ...nora,
    id: `00000000-0000-4000-8000-00000000010${index}`,
    name: `Person ${index}`,
  }));
  const lindenhof = harness.addChat({
    members: [viewer, nora, tobias, ...team],
    name: "Projekt Lindenhof",
    count: 6,
    end: minutesAgo(2),
    unread: 3,
  });
  harness.setNotifications(lindenhof, { level: "all", choice: null, until: null, defaultLevel: "all", following: null });
  const lager = harness.addChat({ members: [viewer, nora, tobias], name: "Team Lager", count: 6, end: minutesAgo(6), unread: 4 });
  harness.setNotifications(lager, { level: "mentions", choice: null, until: null, defaultLevel: "mentions", following: null }, 1);
  const eltern = harness.addChat({ members: [viewer, nora], name: "Elternbeirat", count: 4, end: minutesAgo(90), unread: 2 });
  harness.setNotifications(
    eltern,
    {
      level: "none",
      choice: "none",
      until: new Date(chatTestNow.getTime() + 8 * 3_600_000).toISOString(),
      defaultLevel: "all",
      following: null,
    },
    1,
  );
  return { lindenhof, lager, eltern };
};
const section = (page: Page) => page.locator(".chat-notifications");
const radio = (page: Page, name: string) => section(page).getByRole("radio", { name, exact: false });

describe("Chat notifications", () => {
  for (const [name, options] of [
    ["desktop", desktop],
    ["phone", phone],
  ] as const) {
    test(`${name}: Info shows the levels with the default, saves at once, and Off shows its duration and the head's bell`, async () => {
      const { lindenhof } = seed();
      const { page, errors } = await load(options, { chat: lindenhof, panel: "info" });
      try {
        await section(page).waitFor();
        await viewTransitionEnded(page);
        expect(await page.getByRole("radiogroup", { name: "Benachrichtigungen" }).count()).toBe(1);
        expect(await radio(page, "Alle Nachrichten").getAttribute("aria-checked")).toBe("true");
        expect(await section(page).locator(".k2b-choice-list__marker").textContent()).toBe("Standard");
        expect(await section(page).getByRole("link", { name: "Einstellungen › Benachrichtigungen" }).getAttribute("href")).toBe(
          "/me/notifications",
        );
        await shoot(page, `info-default-light-${name}`);

        await radio(page, "Nur Erwähnungen").click();
        await page.waitForFunction(() => document.querySelector('[role="radio"][aria-checked="true"]')?.textContent?.startsWith("Nur"));
        expect(harness.notificationWrites.at(-1)).toEqual({ level: "mentions" });

        // Keyboard: the arrow moves to "Aus" and saves it with the default duration.
        await radio(page, "Nur Erwähnungen").focus();
        await page.keyboard.press("ArrowDown");
        await section(page).getByText("Aus bis heute").waitFor();
        expect(harness.notificationWrites.at(-1)).toEqual({ level: "none", for: "8h" });
        expect(await page.evaluate(() => document.activeElement?.textContent?.startsWith("Aus"))).toBe(true);
        expect(await section(page).getByRole("radiogroup", { name: "Wie lange" }).count()).toBe(1);
        await page.locator(".chat-conversation__muted").waitFor();
        await shoot(page, `info-muted-light-${name}`);

        await section(page).getByRole("radio", { name: "Bis ich es ändere" }).click();
        await section(page).getByText("Bleibt aus, bis du es änderst.").waitFor();
        expect(harness.notificationWrites.at(-1)).toEqual({ level: "none", for: "forever" });

        // Choosing the marked default gives the choice back to the chat's rule.
        await radio(page, "Alle Nachrichten").click();
        await page.locator(".chat-conversation__muted").waitFor({ state: "detached" });
        expect(harness.notificationWrites.at(-1)).toEqual({ level: "default" });
        expect(errors).toEqual([]);
      } finally {
        await page.context().close();
      }
    }, 30_000);
  }

  test("a failed save returns to the saved level in its reserved place, without moving what follows, and retries", async () => {
    const { lindenhof } = seed();
    // A device that has not decided yet: no blocked note shares the place.
    const { page, errors } = await load(desktop, { chat: lindenhof, panel: "info" }, { device: { permission: "default" } });
    try {
      await section(page).waitFor();
      const link = section(page).getByRole("link", { name: "Einstellungen › Benachrichtigungen" });
      // The panel may scroll the chosen row into view, so the place is measured from the levels' own top.
      const offset = async () => (await link.boundingBox())!.y - (await radio(page, "Alle Nachrichten").boundingBox())!.y;
      const before = await offset();
      harness.failNotifications(1);
      await radio(page, "Nur Erwähnungen").click();
      const alert = section(page).getByRole("alert");
      await alert.waitFor();
      expect(await alert.textContent()).toContain("Nicht gespeichert. Es gilt weiter „Alle Nachrichten“.");
      expect(await radio(page, "Alle Nachrichten").getAttribute("aria-checked")).toBe("true");
      expect(await offset()).toBe(before);
      await shoot(page, "info-error-light-desktop");
      await alert.getByRole("button", { name: "Erneut versuchen" }).click();
      await alert.waitFor({ state: "detached" });
      expect(await radio(page, "Nur Erwähnungen").getAttribute("aria-checked")).toBe("true");
      expect(harness.notificationWrites).toEqual([{ level: "mentions" }, { level: "mentions" }]);
      expect(errors).toEqual([]);
    } finally {
      await page.context().close();
    }
  }, 30_000);

  test("a browser that blocks notifications says so in Info, where the level still applies elsewhere", async () => {
    const { lindenhof } = seed();
    const { page, errors } = await load(phone, { chat: lindenhof, panel: "info" }, { device: { permission: "denied" } });
    try {
      await section(page).getByText("Dein Browser blockiert Benachrichtigungen für Cloud.").waitFor();
      await shoot(page, "info-blocked-light-phone");
      expect(errors).toEqual([]);
    } finally {
      await page.context().close();
    }
  }, 30_000);

  for (const [name, options] of [
    ["desktop", desktop],
    ["phone", phone],
  ] as const) {
    test(`${name}: the list shows the count, @ for mentions, and a quiet muted row; a remembered line stands in the first picture`, async () => {
      seed();
      const { page, errors } = await load(options, {}, { deviceNotice: { kind: "ask" }, device: { permission: "default" } });
      try {
        const row = (title: string) => page.locator(".k2b-app-workspace__sidebar-item:visible", { hasText: title }).first();
        await row("Elternbeirat").waitFor();
        expect(await row("Team Lager").locator(".k2b-app-workspace__sidebar-status-mention").count()).toBe(1);
        expect(await row("Elternbeirat").locator(".k2b-app-workspace__sidebar-status[data-muted]").count()).toBe(1);
        expect(await row("Elternbeirat").locator(".k2b-app-workspace__sidebar-status-muted").count()).toBe(1);
        const notice = page.locator(".chat-device-notice:visible");
        expect(await notice.getAttribute("data-kind")).toBe("ask");
        expect(await notice.textContent()).toContain("Benachrichtigungen auf diesem Gerät einschalten?");
        await shoot(page, `list-ask-light-${name}`);
        await notice.getByRole("button", { name: "Nicht jetzt" }).click();
        await notice.waitFor({ state: "detached" });
        expect(await page.evaluate(() => localStorage.getItem("chat:notifications-ask-dismissed"))).toBe("1");
        expect(await page.evaluate(() => document.cookie)).toContain("chat_device_notice=none");
        expect(errors).toEqual([]);
      } finally {
        await page.context().close();
      }
    }, 30_000);
  }

  test("an iPhone outside the Home Screen and do not disturb have their own line", async () => {
    seed();
    const until = new Date(chatTestNow.getTime() + 78 * 60_000).toISOString();
    const iphone =
      "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
    for (const [kind, notice, device] of [
      ["home-screen", { kind: "home-screen" }, { userAgent: iphone }],
      ["quiet", { kind: "quiet", reason: "doNotDisturb", until }, { permission: "granted", quiet: { reason: "doNotDisturb", until } }],
    ] as const) {
      const { page } = await load(phone, {}, { deviceNotice: notice, device });
      try {
        const line = page.locator(".chat-device-notice:visible");
        expect(await line.getAttribute("data-kind")).toBe(kind);
        if (kind === "home-screen") {
          expect(await line.textContent()).toContain("Home-Bildschirm");
          expect(await line.getByRole("link", { name: "So geht's" }).getAttribute("href")).toBe("/help/apps/chat/chat-notifications");
        } else {
          expect(await line.textContent()).toContain("Nicht stören bis heute");
          expect(await line.getByRole("button", { name: "Beenden" }).count()).toBe(1);
        }
        await shoot(page, `list-${kind}-light-phone`);
      } finally {
        await page.context().close();
      }
    }
  }, 30_000);

  test("an item discussion's head says You follow and ends following; Info lists followed discussions", async () => {
    const ref = { type: "spaces.space", id: "Space1" };
    const chat = harness.addChat({ members: [viewer, nora, tobias], name: "Ausstellung Herbst", count: 2, end: minutesAgo(30) });
    harness.setSystem(chat, ref);
    const thread = harness.addThread(chat, { name: "Sockel für Halle 2", description: "Item", count: 2, end: minutesAgo(5) });
    harness.resourceThread(chat, thread, {
      ref: { type: "spaces.item", id: "Item01" },
      kind: "task",
      status: "Offen",
      done: false,
      href: "/app/spaces/items/Item01",
    });
    harness.followThread(chat, thread, true);
    harness.setNotifications(chat, {
      level: "mentions",
      choice: null,
      until: null,
      defaultLevel: "mentions",
      following: { count: 2, first: { id: thread, name: "Sockel für Halle 2" } },
    });
    const { page, errors } = await load(desktop, { chat, thread, panel: "info" });
    try {
      const follow = page.locator(".chat-conversation__header").getByRole("button", { name: "Du folgst" });
      await follow.waitFor();
      expect(await follow.getAttribute("aria-pressed")).toBe("true");
      expect(await section(page).textContent()).toContain("„Sockel für Halle 2“ und 1 weitere, weil du dort geschrieben hast");
      expect(await section(page).textContent()).toContain("in einer Diskussion schreibt, der du folgst");
      await shoot(page, "info-system-light-desktop");
      await follow.click();
      const unfollowed = page.locator(".chat-conversation__header").getByRole("button", { name: "Folgen" });
      await unfollowed.waitFor();
      expect(await unfollowed.getAttribute("aria-pressed")).toBe("false");
      expect(harness.thread(chat, thread)?.following).toBe(false);
      expect(errors).toEqual([]);
    } finally {
      await page.context().close();
    }
  }, 30_000);

  test("dark: Info and the list keep their states readable", async () => {
    if (!shots) return;
    const { lindenhof } = seed();
    const { page } = await load(desktop, { chat: lindenhof, panel: "info" }, { theme: "dark", deviceNotice: { kind: "ask" } });
    try {
      await section(page).waitFor();
      await shoot(page, "info-default-dark-desktop");
    } finally {
      await page.context().close();
    }
  }, 30_000);
});
