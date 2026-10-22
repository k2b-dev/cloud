import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createConfig } from "@k2b/ssr";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";

const root = mkdtempSync(resolve(tmpdir(), "k2b-ui-drag-tests-"));
const { plugin } = createConfig({ dev: true, rootDir: root });
Bun.plugin(plugin());
process.once("exit", () => rmSync(root, { recursive: true, force: true }));
const { DragSource, DropTarget, LocaleProvider, activeDrag } = await import("../index");

const { useDragAndDropMessages } = await import("./drag-and-drop-messages");

describe("drag and drop on the server", () => {
  test("resolves announcements from the inherited locale without a browser", () => {
    const render = (locale: string) =>
      renderToString(() =>
        createComponent(LocaleProvider, {
          locale,
          get children() {
            const messages = useDragAndDropMessages()();
            return messages.pickedUpKeyboard({ label: "Draft", count: 2 });
          },
        }),
      );
    expect(render("en")).toContain("Draft picked up. 2 places take it.");
    expect(render("de")).toContain("Draft angehoben. 2 Orte nehmen es an.");
  });
  test("renders stable wrappers without browser state or payload attributes", () => {
    const source = renderToString(() =>
      createComponent(DragSource, {
        payload: { type: "demo.row", value: "private-reference", label: "Row" },
        disabled: true,
        class: "row",
        children: "Message",
      }),
    );
    expect(source).toContain('class="k2b-drag-source row" data-drag-disabled=""');
    expect(source).toContain("Message</div>");
    expect(source).not.toContain("private-reference");
    expect(source).not.toContain("data-dragging");
    const target = renderToString(() =>
      createComponent(DropTarget, {
        accept: ["demo.row"],
        label: "Archive",
        class: "archive",
        onDrop: () => {},
        children: "Archive",
      }),
    );
    expect(target).toContain('<div class="k2b-drop-target archive">Archive</div>');
    expect(target).not.toContain("data-drop");
    expect(activeDrag()).toBeUndefined();
  });
});
