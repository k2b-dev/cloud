import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { toJSON } from "seroval";
import { createRoot, onMount } from "solid-js";
import { disposeIslands, mount } from "../../src/mount";
import { type BeforeLeaveEvent, installPageSwap, listenPopState, onBeforeLeave, swapPage } from "../../src/nav";
import { allowsLeave } from "../../src/nav-veto";

const markerKey = "@k2b/ssr/nav";
const disposers: Array<() => void> = [];
const root = () => document.querySelector<HTMLElement>("main")!;
const ask = (delta?: number) => allowsLeave(root(), new URL("https://example.test/app/B"), delta) === undefined;
const register = (check: (event: BeforeLeaveEvent) => void) => {
  const dispose = onBeforeLeave(check);
  disposers.push(dispose);
  return dispose;
};
const island = (check: (event: BeforeLeaveEvent) => void, outside = false, mounted = false) => {
  const element = document.createElement("solid-island");
  element.dataset.id = String(document.querySelectorAll("solid-island").length);
  element.dataset.props = JSON.stringify(toJSON({}));
  (outside ? document.querySelector("nav")! : root()).append(element);
  mount(() => {
    if (mounted) onMount(() => onBeforeLeave(check));
    else onBeforeLeave(check);
    return null;
  }, `solid-island[data-id="${element.dataset.id}"]`);
  return element;
};
const arrive = (page: string, position: number) => {
  const state = { [markerKey]: { page, position } };
  History.prototype.replaceState.call(history, state, "", `/app/${page}`);
  window.dispatchEvent(new PopStateEvent("popstate", { state }));
};
beforeEach(() => {
  history.replaceState({ [markerKey]: { page: "A", position: 2 } }, "", "/app/A");
  document.body.innerHTML = '<div data-nav-shell="veto" data-nav-scope="/app"><nav></nav><main data-nav-root><h1>A</h1></main></div>';
});
afterEach(() => {
  for (const dispose of disposers.splice(0).reverse()) dispose();
  disposeIslands(document);
  document.body.replaceChildren();
  Reflect.deleteProperty(window, "navigation");
  mock.restore();
});

test.each([false, true])("island render/onMount registration (%s) ends with its Solid owner", (mounted) => {
  const check = mock((event: BeforeLeaveEvent) => event.preventDefault());
  const element = island(check, false, mounted);
  expect(ask()).toBe(false);
  expect(check).toHaveBeenCalledTimes(1);
  disposeIslands(element);
  expect(ask()).toBe(true);
  expect(check).toHaveBeenCalledTimes(1);
});

test("returned disposal is idempotent and an owner outside an island is global until cleanup", () => {
  const check = mock((event: BeforeLeaveEvent) => event.preventDefault());
  let stop = () => {};
  const dispose = createRoot((dispose) => {
    stop = register(check);
    return dispose;
  });
  expect(ask()).toBe(false);
  stop();
  stop();
  expect(ask()).toBe(true);
  dispose();
  const cleanup = createRoot((dispose) => {
    onBeforeLeave(check);
    return dispose;
  });
  expect(ask()).toBe(false);
  cleanup();
  expect(ask()).toBe(true);
});

test("shell and disconnected islands are skipped; owner-less checks run until disposed", () => {
  const shell = mock((event: BeforeLeaveEvent) => event.preventDefault());
  island(shell, true);
  const removed = island(shell);
  removed.remove();
  expect(ask()).toBe(true);
  expect(shell).not.toHaveBeenCalled();
  const global = mock((event: BeforeLeaveEvent) => event.preventDefault());
  const stop = register(global);
  expect(ask()).toBe(false);
  stop();
  expect(ask()).toBe(true);
  expect(global).toHaveBeenCalledTimes(1);
  disposeIslands(removed);
});

