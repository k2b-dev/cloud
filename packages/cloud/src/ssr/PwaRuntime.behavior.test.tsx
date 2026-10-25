import { expect, spyOn, test } from "bun:test";
import { createComponent } from "solid-js";
import { isServer, render } from "solid-js/web";
import { createDomTestHarness, type DomTestHarness } from "../../../ui/test/dom";

const waitFor = async (condition: () => boolean, label: string) => {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (condition()) return;
    await Bun.sleep(5);
  }
  throw new Error(`Timed out waiting for ${label}`);
};

type Answer = Response | Promise<Response> | "offline";
const mockRenew = (answers: Answer[]) => {
  const calls: string[] = [];
  const spy = spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(
      async (input: string | URL | Request, init?: RequestInit) => {
        calls.push(`${init?.method ?? "GET"} ${String(input)}`);
        const answer = answers.shift() ?? Response.json({ renewed: false });
        if (answer === "offline") throw new TypeError("Failed to fetch");
        return answer;
      },
      { preconnect: globalThis.fetch.preconnect },
    ),
  );
  return { calls, restore: () => spy.mockRestore() };
};

const load = async () => {
  const dom = createDomTestHarness();
  try {
    return { ui: await import("@k2b/ui"), PwaRuntime: (await import("./PwaRuntime.island")).default };
  } finally {
    dom.cleanup();
  }
};
const modules = isServer ? undefined : await load();

type Harness = {
  dom: DomTestHarness;
  registrations: unknown[][];
  reloads: number;
  replaced: string[];
  intervals: (() => void)[];
  dispose: () => void;
};

const mount = (
  options: {
    keepalive?: boolean;
    builds?: Record<string, string>;
    rememberAddress?: boolean;
    url?: string;
    online?: boolean;
    renewedThisSession?: boolean;
    before?: (dom: DomTestHarness) => void;
  } = {},
): Harness => {
  const { ui, PwaRuntime } = modules!;
  const dom = createDomTestHarness();
  options.before?.(dom);
  Object.defineProperty(dom.document, "visibilityState", { configurable: true, value: "visible" });
  if (options.url) dom.window.history.replaceState(null, "", options.url);
  if (options.renewedThisSession) dom.window.sessionStorage.setItem("cloud.pwa.renewed", "1");
  const harness: Harness = { dom, registrations: [], reloads: 0, replaced: [], intervals: [], dispose: () => {} };
  Object.defineProperty(dom.window.navigator, "serviceWorker", {
    configurable: true,
    value: { register: async (...args: unknown[]) => void harness.registrations.push(args) },
  });
  Object.defineProperty(dom.window.navigator, "onLine", { configurable: true, value: options.online ?? true });
  Object.assign(dom.window.location, {
    reload: () => {
      harness.reloads += 1;
    },
    replace: (url: string) => void harness.replaced.push(url),
  });
  const interval = spyOn(globalThis, "setInterval").mockImplementation(((callback: () => void) => {
    harness.intervals.push(callback);
    return 0;
  }) as never);
  const dispose = render(
    () =>
      createComponent(ui.LocaleProvider, {
        locale: "en",
        get children() {
          return createComponent(PwaRuntime, {
            keepalive: options.keepalive ?? true,
            accountId: "mia",
            rememberAddress: options.rememberAddress ? { cookie: "pwa_last_address", maxAge: 12960000 } : undefined,
            builds: options.builds ?? { inventory: "old", core: "core-old" },
            cloud: "Example Cloud",
          });
        },
      }),
    dom.root,
  );
  harness.dispose = () => {
    dispose();
    interval.mockRestore();
    ui.toast.dismissAll();
    dom.cleanup();
  };
  return harness;
};

const setVisibility = (dom: DomTestHarness, state: "visible" | "hidden") => {
  Object.defineProperty(dom.document, "visibilityState", { configurable: true, value: state });
  dom.window.document.dispatchEvent(new dom.window.Event("visibilitychange"));
};

