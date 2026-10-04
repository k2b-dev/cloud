import { expect, spyOn, test } from "bun:test";
import { createComponent, type JSX } from "solid-js";
import { delegateEvents, isServer, render } from "solid-js/web";
import { createDomTestHarness, type DomTestHarness } from "../../../../ui/test/dom";

const SECRET = `${"A".repeat(42)}w`;

const waitFor = async (condition: () => boolean, label: string) => {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    if (condition()) return;
    await Bun.sleep(5);
  }
  throw new Error(`Timed out waiting for ${label}`);
};

type Route = (method: string, path: string, body: unknown) => Response | undefined;
const mockFetch = (route: Route) => {
  const calls: { method: string; path: string; body: unknown }[] = [];
  const spy = spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(
      async (input: string | URL | Request, init?: RequestInit) => {
        const path = new URL(String(input), "http://localhost/").pathname;
        const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
        calls.push({ method: init?.method ?? "GET", path, body });
        return route(init?.method ?? "GET", path, body) ?? Response.json({ code: "UNAVAILABLE", message: "" }, { status: 503 });
      },
      { preconnect: globalThis.fetch.preconnect },
    ),
  );
  return { calls, restore: () => spy.mockRestore() };
};

const load = async () => {
  const dom = createDomTestHarness();
  try {
    return {
      ui: await import("@k2b/ui"),
      PhoneSettings: (await import("./PhoneSettings.island")).default,
      Unavailable: (await import("./Unavailable.island")).default,
      PairingNotice: (await import("./PairingNotice.island")).default,
    };
  } finally {
    dom.cleanup();
  }
};
const modules = isServer ? undefined : await load();

type Mounted = { dom: DomTestHarness; replaced: string[]; reloads: number; dispose: () => void };
const mount = (view: () => JSX.Element, options: { url?: string; before?: (dom: DomTestHarness) => void } = {}): Mounted => {
  const { ui } = modules!;
  const dom = createDomTestHarness();
  delegateEvents(["click", "input"]);
  dom.window.history.replaceState(null, "", options.url ?? "/pwa/settings");
  const mounted: Mounted = { dom, replaced: [], reloads: 0, dispose: () => {} };
  Object.assign(dom.window.location, {
    replace: (url: string) => void mounted.replaced.push(url),
    reload: () => {
      mounted.reloads += 1;
    },
  });
  options.before?.(dom);
  const dispose = render(
    () =>
      createComponent(ui.LocaleProvider, {
        locale: "en",
        get children() {
          return view();
        },
      }),
    dom.root,
  );
  mounted.dispose = () => {
    dispose();
    ui.toast.dismissAll();
    dom.cleanup();
  };
  return mounted;
};
const button = (dom: DomTestHarness, label: string) =>
  [...dom.document.querySelectorAll("button")].find((element) => element.textContent?.trim() === label) as HTMLButtonElement | undefined;
const settings = () =>
  createComponent(modules!.PhoneSettings, { account: { name: "Mia Muster" }, theme: "light", name: "iPhone", cloud: "Example Cloud" });

