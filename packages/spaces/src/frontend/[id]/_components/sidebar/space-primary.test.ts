import { expect, test } from "bun:test";
import { spacePrimaryHref } from "./space-primary";

test("the main action links to the compose command on the view's address", () => {
  const href = spacePrimaryHref({ space: { id: "Space01" }, query: "view=list&q=server", currentView: "list" });
  const url = new URL(href, "https://cloud.invalid");
  expect(url.pathname).toBe("/app/spaces/Space01");
  expect(url.searchParams.get("q")).toBe("server");
  expect(url.searchParams.get("command")).toBe("spaces.task.compose");
  expect(
    new URL(
      spacePrimaryHref({ space: { id: "Space01" }, query: "view=calendar", currentView: "calendar" }),
      "https://cloud.invalid",
    ).searchParams.get("command"),
  ).toBe("spaces.event.compose");
});

test("primary command links fall back to the current view when the query is too long", () => {
  const href = spacePrimaryHref({ space: { id: "Space01" }, query: `view=kanban&q=${"x".repeat(1990)}`, currentView: "kanban" });
  const url = new URL(href, "https://cloud.invalid");
  expect(url.searchParams.get("command")).toBe("spaces.task.compose");
  expect(JSON.parse(url.searchParams.get("commandInput")!)).toEqual({ spaceId: "Space01" });
  expect(url.searchParams.get("view")).toBe("kanban");
  expect(url.searchParams.has("q")).toBe(false);
});
