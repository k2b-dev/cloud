import { expect, spyOn, test } from "bun:test";
import { createComponent } from "solid-js";
import { isServer, render } from "solid-js/web";
import { createDomTestHarness, type DomTestHarness } from "../../../ui/test/dom";
import { PWA_CANVAS_COLORS, PWA_V2_HEAD_COLORS } from "../contracts/pwa";

// The v2 runtime shares its work with the v1 one (`pwa-runtime.ts`, covered by PwaRuntime.behavior.test.tsx); here
// only what it shows: v2 notices in the frame instead of toasts, and the status bar after a theme change.
const waitFor = async (condition: () => boolean, label: string) => {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (condition()) return;
    await Bun.sleep(5);
  }
  throw new Error(`Timed out waiting for ${label}`);
};

const load = async () => {
  const dom = createDomTestHarness();
  try {
    return { ui: await import("@k2b/ui"), PwaRuntimeV2: (await import("./PwaRuntimeV2.island")).default };
  } finally {
    dom.cleanup();
  }
};
const modules = isServer ? undefined : await load();

const mockRenew = (answers: Response[]) => {
  const spy = spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(async () => answers.shift() ?? Response.json({ renewed: false }), { preconnect: globalThis.fetch.preconnect }),
  );
  return () => spy.mockRestore();
};

const mount = (options: { keepalive: boolean; online?: boolean; renewedThisSession?: boolean }) => {
  const { ui, PwaRuntimeV2 } = modules!;
  const dom = createDomTestHarness();
  const state = { reloads: 0 };
  Object.defineProperty(dom.document, "visibilityState", { configurable: true, value: "visible" });
  Object.defineProperty(dom.window.navigator, "serviceWorker", { configurable: true, value: { register: async () => undefined } });
  Object.defineProperty(dom.window.navigator, "onLine", { configurable: true, value: options.online ?? true });
  Object.assign(dom.window.location, {
    reload: () => {
      state.reloads += 1;
    },
  });
  if (options.renewedThisSession) dom.window.sessionStorage.setItem("cloud.pwa.renewed", "1");
  dom.document.head.innerHTML = '<meta name="theme-color" content="#fafafa"><style data-cloud-canvas></style>';
  const frame = dom.document.createElement("div");
  frame.className = "k2-ui pwa-v2";
  dom.root.append(frame);
  const interval = spyOn(globalThis, "setInterval").mockImplementation((() => 0) as never);
  const dispose = render(
    () =>
      createComponent(ui.LocaleProvider, {
        locale: "en",
        get children() {
          return createComponent(PwaRuntimeV2, {
            keepalive: options.keepalive,
            accountId: "mia",
            builds: { inventory: "old" },
            cloud: "Example Cloud",
          });
        },
      }),
    frame,
  );
  return {
    dom,
    frame,
    state,
    notices: () => [...frame.querySelectorAll<HTMLElement>("[data-k2-part='NoticeStack'] > [data-k2-part='Notice']")],
    dispose: () => {
      dispose();
      interval.mockRestore();
      dom.cleanup();
    },
  };
};

const setVisibility = (dom: DomTestHarness, state: "visible" | "hidden") => {
  Object.defineProperty(dom.document, "visibilityState", { configurable: true, value: state });
  dom.window.document.dispatchEvent(new dom.window.Event("visibilitychange"));
};

if (isServer) test.skip("requires browser conditions", () => {});
else {
  test("shows a lasting offline notice in the frame while the phone is offline, and takes it away online", async () => {
    const restore = mockRenew([]);
    const page = mount({ keepalive: false, online: false });
    try {
      await waitFor(() => page.notices().length === 1, "offline notice");
      // it names what follows from being offline, as the app does it: the open page stays, loading and saving wait
      expect(page.notices()[0]!.textContent).toContain(
        "Offline – what was loaded stays visible; loading and saving work again once you're back online",
      );
      expect(page.notices()[0]!.getAttribute("data-tone")).toBe("warn");
      expect(page.dom.document.querySelector("[data-k2b-toast]")).toBeNull();
      page.dom.window.dispatchEvent(new page.dom.window.Event("online"));
      await waitFor(() => page.notices().length === 0, "notice gone");
      // Hidden, it stays away until the phone goes offline again.
      page.dom.window.dispatchEvent(new page.dom.window.Event("offline"));
      await waitFor(() => page.notices().length === 1, "offline again");
      [...page.notices()[0]!.querySelectorAll("button")].find((button) => button.textContent?.includes("Hide"))!.click();
      await waitFor(() => page.notices().length === 0, "offline notice hidden");
      page.dom.window.dispatchEvent(new page.dom.window.Event("online"));
      page.dom.window.dispatchEvent(new page.dom.window.Event("offline"));
      await waitFor(() => page.notices().length === 1, "offline once more");
    } finally {
      page.dispose();
      restore();
    }
  });

  test("offers Reload for a new version while text is being typed, and names another account once", async () => {
    const restore = mockRenew([Response.json({ renewed: false, builds: { inventory: "new" }, otherAccount: { name: "Max Beispiel" } })]);
    const page = mount({ keepalive: true, renewedThisSession: true });
    try {
      const field = page.dom.document.createElement("textarea");
      page.dom.document.body.append(field);
      field.focus();
      setVisibility(page.dom, "visible");
      await waitFor(() => page.notices().length === 2, "account and update notices");
      const [account, update] = page.notices();
      expect(account!.textContent).toContain("Chrome on this device is signed in to Example Cloud as Max Beispiel.");
      expect(update!.textContent).toContain("New version of Example Cloud");
      // a plain fact of the app, in the info tone
      expect(update!.getAttribute("data-tone")).toBe("info");
      expect(page.state.reloads).toBe(0);
      [...update!.querySelectorAll("button")].find((button) => button.textContent?.includes("Reload"))!.click();
      expect(page.state.reloads).toBe(1);
      // A notice that stays never holds the place above the tab bar: each one can be hidden.
      const hide = (notice: HTMLElement) => [...notice.querySelectorAll("button")].find((button) => button.textContent?.includes("Hide"))!;
      hide(account!).click();
      await waitFor(() => page.notices().length === 1, "account notice hidden");
      expect(page.notices()[0]!.textContent).toContain("New version of Example Cloud");
      hide(page.notices()[0]!).click();
      await waitFor(() => page.notices().length === 0, "update notice hidden");
    } finally {
      page.dispose();
      restore();
    }
  });

  test("after a theme change the status bar takes the head's colour on the phone and the canvas beside the rail", async () => {
    const restore = mockRenew([]);
    const page = mount({ keepalive: false });
    try {
      page.dom.document.documentElement.classList.add("dark");
      page.dom.window.dispatchEvent(new page.dom.window.Event("cloud:theme-preference"));
      const metas = [...page.dom.document.querySelectorAll('meta[name="theme-color"]')].map((meta) => [
        meta.getAttribute("media"),
        meta.getAttribute("content"),
      ]);
      expect(metas).toEqual([
        ["not all and (min-width: 768px)", PWA_V2_HEAD_COLORS.dark],
        ["(min-width: 768px)", PWA_CANVAS_COLORS.dark],
      ]);
      expect(page.dom.document.querySelector("style[data-cloud-canvas]")?.textContent).toContain(PWA_CANVAS_COLORS.dark);
    } finally {
      page.dispose();
      restore();
    }
  });
}
