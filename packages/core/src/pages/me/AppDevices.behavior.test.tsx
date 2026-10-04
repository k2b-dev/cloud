import { expect, spyOn, test } from "bun:test";
import { createComponent } from "solid-js";
import { delegateEvents, isServer, render } from "solid-js/web";
import { createDomTestHarness, type DomTestHarness } from "../../../../ui/test/dom";

const SECRET = `${"A".repeat(42)}w`;
const PAIRING = "8f0b3c39-4a7e-4a37-9bdb-1f0f6b0b8f11";
const PHONE = "2c8b3f2e-6e5b-4c43-8b84-5f0c0e3e1a77";
const OTHER = "4d2f6a14-3c55-4a2b-9e0e-9c2a8c6f0d22";
const NEXT = "9a7c1e52-0b3d-4f6e-8a19-2d4b6c8e0f33";
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

type Route = (method: string, path: string, body: unknown) => Response | Promise<Response> | undefined;
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
const dialog = (dom: DomTestHarness) => dom.document.querySelector("dialog");
const dialogText = (dom: DomTestHarness) => dialog(dom)?.textContent ?? "";
const STORAGE = "cloud.pwa-pairing:7bd9706e-6c70-4dd5-946f-0caac02bfc2a";
const started = () =>
  Response.json(
    {
      id: PAIRING,
      secret: SECRET,
      claimUntil: new Date(Date.now() + 300_000).toISOString(),
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
    },
    { status: 201 },
  );
/** Polls every few seconds in the browser; here at once. */
const fastTimers = () => {
  const wait = globalThis.setTimeout;
  return spyOn(globalThis, "setTimeout").mockImplementation(((run: () => void) => wait(run, 5)) as typeof setTimeout);
};
const resume = (dom: DomTestHarness) =>
  dom.window.sessionStorage.setItem(STORAGE, JSON.stringify({ id: PAIRING, expiresAt: new Date(Date.now() + 600_000).toISOString() }));
const type = (dom: DomTestHarness, code: string) => {
  const inputs = [...dom.document.querySelectorAll<HTMLInputElement>("dialog .k2b-pin-input input")];
  inputs.forEach((input, index) => {
    input.value = code[index]!;
    input.dispatchEvent(new dom.window.Event("input", { bubbles: true }) as unknown as Event);
  });
};

