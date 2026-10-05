import { expect, spyOn, test } from "bun:test";
import { createComponent } from "solid-js";
import { delegateEvents, isServer, render } from "solid-js/web";
import { createDomTestHarness, type DomTestHarness } from "../../../../ui/test/dom";

const SECRET = `${"A".repeat(42)}w`;
const LINK = `http://localhost/pwa/#pair=${SECRET}`;
const expiresAt = new Date(Date.now() + 600_000).toISOString();

const waitFor = async (condition: () => boolean, label: string) => {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    if (condition()) return;
    await Bun.sleep(5);
  }
  throw new Error(`Timed out waiting for ${label}`);
};

type Route = (method: string, path: string, body: unknown) => Response | Promise<Response> | undefined;
const mockFetch = (route: Route) => {
  const calls: { method: string; path: string; body: unknown }[] = [];
  const spy = spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(
      async (input: string | URL | Request, init?: RequestInit) => {
        const path = new URL(String(input), "http://localhost/").pathname;
        const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
        calls.push({ method: init?.method ?? "GET", path, body });
        return (await route(init?.method ?? "GET", path, body)) ?? Response.json({ code: "UNAVAILABLE", message: "" }, { status: 503 });
      },
      { preconnect: globalThis.fetch.preconnect },
    ),
  );
  return { calls, restore: () => spy.mockRestore() };
};

const load = async () => {
  const dom = createDomTestHarness();
  try {
    return { ui: await import("@k2b/ui"), Welcome: (await import("./Welcome.island")).default };
  } finally {
    dom.cleanup();
  }
};
const modules = isServer ? undefined : await load();

type Mounted = { dom: DomTestHarness; replaced: string[]; dispose: () => void };
const SAFARI =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
const mount = (options: {
  standalone: boolean;
  url?: string;
  state?: "new" | "ended" | "expired";
  userAgent?: string;
  platform?: "apple-mobile" | "apple-in-app" | "android";
}): Mounted => {
  const { ui, Welcome } = modules!;
  const dom = createDomTestHarness();
  delegateEvents(["click", "input"]);
  dom.window.history.replaceState(null, "", options.url ?? "/pwa/?pwa=new");
  const query = (media: string) => ({
    matches: media === "(display-mode: standalone)" ? options.standalone : media === "(pointer: coarse)",
    addEventListener: () => {},
    removeEventListener: () => {},
  });
  Object.assign(dom.window, { matchMedia: query });
  Object.defineProperty(globalThis, "matchMedia", { configurable: true, value: query });
  Object.defineProperty(dom.window.navigator, "userAgent", { configurable: true, value: options.userAgent ?? SAFARI });
  const replaced: string[] = [];
  Object.assign(dom.window.location, { replace: (url: string) => void replaced.push(url) });
  // Polling every five seconds would make the test slow; keep the order, not the delay.
  const timeout = spyOn(globalThis, "setTimeout").mockImplementation(((callback: () => void, delay?: number) =>
    dom.window.setTimeout(callback, delay === 5000 ? 5 : delay)) as never);
  const dispose = render(
    () =>
      createComponent(ui.LocaleProvider, {
        locale: "en",
        get children() {
          return createComponent(Welcome, {
            state: options.state ?? "new",
            cloud: "Example Cloud",
            icon: "/branding/pwa-icon-192.png?v=1",
            platform: options.platform ?? "apple-mobile",
            url: "http://localhost/pwa/",
          });
        },
      }),
    dom.root,
  );
  return {
    dom,
    replaced,
    dispose: () => {
      dispose();
      timeout.mockRestore();
      dom.cleanup();
    },
  };
};
const button = (dom: DomTestHarness, label: string) =>
  [...dom.document.querySelectorAll("button")].find((element) => element.textContent?.trim() === label) as HTMLButtonElement | undefined;
const text = (dom: DomTestHarness) => dom.root.textContent ?? "";

const claimed = () => Response.json({ code: "482913", account: { name: "Mia Muster" }, expiresAt });
const waiting = () => Response.json({ state: "waiting", code: "482913", account: { name: "Mia Muster" }, expiresAt }, { status: 202 });

