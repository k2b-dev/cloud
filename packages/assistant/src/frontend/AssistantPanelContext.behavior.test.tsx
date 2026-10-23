import { afterEach, expect, mock, test } from "bun:test";
import { render } from "solid-js/web";
import { createDomTestHarness } from "../../../ui/test/dom";

const place = {
  v: 1 as const,
  seq: 1,
  pageId: "11111111-1111-4111-8111-111111111111",
  app: "notebooks",
  scope: { type: "notebooks.note", id: "note01" },
};
let changed: ((context: typeof place | null) => void) | undefined;
mock.module("@k2b/cloud/browser/panel", () => ({
  getContext: () => place,
  onContextChange: (callback: typeof changed) => {
    changed = callback;
    return () => {
      changed = undefined;
    };
  },
}));
const bootstrap = createDomTestHarness();
const { LocaleProvider } = await import("@k2b/ui");
const { default: PanelContext } = await import("./AssistantPanelContext");
bootstrap.cleanup();
const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const stop of cleanup.splice(0).reverse()) stop();
});
const mount = (attach: (ref: { type: string; id: string }, current: () => boolean) => Promise<void>) => {
  const dom = createDomTestHarness();
  cleanup.push(dom.cleanup);
  const root = dom.document.createElement("div");
  dom.document.body.append(root);
  cleanup.push(
    render(
      () => (
        <LocaleProvider locale="en">
          <PanelContext initial={place} disabled={false} attach={attach} />
        </LocaleProvider>
      ),
      root,
    ),
  );
  return root;
};

test("only an explicit click attaches the place, once; withdrawal invalidates an unresolved reader result", async () => {
  let release = () => {};
  let stillCurrent = () => false;
  const calls: unknown[] = [];
  const root = mount(async (ref, current) => {
    calls.push(ref);
    stillCurrent = current;
    await new Promise<void>((resolve) => {
      release = resolve;
    });
  });
  expect(calls).toEqual([]);
  const button = root.querySelector("button")!;
  button.click();
  button.click();
  expect(calls).toEqual([place.scope]);
  expect(stillCurrent()).toBe(true);
  changed?.(null);
  expect(stillCurrent()).toBe(false);
  expect(root.querySelector("button")).toBeNull();
  release();
  await Promise.resolve();
});

test("a denied reader shows an inline retry path without a private title", async () => {
  let attempts = 0;
  const root = mount(async () => {
    attempts++;
    throw new Error("Private resource title");
  });
  root.querySelector("button")!.click();
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(root.textContent).toContain("This view could not be attached");
  expect(root.textContent).not.toContain("Private resource title");
  expect(root.querySelector("button")!.disabled).toBe(false);
  root.querySelector("button")!.click();
  await Promise.resolve();
  expect(attempts).toBe(2);
});
