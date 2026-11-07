import { afterEach, mock, spyOn, test } from "bun:test";
import { assertAdminReadAuthorization } from "../../../../../../scripts/fixtures/admin-read";
import { useUnitClients } from "../../../../../../scripts/fixtures/unit-clients";
import * as status from "../../../app-status";
import { createAdminAppStatusRoutes } from "./status-api";

useUnitClients();
afterEach(() => mock.restore());
test("Core app status is an admin read, not app-access repair", async () => {
  const read = spyOn(status, "createAppStatusReader").mockImplementation(() => {
    throw new Error("fixture reader");
  });
  const routes = createAdminAppStatusRoutes().onError((_error, c) => c.json({ fixture: true }, 503));
  await assertAdminReadAuthorization(
    (headers) => routes.request("/mail/status", { headers }),
    () => read.mock.calls.length,
  );
});
