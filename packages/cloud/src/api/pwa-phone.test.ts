import { describe, expect, test } from "bun:test";
import { rememberedPwaAddress } from "../contracts/pwa-location";
import { launchTarget } from "./pwa-phone";

describe("launch target", () => {
  test("returns to a page of the app with the launch marker", () => {
    expect(launchTarget("/pwa/spaces?view=today")).toBe("/pwa/spaces?view=today&pwa_launch=1");
    expect(launchTarget("/pwa/")).toBe("/pwa/?pwa_launch=1");
  });

  test("never leads outside the app or into Core's /pwa/_auth, also after the browser resolves the path", () => {
    for (const to of [
      undefined,
      "",
      "https://evil.example.test/",
      "/me/app",
      "/pwa//evil.example.test",
      "/pwa/\\evil",
      "/pwa/_auth",
      "/pwa/_auth/session/launch?to=/pwa/",
      "/pwa/./_auth/session/launch?to=x",
      "/pwa/%2e/_auth/pairings/complete",
      "/pwa/spaces/../_auth/session/renew",
      "/pwa/%5Fauth/session/launch",
      "/pwa/%2F%2Fevil.example.test",
      "/pwa/%E0%A4%A",
      `/pwa/${"a".repeat(2048)}`,
    ]) {
      expect([to, launchTarget(to)]).toEqual([to, "/pwa/?pwa_launch=1"]);
    }
  });
});

test("remembered addresses exclude auth, welcome/error states, offline, and fragments", () => {
  expect(rememberedPwaAddress("/pwa/spaces/demo/task?view=mine&pwa_launch=1")).toBe("/pwa/spaces/demo/task?view=mine");
  expect(rememberedPwaAddress("/pwa/spaces?launch=task&pwa=view")).toBe("/pwa/spaces?launch=task&pwa=view");
  for (const address of [
    undefined,
    "/me",
    "/pwa/_auth/session/renew",
    "/pwa/%5Fauth/session/renew",
    "/pwa/?pwa=ended",
    "/pwa/offline",
    "/pwa/#pair=secret",
  ])
    expect(rememberedPwaAddress(address)).toBeUndefined();
});

test("phone endpoints report live builds and clear the scoped address on sign-out and completed pairing", async () => {
  const { spyOn } = await import("bun:test");
  const { Hono } = await import("hono");
  const settings = await import("../services/settings");
  const limiter = await import("../server/ratelimit");
  const watcher = await import("../_internal/runtime-watcher");
  const { pwaDevices } = await import("../services/pwa-devices");
  const { createPwaPhoneRoutes } = await import("./pwa-phone");
  const get = spyOn(settings, "get").mockResolvedValue(100);
  const check = async () => ({ limited: false, remaining: 99, resetIn: 1000 });
  const spies = [
    get,
    spyOn(limiter, "ratelimit").mockReturnValue({ id: "phone-test", check, checkOrThrow: check }),
    spyOn(watcher, "registeredPwaBuilds").mockReturnValue({ core: "core-a", pwa: "shell-b", spaces: "spaces-c" }),
    spyOn(pwaDevices, "renew").mockResolvedValue({ outcome: "current", userId: "account" }),
    spyOn(pwaDevices, "unpair").mockResolvedValue(undefined),
    spyOn(pwaDevices, "completePairing").mockResolvedValue({ state: "paired", credentials: null, platform: "other" }),
  ];
  const routes = new Hono().route("/pwa/_auth", createPwaPhoneRoutes({ shellAvailable: () => true, notify: async () => {} }));
  const request = (path: string, method: string) => {
    get.mockResolvedValueOnce("https://cloud.example.test").mockResolvedValueOnce(100);
    return routes.request(`https://cloud.example.test/pwa/_auth${path}`, {
      method,
      headers: { Origin: "https://cloud.example.test", Cookie: "pwa_last_address=%2Fpwa%2Fspaces%3Fview%3Dmine" },
    });
  };
  try {
    const renewed = await request("/session/renew", "POST");
    expect(renewed.status).toBe(200);
    expect(renewed.headers.get("cache-control")).toBe("no-store");
    expect(await renewed.json()).toEqual({ renewed: false, builds: { core: "core-a", pwa: "shell-b", spaces: "spaces-c" } });
    for (const [path, method, status] of [
      ["/session", "DELETE", 204],
      ["/pairings/complete", "POST", 200],
    ] as const) {
      const response = await request(path, method);
      expect(response.status).toBe(status);
      const cleared = response.headers.getSetCookie().find((cookie) => cookie.startsWith("pwa_last_address="))!;
      expect(cleared).toContain("Max-Age=0");
      expect(cleared).toContain("Path=/pwa/");
      expect(cleared).toContain("Secure");
      expect(cleared).toContain("SameSite=Lax");
    }
  } finally {
    for (const spy of spies.toReversed()) spy.mockRestore();
  }
});
