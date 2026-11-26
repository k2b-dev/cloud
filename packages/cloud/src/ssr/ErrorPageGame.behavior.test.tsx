import { expect, mock, test } from "bun:test";
import { createComponent } from "solid-js";
import { render } from "solid-js/web";
import { createDomTestHarness } from "../../../ui/test/dom";

// The error page's waiting game is an invitation: nothing is drawn until the person asks. Then the game opens over the
// error screen, its road below the page's words, and a round starts at once.
test("the invitation opens the game over the error screen, below its words, and starts a round", async () => {
  const dom = createDomTestHarness();
  const { maintenanceGameMessages } = await import("../maintenance-game");
  const { default: ErrorPageGame } = await import("./ErrorPageGame.island");
  const host = dom.document.createElement("section");
  host.dataset.k2Part = "ErrorScreen";
  const words = dom.document.createElement("div");
  words.className = "k2-es-stack";
  host.append(words);
  dom.root.append(host);
  const open = mock(() => {});
  const start = mock(() => {});
  const factory = mock((options: { host: HTMLElement; anchor: () => Element | null }) => {
    expect(options.host).toBe(host);
    expect(options.anchor()).toBe(words);
    return { open, start, end: () => false };
  });
  // the game's source defines the factory as this global; a page that loaded it once finds it there
  Reflect.set(dom.window, "__k2bLauf", factory);
  const t = maintenanceGameMessages.resolve(["de"]).t;
  const dispose = render(() => createComponent(ErrorPageGame, { t }), host);
  try {
    const invitation = Array.from(host.querySelectorAll<HTMLElement>("button, a")).find((item) => item.textContent?.includes(t.start));
    expect(invitation).toBeDefined();
    expect(factory).not.toHaveBeenCalled();
    invitation!.click();
    for (let attempt = 0; start.mock.calls.length === 0 && attempt < 50; attempt += 1) await Bun.sleep(10);
    expect(factory).toHaveBeenCalledTimes(1);
    expect(open).toHaveBeenCalledTimes(1);
    expect(start).toHaveBeenCalledTimes(1);
  } finally {
    dispose();
    Reflect.deleteProperty(dom.window, "__k2bLauf");
    dom.cleanup();
  }
});
