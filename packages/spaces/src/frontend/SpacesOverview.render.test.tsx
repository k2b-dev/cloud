import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import { registerSsrTestPlugin } from "../../../ui/test/ssr-test-plugin";

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

const render = (initialActivityError: string | null = null, locale = "en") =>
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
          initialView: "mine",
          initialPinnedSpaceIds: ["Space1"],
          initialWork: {
            view: "mine",
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
          },
          initialActivity: {
            items: [
              {
                id: "1",
                space: { id: "Space1", name: "Launch", color: "#3b82f6" },
                item: { id: "Item01", title: "Ship overview" },
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
    expect(html).toContain("„Ship overview“ in Launch erledigt");
    expect(html).not.toContain("Completed “Ship overview”");
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
    // The work opens its item; the activity names who did what and links to the item.
    expect(html).toContain("Ship overview");
    expect(html.match(/href="\/app\/spaces\/Space1\?item=Item01"/g)).toHaveLength(2);
    expect(textOf(html)).toContain("Completed “Ship overview” in Launch");
    expect(textOf(html)).toContain("Sofie");
    expect(textOf(html)).toContain("2 hours ago");
    expect(html).not.toContain('data-k2-part="Loading"');
  });

  test("keeps activity errors distinct from an empty feed, above the entries that are still there", () => {
    const html = render("Activity unavailable");
    expect(textOf(html)).toContain("Could not load activity: Activity unavailable");
    expect(html).toContain("Retry");
    expect(html).not.toContain("Space and item changes will appear here.");
    expect(html.indexOf("Activity unavailable")).toBeLessThan(html.indexOf("Completed “Ship overview”"));
  });
});
