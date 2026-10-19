import { afterEach, expect, mock, test } from "bun:test";
import { createDomTestHarness } from "../../../ui/test/dom";
import { HELP_SHORTCUT_TITLE_MAX_LENGTH, HELP_START_SHORTCUT_LIMIT } from "../ssr/layout-help-start";
import { getContext, onContextChange, publishPageContext } from "./panel";
import { PAGE_CONTEXT_COLLECT, PANEL_SHORTCUTS_ELEMENT, type PageContextCollection } from "./panel-context-bridge";
import { installPanelContextReceiver } from "./panel-context-receiver";
import { onPanelShortcutsChange, readPanelShortcuts } from "./panel-shortcuts";

let cleanup = () => {};
afterEach(() => cleanup());
const first = {
  v: 1 as const,
  seq: 0,
  pageId: "11111111-1111-4111-8111-111111111111",
  app: "mail",
  scope: { type: "mail.mailbox", id: "Box001" },
};
function mount(initial: typeof first | null = first) {
  const dom = createDomTestHarness();
  dom.root.innerHTML = `<script id="cloud-panel-context" type="application/json">${JSON.stringify(initial)}</script>`;
  const parent = {};
  Object.defineProperty(window, "parent", { value: parent, configurable: true });
  const dispose = installPanelContextReceiver();
  const message = (context: unknown, origin = location.origin, source: unknown = parent, extra = {}) => {
    const event = new Event("message");
    Object.defineProperties(event, {
      source: { value: source },
      origin: { value: origin },
      data: { value: { type: "cloud.panel.context", v: 1, context, ...extra } },
    });
    window.dispatchEvent(event);
  };
  cleanup = () => {
    dispose();
    dom.cleanup();
  };
  return { dom, message, dispose };
}

test("first getContext equals server URL context; messages enforce origin, source, exact shape and ordering", () => {
  const h = mount();
  expect(getContext()).toEqual(first);
  const changed = mock((_context: unknown) => {});
  const unsubscribe = onContextChange(changed);
  for (const [origin, source] of [
    ["https://elsewhere.test", undefined],
    [location.origin, null],
  ])
    h.message({ ...first, seq: 1 }, origin!, source);
  h.message({ ...first, seq: 1 }, location.origin, undefined, { extra: true });
  h.message({ ...first, pageId: "22222222-2222-4222-8222-222222222222", seq: 100 });
  h.message({ ...first, seq: 2, scope: { type: "mail.mailbox", id: "Box002" } });
  h.message({ ...first, seq: 1 });
  expect(getContext()?.seq).toBe(2);
  expect(changed).toHaveBeenCalledTimes(1);
  h.message(getContext()); // Equal seq is idempotent and accepted.
  expect(changed).toHaveBeenCalledTimes(2);
  h.message(null);
  expect(getContext()).toBeNull();
  h.message({ ...first, seq: 1 });
  h.message({ ...first, pageId: "22222222-2222-4222-8222-222222222222", seq: 3 });
  expect(getContext()).toBeNull();
  h.message({ ...first, seq: 3 });
  expect(getContext()?.seq).toBe(3);
  unsubscribe();
  h.message({ ...first, seq: 4 });
  expect(changed).toHaveBeenCalledTimes(4);
  h.dispose();
  h.message(null);
  expect(getContext()?.seq).toBe(4);
});

test("without URL context the first non-null message pins document identity, even after null", () => {
  const h = mount(null);
  expect(getContext()).toBeNull();
  h.message(null);
  h.message(first);
  h.message(null);
  h.message({ ...first, pageId: "22222222-2222-4222-8222-222222222222", seq: 1 });
  expect(getContext()).toBeNull();
});

