import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConfig } from "@k2b/ssr";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";

const root = mkdtempSync(join(tmpdir(), "spaces-overview-render-tests-"));
const { plugin } = createConfig({ dev: true, rootDir: root });
Bun.plugin(plugin());
process.once("exit", () => rmSync(root, { recursive: true, force: true }));
const { default: SpacesOverview, overviewMessages } = await import("./SpacesOverview.island.tsx");
const { LocaleProvider } = await import("@k2b/ui");

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
              icalToken: null,
              createdAt: "2026-08-20T08:00:00.000Z",
              updatedAt: "2026-08-20T08:00:00.000Z",
            },
          ],
          initialView: "mine",
          initialPinnedSpaceIds: ["Space1"],
          mine: [
            {
              id: "i",
              shortId: "Item01",
              spaceId: "s",
              spaceShortId: "Space1",
              spaceName: "Launch",
              spaceColor: "#3b82f6",
              title: "Ship overview",
              priority: "urgent",
              deadline: "2026-08-21T08:00:00.000Z",
            },
          ],
          today: [],
          upcoming: [],
          counts: { mine: 1, today: 0, upcoming: 0 },
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
        });
      },
    }),
  );

describe("Spaces overview", () => {
  test("keeps the catalog complete and renders regional German locales", () => {
    expect(overviewMessages.check()).toEqual([]);
    const html = render(null, "de-CH");
    expect(html).toContain("Für mich");
    expect(html).toContain("„Ship overview“ in Launch erledigt");
    expect(html).not.toContain("Completed “Ship overview”");
  });

  test("renders pinned launchers, real tabs, work rows, and stable activity without a stat grid", () => {
    const html = render();
    expect(html).toContain("spaces-overview-workspace");
    expect(html).toContain("Unpin Launch");
    expect(html).toContain("New space");
    expect(html).toContain('role="tablist"');
    expect(html).toContain("For me");
    expect(html).toContain("Ship overview");
    expect(html).not.toContain("k2b-stat-grid");
    expect(html).toContain("Completed “Ship overview” in Launch");
    expect(html).toMatch(/<aside[^>]*id="k2b-workspace-detail-spaces-overview-activity"(?![^>]*hidden)/);
  });

  test("keeps activity errors distinct from an empty feed", () => {
    const html = render("Activity unavailable");
    expect(html).toContain("Could not load activity");
    expect(html).toContain("Activity unavailable");
    expect(html).toContain("Retry");
    expect(html).not.toContain("No activity yet");
  });
});
