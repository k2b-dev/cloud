import { expect, mock, test } from "bun:test";
import { createDomTestHarness } from "../../../../../../ui/test/dom";
import { interceptSpacePrimaryClick, spacePrimaryHref } from "./space-primary";

test("head primary is a command link and plain clicks run the controller; modified clicks keep the link", () => {
  const dom = createDomTestHarness();
  const create = mock(() => {});
  const ctx = { space: { id: "Space01" }, query: "view=list&q=one", currentView: "list" as const };
  const href = spacePrimaryHref(ctx);
  const stop = interceptSpacePrimaryClick(dom.document, href, create);
  try {
    const url = new URL(href, "https://cloud.invalid");
    expect(url.searchParams.get("command")).toBe("spaces.task.compose");
    expect(JSON.parse(url.searchParams.get("commandInput")!)).toEqual({ spaceId: "Space01" });
    expect(url.searchParams.get("q")).toBe("one");
    const anchor = dom.document.createElement("a");
    anchor.setAttribute("href", href);
    dom.root.append(anchor);
    const click = new MouseEvent("click", { bubbles: true, cancelable: true });
    anchor.dispatchEvent(click);
    expect(click.defaultPrevented).toBe(true);
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
