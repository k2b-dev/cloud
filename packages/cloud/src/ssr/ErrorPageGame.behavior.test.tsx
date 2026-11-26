import { expect, mock, test } from "bun:test";
import { createComponent } from "solid-js";
import { render } from "solid-js/web";
import { createDomTestHarness } from "../../../ui/test/dom";

// The error page's waiting game is an invitation: nothing is drawn until the person asks, with the button or with
// Space while the focus is on the page itself (as a browser's offline game). Then the game opens over the error screen,
// its road below the page's words, and a round starts. Typing a space in a field, such as the shell's search, never
// starts it.
const mount = async () => {
  const dom = createDomTestHarness();
  const { maintenanceGameMessages } = await import("../maintenance-game");
  const { default: ErrorPageGame } = await import("./ErrorPageGame.island");
  const host = dom.document.createElement("section");
  host.dataset.k2Part = "ErrorScreen";
  const words = dom.document.createElement("div");
  words.className = "k2-es-stack";
  host.append(words);
  dom.root.append(host);
  // the shell's search field, outside the error screen
  const search = dom.document.createElement("input");
  search.type = "search";
  dom.root.append(search);
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
  const dispose = render(
    () =>
      createComponent(ErrorPageGame, {
        t,
        keys: "Leertaste drücken, um dir die Zeit zu vertreiben",
        touch: "Tippen, um dir die Zeit zu vertreiben",
      }),
    host,
  );
  const started = async () => {
    for (let attempt = 0; start.mock.calls.length === 0 && attempt < 30; attempt += 1) await Bun.sleep(10);
    return start.mock.calls.length > 0;
  };
  const space = (target: EventTarget) => target.dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true, cancelable: true }));
  return {
    dom,
    host,
    search,
    factory,
    open,
    start,
    started,
    space,
    cleanup: () => {
      dispose();
      Reflect.deleteProperty(dom.window, "__k2bLauf");
      dom.cleanup();
    },
  };
};

// Solid delegates clicks to the first document it renders into, so the clicks stand in this one test.
test("the invitation is a plain button in one sentence; the game plays on the stage, one game per page", async () => {
  const page = await mount();
  try {
    const invite = page.host.querySelector<HTMLButtonElement>('button[data-k2-part="ErrorScreen.Invite"]');
    expect(invite?.getAttribute("aria-label")).toBe("Mini-Spiel starten");
    expect(invite?.querySelector(".k2-es-invite-keys")?.textContent).toBe("Leertaste drücken, um dir die Zeit zu vertreiben");
    expect(invite?.querySelector(".k2-es-invite-touch")?.textContent).toBe("Tippen, um dir die Zeit zu vertreiben");
    expect(page.factory).not.toHaveBeenCalled();
    expect(page.host.hasAttribute("data-k2-stage")).toBe(false);
    invite!.click();
    expect(await page.started()).toBe(true);
    expect(page.factory).toHaveBeenCalledTimes(1);
    expect(page.open).toHaveBeenCalledTimes(1);
    expect(page.host.hasAttribute("data-k2-stage")).toBe(true);
    // a second press keeps the one game and only starts a new round
    invite!.click();
    await Bun.sleep(30);
    expect(page.factory).toHaveBeenCalledTimes(1);
    expect(page.open).toHaveBeenCalledTimes(1);
    expect(page.start).toHaveBeenCalledTimes(2);
  } finally {
    page.cleanup();
  }
});

test("Space on the page starts the game once, like a browser's offline game", async () => {
  const page = await mount();
  try {
    page.space(page.dom.document.body);
    expect(await page.started()).toBe(true);
    page.space(page.dom.document.body);
    await Bun.sleep(30);
    // the game takes its keys itself from then on
    expect(page.factory).toHaveBeenCalledTimes(1);
  } finally {
    page.cleanup();
  }
});

test("a space typed in the shell's search never starts the game", async () => {
  const page = await mount();
  try {
    page.search.focus();
    page.space(page.search);
    expect(await page.started()).toBe(false);
    expect(page.factory).not.toHaveBeenCalled();
  } finally {
    page.cleanup();
  }
});