test("accepted shortcut lists live separately from page context, obey identity and seq, and clear with context", () => {
  const h = mount();
  const shortcuts = [{ id: "mail.edit", title: "Edit Ada", shortcut: "mod+e", scope: "selection" as const }];
  const changed = mock((_shortcuts: unknown) => {});
  const contextChanged = mock((_context: unknown) => {});
  const unsubscribe = onPanelShortcutsChange(changed);
  const unsubscribeContext = onContextChange(contextChanged);
  expect(readPanelShortcuts()).toEqual([]);
  const element = document.getElementById(PANEL_SHORTCUTS_ELEMENT)!;
  expect(element.tagName).toBe("SCRIPT");
  expect(element.getAttribute("type")).toBe("application/json");
  const deliver = (context: unknown, list = shortcuts) => h.message(context, location.origin, undefined, { shortcuts: list });
  deliver({ ...first, seq: 2 });
  expect(readPanelShortcuts()).toEqual(shortcuts);
  expect(element.textContent).toBe(JSON.stringify(shortcuts));
  expect(getContext()).toEqual({ ...first, seq: 2 });
  expect(contextChanged.mock.calls).toEqual([[{ ...first, seq: 2 }]]);
  expect(changed.mock.calls).toEqual([[shortcuts]]);
  deliver({ ...first, seq: 2 });
  expect(changed).toHaveBeenCalledTimes(1);
  expect(contextChanged).toHaveBeenCalledTimes(2);
  const updated = [{ ...shortcuts[0]!, title: "Edit Grace" }];
  deliver({ ...first, seq: 2 }, updated);
  expect(readPanelShortcuts()).toEqual(updated);
  expect(changed.mock.calls.at(-1)).toEqual([updated]);
  expect(changed).toHaveBeenCalledTimes(2);
  expect(contextChanged).toHaveBeenCalledTimes(2);
  deliver({ ...first, seq: 1 }, []);
  deliver({ ...first, pageId: "22222222-2222-4222-8222-222222222222", seq: 100 }, []);
  expect(readPanelShortcuts()).toEqual(updated);
  expect(getContext()?.seq).toBe(2);
  expect(changed).toHaveBeenCalledTimes(2);
  h.message({ ...first, seq: 3 });
  expect(readPanelShortcuts()).toEqual([]);
  expect(changed.mock.calls.at(-1)).toEqual([[]]);
  deliver({ ...first, seq: 3 });
  h.message(null);
  expect(getContext()).toBeNull();
  expect(readPanelShortcuts()).toEqual([]);
  expect(element.textContent).toBe("[]");
  expect(changed).toHaveBeenCalledTimes(5);
  h.message(null);
  expect(changed).toHaveBeenCalledTimes(5);
  deliver({ ...first, seq: 2 });
  expect(readPanelShortcuts()).toEqual([]);
  expect(getContext()).toBeNull();
  unsubscribe();
  deliver({ ...first, seq: 4 });
  expect(readPanelShortcuts()).toEqual(shortcuts);
  expect(changed).toHaveBeenCalledTimes(5);
  for (const [context] of contextChanged.mock.calls) {
    if (context !== null) expect(context).not.toHaveProperty("shortcuts");
  }
  unsubscribeContext();
});

test("invalid shortcut messages reject context and shortcuts together without advancing ordering", () => {
  const h = mount();
  const shortcut = { id: "mail.edit", title: "Edit Ada", shortcut: "e" };
  const shortcuts = [shortcut];
  h.message(first, location.origin, undefined, { shortcuts });
  const changed = mock(() => {});
  const unsubscribe = onPanelShortcutsChange(changed);
  const contextChanged = mock(() => {});
  const unsubscribeContext = onContextChange(contextChanged);
  for (const invalid of [
    [{ ...shortcut, title: "x".repeat(HELP_SHORTCUT_TITLE_MAX_LENGTH + 1) }],
    Array.from({ length: HELP_START_SHORTCUT_LIMIT + 1 }, () => shortcut),
    [{ ...shortcut, extra: true }],
    [, shortcut],
  ]) {
    h.message({ ...first, seq: 100 }, location.origin, undefined, { shortcuts: invalid });
    expect(getContext()).toEqual(first);
    expect(readPanelShortcuts()).toEqual(shortcuts);
  }
  h.message(null, location.origin, undefined, { shortcuts });
  expect(getContext()).toEqual(first);
  expect(readPanelShortcuts()).toEqual(shortcuts);
  expect(changed).not.toHaveBeenCalled();
  expect(contextChanged).not.toHaveBeenCalled();
  h.message({ ...first, seq: 1 }, location.origin, undefined, { shortcuts: [] });
  expect(getContext()?.seq).toBe(1);
  expect(readPanelShortcuts()).toEqual([]);
  expect(changed).toHaveBeenCalledTimes(1);
  unsubscribe();
  unsubscribeContext();
});

test("internal shortcut reader returns an empty list for missing, malformed or invalid DOM data", () => {
  mount();
  const element = document.getElementById(PANEL_SHORTCUTS_ELEMENT)!;
  for (const text of ["{", "null", "{}", '"list"', '[{"id":"bad"}]', '[{"id":"a","title":"b","shortcut":"c","extra":true}]']) {
    element.textContent = text;
    expect(readPanelShortcuts()).toEqual([]);
  }
  element.remove();
  expect(readPanelShortcuts()).toEqual([]);
});

test("publishers are independently collectible before the controller and dispose only their own source", async () => {
  const dom = createDomTestHarness();
  cleanup = dom.cleanup;
  // Import a separate bundle instance: the document events, not module state, carry the sources.
  const bundlePath = "./panel.ts?bundle=publisher";
  const independent: typeof import("./panel") = await import(bundlePath);
  const a = publishPageContext({ scope: first.scope });
  const b = independent.publishPageContext({ scope: { type: "spaces.space", id: "Space1" } });
  const metadata = publishPageContext({});
  const collect = () => {
    const detail: PageContextCollection = { sources: [] };
    window.dispatchEvent(new CustomEvent(PAGE_CONTEXT_COLLECT, { detail }));
    return detail.sources;
  };
  expect(collect()).toEqual([{ scope: first.scope }, { scope: { type: "spaces.space", id: "Space1" } }, {}]);
  a();
  a();
  expect(collect()).toEqual([{ scope: { type: "spaces.space", id: "Space1" } }, {}]);
  b();
  expect(collect()).toEqual([{}]);
  metadata();
  expect(collect()).toEqual([]);
});