if (isServer) test.skip("requires browser conditions", () => {});
else {
  test("the installed app takes the link out of the address before it claims, then shows the code to type on the web", async () => {
    let addressAtClaim = "";
    const fetch = mockFetch((method, path) => {
      if (path === "/pwa/_auth/pairings/claim") {
        addressAtClaim = location.href;
        return claimed();
      }
      if (path === "/pwa/_auth/pairings/complete") return waiting();
    });
    const page = mount({ standalone: true, url: `/pwa/?pwa=new#pair=${SECRET}` });
    try {
      expect(page.dom.window.location.href).toBe("http://localhost/pwa/?pwa=new");
      await waitFor(() => text(page.dom).includes("482 913"), "code");
      expect(addressAtClaim).toBe("http://localhost/pwa/?pwa=new");
      expect(fetch.calls.find((call) => call.path === "/pwa/_auth/pairings/claim")?.body).toEqual({ secret: SECRET, platform: "ios" });
      expect(text(page.dom)).toContain("Connecting to Example Cloud as Mia Muster");
      expect(text(page.dom)).toContain("Enter this code on the web where you started pairing.");
    } finally {
      page.dispose();
      fetch.restore();
    }
  });

  test("the browser never claims: it keeps the link to copy into the app after installing", async () => {
    const copied: string[] = [];
    const fetch = mockFetch(() => undefined);
    const page = mount({ standalone: false, url: `/pwa/?pwa=new#pair=${SECRET}` });
    Object.defineProperty(page.dom.window.navigator, "clipboard", {
      configurable: true,
      value: { writeText: async (value: string) => void copied.push(value) },
    });
    try {
      expect(page.dom.window.location.hash).toBe("");
      await waitFor(() => text(page.dom).includes("Install the app first."), "install note");
      button(page.dom, "Copy link")!.click();
      await waitFor(() => copied.length === 1, "copy");
      expect(copied).toEqual([LINK]);
      await Bun.sleep(30);
      expect(fetch.calls).toEqual([]);
    } finally {
      page.dispose();
      fetch.restore();
    }
  });

  test("inside another app, the warning's one copy action takes the pairing link to Safari", async () => {
    const copied: string[] = [];
    const fetch = mockFetch(() => undefined);
    // A QR scanner's own browser view: an iPhone user agent without Safari's token.
    const page = mount({
      standalone: false,
      url: `/pwa/?pwa=new#pair=${SECRET}`,
      userAgent: SAFARI.replace(" Version/18.0", "").replace(" Safari/604.1", ""),
      platform: "apple-in-app",
    });
    Object.defineProperty(page.dom.window.navigator, "clipboard", {
      configurable: true,
      value: { writeText: async (value: string) => void copied.push(value) },
    });
    try {
      await waitFor(() => text(page.dom).includes("Open this page in Safari"), "warning");
      expect(text(page.dom)).not.toContain("Install the app first.");
      expect(
        [...page.dom.document.querySelectorAll("button")].filter((element) => element.textContent?.includes("Copy link")),
      ).toHaveLength(1);
      button(page.dom, "Copy link")!.click();
      await waitFor(() => copied.length === 1, "copy");
      expect(copied).toEqual([LINK]);
    } finally {
      page.dispose();
      fetch.restore();
    }
  });

  test("on Android, Chrome's own installation dialog replaces the page's steps once Chrome offers it", async () => {
    const fetch = mockFetch(() => undefined);
    const page = mount({
      standalone: false,
      userAgent: "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36",
      platform: "android",
    });
    try {
      expect(text(page.dom)).toContain("Open the browser menu");
      expect(button(page.dom, "Install app")).toBeUndefined();
      const offer = new page.dom.window.Event("beforeinstallprompt", { cancelable: true });
      Object.assign(offer, { prompt: async () => ({ outcome: "accepted" }) });
      page.dom.window.dispatchEvent(offer);
      await waitFor(() => !!button(page.dom, "Install app"), "Install button");
      expect(text(page.dom)).not.toContain("Open the browser menu");
    } finally {
      page.dispose();
      fetch.restore();
    }
  });

  test("a running app claims a link it receives later", async () => {
    const fetch = mockFetch((_method, path) => (path === "/pwa/_auth/pairings/claim" ? claimed() : undefined));
    const page = mount({ standalone: true });
    try {
      await waitFor(() => fetch.calls.length === 1, "pending completion check");
      page.dom.window.location.hash = `#pair=${SECRET}`;
      page.dom.window.dispatchEvent(new page.dom.window.HashChangeEvent("hashchange"));
      await waitFor(() => text(page.dom).includes("482 913"), "code");
      expect(page.dom.window.location.hash).toBe("");
    } finally {
      page.dispose();
      fetch.restore();
    }
  });

  test("a link that opens the app replaces the check for an earlier pairing, so its answer cannot delete the new cookie", async () => {
    let answerClaim = () => {};
    const fetch = mockFetch((_method, path) =>
      path === "/pwa/_auth/pairings/claim"
        ? new Promise<Response>((resolve) => {
            answerClaim = () => resolve(claimed());
          })
        : path === "/pwa/_auth/pairings/complete"
          ? waiting()
          : undefined,
    );
    const page = mount({ standalone: true, url: `/pwa/?pwa=new#pair=${SECRET}` });
    try {
      await waitFor(() => fetch.calls.length === 1, "claim");
      await Bun.sleep(20);
      expect(fetch.calls.map((call) => call.path)).toEqual(["/pwa/_auth/pairings/claim"]);
      answerClaim();
      await waitFor(() => text(page.dom).includes("482 913"), "code");
    } finally {
      page.dispose();
      fetch.restore();
    }
  });

  test("a link the running app receives waits for a completion still on its way", async () => {
    let answerCompletion = () => {};
    const fetch = mockFetch((_method, path) =>
      path === "/pwa/_auth/pairings/complete"
        ? new Promise<Response>((resolve) => {
            answerCompletion = () => resolve(Response.json({ code: "EXPIRED", message: "" }, { status: 410 }));
          })
        : path === "/pwa/_auth/pairings/claim"
          ? claimed()
          : undefined,
    );
    const page = mount({ standalone: true });
    try {
      await waitFor(() => fetch.calls.length === 1, "pending completion check");
      page.dom.window.location.hash = `#pair=${SECRET}`;
      page.dom.window.dispatchEvent(new page.dom.window.HashChangeEvent("hashchange"));
      await Bun.sleep(20);
      expect(fetch.calls.map((call) => call.path)).toEqual(["/pwa/_auth/pairings/complete"]);
      answerCompletion();
      await waitFor(() => text(page.dom).includes("482 913"), "code");
      expect(fetch.calls.map((call) => call.path).slice(0, 2)).toEqual(["/pwa/_auth/pairings/complete", "/pwa/_auth/pairings/claim"]);
    } finally {
      page.dispose();
      fetch.restore();
    }
  });

  test("a pasted link pairs, and other links get their own message", async () => {
    const fetch = mockFetch((_method, path) => (path === "/pwa/_auth/pairings/claim" ? claimed() : undefined));
    const page = mount({ standalone: true });
    const paste = (value: string) => {
      const input = page.dom.document.querySelector<HTMLInputElement>("#pwa-pairing-link")!;
      input.value = value;
      input.dispatchEvent(new Event("input", { bubbles: true }));
      button(page.dom, "Continue")!.click();
    };
    try {
      paste("http://localhost/#pairing=abc");
      await waitFor(() => text(page.dom).includes("This link is for Cloud Login"), "Cloud Login message");
      paste(`https://other.example.test/pwa/#pair=${SECRET}`);
      await waitFor(() => text(page.dom).includes("belongs to another Cloud"), "other Cloud message");
      paste(LINK);
      await waitFor(() => text(page.dom).includes("482 913"), "code");
    } finally {
      page.dispose();
      fetch.restore();
    }
  });

  for (const [status, code, message] of [
    [410, "EXPIRED", "This code expired. Get a new one on the web."],
    [409, "ALREADY_USED", "This code was already used. If that wasn't you, cancel it on the web and start again."],
  ] as const)
    test(`a claim answered ${code} explains what to do`, async () => {
      const fetch = mockFetch((_method, path) =>
        path === "/pwa/_auth/pairings/claim" ? Response.json({ code, message: "" }, { status }) : undefined,
      );
      const page = mount({ standalone: true, url: `/pwa/?pwa=new#pair=${SECRET}` });
      try {
        await waitFor(() => text(page.dom).includes(message), message);
        expect(page.dom.document.querySelector('[role="alert"]')?.textContent).toBe(message);
      } finally {
        page.dispose();
        fetch.restore();
      }
    });

  test("the app finishes once the code was typed, and reopens Start", async () => {
    let completions = 0;
    const fetch = mockFetch((_method, path) => {
      if (path === "/pwa/_auth/pairings/claim") return claimed();
      if (path === "/pwa/_auth/pairings/complete") {
        completions += 1;
        return completions < 3 ? waiting() : Response.json({ state: "paired" });
      }
    });
    const page = mount({ standalone: true, url: `/pwa/?pwa=new#pair=${SECRET}` });
    try {
      await waitFor(() => page.replaced.length === 1, "Start");
      expect(page.replaced).toEqual(["/pwa/"]);
    } finally {
      page.dispose();
      fetch.restore();
    }
  });

  for (const [status, code, expected] of [
    [410, "EXPIRED", { replaced: "/pwa/?pwa=expired" }],
    [403, "ACCOUNT_BLOCKED", { replaced: "/pwa/?pwa=blocked" }],
    [409, "ALREADY_PAIRED", { message: "This app is connected to another account. Sign out of the app first." }],
    [
      409,
      "ACCOUNT_MISMATCH",
      {
        message:
          "Chrome on this phone is signed in to Example Cloud with another account. Sign out there first, or pair from that account.",
      },
    ],
    [429, "LIMIT_REACHED", { message: "You have paired the most phones allowed. Remove one on the web." }],
  ] as const)
    test(`waiting ends on ${code}`, async () => {
      const fetch = mockFetch((_method, path) => {
        if (path === "/pwa/_auth/pairings/claim") return claimed();
        if (path === "/pwa/_auth/pairings/complete") return Response.json({ code, message: "" }, { status });
      });
      const page = mount({ standalone: true, url: `/pwa/?pwa=new#pair=${SECRET}` });
      try {
        if ("replaced" in expected) {
          await waitFor(() => page.replaced.length === 1, "state");
          expect(page.replaced).toEqual([expected.replaced]);
        } else {
          await waitFor(() => text(page.dom).includes(expected.message), "message");
          const calls = fetch.calls.length;
          await Bun.sleep(40);
          // Polling stopped; the person can start again.
          expect(fetch.calls.length).toBe(calls);
          button(page.dom, "Use another code")!.click();
          await waitFor(() => !!button(page.dom, "Scan code"), "pairing view");
        }
      } finally {
        page.dispose();
        fetch.restore();
      }
    });

  test("on start, the app resumes a pairing that is still running, or opens Start when it already finished", async () => {
    let fetch = mockFetch((_method, path) => (path === "/pwa/_auth/pairings/complete" ? waiting() : undefined));
    let page = mount({ standalone: true });
    try {
      await waitFor(() => text(page.dom).includes("482 913"), "resumed code");
    } finally {
      page.dispose();
      fetch.restore();
    }
    fetch = mockFetch((_method, path) => (path === "/pwa/_auth/pairings/complete" ? Response.json({ state: "paired" }) : undefined));
    page = mount({ standalone: true });
    try {
      await waitFor(() => page.replaced.length === 1, "Start");
      expect(page.replaced).toEqual(["/pwa/"]);
    } finally {
      page.dispose();
      fetch.restore();
    }
  });

  test("a camera that cannot start sends the person to the paste field", async () => {
    const fetch = mockFetch(() => undefined);
    const page = mount({ standalone: true, state: "ended" });
    Object.defineProperty(page.dom.window.navigator, "permissions", {
      configurable: true,
      value: { query: async () => ({ state: "denied" }) },
    });
    try {
      expect(text(page.dom)).toContain("This phone was signed out. Connect it again.");
      button(page.dom, "Scan code")!.click();
      await waitFor(() => text(page.dom).includes("Camera not available. Paste the link instead."), "camera message");
      expect(page.dom.document.activeElement?.id).toBe("pwa-pairing-link");
      expect(page.dom.document.querySelector("dialog")).toBeNull();
    } finally {
      page.dispose();
      fetch.restore();
    }
  });
}
