import { describe, expect, spyOn, test } from "bun:test";
import { isServer, render } from "solid-js/web";
import { createDomTestHarness, type DomTestHarness } from "./dom";

const STORAGE_KEY = "k2b-sidebar-scroll:admin:1";

/**
 * Browsers run the inline script while parsing the server response; Solid's
 * client renderer leaves it inert. Running its text with `currentScript`
 * pointed at the rendered element reproduces the parse-time execution.
 */
const runInlineScript = (dom: DomTestHarness) => {
  const script = dom.root.querySelector("script");
  if (!script) throw new Error("SidebarBody renders no inline script");
  Object.defineProperty(dom.document, "currentScript", { configurable: true, value: script });
  try {
    new Function(script.textContent ?? "")();
  } finally {
    Object.defineProperty(dom.document, "currentScript", { configurable: true, value: null });
  }
};

const mountSidebar = async (dom: DomTestHarness) => {
  const { default: AppWorkspace } = await import("../src/layout/AppWorkspace");
  const dispose = render(
    () => (
      <AppWorkspace.SidebarBody>
        <a href="/admin">Overview</a>
        <a href="/admin/observability/nats" aria-current="page">
          NATS
        </a>
      </AppWorkspace.SidebarBody>
    ),
    dom.root,
  );
  const body = dom.root.firstElementChild as HTMLElement;
  const current = body.querySelector<HTMLElement>('[aria-current="page"]');
  if (!current) throw new Error("current item missing");
  const scrollIntoView = spyOn(current, "scrollIntoView").mockImplementation(() => {});
  return { body, dispose, scrollIntoView };
};

describe("@k2b/ui AppWorkspace sidebar scroll memory", () => {
  if (isServer) {
    test.skip("runs in the dedicated browser-conditions test process", () => {});
    return;
  }

  test("restores the stored offset for the path segment and keeps the current item in view", async () => {
    const dom = createDomTestHarness();
    dom.window.location.href = "http://localhost/admin/observability/nats";
    dom.window.sessionStorage.setItem(STORAGE_KEY, "300");
    const { body, dispose, scrollIntoView } = await mountSidebar(dom);
    try {
      runInlineScript(dom);
      expect(body.scrollTop).toBe(300);
      expect(scrollIntoView).toHaveBeenCalledWith({ block: "nearest" });
    } finally {
      dispose();
      dom.cleanup();
    }
  });

  test("falls back to the current item and remembers later scrolling for the session", async () => {
    const dom = createDomTestHarness();
    dom.window.location.href = "http://localhost/admin/settings?tab=nats";
    const { body, dispose, scrollIntoView } = await mountSidebar(dom);
    try {
      runInlineScript(dom);
      expect(body.scrollTop).toBe(0);
      expect(scrollIntoView).toHaveBeenCalledWith({ block: "nearest" });
      body.scrollTop = 420;
      body.dispatchEvent(new Event("scroll"));
      body.scrollTop = 480;
      body.dispatchEvent(new Event("scroll"));
      await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
      expect(dom.window.sessionStorage.getItem(STORAGE_KEY)).toBe("480");
      expect(dom.window.localStorage.length).toBe(0);
    } finally {
      dispose();
      dom.cleanup();
    }
  });
});
