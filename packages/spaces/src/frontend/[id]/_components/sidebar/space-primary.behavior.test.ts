import { expect, test } from "bun:test";
import { createDomTestHarness } from "../../../../../../ui/test/dom";
import {
  reconcileSpacesDetailRoute,
  SPACES_DETAIL_NAVIGATION_EVENT,
  SPACES_DETAIL_STATE_EVENT,
  type SpacesDetailNavigation,
} from "../workspace/workspace-events";
import { spacePrimaryHref, syncSpacePrimaryHref } from "./space-primary";

test("primary command links fall back to the current view when the query is too long", () => {
  const href = spacePrimaryHref({ space: { id: "Space01" }, query: `view=kanban&q=${"x".repeat(1990)}`, currentView: "kanban" });
  const url = new URL(href, "https://cloud.invalid");
  expect(url.searchParams.get("command")).toBe("spaces.task.compose");
  expect(JSON.parse(url.searchParams.get("commandInput")!)).toEqual({ spaceId: "Space01" });
  expect(url.searchParams.get("view")).toBe("kanban");
  expect(url.searchParams.has("q")).toBe(false);
});

test("primary href follows the current URL on mount and only committed navigation for this Space", () => {
  const dom = createDomTestHarness();
  const ctx = { space: { id: "Space01" }, query: "view=list&q=server", currentView: "list" as const };
  const anchor = dom.document.createElement("a");
  anchor.setAttribute("data-workspace-primary", "");
  anchor.setAttribute("href", spacePrimaryHref(ctx));
  dom.root.append(anchor);
  window.history.replaceState(null, "", "/app/spaces/Space01?view=list&q=mounted");
  const stop = syncSpacePrimaryHref(dom.document, ctx);
  try {
    expect(anchor.getAttribute("href")).toBe(spacePrimaryHref({ ...ctx, query: "view=list&q=mounted" }));
    const committed = "/app/spaces/Space01?view=list&q=filtered&date=2026-10-19&item=Item02";
    window.history.replaceState(null, "", committed);
    reconcileSpacesDetailRoute(committed);
    const href = spacePrimaryHref({ ...ctx, query: committed.split("?")[1] ?? "" });
    expect(anchor.getAttribute("href")).toBe(href);
    expect(new URL(anchor.href).searchParams.get("command")).toBe("spaces.task.compose");
    window.dispatchEvent(
      new CustomEvent<SpacesDetailNavigation>(SPACES_DETAIL_NAVIGATION_EVENT, {
        detail: { href: "/app/spaces/Space01?q=pending", itemId: null, occurrenceId: null, history: "push" },
      }),
    );
    expect(anchor.getAttribute("href")).toBe(href);
    reconcileSpacesDetailRoute("/app/spaces/OtherSpace?q=other");
    expect(anchor.getAttribute("href")).toBe(href);
    stop();
    reconcileSpacesDetailRoute("/app/spaces/Space01?q=after-cleanup");
    expect(anchor.getAttribute("href")).toBe(href);
  } finally {
    stop();
    dom.cleanup();
  }
});

test.each([SPACES_DETAIL_STATE_EVENT, "popstate"])("primary href follows the current item on %s and stops after cleanup", (eventName) => {
  const dom = createDomTestHarness();
  const ctx = { space: { id: "Space01" }, query: "view=list&item=Item01", currentView: "list" as const };
  const anchor = dom.document.createElement("a");
  anchor.setAttribute("data-workspace-primary", "");
  anchor.setAttribute("href", spacePrimaryHref(ctx));
  dom.root.append(anchor);
  window.history.replaceState(null, "", `/app/spaces/Space01?${ctx.query}`);
  const stop = syncSpacePrimaryHref(dom.document, ctx);
  const dispatch = () =>
    window.dispatchEvent(
      eventName === SPACES_DETAIL_STATE_EVENT
        ? new CustomEvent(eventName, { detail: { itemId: "Item02", occurrenceId: null, selectionId: "Item02" } })
        : new Event(eventName),
    );
  try {
    expect(new URL(anchor.href).searchParams.get("item")).toBe("Item01");
    window.history.pushState(null, "", "/app/spaces/Space01?view=list&item=Item02");
    dispatch();
    expect(new URL(anchor.href).searchParams.get("item")).toBe("Item02");
    stop();
    window.history.replaceState(null, "", "/app/spaces/Space01?view=list&item=Item03");
    dispatch();
    expect(new URL(anchor.href).searchParams.get("item")).toBe("Item02");
  } finally {
    stop();
    dom.cleanup();
  }
});
