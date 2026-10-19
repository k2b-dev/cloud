import { expect, mock, test } from "bun:test";
import { createDomTestHarness } from "../../../../../../ui/test/dom";
import { reconcileSpacesDetailRoute, SPACES_DETAIL_NAVIGATION_EVENT, type SpacesDetailNavigation } from "../workspace/workspace-events";
import { interceptSpacePrimaryClick, spacePrimaryHref, syncSpacePrimaryHref } from "./space-primary";

test("primary command links fall back to the current view when the query is too long", () => {
  const href = spacePrimaryHref({ space: { id: "Space01" }, query: `view=kanban&q=${"x".repeat(1990)}`, currentView: "kanban" });
  const url = new URL(href, "https://cloud.invalid");
  expect(url.searchParams.get("command")).toBe("spaces.task.compose");
  expect(JSON.parse(url.searchParams.get("commandInput")!)).toEqual({ spaceId: "Space01" });
  expect(url.searchParams.get("view")).toBe("kanban");
  expect(url.searchParams.has("q")).toBe(false);
});

test("head primary is a command link and plain clicks run the controller; modified clicks keep the link", () => {
  const dom = createDomTestHarness();
  const create = mock(() => {});
  const ctx = { space: { id: "Space01" }, query: "view=list&q=one", currentView: "list" as const };
  const href = spacePrimaryHref(ctx);
  const stop = interceptSpacePrimaryClick(dom.document, create);
  try {
    const url = new URL(href, "https://cloud.invalid");
    expect(url.searchParams.get("command")).toBe("spaces.task.compose");
    expect(JSON.parse(url.searchParams.get("commandInput")!)).toEqual({ spaceId: "Space01" });
    expect(url.searchParams.get("q")).toBe("one");
    const anchor = dom.document.createElement("a");
    anchor.setAttribute("href", href);
    dom.root.append(anchor);
    const unmarked = new MouseEvent("click", { bubbles: true, cancelable: true });
    anchor.dispatchEvent(unmarked);
    expect(unmarked.defaultPrevented).toBe(false);
    expect(create).not.toHaveBeenCalled();
    anchor.setAttribute("data-workspace-primary", "");
    anchor.setAttribute("href", spacePrimaryHref({ ...ctx, query: "view=list&q=two" }));
    const click = new MouseEvent("click", { bubbles: true, cancelable: true });
    anchor.dispatchEvent(click);
    expect(click.defaultPrevented).toBe(true);
    expect(create).toHaveBeenCalledTimes(1);
    for (const [attribute, value] of [
      ["target", "_blank"],
      ["download", "task"],
    ] as const) {
      anchor.setAttribute(attribute, value);
      const guarded = new MouseEvent("click", { bubbles: true, cancelable: true });
      anchor.dispatchEvent(guarded);
      expect(guarded.defaultPrevented).toBe(false);
      anchor.removeAttribute(attribute);
    }
    expect(create).toHaveBeenCalledTimes(1);
    for (const modifier of [{ ctrlKey: true }, { metaKey: true }, { shiftKey: true }, { altKey: true }, { button: 1 }]) {
      const modified = new MouseEvent("click", { bubbles: true, cancelable: true, ...modifier });
      anchor.dispatchEvent(modified);
      expect(modified.defaultPrevented).toBe(false);
    }
    expect(create).toHaveBeenCalledTimes(1);
    stop();
    anchor.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    expect(create).toHaveBeenCalledTimes(1);
    expect(new URL(spacePrimaryHref({ ...ctx, currentView: "calendar" }), "https://cloud.invalid").searchParams.get("command")).toBe(
      "spaces.event.compose",
    );
  } finally {
    stop();
    dom.cleanup();
  }
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
