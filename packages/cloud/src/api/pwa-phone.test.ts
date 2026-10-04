import { describe, expect, test } from "bun:test";
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
