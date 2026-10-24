import { expect, mock, test } from "bun:test";
import { delegateEvents, isServer, render } from "solid-js/web";
import { createDomTestHarness } from "../../../../ui/test/dom";
import { contactsPrimaryHref, interceptContactsPrimaryClick } from "./contacts-primary";

const load = async () => {
  const dom = createDomTestHarness();
  try {
    return (await import("./ContactCreateLauncher.island")).default;
  } finally {
    dom.cleanup();
  }
};
const Launcher = isServer ? undefined : await load();

if (!Launcher) test.skip("runs with Solid DOM conditions", () => {});
else {
  test("plain workspace primary opens the create flow in place; modified clicks stay native", async () => {
    const dom = createDomTestHarness();
    dom.window.history.replaceState({}, "", "/app/contacts/team");
    const link = dom.document.createElement("a");
    link.href = contactsPrimaryHref("/app/contacts/team", "team");
    link.dataset.workspacePrimary = "";
    dom.document.body.append(link);
    delegateEvents(["click"], dom.document);
    const previousFetch = globalThis.fetch;
    globalThis.fetch = Object.assign(async () => Response.json({ data: [] }), { preconnect: previousFetch.preconnect });
    const dispose = render(() => <Launcher writableBooks={[{ id: "team", name: "Team" }]} defaultBookId="team" />, dom.root);
    try {
      for (const modifiers of [{ ctrlKey: true }, { metaKey: true }, { shiftKey: true }, { altKey: true }, { button: 1 }]) {
        const event = new MouseEvent("click", { bubbles: true, cancelable: true, ...modifiers });
        link.dispatchEvent(event);
        expect(event.defaultPrevented).toBe(false);
      }
      const event = new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 });
      link.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(true);
      expect(dom.document.body.textContent).toContain("New contact in Team");
      expect(dom.window.location.pathname).toBe("/app/contacts/team");
    } finally {
      dom.document.querySelector<HTMLButtonElement>(".k2b-dialog__close")?.click();
      for (let attempt = 0; attempt < 100 && dom.document.querySelector(".k2b-panel-dialog"); attempt++) await Bun.sleep(5);
      dispose();
      link.remove();
      globalThis.fetch = previousFetch;
      dom.cleanup();
    }
  });
}

test("primary interception preserves explicit new-tab and download links and stops after cleanup", () => {
  const dom = createDomTestHarness();
  const create = mock(() => {});
  const stop = interceptContactsPrimaryClick(dom.document, create);
  const link = dom.document.createElement("a");
  link.href = "/app/contacts";
  link.dataset.workspacePrimary = "";
  dom.root.append(link);
  try {
    link.target = "_blank";
    link.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    link.target = "";
    link.download = "contacts";
    link.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    expect(create).not.toHaveBeenCalled();
    link.removeAttribute("download");
    link.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    expect(create).toHaveBeenCalledTimes(1);
    stop();
    link.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    expect(create).toHaveBeenCalledTimes(1);
  } finally {
    stop();
    dom.cleanup();
  }
});