if (isServer) test.skip("requires browser conditions", () => {});
else {
  test("remembers the place when a page arrives and when the app leaves the foreground, without fragments or welcome states", () => {
    const page = mount({
      renewedThisSession: true,
      rememberAddress: true,
      before: (dom) => dom.window.happyDOM.setURL("https://cloud.example.test/pwa/spaces"),
    });
    const remembered = () => decodeURIComponent(/pwa_last_address=([^;]*)/.exec(page.dom.document.cookie)?.[1] ?? "");
    try {
      expect(remembered()).toBe("/pwa/spaces");
      // A part keeps a selection in the address without a page load.
      page.dom.window.history.pushState(null, "", "/pwa/spaces/demo/task?view=mine#ignored");
      setVisibility(page.dom, "hidden");
      expect(remembered()).toBe("/pwa/spaces/demo/task?view=mine");
      setVisibility(page.dom, "visible");
      page.dom.window.history.pushState(null, "", "/pwa/?pwa=ended");
      setVisibility(page.dom, "hidden");
      expect(remembered()).toBe("/pwa/spaces/demo/task?view=mine");
    } finally {
      page.dispose();
    }
  });

  test("a page being left never writes over the next page's address or a sign-out's deletion", () => {
    const page = mount({
      renewedThisSession: true,
      rememberAddress: true,
      before: (dom) => dom.window.happyDOM.setURL("https://cloud.example.test/pwa/spaces/demo/task"),
    });
    const remembered = () => decodeURIComponent(/pwa_last_address=([^;]*)/.exec(page.dom.document.cookie)?.[1] ?? "");
    // happy-dom ignores `persisted` in the event's options, so it is set on the event.
    const transition = (type: "pagehide" | "pageshow", persisted: boolean) =>
      page.dom.window.dispatchEvent(Object.defineProperty(new page.dom.window.Event(type), "persisted", { value: persisted }));
    const leave = () => {
      transition("pagehide", false);
      setVisibility(page.dom, "hidden");
    };
    try {
      // The next page's response has set its address before this document fires its leaving events.
      page.dom.document.cookie = `pwa_last_address=${encodeURIComponent("/pwa/chat")}; Path=/pwa/; Secure`;
      leave();
      expect(remembered()).toBe("/pwa/chat");
      // A sign-out answer deleted the cookie; leaving does not bring it back.
      page.dom.document.cookie = "pwa_last_address=; Path=/pwa/; Max-Age=0; Secure";
      leave();
      expect(remembered()).toBe("");
      // A page restored from the back-forward cache is current again.
      setVisibility(page.dom, "visible");
      transition("pageshow", true);
      expect(remembered()).toBe("/pwa/spaces/demo/task");
    } finally {
      page.dispose();
    }
  });
  test("reloads the same address on foreground when its owner or Core changed, with no unsaved text", async () => {
    for (const builds of [
      { inventory: "new", core: "core-old" },
      { inventory: "old", core: "core-new" },
    ]) {
      const fetch = mockRenew([Response.json({ renewed: false, builds })]);
      const page = mount({ url: "/pwa/inventory/item?view=mine", renewedThisSession: true });
      try {
        setVisibility(page.dom, "hidden");
        setVisibility(page.dom, "visible");
        await waitFor(() => page.reloads === 1, "safe foreground reload");
        expect(page.dom.window.location.pathname + page.dom.window.location.search).toBe("/pwa/inventory/item?view=mine");
      } finally {
        page.dispose();
        fetch.restore();
      }
    }
  });

  test("does nothing when versions match, another part changes, or the owner is temporarily absent", async () => {
    for (const builds of [{ inventory: "old", core: "core-old", spaces: "new" }, { core: "core-old" }]) {
      const fetch = mockRenew([Response.json({ renewed: false, builds })]);
      const page = mount({ renewedThisSession: true });
      try {
        setVisibility(page.dom, "visible");
        await waitFor(() => fetch.calls.length === 1, "renewal");
        await Bun.sleep(20);
        expect(page.reloads).toBe(0);
        expect(page.dom.document.body.textContent).not.toContain("New version of Example Cloud");
      } finally {
        page.dispose();
        fetch.restore();
      }
    }
  });

  test("offers a persistent reload action for focused text, stored drafts, and blurred unsaved input", async () => {
    for (const mode of ["focused", "draft", "edited", "number focused", "date edited"]) {
      const fetch = mockRenew([Response.json({ renewed: false, builds: { inventory: "new" } })]);
      const page = mount({ renewedThisSession: true });
      try {
        // Numbers, dates and times are typed input too.
        const input =
          mode.startsWith("number") || mode.startsWith("date")
            ? page.dom.document.createElement("input")
            : page.dom.document.createElement("textarea");
        if (mode.startsWith("number")) input.setAttribute("type", "number");
        if (mode.startsWith("date")) input.setAttribute("type", "date");
        page.dom.document.body.append(input);
        if (mode.endsWith("focused")) input.focus();
        if (mode === "draft") page.dom.window.localStorage.setItem("cloud.pwa.draft:mia:chat", "unfinished");
        if (mode.endsWith("edited")) {
          input.value = mode.startsWith("date") ? "2026-10-24" : "unfinished";
          input.dispatchEvent(new Event("input", { bubbles: true }));
          input.blur();
        }
        setVisibility(page.dom, "visible");
        await waitFor(() => page.dom.document.body.textContent?.includes("New version of Example Cloud") ?? false, "update notice");
        expect(page.reloads).toBe(0);
        const notice = page.dom.document.querySelector("[data-k2b-toast]")!;
        expect(notice.textContent).toContain("Reload");
        const reload = [...notice.querySelectorAll("button")].find((button) => button.textContent === "Reload")!;
        reload.click();
        expect(page.reloads).toBe(1);
        if (mode === "draft") expect(page.dom.window.localStorage.getItem("cloud.pwa.draft:mia:chat")).toBe("unfinished");
      } finally {
        page.dispose();
        fetch.restore();
      }
    }
  });

  test("re-checks focus after renewal, and never reloads in the background or on the hourly timer", async () => {
    let release!: (response: Response) => void;
    const fetch = mockRenew([
      new Promise<Response>((resolve) => {
        release = resolve;
      }),
    ]);
    const page = mount({ renewedThisSession: true });
    try {
      setVisibility(page.dom, "visible");
      await waitFor(() => fetch.calls.length === 1, "renewal started");
      const input = page.dom.document.createElement("input");
      page.dom.document.body.append(input);
      input.focus();
      release(Response.json({ renewed: false, builds: { inventory: "new" } }));
      await waitFor(() => page.dom.document.body.textContent?.includes("New version of Example Cloud") ?? false, "notice after focus");
      expect(page.reloads).toBe(0);
    } finally {
      page.dispose();
      fetch.restore();
    }
    const hourly = mockRenew([Response.json({ renewed: false, builds: { inventory: "new" } })]);
    const later = mount({ renewedThisSession: true });
    try {
      later.intervals[0]!();
      await waitFor(() => later.dom.document.body.textContent?.includes("New version of Example Cloud") ?? false, "hourly notice");
      expect(later.reloads).toBe(0);
    } finally {
      later.dispose();
      hourly.restore();
    }
  });

  test("an address that names an ended pairing deletes no drafts: only the launch's answer does", async () => {
    const page = mount({
      keepalive: false,
      url: "/pwa/?pwa=ended",
      before: (dom) => dom.window.localStorage.setItem("cloud.pwa.draft:mia:chat", "old"),
    });
    try {
      expect(page.dom.window.localStorage.getItem("cloud.pwa.draft:mia:chat")).toBe("old");
    } finally {
      page.dispose();
    }
  });
  test("registers the app's service worker for /pwa/ and removes the launch marker from the address", async () => {
    const fetch = mockRenew([]);
    const harness = mount({ url: "/pwa/inventory?view=open&pwa_launch=1#top" });
    try {
      await waitFor(() => harness.registrations.length === 1, "registration");
      expect(harness.registrations[0]).toEqual(["/pwa/sw.js", { scope: "/pwa/", updateViaCache: "none" }]);
      expect(harness.dom.window.location.pathname + harness.dom.window.location.search + harness.dom.window.location.hash).toBe(
        "/pwa/inventory?view=open#top",
      );
    } finally {
      harness.dispose();
      fetch.restore();
    }
  });

  test("renews on the first page of a browsing session only, on every return to the foreground, and hourly while visible", async () => {
    const first = mockRenew([]);
    let harness = mount();
    try {
      await waitFor(() => first.calls.length === 1, "first renewal");
      expect(first.calls[0]).toBe("POST /pwa/_auth/session/renew");
      expect(harness.dom.window.sessionStorage.getItem("cloud.pwa.renewed")).toBe("1");
    } finally {
      harness.dispose();
      first.restore();
    }

    const later = mockRenew([]);
    harness = mount({ renewedThisSession: true });
    try {
      await Bun.sleep(20);
      expect(later.calls).toEqual([]);
      setVisibility(harness.dom, "visible");
      await waitFor(() => later.calls.length === 1, "foreground renewal");
      await Bun.sleep(20);
      setVisibility(harness.dom, "hidden");
      expect(harness.intervals).toHaveLength(1);
      harness.intervals[0]!();
      await Bun.sleep(20);
      expect(later.calls).toHaveLength(1);
      setVisibility(harness.dom, "visible");
      await waitFor(() => later.calls.length === 2, "foreground renewal again");
      // A trigger while a renewal runs joins it.
      await Bun.sleep(20);
      harness.intervals[0]!();
      await waitFor(() => later.calls.length === 3, "hourly renewal");
    } finally {
      harness.dispose();
      later.restore();
    }
  });

  test("runs one renewal at a time and calls once more after a rotation", async () => {
    let release!: (response: Response) => void;
    const pending = new Promise<Response>((resolve) => {
      release = resolve;
    });
    const fetch = mockRenew([pending, Response.json({ renewed: false })]);
    const harness = mount();
    try {
      await waitFor(() => fetch.calls.length === 1, "first renewal");
      setVisibility(harness.dom, "visible");
      setVisibility(harness.dom, "visible");
      await Bun.sleep(20);
      expect(fetch.calls).toHaveLength(1);
      release(Response.json({ renewed: true }));
      await waitFor(() => fetch.calls.length === 2, "confirming renewal");
      await Bun.sleep(20);
      expect(fetch.calls).toHaveLength(2);
    } finally {
      harness.dispose();
      fetch.restore();
    }
  });

  test("a removed device during the rotation confirmation clears drafts and never triggers an update reload", async () => {
    const fetch = mockRenew([
      Response.json({ renewed: true, builds: { inventory: "new" } }),
      Response.json({ code: "UNPAIRED" }, { status: 401 }),
    ]);
    const page = mount({ renewedThisSession: true, before: (dom) => dom.window.localStorage.setItem("cloud.pwa.draft:mia:chat", "hello") });
    try {
      setVisibility(page.dom, "visible");
      await waitFor(() => page.replaced.length === 1, "removed device");
      expect(page.dom.window.localStorage.length).toBe(0);
      expect(page.reloads).toBe(0);
      expect(page.dom.document.body.textContent).not.toContain("New version of Example Cloud");
    } finally {
      page.dispose();
      fetch.restore();
    }
  });

  test("opens the signed-out pairing view when the phone is no longer paired, and the blocked state for a blocked account", async () => {
    const unpaired = mockRenew([Response.json({ code: "UNPAIRED", message: "" }, { status: 401 })]);
    let harness = mount({
      before: (dom) => {
        dom.window.localStorage.setItem("cloud.pwa.draft:mia:chat", "hello");
      },
    });
    try {
      await waitFor(() => harness.replaced.length === 1, "signed-out state");
      expect(harness.dom.window.localStorage.length).toBe(0);
      expect(harness.replaced).toEqual(["/pwa/?pwa=ended"]);
      expect(harness.reloads).toBe(0);
    } finally {
      harness.dispose();
      unpaired.restore();
    }

    const blocked = mockRenew([Response.json({ code: "ACCOUNT_BLOCKED", message: "" }, { status: 403 })]);
    harness = mount();
    try {
      await waitFor(() => harness.replaced.length === 1, "blocked state");
      expect(harness.replaced).toEqual(["/pwa/?pwa=blocked"]);
      expect(harness.reloads).toBe(0);
    } finally {
      harness.dispose();
      blocked.restore();
    }
  });

  test("leaves the page alone when Cloud is unreachable or unavailable", async () => {
    const fetch = mockRenew(["offline", Response.json({ code: "UNAVAILABLE", message: "" }, { status: 503 })]);
    const harness = mount();
    try {
      await waitFor(() => fetch.calls.length === 1, "first renewal");
      await Bun.sleep(20);
      setVisibility(harness.dom, "visible");
      await waitFor(() => fetch.calls.length === 2, "second renewal");
      await Bun.sleep(20);
      expect([harness.reloads, harness.replaced]).toEqual([0, []]);
    } finally {
      harness.dispose();
      fetch.restore();
    }
  });

  test("tells the person once when Chrome on the phone is signed in to another account", async () => {
    const fetch = mockRenew([Response.json({ renewed: false, otherAccount: { name: "Max Beispiel" } })]);
    const harness = mount();
    try {
      await waitFor(() => harness.dom.document.body.textContent?.includes("as Max Beispiel") ?? false, "notice");
      expect(harness.dom.document.body.textContent).toContain(
        "Chrome on this phone is signed in to Example Cloud as Max Beispiel. Changes in the app may be saved to that account.",
      );
    } finally {
      harness.dispose();
      fetch.restore();
    }
  });

  test("shows a lasting offline notice while the phone is offline, and no keepalive without a person", async () => {
    const fetch = mockRenew([]);
    const harness = mount({ keepalive: false, online: false });
    try {
      await waitFor(() => harness.dom.document.body.textContent?.includes("You're offline") ?? false, "offline notice");
      harness.dom.window.dispatchEvent(new harness.dom.window.Event("online"));
      await waitFor(() => !harness.dom.document.querySelector("[data-k2b-toast]:not([data-closing])"), "notice dismissed");
      harness.dom.window.dispatchEvent(new harness.dom.window.Event("offline"));
      await waitFor(() => harness.dom.document.body.textContent?.includes("You're offline") ?? false, "offline again");
      setVisibility(harness.dom, "visible");
      await Bun.sleep(20);
      expect(fetch.calls).toEqual([]);
      expect(harness.intervals).toEqual([]);
    } finally {
      harness.dispose();
      fetch.restore();
    }
  });

  test("measures the server-rendered shell and repaints the status bar after a theme change", async () => {
    const fetch = mockRenew([]);
    const harness = mount({
      keepalive: false,
      before: (dom) => {
        dom.document.head.innerHTML = '<meta name="theme-color" content="#fafafa">';
        dom.document.body.insertAdjacentHTML(
          "afterbegin",
          '<div class="k2b-mobile-shell"><header></header><main class="k2b-mobile-shell__main"><div class="k2b-mobile-shell__body"></div></main><nav></nav></div>',
        );
      },
    });
    try {
      await waitFor(() => harness.dom.document.body.style.getPropertyValue("--k2b-mobile-shell-footer-height") !== "", "footer height");
      harness.dom.document.body.style.backgroundColor = "rgb(9, 13, 18)";
      harness.dom.window.dispatchEvent(new harness.dom.window.Event("cloud:theme-preference"));
      expect(harness.dom.document.querySelector('meta[name="theme-color"]')?.getAttribute("content")).toBe("rgb(9, 13, 18)");
      expect(harness.dom.document.documentElement.style.backgroundColor).toBe("rgb(9, 13, 18)");
    } finally {
      harness.dispose();
      fetch.restore();
    }
  });
}
