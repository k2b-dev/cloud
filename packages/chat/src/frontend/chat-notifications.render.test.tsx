import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createConfig } from "@k2b/ssr";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";

const root = mkdtempSync(resolve(tmpdir(), "chat-notifications-render-"));
const { plugin } = createConfig({ dev: true, rootDir: root });
Bun.plugin(plugin());
process.once("exit", () => rmSync(root, { recursive: true, force: true }));

const { notificationMarks } = await import("./ChatList");
const { default: ChatNotificationSettings, FollowToggle } = await import("./ChatNotificationSettings");
type Props = Parameters<typeof ChatNotificationSettings>[0];

const dateConfig = { locale: "en", timeZone: "UTC" };
const now = () => new Date("2026-10-28T10:42:00Z");
const notifications = (patch: Partial<Props["notifications"]> = {}): Props["notifications"] => ({
  level: "all",
  choice: null,
  until: null,
  defaultLevel: "all",
  following: null,
  ...patch,
});
const conversation = (patch: Partial<Props["conversation"]> = {}): Props["conversation"] => ({ kind: "chat", channel: false, ...patch });
const render = (props: Partial<Props> = {}) =>
  renderToString(() =>
    createComponent(ChatNotificationSettings, {
      conversation: conversation(),
      notifications: notifications(),
      dateConfig,
      now,
      save: async () => {},
      ...props,
    }),
  );

describe("list marks by notification level", () => {
  test("All messages counts, Mentions only shows @ or a dot, Off a bell with a quiet @ count", () => {
    const row = (level: "all" | "mentions" | "none", mentionsUnread = 0) => ({
      notifications: notifications({ level }),
      mentionsUnread,
    });
    expect(notificationMarks(row("all", 1), 5)).toEqual({ unread: 5 });
    expect(notificationMarks(row("mentions", 2), 12)).toEqual({ unread: 2, mention: true });
    expect(notificationMarks(row("mentions"), 12)).toEqual({ unread: true });
    expect(notificationMarks(row("mentions"), undefined)).toEqual({});
    expect(notificationMarks(row("none"), 7)).toEqual({ muted: true });
    expect(notificationMarks(row("none", 1), 7)).toEqual({ muted: true, unread: 1, mention: true });
    // The open chat being read hides its marks; only the bell stays.
    expect(notificationMarks(row("none", 1), undefined)).toEqual({ muted: true });
    expect(notificationMarks(row("all"), true)).toEqual({ unread: true });
    expect(notificationMarks({ notifications: null, mentionsUnread: 0 }, 3)).toEqual({ unread: 3 });
  });
});

describe("Info › Notifications", () => {
  test("three levels in a radio group, the derived default marked, the chat's descriptions, and the way to settings", () => {
    const html = render();
    expect(html).toContain('role="radiogroup"');
    expect(html.match(/role="radio"/g)).toHaveLength(3);
    expect(html).toMatch(/aria-checked="true"[^>]*>.*All messages.*Default/s);
    expect(html).toContain("Every new message notifies you, in all threads.");
    expect(html).toContain("Only when someone mentions you or replies to you.");
    expect(html).toContain('href="/me/notifications"');
    expect(html).toContain("chat-notifications__status");
    expect(html).not.toContain("For how long");
  });

  test("a chosen level moves only the selection; the marker stays at the default", () => {
    const html = render({ notifications: notifications({ level: "mentions", choice: "mentions", defaultLevel: "all" }) });
    expect(html).toMatch(/aria-checked="true"[^>]*>.*Mentions only/s);
    expect(html).toMatch(/All messages<span class="k2b-choice-list__marker">Default/);
  });

  test("Off shows the durations and when the default applies again", () => {
    const html = render({ notifications: notifications({ level: "none", choice: "none", until: "2026-10-28T18:42:00Z" }) });
    expect(html).toContain("For how long");
    for (const label of ["1 hour", "8 hours", "1 week", "Until I change it"]) expect(html).toContain(label);
    expect(html).toContain("Off until today 18:42. Then “All messages” applies again.");
    const forever = render({ notifications: notifications({ level: "none", choice: "none" }) });
    expect(forever).toContain("Stays off until you change it.");
    expect(forever).toMatch(/aria-checked="true"[^>]*>Until I change it/);
  });

  test("a channel and a Space's chat describe their levels, and the chat lists what you follow", () => {
    expect(render({ conversation: conversation({ channel: true }) })).toContain("Every new announcement notifies you.");
    const system = render({
      conversation: conversation({ kind: "system" }),
      notifications: notifications({
        level: "mentions",
        defaultLevel: "mentions",
        following: { count: 2, first: { id: "Thread01", name: "Plinths for hall 2" } },
      }),
    });
    expect(system).toContain("When someone mentions you, replies to you, or writes in a discussion you follow.");
    expect(system).toContain("You follow");
    expect(system).toContain("“Plinths for hall 2” and 1 more, because you wrote there");
  });

  test("a mute ending on another day names the day and date in the reader's language", async () => {
    const { untilLabel } = await import("./chat-format");
    expect(untilLabel("2026-11-04T10:42:00Z", now(), { locale: "de", timeZone: "UTC" })).toBe("Mi., 4.11., 10:42");
    expect(untilLabel("2026-10-28T18:42:00Z", now(), { locale: "de", timeZone: "UTC" })).toBe("heute 18:42");
  });

  test("the follow toggle says its state and is pressed while following", () => {
    const on = renderToString(() => createComponent(FollowToggle, { following: true, onToggle: async () => {} }));
    expect(on).toContain('aria-pressed="true"');
    expect(on).toContain("You follow");
    const off = renderToString(() => createComponent(FollowToggle, { following: false, onToggle: async () => {} }));
    expect(off).toContain('aria-pressed="false"');
    expect(off).toContain("Follow");
  });
});
