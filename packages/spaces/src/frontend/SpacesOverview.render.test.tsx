import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import { registerSsrTestPlugin } from "../../../ui/test/ssr-test-plugin";
import type { OverviewWork } from "../overview-contracts";

const root = mkdtempSync(join(tmpdir(), "spaces-overview-render-tests-"));
registerSsrTestPlugin({ dev: true, rootDir: root });

process.once("exit", () => rmSync(root, { recursive: true, force: true }));
const { default: SpacesOverview } = await import("./SpacesOverview.island.tsx");
const { overviewMessages } = await import("./overview-messages");
const { LocaleProvider } = await import("@k2b/ui");

// The rendered text as a parser reads it: text nodes only, without tags or hydration comments.
const textOf = (html: string) => {
  let plain = "";
  new HTMLRewriter()
    .onDocument({
      text(chunk) {
        plain += chunk.text;
      },
    })
    .transform(html);
  return plain;
};

type Extra = { itemTitle?: string; activitySpace?: string; initialView?: "mine" | "today"; day?: OverviewWork["day"] };
const render = (initialActivityError: string | null = null, locale = "en", extra: Extra = {}) =>
  renderToString(() =>
    createComponent(LocaleProvider, {
      locale,
      get children() {
        return createComponent(SpacesOverview, {
          spaces: [
            {
              id: "Space1",
              name: "Launch",
              description: "Launch work",
              color: "#3b82f6",
              openItemCount: 3,
            },
            {
              id: "Space2",
              name: "Archive",
              description: null,
              color: "#10b981",
              openItemCount: 0,
            },
          ],
          initialView: extra.initialView ?? "mine",
          initialPinnedSpaceIds: ["Space1"],
          initialWork: {
            view: extra.initialView ?? "mine",
            items: [
              {
                shortId: "Item01",
                spaceShortId: "Space1",
                spaceName: "Launch",
                spaceColor: "#3b82f6",
                title: "Ship overview",
                priority: "urgent",
                deadline: "2026-08-21T08:00:00.000Z",
                deadlineAllDay: false,
                startsAt: null,
                endsAt: null,
                canWrite: true,
              },
            ],
            counts: { mine: 1, today: 0, upcoming: 0 },
            day: extra.day,
          },
          initialActivity: {
            items: [
              {
                id: "1",
                space: { id: "Space1", name: extra.activitySpace ?? "Launch", color: "#3b82f6" },
                item: { id: "Item01", title: extra.itemTitle ?? "Ship overview" },
                actor: { kind: "user", id: "00000000-0000-4000-8000-000000000001", displayName: "Sofie", avatarHash: null },
                action: "task.completed",
                metadata: {},
                occurrenceCount: 1,
                createdAt: "2026-08-20T10:00:00.000Z",
                lastOccurredAt: "2026-08-20T10:00:00.000Z",
              },
            ],
            nextCursor: null,
          },
          initialActivityError,
          dateConfig: { locale, timeZone: "Europe/Berlin", firstDayOfWeek: 1 },
          now: "2026-08-20T12:00:00.000Z",
        });
      },
    }),
  );