test("registration order, separate events, and first veto wins", () => {
  const seen: BeforeLeaveEvent[] = [];
  register((event) => {
    seen.push(event);
  });
  register((event) => {
    seen.push(event);
    event.preventDefault();
  });
  const last = mock(() => {});
  register(last);
  expect(ask(-1)).toBe(false);
  expect(seen).toHaveLength(2);
  expect(seen[0]).not.toBe(seen[1]);
  expect(seen[0]?.restored).toBe(seen[1]?.restored);
  expect(seen[0]?.url.href).toBe("https://example.test/app/B");
  expect(seen[0]?.delta).toBe(-1);
  expect(last).not.toHaveBeenCalled();
});

test("throw after preventDefault allows, reports the error, and asks the next check", () => {
  const error = new Error("broken check");
  const report = spyOn(globalThis, "reportError").mockImplementation(() => {});
  register((event) => {
    event.preventDefault();
    throw error;
  });
  const next = mock(() => {});
  register(next);
  expect(ask()).toBe(true);
  expect(report).toHaveBeenCalledWith(error);
  expect(next).toHaveBeenCalledTimes(1);
});

test("return values and promises do not veto", () => {
  register(() => false);
  register(() => Promise.resolve(false));
  expect(ask()).toBe(true);
});

test("vetoed swapPage does not fetch, write history, or cancel an older swap", async () => {
  disposers.push(installPageSwap());
  const pending = Promise.withResolvers<Response>();
  const fetch = spyOn(globalThis, "fetch").mockReturnValue(pending.promise);
  const older = swapPage("/app/B");
  const signal = fetch.mock.calls[0]?.[1]?.signal;
  const before = { url: location.href, length: history.length, state: history.state, root: root() };
  register((event) => event.preventDefault());
  await swapPage("/app/C");
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(signal?.aborted).toBe(false);
  expect({ url: location.href, length: history.length, state: history.state, root: root() }).toEqual(before);
  disposers[0]!();
  pending.resolve(new Response("unused"));
  await older;
});

test.each(["scope", "shell", "install"])("document loads do not ask checks (%s)", async (kind) => {
  if (kind !== "install") disposers.push(installPageSwap());
  if (kind === "shell") document.querySelector("[data-nav-shell]")!.remove();
  const check = mock((event: BeforeLeaveEvent) => event.preventDefault());
  register(check);
  const assign = spyOn(window.location, "assign").mockImplementation(() => {});
  await swapPage(kind === "scope" ? "/outside" : "/app/B");
  expect(check).not.toHaveBeenCalled();
  expect(assign).toHaveBeenCalledTimes(1);
});

const departing = (navigation: EventTarget, key: string) => {
  navigation.dispatchEvent(Object.assign(new Event("navigate"), { navigationType: "traverse", destination: { key } }));
};
const navigationFixture = () => {
  const finished = Promise.withResolvers<void>();
  const committed = Promise.withResolvers<void>();
  const traverseTo = mock(() => ({ committed: committed.promise, finished: finished.promise }));
  const currentEntry: { key?: string; index: number } = { key: "A", index: 2 };
  const navigation = Object.assign(new EventTarget(), {
    currentEntry,
    entries: () => [{ key: "older" }, { key: "B" }, { key: "A" }],
    traverseTo,
  });
  Object.defineProperty(window, "navigation", { configurable: true, value: navigation });
  disposers.push(installPageSwap());
  return { navigation, traverseTo, finished, committed };
};

test("rollback absorbs intermediate pops without checks, listeners, scroll, or aborting newer work", async () => {
  const { navigation, traverseTo, finished, committed } = navigationFixture();
  const check = mock((event: BeforeLeaveEvent) => event.preventDefault());
  const stop = register(check);
  const helper = mock(() => {});
  const raw = mock(() => {});
  disposers.push(listenPopState(helper));
  window.addEventListener("popstate", raw);
  window.addEventListener("ssr:nav-popstate", raw);
  disposers.push(() => {
    window.removeEventListener("popstate", raw);
    window.removeEventListener("ssr:nav-popstate", raw);
  });
  const scroll = spyOn(window, "scrollTo");
  departing(navigation, "B");
  navigation.currentEntry = { key: "B", index: 1 };
  arrive("B", 1);
  expect(traverseTo).toHaveBeenCalledWith("A");
  expect(check.mock.calls[0]?.[0].delta).toBe(-1);
  stop();
  const pending = Promise.withResolvers<Response>();
  const fetch = spyOn(globalThis, "fetch").mockReturnValue(pending.promise);
  const newer = swapPage("/app/C");
  navigation.currentEntry = { key: "older", index: 0 };
  arrive("older", 0);
  navigation.currentEntry = { key: "A", index: 2 };
  arrive("A", 2);
  expect(fetch.mock.calls[0]?.[1]?.signal?.aborted).toBe(false);
  expect(check).toHaveBeenCalledTimes(1);
  expect(helper).not.toHaveBeenCalled();
  expect(raw).not.toHaveBeenCalled();
  expect(scroll).not.toHaveBeenCalled();
  committed.resolve();
  finished.resolve();
  disposers[0]!();
  pending.resolve(new Response("unused"));
  await newer;
});

