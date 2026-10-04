import { expect, test } from "bun:test";
import { createComponent } from "solid-js";
import { isServer, render } from "solid-js/web";
import { createDomTestHarness } from "../../../ui/test/dom";

const load = async () => {
  const dom = createDomTestHarness();
  try {
    return (await import("./TimezoneCookie.island")).default;
  } finally {
    dom.cleanup();
  }
};
const TimezoneCookie = isServer ? undefined : await load();

const mount = (reload?: boolean) => {
  const dom = createDomTestHarness();
  let reloads = 0;
  // The island reads the global `sessionStorage`, which the harness does not install.
  Object.defineProperty(globalThis, "sessionStorage", { configurable: true, value: dom.window.sessionStorage });
  Object.assign(dom.window.location, {
    reload: () => {
      reloads += 1;
    },
  });
  const dispose = render(() => createComponent(TimezoneCookie!, reload === undefined ? {} : { reload }), dom.root);
  return {
    cookie: () => dom.document.cookie,
    reloads: () => reloads,
    dispose: () => {
      dispose();
      Reflect.deleteProperty(globalThis, "sessionStorage");
      dom.cleanup();
    },
  };
};

if (isServer) test.skip("requires browser conditions", () => {});
else {
  test("stores a changed timezone and reloads once, unless the page asks for no reload", () => {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    for (const [reload, reloads] of [
      [false, 0],
      [undefined, 1],
    ] as const) {
      const page = mount(reload);
      try {
        expect(page.cookie()).toContain(encodeURIComponent(zone));
        expect(page.reloads()).toBe(reloads);
      } finally {
        page.dispose();
      }
    }
  });
}
