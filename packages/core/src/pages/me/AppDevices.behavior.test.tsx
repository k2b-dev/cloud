import { expect, spyOn, test } from "bun:test";
import { createComponent } from "solid-js";
import { delegateEvents, isServer, render } from "solid-js/web";
import { createDomTestHarness, type DomTestHarness } from "../../../../ui/test/dom";

const SECRET = `${"A".repeat(42)}w`;
const PAIRING = "8f0b3c39-4a7e-4a37-9bdb-1f0f6b0b8f11";
const PHONE = "2c8b3f2e-6e5b-4c43-8b84-5f0c0e3e1a77";
const OTHER = "4d2f6a14-3c55-4a2b-9e0e-9c2a8c6f0d22";
const devices = [
  {
    id: PHONE,
    name: "iPhone",
    platform: "ios",
    createdAt: "2026-09-01T10:00:00.000Z",
    lastUsedAt: "2026-09-02T10:00:00.000Z",
    current: true,
  },
  {
    id: OTHER,
    name: "Android",
    platform: "android",
    createdAt: "2026-09-01T10:00:00.000Z",
    lastUsedAt: new Date().toISOString(),
    current: false,
  },
] as const;

const waitFor = async (condition: () => boolean, label: string) => {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (condition()) return;
    await Bun.sleep(10);
  }
  throw new Error(`Timed out waiting for ${label}`);
};

type Route = (method: string, path: string, body: unknown) => Response | undefined;
const mockFetch = (route: Route) => {
  const calls: { method: string; path: string; body: unknown }[] = [];
  const spy = spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(
      async (input: string | URL | Request, init?: RequestInit) => {
        const request = input instanceof Request ? input : new Request(new URL(String(input), "http://localhost/"), init);
        const path = new URL(request.url).pathname;
        const text = await request.text();
        const body = text ? JSON.parse(text) : undefined;
        calls.push({ method: request.method, path, body });
        return route(request.method, path, body) ?? Response.json({ code: "UNAVAILABLE" }, { status: 503 });
      },
      { preconnect: globalThis.fetch.preconnect },
    ),
  );
  return { calls, restore: () => spy.mockRestore() };
};

const load = async () => {
  const dom = createDomTestHarness();
  try {
    return { ui: await import("@k2b/ui"), AppDevices: (await import("./AppDevices.island.tsx")).default };
  } finally {
    dom.cleanup();
  }
};
const modules = isServer ? undefined : await load();

const mount = (dom: DomTestHarness, options: { fine?: boolean; initial?: typeof devices | [] } = {}) => {
  const { ui, AppDevices } = modules!;
  // Solid delegates these on the document of the moment; each test has its own.
  delegateEvents(["input", "click"]);
  Object.assign(dom.window, { matchMedia: (query: string) => ({ matches: query === "(pointer: fine)" && options.fine !== false }) });
  return render(
    () =>
      createComponent(ui.LocaleProvider, {
        locale: "en",
        get children() {
          return createComponent(AppDevices, {
            userId: "7bd9706e-6c70-4dd5-946f-0caac02bfc2a",
            initial: [...(options.initial ?? devices)],
            dateConfig: { timeZone: "UTC" },
          });
        },
      }),
    dom.root,
  );
};
const button = (dom: DomTestHarness, label: string) =>
  [...dom.document.querySelectorAll("button")].find((element) => element.textContent?.trim() === label) as HTMLButtonElement | undefined;

