import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { MutationResult, SpaceWormhole } from "@/contracts";

// Keep the Spaces service fixture inside its own process so package-wide test
// runs never replace the real service modules used by other suites.
if (process.env.SPACES_SETTINGS_STATE_CHILD !== "1") {
  test("Space settings context loads member and administrator data behind permission checks", async () => {
    const child = Bun.spawn([process.execPath, "test", import.meta.path], {
      env: { ...process.env, SPACES_SETTINGS_STATE_CHILD: "1" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect({ code, output: code === 0 ? "passed" : `${stdout}\n${stderr}` }).toEqual({ code: 0, output: "passed" });
  }, 60_000);
} else {
  const SPACE_ID = "11111111-1111-4111-8111-111111111111";
  const USER_ID = "22222222-2222-4222-8222-222222222222";
  const settings = { view: "kanban" as const, hideSettings: false };
  const calls: string[] = [];
  let permission: "none" | "read" | "write" | "admin" = "read";
  let spaceExists = true;
  let configuredWormholes: MutationResult<SpaceWormhole[]> = { ok: true, data: [] };

  const space = {
    id: SPACE_ID,
    name: "Delivery",
    description: null,
    color: "#3b82f6",
    icalToken: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };

  mock.module("@/service", () => ({
    spacesService: {
      space: {
        get: async () => (spaceExists ? space : null),
        getDetail: async () => {
          calls.push("space.getDetail");
          return spaceExists ? { ...space, columns: [], tags: [] } : null;
        },
        permission: { get: async () => permission },
        githubToken: {
          has: async () => {
            calls.push("githubToken.has");
            return true;
          },
        },
      },
      access: {
        list: async () => {
          calls.push("access.list");
          return { items: [], page: 1, perPage: 0, total: 0, hasNext: false };
        },
        apiKeys: {
          list: async () => {
            calls.push("apiKeys.list");
            return [];
          },
        },
      },
      wormhole: {
        actorForUser: () => ({ subject: { type: "user", userId: USER_ID }, resourceBoundSpaceId: null }),
        listConfigured: async () => {
          calls.push("wormholes.listConfigured");
          return configuredWormholes;
        },
      },
    },
  }));

  mock.module("@/service/public-resources", () => ({
    spacesPublicResources: {
      projectSpaces: async (items: Array<{ id: string }>) => items.map((item) => ({ ...item, id: "Space1" })),
      projectColumns: async (items: unknown[]) => items,
      projectTags: async (items: unknown[]) => items,
      projectWormholes: async (items: unknown[]) => items,
    },
  }));

  const { loadSpaceSettingsContext } = await import("./settings-state");

  beforeEach(() => {
    calls.splice(0);
    permission = "read";
    spaceExists = true;
    configuredWormholes = { ok: true, data: [] };
  });

  describe("Space settings context", () => {
    test("returns member settings without loading administrator data", async () => {
      const result = await loadSpaceSettingsContext({ user: { id: USER_ID }, spaceId: SPACE_ID, settings });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.data.permission).toBe("read");
      expect(result.data.space.id).toBe("Space1");
      expect(result.data.settings).toEqual(settings);
      expect(result.data.accessEntries).toEqual([]);
      expect(result.data.apiKeys).toEqual([]);
      expect(result.data.wormholes).toEqual([]);
      expect(result.data.githubTokenConfigured).toBe(false);
      expect(calls).toEqual(["space.getDetail"]);
    });

    test("loads all administrator-only settings in one context", async () => {
      permission = "admin";
      const result = await loadSpaceSettingsContext({ user: { id: USER_ID }, spaceId: SPACE_ID, settings });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.data.permission).toBe("admin");
      expect(result.data.githubTokenConfigured).toBe(true);
      expect(calls).toEqual(["space.getDetail", "access.list", "apiKeys.list", "wormholes.listConfigured", "githubToken.has"]);
    });

    test("fails closed before loading settings data", async () => {
      permission = "none";
      const denied = await loadSpaceSettingsContext({ user: { id: USER_ID }, spaceId: SPACE_ID, settings });
      expect(denied.ok).toBe(false);
      expect(calls).toEqual([]);

      permission = "admin";
      configuredWormholes = { ok: false, error: "Unavailable", status: 500 };
      const failed = await loadSpaceSettingsContext({ user: { id: USER_ID }, spaceId: SPACE_ID, settings });
      expect(failed.ok).toBe(false);
    });
  });
}
