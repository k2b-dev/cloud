import { afterEach, mock, spyOn, test } from "bun:test";
import { redis } from "@k2b/cloud";
import { logging } from "@k2b/cloud/services";
import { assertAdminReadAuthorization } from "../../../../scripts/fixtures/admin-read";
import { stubRouterInfrastructure } from "../../../../scripts/fixtures/no-transform";
import { useUnitClients } from "../../../../scripts/fixtures/unit-clients";
import nats from "./nats/api";
import * as diagnostics from "./nats/diagnostics";
import sync from "./sync/api";
import { syncOpsService } from "./sync/runtime";
import telemetry from "./telemetry/api";

useUnitClients();
afterEach(() => mock.restore());
for (const kind of ["nats", "sync", "browser"] as const) {
  test(`${kind}: admin read/write login reaches the reader, role revocation and roleless OAuth fail closed`, async () => {
    const probe =
      kind === "nats"
        ? spyOn(diagnostics, "readNatsDiagnostics")
        : kind === "sync"
          ? spyOn(syncOpsService, "overview")
          : spyOn(logging, "webVitals");
    probe.mockImplementation(async () => {
      throw new Error("fixture reader");
    });
    const routes = (kind === "nats" ? nats : kind === "sync" ? sync : telemetry).onError((error, c) => {
      if (error.message !== "fixture reader") console.error(error);
      return c.json({ fixture: true }, 503);
    });
    const infrastructure = stubRouterInfrastructure();
    const limiter = spyOn(redis, "send").mockResolvedValue([1, 0, "1"]);
    try {
      await assertAdminReadAuthorization(
        (headers) => routes.request(kind === "browser" ? "/browser" : "/", { headers }),
        () => probe.mock.calls.length,
      );
    } finally {
      limiter.mockRestore();
      for (const spy of infrastructure) spy.mockRestore();
    }
  });
}
