import { afterAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as cloud from "@k2b/cloud";
import { type User, WIDGET_SETTING_TEXT_MAX_LENGTH, WIDGET_SETTINGS_MAX_FIELDS } from "@k2b/cloud/contracts";
import * as server from "@k2b/cloud/server";
import { session } from "@k2b/cloud/services/session";
import { dashboardSettingsService } from "../service";
import type { DashboardBoardEntry } from "../shared";

// Keep the HTTP validation and authentication real without connecting the rate limiter to Valkey.
const rateLimit = spyOn(server, "rateLimit").mockReturnValue(async (_c, next) => next());
const { default: apiRoutes, repeatedKeysWithoutSettings, SettingsSchema } = await import("./index");
rateLimit.mockRestore();

const entry = { id: "one", key: "weather/current", size: "small" as const };
const accepts = (board: unknown[]) => SettingsSchema.safeParse({ board }).success;

describe("dashboard save validation", () => {
  test("rejects duplicate ids and accepts different ids for one key", () => {
    expect(accepts([entry, { ...entry, key: "spaces/today" }])).toBeFalse();
    expect(accepts([entry, { ...entry, id: "two" }])).toBeTrue();
  });
  test("bounds settings and accepts a resource title snapshot", () => {
    expect(accepts([{ ...entry, settings: { a: true, b: true, c: true, d: true, e: true } }])).toBeFalse();
    expect(accepts([{ ...entry, settings: { note: "x".repeat(WIDGET_SETTING_TEXT_MAX_LENGTH + 1) } }])).toBeFalse();
    expect(accepts([{ ...entry, settings: { space: { type: "spaces.space", id: "a", title: "Home" } } }])).toBeTrue();
    for (const name of ["bad_name", "constructor", "toString", "a".repeat(33)]) {
      expect(accepts([{ ...entry, settings: { [name]: true } }])).toBeFalse();
    }
    expect(accepts([{ ...entry, settings: { space: { type: "spaces.space", id: "a", extra: true } } }])).toBeFalse();
  });
  test("restricts repeated keys only when a running widget declares no settings", () => {
    const board = [entry, { ...entry, id: "two" }];
    expect(repeatedKeysWithoutSettings(board, new Map([[entry.key, false]]))).toEqual([entry.key]);
    expect(repeatedKeysWithoutSettings(board, new Map([[entry.key, true]]))).toEqual([]);
    expect(repeatedKeysWithoutSettings(board, new Map())).toEqual([]);
  });
});

describe("PUT /settings", () => {
  const user: User = {
    id: "11111111-1111-4111-8111-111111111111",
    uid: "dashboard-test",
    provider: "local",
    profile: "user",
    roles: ["user"],
    givenname: "Test",
    sn: "User",
    displayName: "Test User",
    mail: null,
    avatarHash: null,
    ipa: null,
    accountExpires: null,
    lastLoginLocal: null,
    memberofGroup: [],
    memberofGroupIds: [],
    manages: [],
    managesGroupIds: [],
  };
  const widget: cloud.DashboardWidget = {
    appId: "weather",
    appName: "Weather",
    appIcon: "ti ti-sun",
    widgetId: "current",
    url: "http://weather/api/weather/widget/current",
    title: "Weather",
    description: "Current weather",
    sizes: ["small"],
    defaultSize: "small",
    suggest: true,
    requiresRoles: [],
  };
  const token = spyOn(session, "getToken").mockReturnValue("test-session");
  const authenticate = spyOn(session, "authenticateRequest").mockResolvedValue({
    user,
    data: { userId: user.id, sid: "test-session", authEpoch: 0, kind: "web", expiresAt: "2099-01-01T00:00:00Z" },
  });
  const registry = spyOn(cloud, "listWidgets");
  const save = spyOn(dashboardSettingsService, "save");
  const put = (board: DashboardBoardEntry[]) =>
    apiRoutes.request("/settings", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ board }),
    });

  beforeEach(() => {
    registry.mockReset().mockResolvedValue([widget]);
    save.mockReset().mockImplementation(async (_userId, input) => input);
  });
  afterAll(() => {
    token.mockRestore();
    authenticate.mockRestore();
    registry.mockRestore();
    save.mockRestore();
  });

  test("rejects a second entry of a widget that declares no settings", async () => {
    const response = await put([entry, { ...entry, id: "two" }]);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ message: `Widgets without settings can appear only once: ${entry.key}` });
    expect(registry).toHaveBeenCalledTimes(1);
    expect(save).not.toHaveBeenCalled();
  });

  test("rejects duplicate entry ids", async () => {
    expect((await put([entry, { ...entry, key: "spaces/today" }])).status).toBe(400);
    expect(save).not.toHaveBeenCalled();
  });

  test("rejects too many settings", async () => {
    const settings = Object.fromEntries(Array.from({ length: WIDGET_SETTINGS_MAX_FIELDS + 1 }, (_, index) => [`field${index}`, true]));
    expect((await put([{ ...entry, settings }])).status).toBe(400);
    expect(save).not.toHaveBeenCalled();
  });

  test("rejects overlong text", async () => {
    expect((await put([{ ...entry, settings: { note: "x".repeat(WIDGET_SETTING_TEXT_MAX_LENGTH + 1) } }])).status).toBe(400);
    expect(save).not.toHaveBeenCalled();
  });

  test("saves two entries of a widget that declares settings", async () => {
    registry.mockResolvedValue([{ ...widget, settings: { note: { kind: "text", label: "Note" } } }]);
    const board = [
      { ...entry, settings: { note: "first" } },
      { ...entry, id: "two", settings: { note: "second" } },
    ];
    const response = await put(board);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ shortcuts: [], board });
    expect(registry).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith(user.id, { shortcuts: [], board });
  });

  test("saves when the registry is unavailable and every widget key is unknown", async () => {
    registry.mockRejectedValue(new Error("Registry unavailable"));
    const board = [entry, { ...entry, id: "two" }];
    const response = await put(board);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ shortcuts: [], board });
    expect(registry).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith(user.id, { shortcuts: [], board });
  });
});
