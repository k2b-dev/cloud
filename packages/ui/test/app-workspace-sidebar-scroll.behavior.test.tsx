import { describe, expect, spyOn, test } from "bun:test";
import { isServer, render } from "solid-js/web";
import { createDomTestHarness, type DomTestHarness } from "./dom";

const STORAGE_KEY = "k2b-sidebar-scroll:/admin/settings:1";

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

const mountSidebar = async (dom: DomTestHarness, current: "page" | "true" = "page", scrollPreserveKey?: string | false) => {
  const { default: AppWorkspace } = await import("../src/layout/AppWorkspace");
  const scrollIntoView = spyOn(HTMLElement.prototype, "scrollIntoView").mockImplementation(() => {});
  const unmount = render(
    () => (
      <AppWorkspace.SidebarBody scrollPreserveKey={scrollPreserveKey}>
        <a href="/admin">Overview</a>
        <a href="/admin/observability/nats" aria-current={current}>
          NATS
        </a>
      </AppWorkspace.SidebarBody>
    ),
    dom.root,
  );
  const body = dom.root.firstElementChild as HTMLElement;
  const item = body.querySelector<HTMLElement>(`[aria-current="${current}"]`);
  if (!item) throw new Error("current item missing");
  const dispose = () => {
    unmount();
    scrollIntoView.mockRestore();
  };
  return { body, dispose, scrollIntoView };
};