test.each(["none", "island push"])("a failed absolute rollback reloads (%s during the rollback)", async (write) => {
  const { navigation, finished, committed } = navigationFixture();
  const restored = mock(() => {});
  register((event) => {
    event.preventDefault();
    void event.restored.then(restored);
  });
  const reload = spyOn(window.location, "reload").mockImplementation(() => {});
  departing(navigation, "B");
  navigation.currentEntry = { key: "B", index: 1 };
  arrive("B", 1);
  // The shown page's own write lands on B's position: its column and the URL no longer match.
  if (write === "island push") history.pushState(null, "", "/app/A?new");
  committed.reject(new Error("interrupted"));
  finished.reject(new Error("interrupted"));
  await Promise.resolve();
  await Promise.resolve();
  expect(reload).toHaveBeenCalledTimes(1);
  expect(restored).not.toHaveBeenCalled();
});

test("a failed absolute rollback keeps the entry of a newer swap that committed meanwhile", async () => {
  const { navigation, finished, committed } = navigationFixture();
  const check = mock((event: BeforeLeaveEvent) => event.preventDefault());
  const stop = register(check);
  const reload = spyOn(window.location, "reload").mockImplementation(() => {});
  departing(navigation, "B");
  navigation.currentEntry = { key: "B", index: 1 };
  arrive("B", 1);
  stop();
  const page =
    '<!doctype html><html><head><title>C</title></head><body><div data-nav-shell="veto" data-nav-scope="/app"><nav></nav><main data-nav-root><h1>C</h1></main></div></body></html>';
  spyOn(globalThis, "fetch").mockResolvedValue(new Response(page, { headers: { "content-type": "text/html" } }));
  await swapPage("/app/C");
  expect(root().querySelector("h1")?.textContent).toBe("C");
  committed.reject(new Error("removed"));
  finished.reject(new Error("removed"));
  await Promise.resolve();
  await Promise.resolve();
  expect(reload).not.toHaveBeenCalled();
  expect(location.pathname).toBe("/app/C");
  expect(check).toHaveBeenCalledTimes(1);
});

test("a rollback that arrives after a newer replace swap committed is an ordinary traversal", async () => {
  const { navigation } = navigationFixture();
  const check = mock((event: BeforeLeaveEvent) => event.preventDefault());
  const stop = register(check);
  spyOn(window.location, "reload").mockImplementation(() => {});
  const restored = mock(() => {});
  const claimed = mock(() => {});
  window.addEventListener("ssr:nav-popstate", claimed);
  disposers.push(() => window.removeEventListener("ssr:nav-popstate", claimed));
  departing(navigation, "B");
  navigation.currentEntry = { key: "B", index: 1 };
  arrive("B", 1);
  void check.mock.calls[0]?.[0].restored.then(restored);
  stop();
  const page = (label: string) =>
    `<!doctype html><html><head><title>${label}</title></head><body><div data-nav-shell="veto" data-nav-scope="/app"><nav></nav><main data-nav-root><h1>${label}</h1></main></div></body></html>`;
  const html = (label: string) => new Response(page(label), { headers: { "content-type": "text/html" } });
  const fetch = spyOn(globalThis, "fetch").mockResolvedValueOnce(html("C")).mockResolvedValueOnce(html("A"));
  await swapPage("/app/C", { replace: true });
  expect(root().querySelector("h1")?.textContent).toBe("C");
  // The rollback still reaches A's entry, which the replace left in place.
  departing(navigation, "A");
  navigation.currentEntry = { key: "A", index: 2 };
  arrive("A", 2);
  expect(claimed).toHaveBeenCalledTimes(1);
  expect(String(fetch.mock.calls.at(-1)?.[0])).toBe("https://example.test/app/A");
  await Promise.resolve();
  expect(restored).not.toHaveBeenCalled();
});

