import { afterEach, describe, expect, mock, test } from "bun:test";
import { batch, createSignal } from "solid-js";
import { delegateEvents, isServer, render } from "solid-js/web";
import { createDomTestHarness, type DomTestHarness } from "../../ui/test/dom";
import type { SpaceItemReaction } from "../src/contracts";
import { subscribeToSpacesDataInvalidation } from "../src/frontend/[id]/_components/workspace/workspace-events";

const reaction = (emoji = "👍", own = false, count = own ? 2 : 1): SpaceItemReaction => ({
  emoji,
  own,
  count,
  people: [{ kind: "user", id: "other", displayName: "Nora Brandt" }],
});
const defaults = ["👍", "❤️", "🎉", "😄", "👀", "🚀", "✅", "🙏"];
const flush = () => new Promise((resolve) => setTimeout(resolve, 10));
const until = async (ready: () => boolean) => {
  for (let attempt = 0; attempt < 100 && !ready(); attempt++) await flush();
  expect(ready()).toBe(true);
};

describe("Spaces item reactions", () => {
  if (isServer) {
    test.skip("runs in the dedicated browser-conditions test process", () => {});
    return;
  }

  type Request = { method: "PUT" | "DELETE"; itemId: string; emoji: string; resolve: (response: Response) => void; answered: boolean };
  let requests: Request[] = [];
  let dom: DomTestHarness;
  let dispose: (() => void) | undefined;
  const extraSurfaces: (() => void)[] = [];
  let previousCss: PropertyDescriptor | undefined;
  let restorePopover: (() => void) | undefined;
  let unsubscribeReload: (() => void) | undefined;
  const pendingReloads: PromiseWithResolvers<void>[] = [];
  const deferredReload = () => {
    const reload = Promise.withResolvers<void>();
    pendingReloads.push(reload);
    return reload;
  };
  let itemNumber = 0;
  const send =
    (method: Request["method"]) =>
    ({ param }: { param: { itemId: string; emoji: string } }) =>
      new Promise<Response>((resolve) => {
        requests.push({ method, ...param, answered: false, resolve });
      });
  mock.module("@/api/client", () => ({
    apiClient: { ":id": { items: { ":itemId": { reactions: { ":emoji": { $put: send("PUT"), $delete: send("DELETE") } } } } } },
  }));
  const answer = (index: number, reactions: SpaceItemReaction[], status = 200) => {
    const request = requests[index]!;
    request.answered = true;
    request.resolve(Response.json({ reactions }, { status }));
  };
  const mount = async (initial: SpaceItemReaction[] = [reaction()], focusFallback?: () => HTMLElement | null | undefined) => {
    dom = createDomTestHarness();
    delegateEvents(["click", "focusin", "focusout"], dom.document);
    previousCss = Object.getOwnPropertyDescriptor(globalThis, "CSS");
    Object.defineProperty(globalThis, "CSS", { configurable: true, value: dom.window.CSS });
    // Happy DOM has no popover top layer. Keep the real picker DOM and emulate only the platform API.
    const prototype = HTMLElement.prototype;
    const matches = prototype.matches;
    const descriptors = ["matches", "showPopover", "hidePopover"].map(
      (key) => [key, Object.getOwnPropertyDescriptor(prototype, key)] as const,
    );
    restorePopover = () => {
      for (const [key, descriptor] of descriptors) {
        if (descriptor) Object.defineProperty(prototype, key, descriptor);
        else Reflect.deleteProperty(prototype, key);
      }
    };
    const open = new WeakSet<Element>();
    Object.defineProperties(prototype, {
      matches: {
        configurable: true,
        value: function (this: Element, selector: string) {
          return selector === ":popover-open" ? open.has(this) : matches.call(this, selector);
        },
      },
      showPopover: {
        configurable: true,
        value: function (this: HTMLElement) {
          open.add(this);
        },
      },
      hidePopover: {
        configurable: true,
        value: function (this: HTMLElement) {
          open.delete(this);
        },
      },
    });
    requests = [];
    const { LocaleProvider } = await import("@k2b/ui");
    const { default: ItemReactions, createReactionPicker } = await import(
      "../src/frontend/[id]/_components/shared/reactions/ItemReactions"
    );
    const { createRetryToasts } = await import("../src/frontend/lib/feedback");
    const [snapshot, setSnapshot] = createSignal(initial);
    const itemId = `ReactionItem${++itemNumber}`;
    const Surface = () => {
      const retryToast = createRetryToasts();
      const picker = createReactionPicker();
      return (
        <LocaleProvider locale="en">
          <ItemReactions
            spaceId="Space1"
            itemId={itemId}
            reactions={snapshot()}
            canReact
            picker={picker}
            retryToast={retryToast}
            density="default"
            add="always"
            focusFallback={focusFallback}
          />
          {picker.popover()}
        </LocaleProvider>
      );
    };
    dispose = render(() => <Surface />, dom.root);
    await flush();
    const remount = (reactions: SpaceItemReaction[]) => {
      dispose?.();
      setSnapshot(reactions);
      dispose = render(() => <Surface />, dom.root);
    };
    const addSurface = () => {
      const root = dom.document.createElement("div");
      dom.document.body.append(root);
      const stop = render(() => <Surface />, root);
      const unmount = () => {
        stop();
        root.remove();
      };
      extraSurfaces.push(unmount);
      return { root, unmount };
    };
    return { setSnapshot, remount, itemId, addSurface };
  };
  const chip = (emoji = "👍") => dom.root.querySelector<HTMLButtonElement>(`[data-reaction-key="${emoji}"]`)!;
  const pick = async (emoji: string) => {
    dom.root.querySelector<HTMLButtonElement>('button[aria-label="Add reaction"]')!.click();
    await until(() =>
      [...dom.root.querySelectorAll<HTMLButtonElement>(".k2b-emoji-picker button")].some((button) => button.textContent === emoji),
    );
    [...dom.root.querySelectorAll<HTMLButtonElement>(".k2b-emoji-picker button")].find((button) => button.textContent === emoji)!.click();
    await flush();
  };
  const rail = () => dom.document.querySelector<HTMLElement>("[data-k2b-toast-container]");

  afterEach(async () => {
    for (const unmount of extraSurfaces.splice(0)) unmount();
    dispose?.();
    dispose = undefined;
    unsubscribeReload?.();
    unsubscribeReload = undefined;
    for (const reload of pendingReloads.splice(0)) reload.resolve();
    for (let index = 0; index < requests.length; index++) {
      const request = requests[index]!;
      if (!request.answered) request.resolve(Response.json({ reactions: [] }));
      await flush();
    }
    const { toast } = await import("@k2b/ui");
    toast.dismissAll();
    await new Promise((resolve) => setTimeout(resolve, 250));
    restorePopover?.();
    restorePopover = undefined;
    if (previousCss) Object.defineProperty(globalThis, "CSS", previousCss);
    else Reflect.deleteProperty(globalThis, "CSS");
    dom?.cleanup();
  });

  test.each([
    ["next", [reaction("👍", true, 1), reaction("❤️")]],
    ["previous", [reaction("❤️"), reaction("👍", true, 1)]],
  ] as const)("removing a focused own chip focuses the %s chip and restores it after a rebuild", async (_, initial) => {
    const { remount } = await mount([...initial]);
    const removed = chip();
    removed.focus();
    expect(dom.document.activeElement === removed).toBe(true);
    batch(() => removed.click());
    await flush();
    expect(requests[0]?.method).toBe("DELETE");
    expect(removed.isConnected).toBe(false);
    expect(dom.document.activeElement === chip("❤️")).toBe(true);
    remount([reaction("❤️")]);
    await flush();
    expect(dom.document.activeElement === chip("❤️")).toBe(true);
  });

  test("removing the only focused own chip focuses Add reaction", async () => {
    await mount([reaction("👍", true, 1)]);
    const removed = chip();
    removed.focus();
    removed.click();
    await flush();
    expect(removed.isConnected).toBe(false);
    expect(dom.document.activeElement === dom.root.querySelector(".k2b-reaction-bar__add button")).toBe(true);
  });

  test("removing the only focused own chip uses the fallback when Add reaction cannot take focus", async () => {
    await mount([reaction("👍", true, 1)], () => link);
    const link = dom.document.createElement("a");
    link.href = "#item";
    link.textContent = "Open item";
    dom.root.append(link);
    const add = dom.root.querySelector<HTMLButtonElement>(".k2b-reaction-bar__add button")!;
    // Happy DOM does not enforce display:none focus rules; emulate a hidden touch add button refusing focus.
    add.style.display = "none";
    const focus = mock(() => {});
    add.focus = focus;
    chip().focus();
    chip().click();
    await flush();
    expect(focus).toHaveBeenCalledWith({ preventScroll: true });
    expect(dom.document.activeElement === link).toBe(true);
  });

  test("removing a focused chip does not take focus back from another control", async () => {
    await mount([reaction("👍", true, 1)]);
    const other = dom.document.createElement("button");
    dom.root.append(other);
    chip().focus();
    chip().click();
    other.focus();
    await flush();
    expect(dom.document.activeElement === other).toBe(true);
  });

  test("a card rebuild restores its focused chip when there was no outside interaction", async () => {
    const { remount } = await mount();
    const previous = chip();
    previous.focus();
    remount([reaction()]);
    await flush();
    expect(previous.isConnected).toBe(false);
    expect(dom.document.activeElement === chip()).toBe(true);
  });

  test.each(["in place", "after a rebuild"] as const)(
    "a live read that removes the focused chip moves focus to the chip at its place %s",
    async (how) => {
      const { setSnapshot, remount } = await mount([reaction("👍"), reaction("❤️")]);
      const removed = chip();
      removed.focus();
      // Someone else took back the last 👍.
      if (how === "in place") setSnapshot([reaction("❤️")]);
      else remount([reaction("❤️")]);
      await flush();
      expect(removed.isConnected).toBe(false);
      expect(dom.document.activeElement === chip("❤️")).toBe(true);
      expect(requests).toHaveLength(0);
    },
  );

  test.each(["pointerdown", "focusin"])("an outside %s after unmount prevents a later card from stealing focus", async (type) => {
    const { remount } = await mount();
    chip().focus();
    dispose!();
    dispose = undefined;
    expect(dom.document.activeElement === dom.document.body).toBe(true);
    dom.document.body.dispatchEvent(new Event(type, { bubbles: true }));
    remount([reaction()]);
    await flush();
    expect(dom.document.activeElement === dom.document.body).toBe(true);
  });

  test("a failed PUT after its surface unmounts shows Retry on the remaining surface and resends the same PUT", async () => {
    const { addSurface } = await mount();
    const remaining = addSurface();
    chip().click();
    dispose!();
    dispose = undefined;
    answer(0, [], 500);
    await until(() => Boolean(rail()?.textContent?.includes("The reaction could not be saved.")));
    [...rail()!.querySelectorAll("button")].find((button) => button.textContent === "Try again")!.click();
    await until(() => requests.length === 2);
    expect(requests[1]?.method).toBe("PUT");
    expect(requests[1]?.itemId).toBe(requests[0]?.itemId);
    expect(requests[1]?.emoji).toBe(requests[0]?.emoji);
    // Retry belongs to the fallback surface even if another one mounts before its answer.
    addSurface();
    await flush();
    answer(1, [], 500);
    await until(() => Boolean(rail()?.textContent?.includes("The reaction could not be saved.")));
    remaining.unmount();
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(rail()?.children.length ?? 0).toBe(0);
  });

  test("a failed intent keeps its originating surface's notice while that surface is mounted", async () => {
    const { addSurface } = await mount();
    const newer = addSurface();
    chip().click();
    answer(0, [], 500);
    await until(() => Boolean(rail()?.textContent?.includes("The reaction could not be saved.")));
    newer.unmount();
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(rail()?.textContent).toContain("The reaction could not be saved.");
    dispose!();
    dispose = undefined;
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(rail()?.children.length ?? 0).toBe(0);
  });

  test("a failed intent falls back to the newest remaining surface", async () => {
    const { addSurface } = await mount();
    addSurface();
    const newest = addSurface();
    chip().click();
    dispose!();
    dispose = undefined;
    answer(0, [], 500);
    await until(() => Boolean(rail()?.textContent?.includes("The reaction could not be saved.")));
    newest.unmount();
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(rail()?.children.length ?? 0).toBe(0);
  });

  test("a failed refresh after its surface unmounts shows Retry on the remaining surface without another write", async () => {
    const { addSurface } = await mount();
    addSurface();
    const reload = deferredReload();
    let reads = 0;
    unsubscribeReload = subscribeToSpacesDataInvalidation(["view"], () => {
      reads++;
      return reads === 1 ? reload.promise : Promise.resolve();
    });
    chip().click();
    dispose!();
    dispose = undefined;
    answer(0, [reaction("👍", true)]);
    await until(() => reads === 1);
    reload.reject(new Error("Canonical read failed"));
    await until(() => Boolean(rail()?.textContent?.includes("Changes were saved, but item data could not be refreshed.")));
    [...rail()!.querySelectorAll("button")].find((button) => button.textContent === "Retry")!.click();
    await until(() => reads === 2);
    expect(requests).toHaveLength(1);
  });

  test("two quick chip toggles serialize PUT then DELETE, stay busy until both answer, and invalidate once after draining", async () => {
    const { itemId } = await mount();
    const reload = deferredReload();
    const invalidations: { cursor: string | null; itemId: string | null }[] = [];
    unsubscribeReload = subscribeToSpacesDataInvalidation(["view"], ({ cursor, itemId }) => {
      invalidations.push({ cursor, itemId });
      return reload.promise;
    });
    chip().click();
    chip().click();
    expect(requests.map((request) => request.method)).toEqual(["PUT"]);
    expect(chip().getAttribute("aria-pressed")).toBe("false");
    expect(chip().getAttribute("aria-busy")).toBe("true");
    await flush();
    expect(requests).toHaveLength(1);
    expect(invalidations).toEqual([]);
    answer(0, [reaction("👍", true)]);
    await until(() => requests.length === 2);
    expect(requests[1]?.method).toBe("DELETE");
    expect(requests[1]?.emoji).toBe(encodeURIComponent("👍"));
    expect(requests[1]?.itemId).toBe(requests[0]?.itemId);
    expect(chip().getAttribute("aria-busy")).toBe("true");
    expect(invalidations).toEqual([]);
    answer(1, [reaction()]);
    await until(() => !chip().hasAttribute("aria-busy"));
    expect(chip().getAttribute("aria-pressed")).toBe("false");
    expect(chip().textContent).toBe("👍1");
    expect(invalidations).toEqual([{ cursor: null, itemId }]);
    reload.resolve();
    await flush();
    expect(invalidations).toHaveLength(1);
  });

  test("a failed PUT rolls back only itself, drains later intents, and Retry replays that PUT", async () => {
    const { setSnapshot } = await mount([reaction(), reaction("❤️")]);
    chip().click();
    chip("❤️").click();
    expect(requests).toHaveLength(1);
    answer(0, [], 500);
    await until(() => requests.length === 2);
    expect(chip().getAttribute("aria-pressed")).toBe("false");
    expect(chip().textContent).toBe("👍1");
    expect(chip().hasAttribute("aria-busy")).toBe(false);
    expect(chip("❤️").getAttribute("aria-busy")).toBe("true");
    expect(requests[1]?.method).toBe("PUT");
    expect(requests[1]?.emoji).toBe(encodeURIComponent("❤️"));
    expect(rail()?.textContent).toContain("The reaction could not be saved.");
    const retry = [...rail()!.querySelectorAll("button")].find((button) => button.textContent === "Try again")!;
    expect(retry).toBeDefined();
    answer(1, [reaction(), reaction("❤️", true)]);
    await until(() => !chip("❤️").hasAttribute("aria-busy"));
    // A new server snapshot already includes our reaction: Retry must still replay PUT, never toggle to DELETE.
    // This catches callbacks that retry by calling the chip's toggle handler.
    setSnapshot([reaction("👍", true), reaction("❤️", true)]);
    retry.click();
    await until(() => requests.length === 3);
    expect(requests[2]?.method).toBe("PUT");
    expect(requests[2]?.emoji).toBe(requests[0]?.emoji);
    answer(2, [reaction("👍", true), reaction("❤️", true)]);
    await until(() => !chip().hasAttribute("aria-busy"));
    expect(chip().getAttribute("aria-pressed")).toBe("true");
  });

  test("a pick past the emoji limit sends nothing, and a limit answer says why without Try again", async () => {
    const many = defaults.concat(["🔥", "💡", "🎯", "📌", "🙌", "👏", "💯", "🤔", "😅", "🥳", "⭐", "💬"]);
    expect(many).toHaveLength(20);
    await mount(many.map((emoji) => reaction(emoji)));
    await pick("🍀");
    expect(requests).toHaveLength(0);
    await until(() => Boolean(rail()?.textContent?.includes("An item can have up to 20 different reactions.")));
    expect([...rail()!.querySelectorAll("button")].some((button) => button.textContent === "Try again")).toBe(false);
    // Someone else took the last place meanwhile: the server's limit answer reads the same.
    for (const toastButton of rail()!.querySelectorAll<HTMLButtonElement>("button")) toastButton.click();
    chip().click();
    expect(requests[0]?.method).toBe("PUT");
    requests[0]!.answered = true;
    requests[0]!.resolve(Response.json({ code: "REACTION_LIMIT_REACHED", message: "limit" }, { status: 409 }));
    await until(() => !chip().hasAttribute("aria-busy"));
    expect(chip().getAttribute("aria-pressed")).toBe("false");
    expect(rail()?.textContent).not.toContain("The reaction could not be saved.");
    expect([...rail()!.querySelectorAll("button")].some((button) => button.textContent === "Try again")).toBe(false);
  });

  test("a saved write's answer reaches its listeners, and a listener that left keeps nothing", async () => {
    const { onReactionAnswer } = await import("../src/frontend/[id]/_components/shared/reactions/reaction-queue");
    const { itemId } = await mount();
    const heard: string[] = [];
    const stop = onReactionAnswer((target, reactions) => heard.push(`${target.itemId} ${reactions.map((r) => `${r.emoji}${r.count}`)}`));
    chip().click();
    // The answer must match the public schema, whose people carry UUIDs.
    answer(0, [{ ...reaction("👍", true, 2), people: [] }]);
    await until(() => heard.length === 1);
    expect(heard).toEqual([`${itemId} 👍2`]);
    stop();
    await until(() => !chip().hasAttribute("aria-busy"));
    chip().click();
    answer(1, [{ ...reaction("👍"), people: [] }]);
    await until(() => !chip().hasAttribute("aria-busy"));
    expect(heard).toHaveLength(1);
  });

  test("the real picker ignores an own emoji and PUTs a new emoji", async () => {
    const { setSnapshot } = await mount([reaction("👍", true)]);
    unsubscribeReload = subscribeToSpacesDataInvalidation(["view"], async () => {
      setSnapshot([reaction("👍", true), reaction("🎉", true, 1)]);
    });
    await pick("👍");
    expect(requests).toEqual([]);
    await pick("🎉");
    expect(requests.map(({ method, emoji }) => ({ method, emoji }))).toEqual([{ method: "PUT", emoji: encodeURIComponent("🎉") }]);
    expect(chip("🎉").getAttribute("aria-pressed")).toBe("true");
    answer(0, [reaction("👍", true), reaction("🎉", true, 1)]);
    await until(() => !chip("🎉").hasAttribute("aria-busy"));
  });

  test("recent emoji start with defaults and persist the pick first under spaces:recent-emoji", async () => {
    await mount([]);
    const { readRecentEmoji, rememberRecentEmoji } = await import("../src/frontend/[id]/_components/shared/reactions/recent-emoji");
    expect(readRecentEmoji()).toEqual(defaults);
    const recent = rememberRecentEmoji("🎉");
    expect(recent[0]).toBe("🎉");
    expect(recent.filter((emoji) => emoji === "🎉")).toHaveLength(1);
    expect(JSON.parse(dom.window.localStorage.getItem("spaces:recent-emoji")!)).toEqual(recent);
    expect(readRecentEmoji()).toEqual(recent);
  });

  test("damaged or throwing localStorage falls back without throwing", async () => {
    await mount([]);
    const { readRecentEmoji, rememberRecentEmoji } = await import("../src/frontend/[id]/_components/shared/reactions/recent-emoji");
    for (const damaged of ["{broken", "{}", "[]", '[null, 7, ""]']) {
      dom.window.localStorage.setItem("spaces:recent-emoji", damaged);
      expect(readRecentEmoji()).toEqual(defaults);
    }
    const descriptor = Object.getOwnPropertyDescriptor(dom.window, "localStorage");
    try {
      Object.defineProperty(dom.window, "localStorage", {
        configurable: true,
        get: () => {
          throw new Error("Storage blocked");
        },
      });
      expect(readRecentEmoji()).toEqual(defaults);
      expect(rememberRecentEmoji("🚀")[0]).toBe("🚀");
    } finally {
      if (descriptor) Object.defineProperty(dom.window, "localStorage", descriptor);
      else Reflect.deleteProperty(dom.window, "localStorage");
    }
  });

  test("a fresh payload snapshot keeps the saved overlay until the canonical reload finishes, then shows exactly that snapshot", async () => {
    const { setSnapshot } = await mount();
    const reload = deferredReload();
    const canonical = [reaction("👀", true, 3), reaction("👍", false, 6), reaction("❤️")];
    unsubscribeReload = subscribeToSpacesDataInvalidation(["view"], async () => {
      await reload.promise;
      setSnapshot(canonical);
    });
    chip().click();
    setSnapshot([reaction("👍", false, 4), reaction("👀")]);
    expect(chip().textContent).toBe("👍5");
    expect(chip().getAttribute("aria-pressed")).toBe("true");
    expect(chip().getAttribute("aria-busy")).toBe("true");
    expect(chip("👀")).not.toBeNull();
    // A write answer is deliberately different from both the payload and the canonical read.
    answer(0, [reaction("👍", true, 2)]);
    await until(() => !chip().hasAttribute("aria-busy"));
    expect(chip().getAttribute("aria-pressed")).toBe("true");
    expect(chip().textContent).toBe("👍5");
    expect(chip("👀")).not.toBeNull();
    await flush();
    expect(chip().textContent).toBe("👍5");
    expect(chip().hasAttribute("aria-busy")).toBe(false);

    reload.resolve();
    await flush();
    expect(
      [...dom.root.querySelectorAll<HTMLButtonElement>("[data-reaction-key]")].map((button) => ({
        text: button.textContent,
        own: button.getAttribute("aria-pressed"),
        busy: button.hasAttribute("aria-busy"),
      })),
    ).toEqual([
      { text: "👀3", own: "true", busy: false },
      { text: "👍6", own: "false", busy: false },
      { text: "❤️1", own: "false", busy: false },
    ]);
  });

  test("a moved card remounted with a stale payload keeps its saved reaction and the next click sends DELETE", async () => {
    const stale = [reaction()];
    const { remount, setSnapshot, itemId } = await mount(stale);
    const reload = deferredReload();
    unsubscribeReload = subscribeToSpacesDataInvalidation(["view"], async () => {
      await reload.promise;
      setSnapshot([reaction()]);
    });
    chip().click();
    answer(0, [reaction("👍", true)]);
    await until(() => !chip().hasAttribute("aria-busy"));
    remount(stale);
    expect(chip().getAttribute("aria-pressed")).toBe("true");
    expect(chip().textContent).toBe("👍2");
    expect(chip().hasAttribute("aria-busy")).toBe(false);

    chip().click();
    expect(requests.map(({ method, itemId }) => ({ method, itemId }))).toEqual([
      { method: "PUT", itemId },
      { method: "DELETE", itemId },
    ]);
    answer(1, [reaction()]);
    await until(() => !chip().hasAttribute("aria-busy"));
    reload.resolve();
    await flush();
    expect(chip().getAttribute("aria-pressed")).toBe("false");
    expect(chip().textContent).toBe("👍1");
  });

  test("a fresher payload containing our reaction is never replaced by an older PUT answer", async () => {
    const { setSnapshot } = await mount();
    const reload = deferredReload();
    unsubscribeReload = subscribeToSpacesDataInvalidation(["view"], async () => {
      await reload.promise;
      setSnapshot([reaction("👍", true, 3)]);
    });
    chip().click();
    setSnapshot([reaction("👍", true, 3)]);
    expect(chip().textContent).toBe("👍3");
    expect(chip().getAttribute("aria-pressed")).toBe("true");
    expect(chip().getAttribute("aria-busy")).toBe("true");

    answer(0, [reaction("👍", true, 2)]);
    await until(() => !chip().hasAttribute("aria-busy"));
    expect(chip().textContent).toBe("👍3");
    expect(chip().getAttribute("aria-pressed")).toBe("true");
    reload.resolve();
    await flush();
    expect(chip().textContent).toBe("👍3");
    expect(chip().getAttribute("aria-pressed")).toBe("true");
    expect(chip().hasAttribute("aria-busy")).toBe(false);
  });

  test("a rejected canonical reload shows the last read, says so, and Retry reads again without another write", async () => {
    const { setSnapshot, itemId } = await mount();
    const failedReload = deferredReload();
    const retryReload = deferredReload();
    const invalidatedItems: (string | null)[] = [];
    unsubscribeReload = subscribeToSpacesDataInvalidation(["view"], async ({ itemId }) => {
      invalidatedItems.push(itemId);
      if (invalidatedItems.length === 1) {
        await failedReload.promise;
        return;
      }
      await retryReload.promise;
      setSnapshot([reaction("👍", true, 3)]);
    });
    chip().click();
    answer(0, [reaction("👍", true)]);
    await until(() => invalidatedItems.length === 1);
    failedReload.reject(new Error("Canonical read failed"));
    const message = "Changes were saved, but item data could not be refreshed.";
    await until(() => Boolean(rail()?.textContent?.includes(message)));
    // Nothing is left on the view that a later read would not retire: it shows the last read, and the toast says so.
    expect(chip().getAttribute("aria-pressed")).toBe("false");
    expect(chip().textContent).toBe("👍1");
    expect(chip().hasAttribute("aria-busy")).toBe(false);
    const retry = [...rail()!.querySelectorAll("button")].find((button) => button.textContent === "Retry");
    expect(retry).toBeDefined();
    retry!.click();
    await until(() => invalidatedItems.length === 2);
    expect(invalidatedItems).toEqual([itemId, itemId]);
    expect(requests).toHaveLength(1);
    await flush();
    expect(chip().getAttribute("aria-pressed")).toBe("false");
    expect(chip().hasAttribute("aria-busy")).toBe(false);

    retryReload.resolve();
    await flush();
    expect(chip().textContent).toBe("👍3");
    expect(chip().getAttribute("aria-pressed")).toBe("true");
    expect(chip().hasAttribute("aria-busy")).toBe(false);
    expect(requests).toHaveLength(1);
  });

  test("a reload Retry started while a later intent is open does not cover that intent once it is saved", async () => {
    const { setSnapshot } = await mount([reaction(), reaction("❤️")]);
    const reloads: PromiseWithResolvers<void>[] = [];
    unsubscribeReload = subscribeToSpacesDataInvalidation(["view"], () => {
      const reload = deferredReload();
      reloads.push(reload);
      return reload.promise;
    });
    chip().click();
    answer(0, [reaction("👍", true), reaction("❤️")]);
    await until(() => reloads.length === 1);
    reloads[0]!.reject(new Error("Canonical read failed"));
    await until(() => Boolean(rail()?.textContent?.includes("could not be refreshed")));
    // A new intent is open while Retry starts a read that may predate its write.
    chip("❤️").click();
    expect(requests).toHaveLength(2);
    [...rail()!.querySelectorAll("button")].find((button) => button.textContent === "Retry")!.click();
    await until(() => reloads.length === 2);
    answer(1, [reaction("👍", true), reaction("❤️", true)]);
    await until(() => !chip("❤️").hasAttribute("aria-busy"));
    // The Retry read answers with what it saw before the ❤️ write.
    setSnapshot([reaction("👍", true), reaction("❤️")]);
    reloads[1]!.resolve();
    await flush();
    expect(chip("❤️").getAttribute("aria-pressed")).toBe("true");
    expect(chip("❤️").textContent).toBe("❤️2");
    // Its own reload covers it.
    await until(() => reloads.length === 3);
    setSnapshot([reaction("👍", true), reaction("❤️", true)]);
    reloads[2]!.resolve();
    await flush();
    expect(chip("❤️").getAttribute("aria-pressed")).toBe("true");
    expect(chip("❤️").textContent).toBe("❤️2");
  });

  test("quick presses while a request is on its way keep one waiting intent per emoji, the last one", async () => {
    await mount();
    chip().click();
    for (let press = 0; press < 5; press++) chip().click();
    expect(requests.map((request) => request.method)).toEqual(["PUT"]);
    // Six presses end on "off": the overlay shows it, and only that wish waits.
    expect(chip().getAttribute("aria-pressed")).toBe("false");
    answer(0, [reaction("👍", true)]);
    await until(() => requests.length === 2);
    expect(requests[1]?.method).toBe("DELETE");
    answer(1, [reaction()]);
    await until(() => !chip().hasAttribute("aria-busy"));
    await flush();
    expect(requests).toHaveLength(2);
  });

  test("unmount closes owned Retry toasts and a late failure creates none", async () => {
    await mount([reaction(), reaction("❤️")]);
    chip().click();
    chip("❤️").click();
    answer(0, [], 500);
    await until(() => Boolean(rail()?.textContent?.includes("Try again")));
    dispose!();
    dispose = undefined;
    answer(1, [], 500);
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(rail()?.children.length ?? 0).toBe(0);
  });
});