if (isServer) test.skip("requires browser conditions", () => {});
else {
  test("the page is the phone list and one action; pairing happens in a dialog", () => {
    const dom = createDomTestHarness();
    const dispose = mount(dom);
    try {
      expect(button(dom, "Pair a phone")).toBeDefined();
      expect(dialog(dom)).toBeNull();
      expect(dom.root.querySelector("img")).toBeNull();
      expect(dom.root.textContent).not.toContain("Copy link");
    } finally {
      dispose();
      dom.cleanup();
    }
  });

  test("the dialog shows the QR code on fine pointers, a countdown and the copy link; cancel closes it and ends the pairing", async () => {
    const dom = createDomTestHarness();
    const copied: string[] = [];
    Object.defineProperty(dom.window.navigator, "clipboard", {
      configurable: true,
      value: { writeText: async (text: string) => void copied.push(text) },
    });
    const fetch = mockFetch((method, path) => {
      if (method === "POST" && path === "/api/auth/pwa/v1/pairings") return started();
      if (method === "POST" && path === `/api/auth/pwa/v1/pairings/${PAIRING}/cancel`) return new Response(null, { status: 204 });
    });
    const dispose = mount(dom);
    try {
      button(dom, "Pair a phone")!.click();
      await waitFor(() => Boolean(dom.document.querySelector('dialog img[alt="Pairing code for the app"]')), "QR code");
      // The answer came before the dialog's first frame; that frame must not take focus away from the step's task.
      await Bun.sleep(30);
      expect(dom.document.activeElement).toBe(button(dom, "Copy link")!);
      expect(dialogText(dom)).toMatch(/The link works for [45]:\d\d\./);
      expect(dialogText(dom)).toContain("In the app, tap Scan code.");
      expect(dom.window.sessionStorage.getItem(STORAGE)).toContain(PAIRING);
      // The link secret never goes to storage.
      expect(dom.window.sessionStorage.getItem(STORAGE)).not.toContain(SECRET);
      button(dom, "Copy link")!.click();
      await waitFor(() => copied.length === 1, "copy");
      expect(copied[0]).toBe(`http://localhost/pwa/#pair=${SECRET}`);
      button(dom, "Cancel")!.click();
      await waitFor(() => !dialog(dom), "dialog closed");
      await waitFor(() => fetch.calls.some((call) => call.path === `/api/auth/pwa/v1/pairings/${PAIRING}/cancel`), "cancel");
      expect(dom.window.sessionStorage.length).toBe(0);
    } finally {
      modules!.ui.dialogCore.close();
      dispose();
      fetch.restore();
      dom.cleanup();
    }
  });

  test("touch screens get the copy link as the main action, no QR code, and the way to install the app", async () => {
    const dom = createDomTestHarness();
    const fetch = mockFetch((method, path) => (method === "POST" && path === "/api/auth/pwa/v1/pairings" ? started() : undefined));
    const dispose = mount(dom, { fine: false });
    try {
      button(dom, "Pair a phone")!.click();
      await waitFor(() => Boolean(button(dom, "Copy link")), "copy link");
      expect(dom.document.querySelector("dialog img")).toBeNull();
      expect(button(dom, "Copy link")!.dataset.variant).toBe("primary");
      const install = dom.document.querySelector<HTMLAnchorElement>('dialog a[href="/pwa/"]');
      expect(install?.textContent?.trim()).toBe("Install the app");
      // Shaped like a button: a touch screen has no hover to reveal a text link.
      expect(install?.classList.contains("k2b-button")).toBeTrue();
    } finally {
      modules!.ui.dialogCore.close();
      dispose();
      fetch.restore();
      dom.cleanup();
    }
  });

  test("a resumed pairing reopens the dialog, asks for the phone's code, counts wrong codes and lists the phone once it completed", async () => {
    const dom = createDomTestHarness();
    resume(dom);
    const timers = fastTimers();
    let state: "claimed" | "confirmed" | "completed" = "claimed";
    let confirmations = 0;
    const paired = { ...devices[0], id: "6b1d2e3f-4a5b-4c6d-8e7f-8091a2b3c4d5", name: "New iPhone", current: false };
    const fetch = mockFetch((method, path, body) => {
      if (method === "GET" && path === `/api/auth/pwa/v1/pairings/${PAIRING}`)
        return Response.json({
          state,
          claimUntil: new Date(Date.now() + 300_000).toISOString(),
          expiresAt: new Date(Date.now() + 600_000).toISOString(),
          device: { name: "iPhone", platform: "ios" },
          attemptsLeft: 3,
        });
      if (method === "POST" && path === `/api/auth/pwa/v1/pairings/${PAIRING}/confirm`) {
        confirmations += 1;
        expect(body).toEqual({ code: confirmations === 1 ? "111111" : "482913" });
        if (confirmations === 1)
          return Response.json({ code: "WRONG_CODE", message: "The code does not match.", attemptsLeft: 2 }, { status: 409 });
        state = "confirmed";
        return new Response(null, { status: 204 });
      }
      // The device exists only after the phone completed.
      if (method === "GET" && path === "/api/auth/pwa/v1/devices") return Response.json({ items: state === "completed" ? [paired] : [] });
    });
    const dispose = mount(dom, { initial: [] });
    try {
      await waitFor(() => dialogText(dom).includes("iPhone wants to connect. Enter the code shown in the app."), "claimed");
      expect(button(dom, "Pair")!.disabled).toBeTrue();
      // The code step takes the keyboard to the first digit.
      await waitFor(() => dom.document.activeElement === dom.document.querySelector("dialog .k2b-pin-input input"), "focus on the code");
      type(dom, "111111");
      button(dom, "Pair")!.click();
      await waitFor(() => dialogText(dom).includes("That code doesn't match. 2 tries left."), "wrong code");
      type(dom, "482913");
      button(dom, "Pair")!.click();
      await waitFor(() => dialogText(dom).includes("iPhone is paired."), "paired");
      expect(dialogText(dom)).toContain("The app finishes on its own.");
      expect(dom.window.sessionStorage.length).toBe(0);
      // Still confirmed: the list waits for the phone instead of reloading too early.
      await waitFor(() => fetch.calls.filter((call) => call.path === `/api/auth/pwa/v1/pairings/${PAIRING}`).length >= 4, "polls");
      expect(fetch.calls.some((call) => call.path === "/api/auth/pwa/v1/devices")).toBeFalse();
      // Done closes the dialog without cancelling; the list still follows the phone.
      button(dom, "Done")!.click();
      await waitFor(() => !dialog(dom), "dialog closed");
      expect(fetch.calls.some((call) => call.path.endsWith("/cancel"))).toBeFalse();
      expect(dom.root.textContent).toContain("No phones paired yet.");
      state = "completed";
      await waitFor(() => dom.root.textContent?.includes("New iPhone") ?? false, "list reload");
      expect(dom.root.textContent).not.toContain("No phones paired yet.");
    } finally {
      modules!.ui.dialogCore.close();
      dispose();
      fetch.restore();
      timers.mockRestore();
      dom.cleanup();
    }
  });

  test("the last wrong code ends the pairing and offers a new one", async () => {
    const dom = createDomTestHarness();
    resume(dom);
    const timers = fastTimers();
    const fetch = mockFetch((method, path) => {
      if (method === "GET" && path === `/api/auth/pwa/v1/pairings/${PAIRING}`)
        return Response.json({
          state: "claimed",
          claimUntil: new Date(Date.now() + 300_000).toISOString(),
          expiresAt: new Date(Date.now() + 600_000).toISOString(),
          device: { name: "iPhone", platform: "ios" },
          attemptsLeft: 1,
        });
      if (method === "POST" && path === `/api/auth/pwa/v1/pairings/${PAIRING}/confirm`)
        return Response.json({ code: "EXPIRED", message: "This pairing has expired.", attemptsLeft: 0 }, { status: 410 });
    });
    const dispose = mount(dom, { initial: [] });
    try {
      await waitFor(() => dialogText(dom).includes("iPhone wants to connect."), "claimed");
      type(dom, "111111");
      button(dom, "Pair")!.click();
      await waitFor(() => dialogText(dom).includes("Too many wrong codes"), "locked");
      await waitFor(() => dom.document.activeElement === button(dom, "Start again"), "focus on the next step");
      expect(dom.window.sessionStorage.length).toBe(0);
    } finally {
      modules!.ui.dialogCore.close();
      dispose();
      fetch.restore();
      timers.mockRestore();
      dom.cleanup();
    }
  });

  test("an expiry after wrong codes says it expired; only the server's last wrong code says too many", async () => {
    const dom = createDomTestHarness();
    resume(dom);
    const timers = fastTimers();
    const fetch = mockFetch((method, path) => {
      if (method === "GET" && path === `/api/auth/pwa/v1/pairings/${PAIRING}`)
        return Response.json({
          state: "claimed",
          claimUntil: new Date(Date.now() + 300_000).toISOString(),
          expiresAt: new Date(Date.now() + 600_000).toISOString(),
          device: { name: "iPhone", platform: "ios" },
          attemptsLeft: 1,
        });
      // Two wrong codes before, then the pairing ran out of time: no `attemptsLeft` in the answer.
      if (method === "POST" && path === `/api/auth/pwa/v1/pairings/${PAIRING}/confirm`)
        return Response.json({ code: "EXPIRED", message: "This pairing has expired." }, { status: 410 });
    });
    const dispose = mount(dom, { initial: [] });
    try {
      await waitFor(() => dialogText(dom).includes("iPhone wants to connect."), "claimed");
      type(dom, "111111");
      button(dom, "Pair")!.click();
      await waitFor(() => dialogText(dom).includes("This pairing has expired."), "expired");
      expect(dialogText(dom)).not.toContain("Too many wrong codes");
    } finally {
      modules!.ui.dialogCore.close();
      dispose();
      fetch.restore();
      timers.mockRestore();
      dom.cleanup();
    }
  });

  test("an unclaimed link ends when the server says so, not by this computer's clock", async () => {
    const dom = createDomTestHarness();
    resume(dom);
    const timers = fastTimers();
    let expired = false;
    const fetch = mockFetch((method, path) => {
      if (method === "GET" && path === `/api/auth/pwa/v1/pairings/${PAIRING}`)
        return expired
          ? Response.json({ code: "EXPIRED", message: "This pairing has expired." }, { status: 410 })
          : // This computer's clock runs ahead: the claim window is over here, but not on the server.
            Response.json({
              state: "pending",
              claimUntil: new Date(Date.now() - 10_000).toISOString(),
              expiresAt: new Date(Date.now() + 600_000).toISOString(),
              device: null,
              attemptsLeft: 3,
            });
    });
    const dispose = mount(dom, { initial: [] });
    try {
      await waitFor(() => fetch.calls.filter((call) => call.method === "GET").length >= 3, "polls");
      expect(dialogText(dom)).toContain("Waiting for the phone.");
      expired = true;
      await waitFor(() => dialogText(dom).includes("This pairing has expired."), "expired");
      // Over on the server: closing has nothing left to cancel.
      button(dom, "Close")!.click();
      await waitFor(() => !dialog(dom), "dialog closed");
      expect(fetch.calls.some((call) => call.path.endsWith("/cancel"))).toBeFalse();
    } finally {
      modules!.ui.dialogCore.close();
      dispose();
      fetch.restore();
      timers.mockRestore();
      dom.cleanup();
    }
  });

  test("a code the server could not take stays, so it can be sent again; closing still cancels", async () => {
    const dom = createDomTestHarness();
    resume(dom);
    const timers = fastTimers();
    let confirmations = 0;
    const fetch = mockFetch((method, path) => {
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
        return Response.json({ code: "UNAVAILABLE", message: "Try again later." }, { status: 503 });
      }
      if (method === "POST" && path === `/api/auth/pwa/v1/pairings/${PAIRING}/cancel`) return new Response(null, { status: 204 });
    });
    const dispose = mount(dom, { initial: [] });
    try {
      await waitFor(() => dialogText(dom).includes("iPhone wants to connect."), "claimed");
      type(dom, "482913");
      button(dom, "Pair")!.click();
      await waitFor(() => confirmations === 1 && !button(dom, "Pair")!.disabled, "first answer");
      expect(dialogText(dom)).toContain("iPhone wants to connect.");
      button(dom, "Pair")!.click();
      await waitFor(() => confirmations === 2 && !button(dom, "Pair")!.disabled, "sent again");
      button(dom, "Cancel")!.click();
      await waitFor(() => fetch.calls.some((call) => call.path === `/api/auth/pwa/v1/pairings/${PAIRING}/cancel`), "cancel");
    } finally {
      modules!.ui.dialogCore.close();
      dispose();
      fetch.restore();
      timers.mockRestore();
      dom.cleanup();
    }
  });

  test("an answer for a closed dialog changes nothing in the next one", async () => {
    const dom = createDomTestHarness();
    resume(dom);
    const timers = fastTimers();
    let state: "claimed" | "confirmed" = "claimed";
    let answer = () => {};
    const fetch = mockFetch((method, path) => {
      if (method === "GET" && path === `/api/auth/pwa/v1/pairings/${PAIRING}`)
        return Response.json({
          state,
          claimUntil: new Date(Date.now() + 300_000).toISOString(),
          expiresAt: new Date(Date.now() + 600_000).toISOString(),
          device: { name: "iPhone", platform: "ios" },
          attemptsLeft: 3,
        });
      // The confirmation lands on the server, but its answer is slow.
      if (method === "POST" && path === `/api/auth/pwa/v1/pairings/${PAIRING}/confirm`) {
        state = "confirmed";
        return new Promise<Response>((resolve) => {
          answer = () => resolve(new Response(null, { status: 204 }));
        });
      }
      if (method === "POST" && path === "/api/auth/pwa/v1/pairings")
        return Response.json(
          {
            id: NEXT,
            secret: SECRET,
            claimUntil: new Date(Date.now() + 300_000).toISOString(),
            expiresAt: new Date(Date.now() + 600_000).toISOString(),
          },
          { status: 201 },
        );
      if (method === "GET" && path === `/api/auth/pwa/v1/pairings/${NEXT}`)
        return Response.json({
          state: "pending",
          claimUntil: new Date(Date.now() + 300_000).toISOString(),
          expiresAt: new Date(Date.now() + 600_000).toISOString(),
          device: null,
          attemptsLeft: 3,
        });
      if (method === "GET" && path === "/api/auth/pwa/v1/devices") return Response.json({ items: [] });
    });
    const dispose = mount(dom, { initial: [] });
    try {
      await waitFor(() => dialogText(dom).includes("iPhone wants to connect."), "claimed");
      type(dom, "482913");
      button(dom, "Pair")!.click();
      await waitFor(() => dialogText(dom).includes("iPhone is paired."), "paired, read by the poll");
      button(dom, "Done")!.click();
      await waitFor(() => !dialog(dom), "dialog closed");
      button(dom, "Pair a phone")!.click();
      await waitFor(() => Boolean(button(dom, "Copy link")), "a new pairing");
      answer();
      await Bun.sleep(30);
      expect(Boolean(button(dom, "Copy link"))).toBeTrue();
      expect(dialogText(dom)).not.toContain("is paired.");
    } finally {
      modules!.ui.dialogCore.close();
      dispose();
      fetch.restore();
      timers.mockRestore();
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
      expect(dialogText(dom)).toContain("Pairing a phone needs a recent sign-in.");
    } finally {
      modules!.ui.dialogCore.close();
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
      expect(dom.root.textContent).toContain("This phone · Last used Sep 2, 2026");
      expect(dom.root.textContent).toContain("Last used today");
      expect(dom.root.querySelector('[role="img"][aria-label="iPhone or iPad"]')).not.toBeNull();
      expect(dom.root.querySelector('[role="img"][aria-label="Android"]')).not.toBeNull();
      expect([...dom.root.querySelectorAll("li button")].map((element) => element.getAttribute("aria-label"))).toEqual([
        "Remove iPhone",
        "Remove Android",
      ]);
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