describe("@k2b/ui AppWorkspace sidebar scroll memory", () => {
  if (isServer) {
    test.skip("runs in the dedicated browser-conditions test process", () => {});
    return;
  }

  test("restores the stored offset for the page path and keeps the current item in view", async () => {
    const dom = createDomTestHarness();
    dom.window.location.href = "http://localhost/admin/observability/nats";
    dom.window.sessionStorage.setItem("k2b-sidebar-scroll:/admin/observability/nats:1", "300");
    const { body, dispose, scrollIntoView } = await mountSidebar(dom);
    try {
      body.scrollTop = 0;
      scrollIntoView.mockClear();
      runInlineScript(dom);
      expect(body.scrollTop).toBe(300);
      expect(scrollIntoView).toHaveBeenCalledWith({ block: "nearest" });
    } finally {
      dispose();
      dom.cleanup();
    }
  });

  test("on a page deeper than the sidebar lists, keeps the item that contains it in view", async () => {
    const dom = createDomTestHarness();
    dom.window.location.href = "http://localhost/admin/observability/nats/streams";
    const { dispose, scrollIntoView } = await mountSidebar(dom, "true");
    try {
      scrollIntoView.mockClear();
      runInlineScript(dom);
      expect(scrollIntoView).toHaveBeenCalledWith({ block: "nearest" });
    } finally {
      dispose();
      dom.cleanup();
    }
  });

  for (const scrollPreserveKey of [undefined, "mail-sidebar-A"] as const) {
    test(`scroll events store nothing; pagehide remembers the offset for ${scrollPreserveKey ?? "the page path"} only for the session`, async () => {
      const dom = createDomTestHarness();
      dom.window.location.href = "http://localhost/admin/settings?tab=nats";
      const storageKey = scrollPreserveKey ? `k2b-sidebar-scroll:${scrollPreserveKey}:1` : STORAGE_KEY;
      const { body, dispose, scrollIntoView } = await mountSidebar(dom, "page", scrollPreserveKey);
      try {
        scrollIntoView.mockClear();
        runInlineScript(dom);
        expect(body.scrollTop).toBe(0);
        expect(scrollIntoView).toHaveBeenCalledWith({ block: "nearest" });
        body.scrollTop = 420;
        body.dispatchEvent(new Event("scroll"));
        body.scrollTop = 480;
        body.dispatchEvent(new Event("scroll"));
        await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
        expect(dom.window.sessionStorage.getItem(storageKey)).toBeNull();
        dom.window.dispatchEvent(new dom.window.Event("pagehide"));
        expect(dom.window.sessionStorage.getItem(storageKey)).toBe("480");
        expect(dom.window.localStorage.length).toBe(0);
      } finally {
        dispose();
        dom.cleanup();
      }
    });
  }

  for (const scrollPreserveKey of [undefined, false] as const) {
    test(`unkeyed sidebars (${String(scrollPreserveKey)}) on different paths with the same first segment keep separate offsets`, async () => {
      const dom = createDomTestHarness();
      try {
        dom.window.location.href = "http://localhost/app/notebooks/x";
        const notebooks = await mountSidebar(dom, "page", scrollPreserveKey);
        try {
          runInlineScript(dom);
          notebooks.body.scrollTop = 300;
          dom.window.dispatchEvent(new dom.window.Event("pagehide"));
        } finally {
          notebooks.dispose();
        }

        dom.window.location.href = "http://localhost/app/mail/y";
        const mail = await mountSidebar(dom, "page", scrollPreserveKey);
        try {
          expect(mail.body.scrollTop).toBe(0);
          runInlineScript(dom);
          expect(mail.body.scrollTop).toBe(0);
        } finally {
          mail.dispose();
        }
      } finally {
        dom.cleanup();
      }
    });
  }

  test("an unkeyed sidebar that survives a path change remembers and restores the current path's offset", async () => {
    const dom = createDomTestHarness();
    try {
      dom.window.location.href = "http://localhost/app/notebooks/x/notes/a";
      const noteA = await mountSidebar(dom);
      try {
        runInlineScript(dom);
        dom.window.history.pushState(null, "", "/app/notebooks/x/notes/b");
        expect(dom.window.location.pathname).toBe("/app/notebooks/x/notes/b");
        noteA.body.scrollTop = 300;
        dom.window.dispatchEvent(new dom.window.Event("pagehide"));
        expect(dom.window.sessionStorage.getItem("k2b-sidebar-scroll:/app/notebooks/x/notes/b:1")).toBe("300");
        expect(dom.window.sessionStorage.getItem("k2b-sidebar-scroll:/app/notebooks/x/notes/a:1")).toBeNull();
      } finally {
        noteA.dispose();
      }

      const noteB = await mountSidebar(dom);
      try {
        expect(noteB.body.scrollTop).toBe(300);
        noteB.body.scrollTop = 0;
        runInlineScript(dom);
        expect(noteB.body.scrollTop).toBe(300);
      } finally {
        noteB.dispose();
      }
    } finally {
      dom.cleanup();
    }
  });

  test("a keyed sidebar restores across paths without sharing its offset with another key", async () => {
    const dom = createDomTestHarness();
    try {
      dom.window.location.href = "http://localhost/app/mail/A?view=inbox";
      const inbox = await mountSidebar(dom, "page", "mail-sidebar-A");
      try {
        runInlineScript(dom);
        inbox.body.scrollTop = 300;
        dom.window.dispatchEvent(new dom.window.Event("pagehide"));
      } finally {
        inbox.dispose();
      }

      for (const [key, offset] of [
        ["mail-sidebar-A", 300],
        ["mail-sidebar-B", 0],
      ] as const) {
        dom.window.location.href = "http://localhost/app/mail/A/conversations/1";
        const conversation = await mountSidebar(dom, "page", key);
        try {
          expect(conversation.body.scrollTop).toBe(offset);
          conversation.body.scrollTop = 0;
          runInlineScript(dom);
          expect(conversation.body.scrollTop).toBe(offset);
        } finally {
          conversation.dispose();
        }
      }
    } finally {
      dom.cleanup();
    }
  });

  test("a client mount restores the offset and keeps the current item in view without running the inline script", async () => {
    const dom = createDomTestHarness();
    dom.window.location.href = "http://localhost/admin/settings";
    dom.window.sessionStorage.setItem(STORAGE_KEY, "300");
    const { body, dispose, scrollIntoView } = await mountSidebar(dom);
    try {
      expect(body.scrollTop).toBe(300);
      expect(scrollIntoView).toHaveBeenCalledWith({ block: "nearest" });
    } finally {
      dispose();
      dom.cleanup();
    }
  });

  test("restore scrolls never overwrite the stored offset", async () => {
    const dom = createDomTestHarness();
    dom.window.location.href = "http://localhost/admin/settings";
    dom.window.sessionStorage.setItem(STORAGE_KEY, "300");
    const { body, dispose } = await mountSidebar(dom);
    try {
      runInlineScript(dom);
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      // Layout can clamp a restored offset before the document is complete.
      body.scrollTop = 20;
      body.dispatchEvent(new Event("scroll"));
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      expect(dom.window.sessionStorage.getItem(STORAGE_KEY)).toBe("300");
    } finally {
      dispose();
      dom.cleanup();
    }
  });

  test("disposing a client body removes its pagehide listener", async () => {
    const dom = createDomTestHarness();
    dom.window.location.href = "http://localhost/admin/settings";
    dom.window.sessionStorage.setItem(STORAGE_KEY, "300");
    const { body, dispose } = await mountSidebar(dom);
    dispose();
    try {
      // Reconnection must not revive the disposed component's listener.
      dom.root.append(body);
      body.scrollTop = 20;
      dom.window.dispatchEvent(new dom.window.Event("pagehide"));
      expect(dom.window.sessionStorage.getItem(STORAGE_KEY)).toBe("300");
    } finally {
      dom.cleanup();
    }
  });

  test("pagehide ignores a detached server body after the client body is disposed", async () => {
    const dom = createDomTestHarness();
    dom.window.location.href = "http://localhost/admin/settings";
    dom.window.sessionStorage.setItem(STORAGE_KEY, "300");
    const { body, dispose } = await mountSidebar(dom);
    runInlineScript(dom);
    dispose();
    try {
      expect(body.isConnected).toBe(false);
      body.scrollTop = 20;
      dom.window.dispatchEvent(new dom.window.Event("pagehide"));
      expect(dom.window.sessionStorage.getItem(STORAGE_KEY)).toBe("300");
    } finally {
      dom.cleanup();
    }
  });
});
