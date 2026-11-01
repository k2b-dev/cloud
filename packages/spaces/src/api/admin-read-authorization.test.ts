import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { redis } from "@k2b/cloud";
import { assertAdminReadAuthorization } from "../../../../scripts/fixtures/admin-read";
import { stubRouterInfrastructure } from "../../../../scripts/fixtures/no-transform";
import { useUnitClients } from "../../../../scripts/fixtures/unit-clients";
import { spacesService } from "../service";
import * as publicResources from "../service/public-resources";
import routes from ".";

useUnitClients();
afterEach(() => mock.restore());
test("the global Spaces summary is readable only with a live admin person and read scope", async () => {
  stubRouterInfrastructure();
  spyOn(redis, "send").mockResolvedValue([1, 0, "1"]);
  const read = spyOn(spacesService.space.admin, "list").mockResolvedValue({
    items: [
      {
        id: "11111111-1111-4111-8111-111111111111",
        name: "Team",
        description: null,
        color: "#000000",
        icalToken: "private-calendar-export",
        permissionCount: 1,
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
      },
    ],
    page: 1,
    perPage: 50,
    total: 1,
    hasNext: false,
  });
  spyOn(publicResources, "projectSpaces").mockImplementation(async (items) => items);
  spyOn(spacesService.space.admin, "summary").mockResolvedValue({ total: 0, orphaned: 0, totalPermissions: 0 });
  await assertAdminReadAuthorization(
    async (headers) => {
      const response = await routes.request("/admin", { headers });
      if (response.status !== 401 && response.status !== 403) {
        expect(response.status).toBe(200);
        const body = await response.clone().json();
        expect(body.items).toHaveLength(1);
        expect(body.items[0]).not.toHaveProperty("icalToken");
        expect(JSON.stringify(body)).not.toContain("private-calendar-export");
      }
      return response;
    },
    () => read.mock.calls.length,
  );
});