test.each(["other", "A"])("without Navigation API rollback uses history.go and reloads a wrong arrival (%s)", (page) => {
  disposers.push(installPageSwap());
  const go = spyOn(history, "go").mockImplementation(() => {});
  const reload = spyOn(window.location, "reload").mockImplementation(() => {});
  const check = mock((event: BeforeLeaveEvent) => event.preventDefault());
  register(check);
  arrive("B", 1);
  expect(go).toHaveBeenCalledWith(1);
  arrive(page, 0);
  expect(reload).toHaveBeenCalledTimes(1);
  expect(check).toHaveBeenCalledTimes(1);
});

test.each(["unknown", "zero"])("a traversal with %s delta cannot be vetoed", async (kind) => {
  disposers.push(installPageSwap());
  const check = mock((event: BeforeLeaveEvent) => event.preventDefault());
  register(check);
  const pending = Promise.withResolvers<Response>();
  const fetch = spyOn(globalThis, "fetch").mockReturnValue(pending.promise);
  if (kind === "zero") arrive("B", 2);
  else {
    History.prototype.replaceState.call(history, null, "", "/app/B");
    window.dispatchEvent(new PopStateEvent("popstate", { state: null }));
  }
  expect(check).not.toHaveBeenCalled();
  expect(fetch).toHaveBeenCalledTimes(1);
  disposers[0]!();
  pending.resolve(new Response("unused"));
  await Promise.resolve();
});

test("pageshow and fragment claims continue a traversal without asking again", async () => {
  const { navigation } = navigationFixture();
  const check = mock((event: BeforeLeaveEvent) => event.preventDefault());
  register(check);
  const pending = Promise.withResolvers<Response>();
  const fetch = spyOn(globalThis, "fetch").mockReturnValue(pending.promise);
  History.prototype.replaceState.call(history, { [markerKey]: { page: "B", position: 1 } }, "", "/app/B");
  departing(navigation, "B");
  navigation.currentEntry = { key: "B", index: 1 };
  window.dispatchEvent(Object.assign(new Event("pageshow"), { persisted: true }));
  navigation.dispatchEvent(
    Object.assign(new Event("navigate"), {
      navigationType: "push",
      destination: { key: "fragment" },
      hashChange: true,
    }),
  );
  navigation.currentEntry = { key: "fragment", index: 2 };
  History.prototype.replaceState.call(history, null, "", "/app/B#section");
  window.dispatchEvent(new PopStateEvent("popstate", { state: null }));
  expect(check).not.toHaveBeenCalled();
  expect(fetch).toHaveBeenCalledTimes(2);
  disposers[0]!();
  pending.resolve(new Response("unused"));
  await Promise.resolve();
});

test("uninstall clears rollback and a late rejection cannot reload", async () => {
  const { navigation, committed, finished } = navigationFixture();
  register((event) => event.preventDefault());
  const reload = spyOn(window.location, "reload").mockImplementation(() => {});
  departing(navigation, "B");
  navigation.currentEntry = { key: "B", index: 1 };
  arrive("B", 1);
  disposers[0]!();
  committed.reject(new Error("uninstalled"));
  finished.reject(new Error("uninstalled"));
  await Promise.resolve();
  expect(reload).not.toHaveBeenCalled();
});

