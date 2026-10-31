import { afterEach, mock, spyOn, test } from "bun:test";
import { redis } from "@k2b/cloud";
import { assertAdminReadAuthorization } from "../../../../scripts/fixtures/admin-read";
import { stubRouterInfrastructure } from "../../../../scripts/fixtures/no-transform";
import { useUnitClients } from "../../../../scripts/fixtures/unit-clients";
import { spacesService } from "../service";
import routes from ".";

useUnitClients();
afterEach(() => mock.restore());
test("the global Spaces summary is readable only with a live admin person and read scope", async () => {
  stubRouterInfrastructure();
  spyOn(redis, "send").mockResolvedValue([1, 0, "1"]);
  const read = spyOn(spacesService.space.admin, "list").mockResolvedValue({ items: [], page: 1, perPage: 50, total: 0, hasNext: false });
  spyOn(spacesService.space.admin, "summary").mockResolvedValue({ total: 0, orphaned: 0, totalPermissions: 0 });
  await assertAdminReadAuthorization(
    (headers) => routes.request("/admin", { headers }),
    () => read.mock.calls.length,
  );
});