if (isServer) test.skip("requires browser conditions", () => {});
else {
  test("starting shows the QR code on fine pointers, a countdown and the copy link; cancel ends the pairing", async () => {
    const dom = createDomTestHarness();
    const copied: string[] = [];
    Object.defineProperty(dom.window.navigator, "clipboard", {
      configurable: true,
      value: { writeText: async (text: string) => void copied.push(text) },
    });
    const claimUntil = new Date(Date.now() + 300_000).toISOString();
    const expiresAt = new Date(Date.now() + 600_000).toISOString();
    const fetch = mockFetch((method, path) => {
      if (method === "POST" && path === "/api/auth/pwa/v1/pairings")
        return Response.json({ id: PAIRING, secret: SECRET, claimUntil, expiresAt }, { status: 201 });
      if (method === "POST" && path === `/api/auth/pwa/v1/pairings/${PAIRING}/cancel`) return new Response(null, { status: 204 });
    });
    const dispose = mount(dom);
    try {
      button(dom, "Pair a phone")!.click();
      await waitFor(() => Boolean(dom.root.querySelector('img[alt="Pairing code for the app"]')), "QR code");
      expect(dom.root.textContent).toMatch(/The link works for [45]:\d\d\./);
      expect(dom.window.sessionStorage.getItem("cloud.pwa-pairing:7bd9706e-6c70-4dd5-946f-0caac02bfc2a")).toContain(PAIRING);
      // The link secret never goes to storage.
      expect(dom.window.sessionStorage.getItem("cloud.pwa-pairing:7bd9706e-6c70-4dd5-946f-0caac02bfc2a")).not.toContain(SECRET);
      button(dom, "Copy link")!.click();
      await waitFor(() => copied.length === 1, "copy");
      expect(copied[0]).toBe(`http://localhost/pwa/#pair=${SECRET}`);
      button(dom, "Cancel")!.click();
      await waitFor(() => dom.root.textContent?.includes("Pairing cancelled.") ?? false, "cancelled");
      expect(fetch.calls.map((call) => `${call.method} ${call.path}`)).toContain(`POST /api/auth/pwa/v1/pairings/${PAIRING}/cancel`);
      expect(dom.window.sessionStorage.length).toBe(0);
    } finally {
      dispose();
      fetch.restore();
      dom.cleanup();
    }
  });

  test("touch screens get the copy link without a QR code", async () => {
    const dom = createDomTestHarness();
    const fetch = mockFetch((method, path) =>
      method === "POST" && path === "/api/auth/pwa/v1/pairings"
        ? Response.json(
            {
              id: PAIRING,
              secret: SECRET,
              claimUntil: new Date(Date.now() + 300_000).toISOString(),
              expiresAt: new Date(Date.now() + 600_000).toISOString(),
            },
            { status: 201 },
          )
        : undefined,
    );
    const dispose = mount(dom, { fine: false });
    try {
      button(dom, "Pair a phone")!.click();
      await waitFor(() => Boolean(button(dom, "Copy link")), "copy link");
      expect(dom.root.querySelector("img")).toBeNull();
    } finally {
      dispose();
      fetch.restore();
      dom.cleanup();
    }
  });

  test("a resumed pairing asks for the phone's code, counts wrong codes and reloads the list when paired", async () => {
    const dom = createDomTestHarness();
    dom.window.sessionStorage.setItem(
      "cloud.pwa-pairing:7bd9706e-6c70-4dd5-946f-0caac02bfc2a",
      JSON.stringify({ id: PAIRING, expiresAt: new Date(Date.now() + 600_000).toISOString() }),
    );
    let confirmations = 0;
    const fetch = mockFetch((method, path, body) => {
      if (method === "GET" && path === `/api/auth/pwa/v1/pairings/${PAIRING}`)
        return Response.json({
          state: "claimed",
          claimUntil: new Date(Date.now() + 300_000).toISOString(),
          expiresAt: new Date(Date.now() + 600_000).toISOString(),
          device: { name: "iPhone", platform: "ios" },
          attemptsLeft: 3,
        });
      if (method === "POST" && path === `/api/auth/pwa/v1/pairings/${PAIRING}/confirm`) {
        confirmations += 1;
        expect(body).toEqual({ code: confirmations === 1 ? "111111" : "482913" });
        return confirmations === 1
          ? Response.json({ code: "WRONG_CODE", message: "The code does not match.", attemptsLeft: 2 }, { status: 409 })
          : new Response(null, { status: 204 });
      }
      if (method === "GET" && path === "/api/auth/pwa/v1/devices") return Response.json({ items: [devices[1]] });
    });
    const dispose = mount(dom);
    const type = (code: string) => {
      const inputs = [...dom.root.querySelectorAll<HTMLInputElement>("form input")];
      inputs.forEach((input, index) => {
        input.value = code[index]!;
        input.dispatchEvent(new dom.window.Event("input", { bubbles: true }) as unknown as Event);
      });
    };
    try {
      await waitFor(() => dom.root.textContent?.includes("iPhone wants to connect. Enter the code shown in the app.") ?? false, "claimed");
      type("111111");
      button(dom, "Pair")!.click();
      await waitFor(() => dom.root.textContent?.includes("That code doesn't match. 2 tries left.") ?? false, "wrong code");
      type("482913");
      button(dom, "Pair")!.click();
      await waitFor(() => dom.root.textContent?.includes("Paired. The app finishes on its own.") ?? false, "paired");
      await waitFor(() => !dom.root.textContent?.includes("This phone"), "list reload");
      expect(dom.window.sessionStorage.length).toBe(0);
    } finally {
      dispose();
      fetch.restore();
      dom.cleanup();
    }
  });

  test("an old sign-in leads to re-authentication instead of an error", async () => {
    const dom = createDomTestHarness();
    const fetch = mockFetch((method, path) =>
      method === "POST" && path === "/api/auth/pwa/v1/pairings"
        ? Response.json({ code: "REAUTHENTICATE", message: "Sign in again to pair a phone." }, { status: 403 })
        : undefined,
    );
    const dispose = mount(dom);
    try {
      button(dom, "Pair a phone")!.click();
      await waitFor(() => Boolean(button(dom, "Confirm it's you")), "re-authenticate");
      expect(dom.root.textContent).toContain("Pairing a phone needs a recent sign-in.");
    } finally {
      dispose();
      fetch.restore();
      dom.cleanup();
    }
  });

  test("the phone list marks this phone and removes a phone after confirmation", async () => {
    const dom = createDomTestHarness();
    const fetch = mockFetch((method, path) =>
      method === "DELETE" && path === `/api/auth/pwa/v1/devices/${OTHER}` ? new Response(null, { status: 204 }) : undefined,
    );
    const dispose = mount(dom);
    try {
      expect(dom.root.textContent).toContain("This phone");
      expect(dom.root.textContent).toContain("Last used Sep 2, 2026");
      expect(dom.root.textContent).toContain("Last used today");
      const rows = [...dom.root.querySelectorAll("li")];
      ([...rows[1]!.querySelectorAll("button")].find((element) => element.textContent?.includes("Remove")) as HTMLButtonElement).click();
      await waitFor(() => Boolean(dom.document.querySelector("dialog")), "confirm prompt");
      const confirm = [...dom.document.querySelectorAll("dialog button")].find((element) => element.textContent?.trim() === "Remove");
      (confirm as HTMLButtonElement).click();
      await waitFor(() => dom.root.querySelectorAll("li").length === 1, "removed");
      expect(fetch.calls.some((call) => call.method === "DELETE")).toBeTrue();
    } finally {
      modules!.ui.dialogCore.close();
      dispose();
      fetch.restore();
      dom.cleanup();
    }
  });

  test("without phones the list is one calm line", () => {
    const dom = createDomTestHarness();
    const dispose = mount(dom, { initial: [] });
    try {
      expect(dom.root.textContent).toContain("No phones paired yet.");
    } finally {
      dispose();
      dom.cleanup();
    }
  });
}
