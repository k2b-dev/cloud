import { afterEach, mock, spyOn, test } from "bun:test";
import { assertAdminReadAuthorization, assertAdminWriteAuthorization } from "../../../../scripts/fixtures/admin-read";
import { useUnitClients } from "../../../../scripts/fixtures/unit-clients";
import * as administration from "../service/base-admin";
import * as policy from "../service/base-policy";
import { storeAdmin } from "../store/service";
import admin from "./routes/admin";
import bases from "./routes/base-admin";

useUnitClients();
afterEach(() => mock.restore());
test("Pulse store metadata accepts normal login and checks the live person role", async () => {
  const read = spyOn(storeAdmin, "status").mockRejectedValue(new Error("fixture reader"));
  await assertAdminReadAuthorization(
    (headers) => admin.request("/", { headers }),
    () => read.mock.calls.length,
  );
});
test("Pulse policy reads accept normal login and reject clients without the person role", async () => {
  const read = spyOn(policy, "getPolicy").mockRejectedValue(new Error("fixture reader"));
  await assertAdminReadAuthorization(
    (headers) => bases.request("/policy", { headers }),
    () => read.mock.calls.length,
  );
});
for (const surface of ["policy", "limits", "target-add", "target-remove"] as const) {
  test(`Pulse ${surface} configuration uses write and a live administrator`, async () => {
    const write =
      surface === "policy"
        ? spyOn(policy, "setPolicy")
        : surface === "limits"
          ? spyOn(administration, "updateBaseLimits")
          : surface === "target-add"
            ? spyOn(administration, "addInternalTarget")
            : spyOn(administration, "removeInternalTarget");
    write.mockImplementation(async () => {
      throw new Error("fixture writer");
    });
    const path =
      surface === "policy"
        ? "/policy"
        : surface === "limits"
          ? "/bases/Abc123/limits"
          : surface === "target-add"
            ? "/targets"
            : "/targets/11111111-1111-4111-8111-111111111111";
    const body =
      surface === "policy"
        ? {}
        : surface === "limits"
          ? { limits: { valuesPerMinute: 100 } }
          : { baseId: "Abc123", entry: "127.0.0.1:9090" };
    await assertAdminWriteAuthorization(
      (headers) =>
        bases.request(path, {
          method: surface === "target-remove" ? "DELETE" : surface === "target-add" ? "POST" : "PUT",
          headers: { ...headers, "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
      () => write.mock.calls.length,
    );
  });
}
