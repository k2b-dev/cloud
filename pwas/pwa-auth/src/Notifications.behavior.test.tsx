import { afterEach, beforeEach, expect, test } from "bun:test";
import { createComponent, createRoot, createSignal } from "solid-js";
import { render } from "solid-js/web";
import { createDomTestHarness, type DomTestHarness } from "../../../packages/ui/test/dom";
import type { Installation } from "./install";
import type { Push, PushState } from "./push";

let dom: DomTestHarness;
beforeEach(() => {
  dom = createDomTestHarness();
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: dom.window.localStorage });
});
afterEach(() => dom.cleanup());

const installation = (platform: Installation["platform"], installed: boolean): Installation => ({
  installed: () => installed,
  busy: () => false,
  requested: () => false,
  failed: () => false,
  install: async () => {},
  platform,
  canPrompt: () => false,
  shouldIntroduce: () => false,
  markIntroduced: () => {},
});

function fakePush(state: PushState) {
  const calls: string[] = [];
  const [current, setCurrent] = createSignal(state);
  const [dismissed, setDismissed] = createSignal(false);
  const push: Push = {
    state: current,
    busy: () => false,
    failed: () => false,
    token: () => undefined,
    dismissed,
    dismiss: () => setDismissed(true),
    enable: async () => {
      calls.push("enable");
      setCurrent("active");
      return true;
    },
    retry: async () => {
      calls.push("retry");
      return true;
    },
    test: async () => {
      calls.push("test");
      return true;
    },
  };
  return { push, calls };
}

const text = () => dom.root.textContent ?? "";
const button = (label: string) => [...dom.root.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.includes(label));

test("the onboarding card asks installed apps once and never auto-prompts", async () => {
  const { PushCard } = await import("./Notifications");
  const { push, calls } = fakePush("default");
  const dispose = render(
    () => createComponent(PushCard, { push, installation: installation("android", true), showInstall: () => {} }),
    dom.root,
  );
  expect(text()).toContain("Turn on notifications");
  expect(calls).toEqual([]);
  button("Turn on")!.click();
  await Bun.sleep(0);
  expect(calls).toEqual(["enable"]);
  expect(text()).toBe("");
  dispose();

  const browserTab = render(
    () =>
      createComponent(PushCard, { push: fakePush("default").push, installation: installation("android", false), showInstall: () => {} }),
    dom.root,
  );
  expect(text()).toBe("");
  browserTab();
});

test("on iPhone Safari the card explains the Home Screen requirement and can be dismissed", async () => {
  const { PushCard } = await import("./Notifications");
  const { push } = fakePush("not-installed");
  let steps = 0;
  const dispose = render(
    () => createComponent(PushCard, { push, installation: installation("apple-mobile", false), showInstall: () => steps++ }),
    dom.root,
  );
  expect(text()).toContain("Home Screen (iOS 16.4 or later)");
  button("Show steps")!.click();
  expect(steps).toBe(1);
  button("Not now")!.click();
  await Bun.sleep(0);
  expect(text()).toBe("");
  dispose();
});

test("settings show each push state with its action", async () => {
  const { NotificationSettings } = await import("./Notifications");
  const cases: [PushState, Installation["platform"], string, string | undefined][] = [
    ["active", "android", "Active", "Send test notification"],
    ["default", "android", "Not requested yet", "Ask again"],
    ["denied", "apple-mobile", "Not allowed", undefined],
    ["unsupported", "generic", "Not supported", undefined],
    ["not-installed", "apple-mobile", "App not installed", "Show steps"],
    ["inactive", "android", "Not connected", "Connect again"],
  ];
  for (const [state, platform, label, action] of cases) {
    const { push, calls } = fakePush(state);
    const dispose = render(
      () =>
        createComponent(NotificationSettings, { push, installation: installation(platform, true), showInstall: () => {}, close: () => {} }),
      dom.root,
    );
    expect(dom.root.querySelector(".k2b-status-badge")?.textContent).toContain(label);
    if (action) {
      button(action)!.click();
      await Bun.sleep(0);
      if (state === "active") {
        expect(calls).toEqual(["test"]);
        expect(text()).toContain("Test notification sent");
      }
    }
    if (state === "denied") {
      expect(text()).toContain("Tap Notifications, then Cloud Login.");
      expect(button("Ask again")).toBeUndefined();
    }
    dispose();
  }
});

type Subscription = { endpoint: string; toJSON: () => unknown; unsubscribe: () => Promise<boolean> };
function fakeBrowser(options: { permission?: NotificationPermission; config?: number; testStatuses?: number[] }) {
  let permission = options.permission;
  let current: Subscription | null = null;
  const requests: string[] = [];
  const testStatuses = [...(options.testStatuses ?? [202])];
  let tokens = 0;
  const pushManager = {
    getSubscription: async () => current,
    subscribe: async () => {
      current = {
        endpoint: "https://push.example.test/endpoint",
        toJSON: () => ({ endpoint: "https://push.example.test/endpoint", keys: { p256dh: "p", auth: "a" } }),
        unsubscribe: async () => true,
      };
      return current;
    },
  };
  return {
    requests,
    browser: {
      permission: () => permission,
      requestPermission: async () => {
        permission = "granted";
        return permission;
      },
      registration: async () => ({ pushManager }),
      fetch: async (path: string, init?: RequestInit) => {
        requests.push(`${init?.method ?? "GET"} ${path}`);
        if (path === "/push/config")
          return options.config === 404 ? new Response(null, { status: 404 }) : Response.json({ publicKey: "BAAA" });
        if (path === "/push/subscriptions") return Response.json({ token: `token-${++tokens}` }, { status: 201 });
        return new Response(null, { status: testStatuses.shift() ?? 202 });
      },
    },
  };
}

test("enabling push asks once, subscribes and re-registers after the server forgot the token", async () => {
  const { createPush } = await import("./push");
  const fake = fakeBrowser({ permission: "default", testStatuses: [410, 202] });
  await createRoot(async (dispose) => {
    const push = createPush(installation("android", true), fake.browser);
    await Bun.sleep(10);
    expect(push.state()).toBe("default");
    expect(await push.enable()).toBe(true);
    expect(push.state()).toBe("active");
    expect(push.token()).toBe("token-1");
    expect(await push.test()).toBe(true);
    expect(push.token()).toBe("token-2");
    expect(fake.requests).toEqual([
      "GET /push/config",
      "POST /push/subscriptions",
      "POST /push/test",
      "POST /push/subscriptions",
      "POST /push/test",
    ]);
    dispose();
  });
});

test("push reports unsupported browsers, servers without push and iPhone tabs", async () => {
  const { createPush } = await import("./push");
  await createRoot(async (dispose) => {
    expect(createPush(installation("apple-mobile", false), fakeBrowser({}).browser).state()).toBe("not-installed");
    expect(createPush(installation("generic", false), fakeBrowser({}).browser).state()).toBe("unsupported");
    const noServer = createPush(installation("android", true), fakeBrowser({ permission: "default", config: 404 }).browser);
    const denied = createPush(installation("android", true), fakeBrowser({ permission: "denied" }).browser);
    await Bun.sleep(10);
    expect(noServer.state()).toBe("unsupported");
    expect(denied.state()).toBe("denied");
    dispose();
  });
});