test.each(["missing entry", "missing from"])("marker-only rollback works with Navigation API (%s)", (kind) => {
  const { navigation, traverseTo } = navigationFixture();
  // Marker positions have grown beyond the API's shifted indices.
  History.prototype.replaceState.call(history, { [markerKey]: { page: "A", position: 62 } }, "", "/app/A");
  if (kind === "missing entry") navigation.entries = () => [];
  else navigation.currentEntry = { index: 2 };
  departing(navigation, "B");
  navigation.currentEntry = { key: "B", index: 1 };
  register((event) => event.preventDefault());
  const go = spyOn(history, "go").mockImplementation(() => {});
  const reload = spyOn(window.location, "reload").mockImplementation(() => {});
  arrive("B", 61);
  expect(go).toHaveBeenCalledWith(1);
  expect(traverseTo).not.toHaveBeenCalled();
  arrive("A", 62);
  expect(reload).not.toHaveBeenCalled();
});

test("a successful history.go rollback absorbs only the rollback popstate", () => {
  disposers.push(installPageSwap());
  const go = spyOn(history, "go").mockImplementation(() => {});
  const reload = spyOn(window.location, "reload").mockImplementation(() => {});
  const check = mock((event: BeforeLeaveEvent) => event.preventDefault());
  register(check);
  const helper = mock(() => {});
  disposers.push(listenPopState(helper));
  arrive("B", 1);
  arrive("A", 2);
  expect(go).toHaveBeenCalledWith(1);
  expect(helper).not.toHaveBeenCalled();
  expect(reload).not.toHaveBeenCalled();
  arrive("A", 1);
  expect(helper).toHaveBeenCalledTimes(1);
  expect(check).toHaveBeenCalledTimes(1);
});

test("restored resolves right away for a vetoed swapPage", async () => {
  disposers.push(installPageSwap());
  const restored = mock(() => {});
  register((event) => {
    event.preventDefault();
    void event.restored.then(restored);
  });
  await swapPage("/app/B");
  expect(restored).toHaveBeenCalledTimes(1);
});

test.each([true, false])("restored waits for the rollback arrival (absolute: %s)", async (absolute) => {
  const fixture = absolute ? navigationFixture() : undefined;
  if (!absolute) disposers.push(installPageSwap());
  const restored = mock(() => {});
  register((event) => {
    event.preventDefault();
    void event.restored.then(restored);
  });
  spyOn(history, "go").mockImplementation(() => {});
  if (fixture) {
    departing(fixture.navigation, "B");
    fixture.navigation.currentEntry = { key: "B", index: 1 };
  }
  arrive("B", 1);
  await Promise.resolve();
  expect(restored).not.toHaveBeenCalled();
  if (fixture) fixture.navigation.currentEntry = { key: "A", index: 2 };
  arrive("A", 2);
  await Promise.resolve();
  expect(restored).toHaveBeenCalledTimes(1);
  const helper = mock(() => {});
  disposers.push(listenPopState(helper));
  arrive("A", 3);
  expect(helper).toHaveBeenCalledTimes(1);
});

test("a rollback whose target is already current clears pending and resolves restored", async () => {
  const { navigation, traverseTo } = navigationFixture();
  const restored = mock(() => {});
  register((event) => {
    event.preventDefault();
    // Simulate history reaching the target while the check runs, without a wrapper write.
    navigation.currentEntry = { key: "A", index: 2 };
    void event.restored.then(restored);
  });
  departing(navigation, "B");
  navigation.currentEntry = { key: "B", index: 1 };
  arrive("B", 1);
  await Promise.resolve();
  expect(restored).toHaveBeenCalledTimes(1);
  expect(traverseTo).not.toHaveBeenCalled();
  const helper = mock(() => {});
  disposers.push(listenPopState(helper));
  arrive("A", 2);
  expect(helper).toHaveBeenCalledTimes(1);
});

