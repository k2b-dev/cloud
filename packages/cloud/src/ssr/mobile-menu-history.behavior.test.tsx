import { expect, test } from "bun:test";
import { createDomTestHarness } from "../../../ui/test/dom";

test("selection finishes menu history before opening the next dialog", async () => {
  const dom = createDomTestHarness();
  const { dialogCore } = await import("@k2b/ui");
  const { openMobileMenu } = await import("./mobile-menu-history");
  history.replaceState({ applicationState: "kept" }, "");
  let select = async () => false;
  const menu = openMobileMenu((beforeSelect) => () => {
    select = beforeSelect;
    return document.createElement("button");
  });
  expect(history.state.cloudMobileMenu).toBeString();
  expect(openMobileMenu(() => () => document.createElement("button"))).toBe(menu);
  expect(await select()).toBe(true);
  await menu;
  expect(history.state).toEqual({ applicationState: "kept" });
  expect(dialogCore.isOpen()).toBe(false);
  let closeNext = () => {};
  const next = dialogCore.open((close) => {
    closeNext = close;
    return document.createElement("input");
  });
  expect(dialogCore.isOpen()).toBe(true);
  closeNext();
  await next;
  dom.cleanup();
});

test("Back dismisses; pagehide does not wait for an impossible history return", async () => {
  const dom = createDomTestHarness();
  const { dialogCore } = await import("@k2b/ui");
  const { openMobileMenu } = await import("./mobile-menu-history");
  const menu = openMobileMenu(() => () => document.createElement("button"));
  history.back();
  await menu;
  expect(dialogCore.isOpen()).toBe(false);
  const next = openMobileMenu(() => () => document.createElement("button"));
  window.dispatchEvent(new Event("pagehide"));
  await next;
  expect(dialogCore.isOpen()).toBe(false);
  dom.cleanup();
});

test("an address that an open menu replaces returns to the earlier one when the menu closes", async () => {
  const dom = createDomTestHarness();
  const { openMobileMenu } = await import("./mobile-menu-history");
  history.replaceState({}, "", "/app/notes/one");
  let close = () => {};
  const menu = openMobileMenu(() => (dismiss) => {
    close = dismiss;
    return document.createElement("button");
  });
  // An action that keeps the menu open, such as a filter, writes its address on the menu's entry.
  history.replaceState(history.state, "", "/app/notes/one?view=favorites");
  close();
  await menu;
  expect(`${location.pathname}${location.search}`).toBe("/app/notes/one");
  expect(history.state).toEqual({});
  dom.cleanup();
});
