import { afterEach, mock, spyOn, test } from "bun:test";
import { redis } from "@k2b/cloud";
import { ok } from "@k2b/stdlib";
import { assertAdminReadAuthorization } from "../../../../scripts/fixtures/admin-read";
import { stubRouterInfrastructure } from "../../../../scripts/fixtures/no-transform";
import { useUnitClients } from "../../../../scripts/fixtures/unit-clients";
import { contactsService } from "../service";
import routes from ".";

useUnitClients();
afterEach(() => mock.restore());
test("the global books summary is readable only with a live admin person and read scope", async () => {
  stubRouterInfrastructure();
  spyOn(redis, "send").mockResolvedValue([1, 0, "1"]);
  const read = spyOn(contactsService.book.admin, "list").mockResolvedValue(
    ok({ items: [], page: 1, perPage: 50, total: 0, hasNext: false }),
  );
  spyOn(contactsService.book.admin, "summary").mockResolvedValue(ok({ total: 0, orphaned: 0, totalPermissions: 0, totalContacts: 0 }));
  await assertAdminReadAuthorization(
    (headers) => routes.request("/admin/books", { headers }),
    () => read.mock.calls.length,
  );
});