if (isServer) test.skip("requires browser conditions", () => {});
else {
  test("Settings renames this phone, and saving needs a changed name", async () => {
    const fetch = mockFetch((method, path) =>
      method === "PATCH" && path === "/pwa/_auth/session" ? new Response(null, { status: 204 }) : undefined,
    );
    const page = mount(settings);
    try {
      const input = page.dom.document.querySelector<HTMLInputElement>('input[maxlength="80"]')!;
      expect(input.value).toBe("iPhone");
      expect(button(page.dom, "Save")!.disabled).toBe(true);
      input.value = "  Mia's iPhone  ";
      input.dispatchEvent(new Event("input", { bubbles: true }));
      button(page.dom, "Save")!.click();
      await waitFor(() => page.dom.document.body.textContent?.includes("Name saved") ?? false, "saved");
      expect(fetch.calls).toEqual([{ method: "PATCH", path: "/pwa/_auth/session", body: { name: "Mia's iPhone" } }]);
      expect(button(page.dom, "Save")!.disabled).toBe(true);
    } finally {
      page.dispose();
      fetch.restore();
    }
  });

  test("Settings reloads once when the phone is no longer paired", async () => {
    const fetch = mockFetch(() => Response.json({ code: "UNPAIRED", message: "" }, { status: 401 }));
    const page = mount(settings);
    try {
      const input = page.dom.document.querySelector<HTMLInputElement>('input[maxlength="80"]')!;
      input.value = "Work phone";
      input.dispatchEvent(new Event("input", { bubbles: true }));
      button(page.dom, "Save")!.click();
      await waitFor(() => page.reloads === 1, "reload");
    } finally {
      page.dispose();
      fetch.restore();
    }
  });

  test("Settings switches the appearance, which repaints the status bar, and the language, which reloads", async () => {
    const page = mount(settings);
    let repaints = 0;
    page.dom.window.addEventListener("cloud:theme-preference", () => {
      repaints += 1;
    });
    try {
      const dark = [...page.dom.document.querySelectorAll<HTMLButtonElement>('[role="radio"]')].find((radio) =>
        radio.textContent?.includes("Dark"),
      )!;
      dark.click();
      await waitFor(() => repaints === 1, "repaint");
      expect(page.dom.document.documentElement.classList.contains("dark")).toBe(true);
      expect(page.dom.document.cookie).toContain("theme=dark");
      const german = [...page.dom.document.querySelectorAll<HTMLButtonElement>('[role="radio"]')].find((radio) =>
        radio.textContent?.includes("Deutsch"),
      )!;
      german.click();
      await waitFor(() => page.reloads === 1, "reload in German");
      expect(page.dom.document.cookie).toContain("cloud.locale=de");
    } finally {
      page.dispose();
    }
  });

  test("Settings signs the phone out after a confirmation and opens the pairing view", async () => {
    const fetch = mockFetch((method, path) =>
      method === "DELETE" && path === "/pwa/_auth/session" ? new Response(null, { status: 204 }) : undefined,
    );
    const page = mount(settings);
    try {
      const start = page.dom.window.history.length;
      button(page.dom, "Sign out of the app")!.click();
      await waitFor(() => !!page.dom.document.querySelector("dialog"), "confirmation");
      // Back closes the confirmation instead of leaving Settings.
      expect(page.dom.window.history.length).toBe(start + 1);
      expect(page.dom.document.querySelector("dialog")?.textContent).toContain("pair it with Example Cloud on the web");
      const confirm = [...page.dom.document.querySelectorAll<HTMLButtonElement>("dialog button")].find(
        (element) => element.textContent?.trim() === "Sign out of the app",
      )!;
      confirm.click();
      await waitFor(() => page.replaced.length === 1, "pairing view");
      expect(page.replaced).toEqual(["/pwa/"]);
      expect(fetch.calls).toEqual([{ method: "DELETE", path: "/pwa/_auth/session", body: undefined }]);
    } finally {
      page.dispose();
      fetch.restore();
    }
  });

  test("the unavailable state renews once on its own and returns to Start, but never loops", async () => {
    const fetch = mockFetch((_method, path) => (path === "/pwa/_auth/session/renew" ? Response.json({ renewed: true }) : undefined));
    let page = mount(() => createComponent(modules!.Unavailable, {}), { url: "/pwa/?pwa=unavailable" });
    try {
      await waitFor(() => page.replaced.length === 1, "Start");
      expect(page.replaced).toEqual(["/pwa/"]);
      const marker = page.dom.window.sessionStorage.getItem("cloud.pwa.unavailable-retry")!;
      page.dispose();
      page = mount(() => createComponent(modules!.Unavailable, {}), {
        url: "/pwa/?pwa=unavailable",
        before: (dom) => dom.window.sessionStorage.setItem("cloud.pwa.unavailable-retry", marker),
      });
      await waitFor(() => fetch.calls.length === 2, "second renewal");
      await Bun.sleep(20);
      expect(page.replaced).toEqual([]);
      button(page.dom, "Try again")!.click();
      expect(page.replaced).toEqual(["/pwa/"]);
    } finally {
      page.dispose();
      fetch.restore();
    }
  });

  test("a connected app explains why a pairing link does not pair again; other pages just drop it", async () => {
    let page = mount(() => createComponent(modules!.PairingNotice, { name: "Mia Muster" }), { url: `/pwa/#pair=${SECRET}` });
    try {
      expect(page.dom.window.location.href).toBe("http://localhost/pwa/");
      await waitFor(() => page.dom.document.body.textContent?.includes("already connected as Mia Muster") ?? false, "notice");
    } finally {
      page.dispose();
    }
    page = mount(() => createComponent(modules!.PairingNotice, {}), { url: `/pwa/?pwa=blocked#pair=${SECRET}` });
    try {
      expect(page.dom.window.location.href).toBe("http://localhost/pwa/?pwa=blocked");
      await Bun.sleep(20);
      expect(page.dom.document.querySelector("[data-k2b-toast]")).toBeNull();
    } finally {
      page.dispose();
    }
  });
}