test.each(["push", "replace", "same-URL replace"])(
  "a check's synchronous history %s during Back reloads without restoring",
  async (kind) => {
    const { navigation, traverseTo } = navigationFixture();
    const restored = mock(() => {});
    register((event) => {
      event.preventDefault();
      void event.restored.then(restored);
      if (kind === "push") history.pushState(null, "", location.href);
      else if (kind === "same-URL replace") history.replaceState({ ...history.state, draft: 1 }, "");
      else history.replaceState(null, "", "/app/B?changed");
    });
    const reload = spyOn(window.location, "reload").mockImplementation(() => {});
    const error = spyOn(console, "error").mockImplementation(() => {});
    const helper = mock(() => {});
    disposers.push(listenPopState(helper));
    departing(navigation, "B");
    navigation.currentEntry = { key: "B", index: 1 };
    arrive("B", 1);
    await Promise.resolve();
    expect(reload).toHaveBeenCalledTimes(1);
    expect(error.mock.calls[0]?.[0]).toContain("A leave check wrote history");
    expect(traverseTo).not.toHaveBeenCalled();
    expect(restored).not.toHaveBeenCalled();
    expect(helper).not.toHaveBeenCalled();
    arrive("A", 2);
    expect(helper).toHaveBeenCalledTimes(1);
  },
);

test("a same-URL replace during rollback keeps the foreign entry cross-page on the next Back", async () => {
  const { navigation, traverseTo, committed, finished } = navigationFixture();
  const stop = register((event) => event.preventDefault());
  const reload = spyOn(window.location, "reload").mockImplementation(() => {});
  departing(navigation, "B");
  navigation.currentEntry = { key: "B", index: 1 };
  arrive("B", 1);
  expect(traverseTo).toHaveBeenCalledWith("A");
  history.replaceState({ ...history.state, draft: 1 }, "");
  // Save the entry actually written by the wrapper, so the later Back exposes a corrupted marker.
  const b = history.state;
  navigation.currentEntry = { key: "A", index: 2 };
  arrive("A", 2);
  committed.resolve();
  finished.resolve();
  stop();
  const pending = Promise.withResolvers<Response>();
  const fetch = spyOn(globalThis, "fetch").mockReturnValue(pending.promise);
  departing(navigation, "B");
  navigation.currentEntry = { key: "B", index: 1 };
  History.prototype.replaceState.call(history, b, "", "/app/B");
  window.dispatchEvent(new PopStateEvent("popstate", { state: b }));
  expect(String(fetch.mock.calls[0]?.[0])).toBe("https://example.test/app/B");
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(fetch.mock.calls[0]?.[1]?.signal?.aborted).toBe(false);
  expect(b).toEqual({ [markerKey]: { page: "B", position: 1 }, draft: 1 });
  expect(reload).not.toHaveBeenCalled();
  disposers[0]!();
  pending.resolve(new Response("unused"));
  await Promise.resolve();
});

test("a traversal during a pending cross-page traversal is not asked again", async () => {
  const { navigation } = navigationFixture();
  const check = mock((event: BeforeLeaveEvent) => {
    if (check.mock.calls.length > 1) event.preventDefault();
  });
  register(check);
  const pending = Promise.withResolvers<Response>();
  const fetch = spyOn(globalThis, "fetch").mockReturnValue(pending.promise);
  departing(navigation, "B");
  navigation.currentEntry = { key: "B", index: 1 };
  arrive("B", 1);
  const firstSignal = fetch.mock.calls[0]?.[1]?.signal;
  departing(navigation, "older");
  navigation.currentEntry = { key: "older", index: 0 };
  arrive("older", 0);
  expect(check).toHaveBeenCalledTimes(1);
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(firstSignal?.aborted).toBe(true);
  disposers[0]!();
  pending.resolve(new Response("unused"));
  await Promise.resolve();
});

test("absolute rollback uses the departure key's current index after eviction", () => {
  const { navigation, traverseTo } = navigationFixture();
  History.prototype.replaceState.call(history, { [markerKey]: { page: "A", position: 62 } }, "", "/app/A");
  const check = mock((event: BeforeLeaveEvent) => event.preventDefault());
  register(check);
  departing(navigation, "B");
  navigation.currentEntry = { key: "B", index: 1 };
  arrive("B", 61);
  expect(check.mock.calls[0]?.[0].delta).toBe(-1);
  expect(traverseTo).toHaveBeenCalledWith("A");
});

test("restored stays pending when no check vetoes", async () => {
  const restored = mock(() => {});
  register((event) => {
    void event.restored.then(restored);
  });
  expect(ask()).toBe(true);
  await Promise.resolve();
  expect(restored).not.toHaveBeenCalled();
});
