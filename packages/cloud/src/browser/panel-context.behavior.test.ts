import { afterEach, expect, mock, test } from "bun:test";
import { createDomTestHarness } from "../../../ui/test/dom";
import { getContext, onContextChange, publishPageContext } from "./panel";
import { PAGE_CONTEXT_COLLECT, type PageContextCollection } from "./panel-context-bridge";
import { installPanelContextReceiver } from "./panel-context-receiver";

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