describe("Spaces overview", () => {
  test("keeps the catalog complete and renders regional German locales", () => {
    expect(overviewMessages.check()).toEqual([]);
    const html = render(null, "de-CH");
    expect(html).toContain("Für mich");
    expect(html).toContain("Meine Arbeit");
    // The item's mark and name stand where the quotes were.
    expect(textOf(html)).toContain("Sofie · Ship overview in Launch erledigt");
    expect(textOf(html)).not.toContain("Completed");
  });

  test("renders the Spaces in the sidebar, the views as tabs, and the work and activity as rows", () => {
    const html = render();
    expect(html).toContain("data-k2-workspace");
    // The sidebar: each Space with its open items, pinned or not, and a way to start one.
    expect(html).toContain('href="/app/spaces/Space1"');
    expect(html).toContain('href="/app/spaces/Space2"');
    expect(html).toContain("Unpin Launch");
    expect(html).toContain("Pin Archive");
    expect(html).toContain("New space");
    expect(html).toMatch(/<a[^>]*data-k2-part="Nav.Item"[^>]*aria-current="page"[^>]*href="\/app\/spaces"/);
    // The head: the views as tabs, the search and the main action.
    expect(html).toMatch(/<a[^>]*class="k2-tab "[^>]*aria-current="page"[^>]*href="\/app\/spaces"/);
    expect(html).toContain('aria-label="Search Spaces"');
    expect(html).toContain("New task");
    // The work opens its item; the activity is a sentence: who, the deed, and the item with its mark, linked to it.
    expect(html).toContain("Ship overview");
    expect(html.match(/href="\/app\/spaces\/Space1\?item=Item01"/g)).toHaveLength(2);
    expect(textOf(html)).toContain("Sofie · Completed Ship overview in Launch");
    expect(textOf(html)).toContain("Sofie");
    expect(textOf(html)).toContain("2 hours ago");
    expect(html).not.toContain('data-k2-part="Loading"');
  });

  test("keeps activity errors distinct from an empty feed, above the entries that are still there", () => {
    const html = render("Activity unavailable");
    expect(textOf(html)).toContain("Could not load activity: Activity unavailable");
    expect(html).toContain("Retry");
    expect(html).not.toContain("Space and item changes will appear here.");
    expect(html.indexOf("Activity unavailable")).toBeLessThan(html.indexOf("Completed"));
    expect(html.indexOf("Completed")).toBeGreaterThan(-1);
  });

  test("puts the item's name where the sentence names it, also when the deed says the same word", () => {
    // "Completed “Completed” in Launch": the title is the slot of the message, not the first place its words appear.
    expect(textOf(render(null, "en", { itemTitle: "Completed" }))).toContain("Sofie · Completed Completed in Launch");
    expect(textOf(render(null, "de", { itemTitle: "erledigt" }))).toContain("Sofie · erledigt in Launch erledigt");
  });

  test("keeps the whole sentence when a Space's name contains the sign that marks the title's place", () => {
    // A Space name is free input; with the slot sign in it the sentence would split in three and lose its end.
    expect(textOf(render(null, "en", { activitySpace: "AB" }))).toContain("Sofie · Completed “Ship overview” in AB");
  });

  test("says each thing once: no line about the activity, and one search place on the phone", () => {
    const html = render();
    // The section's title says what it is; a sentence under it that names no deed is left out.
    expect(textOf(html)).not.toContain("Recent changes across your Spaces.");
    // On the phone the shell's bar holds the one search; the head's search gives way there.
    const search = html.match(/<button[^>]*aria-label="Search Spaces"[^>]*>/)?.[0];
    expect(search).toBeDefined();
    expect(search).not.toContain("data-keep");
  });

  test("with nothing overdue and nothing next, the work has no first row", () => {
    const html = render(null, "en", { day: { at: "2026-08-20T12:00:00.000Z", agenda: [], next: null, overdue: 0 } });
    expect(html).not.toContain('data-k2-part="StatusRow"');
  });

  test("reads what counts today from the server in every view: overdue and the next entry", () => {
    const next = {
      shortId: "Event9",
      spaceShortId: "Space1",
      spaceName: "Launch",
      spaceColor: "#3b82f6",
      title: "Late review",
      priority: null,
      startsAt: "2026-08-20T15:00:00.000Z",
      endsAt: null,
      deadline: null,
      deadlineAllDay: false,
      canWrite: true,
    };
    // Opened on Today, whose rows hold no assigned task: the overdue count still comes from the day.
    const text = textOf(
      render(null, "en", { initialView: "today", day: { at: "2026-08-20T12:00:00.000Z", agenda: [], next, overdue: 2 } }),
    );
    // The tab already counts the work for this person ("For me 1"); the row says only what to act on.
    expect(text).toContain("2 overdue");
    expect(text).not.toContain("for you");
    expect(text).toContain("Late review");
    expect(text).toContain("in 3 hr");
    // A day read later (after a view switch) counts from its own moment, not from when the page loaded.
    const later = textOf(
      render(null, "en", { initialView: "today", day: { at: "2026-08-20T14:30:00.000Z", agenda: [], next, overdue: 2 } }),
    );
    expect(later).toContain("in 30 min");
  });
});
