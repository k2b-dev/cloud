import { describe, expect, mock, test } from "bun:test";
import { createComponent } from "solid-js";
import { isServer, render } from "solid-js/web";
import { createDomTestHarness } from "../../ui/test/dom";
import type { CalendarRange } from "../src/frontend/[id]/_components/calendar/range";
import type { CalendarProps } from "../src/frontend/[id]/_components/calendar/types";
import type { SpacesViewSnapshot } from "../src/frontend/[id]/_components/workspace/workspace-types";

const SPACE_ID = "11111111-1111-4111-8111-111111111111";

describe("Spaces calendar block requests", () => {
  if (isServer) {
    test.skip("runs in the dedicated browser-conditions test process", () => {});
    return;
  }

  for (const cv of ["", "&cv=timeline"]) {
    test(`earlier and later blocks name the month view when the page URL has ${cv ? "cv=timeline" : "no cv"}`, async () => {
      const dom = createDomTestHarness();
      const base = `/app/spaces/${SPACE_ID}?view=calendar&cd=2026-08-01${cv}`;
      dom.window.history.replaceState(null, "", base);
      const initialState = {
        view: "month" as const,
        date: "2026-08-01T00:00:00.000Z",
        filter: { type: "all" as const, assignedTo: "all", priorities: [], columnIds: [], tagIds: [], colorBy: "tag" as const },
        range: { from: "2026-06-22T00:00:00.000Z", to: "2026-10-12T00:00:00.000Z" },
        items: [],
        weather: {},
        tray: null,
      };
      const requests: Array<{ href: string; range: CalendarRange & { includeTray?: "false" } }> = [];
      mock.module("../src/frontend/[id]/_components/workspace/view-query", () => ({
        SpacesViewUnavailableError: class extends Error {},
        loadSpacesViewSnapshot: async (
          href: string,
          _signal: AbortSignal,
          _locale: string,
          range: CalendarRange & { includeTray?: "false" },
        ): Promise<SpacesViewSnapshot> => {
          requests.push({ href, range });
          return { kind: "calendar", ...initialState, range };
        },
      }));
      let calendar!: CalendarProps;
      // The route owns block loading; the child only asks for an edge and receives the merged range.
      mock.module("../src/frontend/[id]/_components/calendar", () => ({
        default: (props: CalendarProps) => {
          calendar = props;
          return dom.document.createTextNode("");
        },
      }));
      const { default: SpacesCalendarRoute } = await import("../src/frontend/[id]/_components/workspace/SpacesCalendarRoute.island");
      const dispose = render(
        () =>
          createComponent(SpacesCalendarRoute, {
            spaceId: SPACE_ID,
            baseUrl: base,
            columns: [],
            tags: [],
            initialState,
            selectedItemId: "",
            dateConfig: { timeZone: "UTC" },
            canWrite: false,
            currentUserId: "33333333-3333-4333-8333-333333333333",
          }),
        dom.root,
      );
      try {
        await calendar.onLoadEarlier!();
        await calendar.onLoadLater!();
        expect(requests).toHaveLength(2);
        for (const request of requests) {
          const url = new URL(request.href, "http://localhost");
          expect(url.pathname).toBe(`/app/spaces/${SPACE_ID}`);
          expect(url.searchParams.get("cv")).toBe("month");
          expect(url.searchParams.get("view")).toBe("calendar");
          expect(url.searchParams.get("cd")).toBe("2026-08-01");
        }
        expect(requests.map((request) => request.range)).toEqual([
          { from: "2026-04-27T00:00:00.000Z", to: "2026-06-22T00:00:00.000Z", includeTray: "false" },
          { from: "2026-10-12T00:00:00.000Z", to: "2026-12-07T00:00:00.000Z", includeTray: "false" },
        ]);
        expect(calendar.range).toEqual({ from: "2026-04-27T00:00:00.000Z", to: "2026-12-07T00:00:00.000Z" });
        expect(dom.window.location.search).toBe(new URL(base, "http://localhost").search);
      } finally {
        dispose();
        dom.cleanup();
      }
    });
  }
});
