import { afterAll, beforeAll, describe, expect, setSystemTime, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConfig } from "@k2b/ssr";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import type { OverviewWork } from "../overview-contracts";
import type { SpaceTimeBlock } from "../time-block-contracts";

const root = mkdtempSync(join(tmpdir(), "spaces-overview-render-tests-"));
const { plugin } = createConfig({ dev: true, rootDir: root });
Bun.plugin(plugin());
process.once("exit", () => rmSync(root, { recursive: true, force: true }));
const { default: SpacesOverview } = await import("./SpacesOverview.island.tsx");
const { overviewMessages } = await import("./overview-messages");
const { LocaleProvider } = await import("@k2b/ui");

const render = (initialActivityError: string | null = null, locale = "en", work?: OverviewWork) =>
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
          initialView: work?.view ?? "mine",
          initialPinnedSpaceIds: ["Space1"],
          initialWork: work ?? {
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
        });
      },
    }),
  );

describe("Spaces overview", () => {
  beforeAll(() => setSystemTime(new Date("2032-08-20T07:00:00.000Z")));
  afterAll(() => setSystemTime());
  test("Today and Upcoming render task blocks as their own linked work rows, including completed and deleted tasks", () => {
    const block: SpaceTimeBlock = {
      id: "00000000-0000-4000-8000-000000000101",
      itemId: "Item01",
      spaceId: "Space1",
      ownerId: "00000000-0000-4000-8000-000000000001",
      ownerName: "Sofie",
      spaceName: "Launch",
      spaceColor: "#3b82f6",
      title: "Review launch plan",
      startsAt: "2032-08-20T08:00:00.000Z",
      endsAt: "2032-08-20T09:00:00.000Z",
      taskState: "done",
      canWrite: true,
      canDelete: true,
    };
    for (const view of ["today", "upcoming"] as const) {
      const startsAt = view === "upcoming" ? "2033-08-20T08:00:00.000Z" : block.startsAt;
      const html = render(null, "en", {
        view,
        items: [],
        counts: { mine: 0, today: 0, upcoming: 0 },
        timeBlocks: [
          {
            ...block,
            startsAt,
            endsAt: view === "upcoming" ? "2033-08-20T09:00:00.000Z" : block.endsAt,
          },
          {
            ...block,
            id: "00000000-0000-4000-8000-000000000102",
            itemId: null,
            taskState: "deleted",
            canWrite: false,
            title: "Preserved planning",
          },
        ],
        timeBlockCounts: { today: 2, upcoming: 2 },
      });
      expect(html).toContain("Review launch plan");
      const blockTime = [...html.matchAll(/<time\b[^>]*datetime="([^"]+)"[^>]*>([\s\S]*?)<\/time>/g)].find(
        (match) => match[1] === startsAt,
      )?.[2];
      expect(blockTime).toContain("10:00");
      expect(blockTime).toContain("11:00");
      if (view === "upcoming") expect(blockTime).toContain("2033");
      expect(html).toContain(`href="/app/spaces/Space1?item=Item01&amp;block=${block.id}"`);
      expect(html).toContain("ti-circle-check");
      expect(html).toContain("Preserved planning");
      expect(html).toContain("Task deleted");
      expect(html).not.toContain("?item=null");
      expect(html).not.toContain("Nothing planned");
    }
  });

  test("keeps the catalog complete and renders regional German locales", () => {
    expect(overviewMessages.check()).toEqual([]);
    const html = render(null, "de-CH");
    expect(html).toContain("Für mich");
    expect(html).toContain("Meine Arbeit");
    expect(html).toContain("3 offene Einträge");
    expect(html).toContain("„Ship overview“ in Launch erledigt");
    expect(html).not.toContain("Completed “Ship overview”");
  });

  test("renders the shared object navigation, head tabs and flat work/activity rows", () => {
    const html = render();
    expect(html).toContain("spaces-overview-workspace");
    expect(html).toContain('href="/app/spaces/Space1"');
    expect(html).toContain('href="/app/spaces/Space2"');
    expect(html).toContain("3 open items");
    expect(html).toContain("0 open items");
    expect(html).toContain("Unpin Launch");
    expect(html).toContain("Pin Archive");
    expect(html).toContain("Search Spaces");
    expect(html).toContain("New space");
    expect(html).toContain("My work");
    expect(html).toMatch(/href="\/app\/spaces"[^>]*aria-current="page"/);
    expect(html).toMatch(/href="\/app\/spaces\?view=mine"[^>]*aria-current="page"/);
    expect(html).toContain("New task");
    expect(html).not.toContain("k2b-app-workspace__switcher");
    expect(html).not.toContain("k2b-paper");
    expect(html).toContain("spaces-overview-work-row");
    expect(html).toContain("spaces-overview-activity-row");
    expect(html).not.toContain("spaces-overview-space-list");
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
