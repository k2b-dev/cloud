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
    url?: string;
    online?: boolean;
    renewedThisSession?: boolean;
    before?: (dom: DomTestHarness) => void;
  } = {},
): Harness => {
  const { ui, PwaRuntime } = modules!;
  const dom = createDomTestHarness();
  options.before?.(dom);
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
          return createComponent(PwaRuntime, { keepalive: options.keepalive ?? true, cloud: "Example Cloud" });
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

  test("reloads once when the phone is no longer paired and opens the blocked state for a blocked account", async () => {
    const unpaired = mockRenew([Response.json({ code: "UNPAIRED", message: "" }, { status: 401 })]);
    let harness = mount();
    try {
      await waitFor(() => harness.reloads === 1, "reload");
      expect(harness.replaced).toEqual([]);
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
