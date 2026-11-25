import { expect, spyOn, test } from "bun:test";
import * as server from "@k2b/cloud/server";
import { session } from "@k2b/cloud/services/session";
import { buildProjectedUser } from "@k2b/cloud/services/session/user";
import { stubRouterInfrastructure } from "../../../../../scripts/fixtures/no-transform";
import { useUnitClients } from "../../../../../scripts/fixtures/unit-clients";
import { loggingService } from "./service";

useUnitClients();

const levels = { debug: 0, info: 3, warn: 1, error: 2 };

const withAdmin = async (run: (routes: { request: (path: string) => Response | Promise<Response> }) => Promise<void>) => {
  const limit = spyOn(server, "rateLimit").mockReturnValue(async (_c, next) => next());
  const infrastructure = stubRouterInfrastructure();
  const user = buildProjectedUser({
    id: "00000000-0000-4000-8000-000000000001",
    provider: "local",
    profile: "user",
    effective_admin: true,
  });
  const authenticate = spyOn(session, "authenticateRequest").mockResolvedValue({
    user,
    data: { userId: user.id, sid: "test", authEpoch: 0, kind: "web", expiresAt: "2099-01-01T00:00:00.000Z" },
  });
  try {
    const { default: routes } = await import("./api");
    await run({ request: (path) => routes.request(path, { headers: { Cookie: "session_token=test" } }) });
  } finally {
    for (const spy of [authenticate, limit, ...infrastructure]) spy.mockRestore();
  }
};

test("the list API reads its query through the page's declaration and keeps its pre-v2 names", async () => {
  const search = spyOn(loggingService.entry, "search").mockResolvedValue({ entries: [], total: 6, levels });
  try {
    await withAdmin(async (routes) => {
      const before = Date.now();
      const response = await routes.request("/?search=grids&since_hours=6&level=error,warn&source=mail,gateway&per_page=50&page=2");
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ entries: [], levels, pagination: { page: 2, per_page: 50, total: 6 } });
      const [filter, page, perPage] = search.mock.calls[0]!;
      expect({ ...filter, since: undefined }).toEqual({
        since: undefined,
        levels: ["warn", "error"],
        sources: ["mail", "gateway"],
        search: "grids",
        request: undefined,
      });
      // `since_hours=6` starts the range six hours back, at the minute.
      expect(before - filter.since.getTime()).toBeGreaterThanOrEqual(6 * 3_600_000);
      expect(before - filter.since.getTime()).toBeLessThan(6 * 3_600_000 + 120_000);
      expect([page, perPage]).toEqual([2, 50]);
    });
  } finally {
    search.mockRestore();
  }
});

test("a filter the declaration does not allow is refused, not ignored", async () => {
  const search = spyOn(loggingService.entry, "search").mockResolvedValue({ entries: [], total: 0, levels });
  try {
    await withAdmin(async (routes) => {
      for (const path of [
        "/?level=fatal",
        "/?time=last-2y",
        "/?colour=red",
        `/?request=${"x".repeat(129)}`,
        `/?source=${Array.from({ length: 21 }, (_, i) => `s${i}`).join(",")}`,
      ]) {
        const response = await routes.request(path);
        expect(response.status).toBe(400);
      }
      expect(search).not.toHaveBeenCalled();
    });
  } finally {
    search.mockRestore();
  }
});
